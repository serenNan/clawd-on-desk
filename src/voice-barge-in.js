(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (root) root.ClawdVoiceBargeIn = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Two-stage barge-in: >=duckVoicedMs of continuous voice only ducks the TTS
  // (shallow, so leaked speaker echo is not a jarring volume dip); it is
  // confirmed (stop + onCommit) by a substantive STT partial or >=commitVoicedMs
  // of continuous voice, otherwise the volume is restored recoverMs after the duck.
  // partialOnly (streaming STT available): only recognised words stop playback;
  // no duck and no duration commit, so background music never interrupts.
  const BACKCHANNELS = [
    "嗯嗯", "嗯哼", "哦哦", "好的", "对对", "是的", "哈哈",
    "嗯", "对", "好", "是", "哦", "啊", "哈", "呃", "噢",
  ];
  const BACKCHANNEL_RE = new RegExp(`^(?:${BACKCHANNELS.join("|")})+$`);

  const DUCK_DB = -8;
  const DUCK_VOICED_MS = 200;

  function isBackchannel(text) {
    const s = String(text == null ? "" : text).replace(/[\s\p{P}\p{S}]+/gu, "");
    return s === "" || BACKCHANNEL_RE.test(s);
  }

  function createBargeIn(options) {
    const { sink, onCommit } = options;
    const now = options.now || Date.now;
    const setT = options.setTimeout || setTimeout;
    const clearT = options.clearTimeout || clearTimeout;
    const duckDb = options.duckDb ?? DUCK_DB;
    const duckVoicedMs = options.duckVoicedMs ?? DUCK_VOICED_MS;
    const commitVoicedMs = options.commitVoicedMs ?? 300;
    const recoverMs = options.recoverMs ?? 600;
    const partialOnly = !!options.partialOnly;

    const stats = { duckAt: null, commitAt: null, commitReason: null, restoreAt: null };
    let active = false;
    let committed = false;
    let ducked = false; // confirmation window open
    let voicing = false;
    let commitTimer = null;
    let duckTimer = null;
    let windowUntil = 0; // partials count until recoverMs after the latest speech-start
    let recoverTimer = null;

    function clearTimers() {
      clearT(commitTimer);
      clearT(duckTimer);
      clearT(recoverTimer);
      commitTimer = duckTimer = recoverTimer = null;
    }

    function commit(reason) {
      if (committed) return;
      committed = true;
      ducked = false;
      clearTimers();
      stats.commitAt = now();
      stats.commitReason = reason;
      sink.stop();
      onCommit(reason);
    }

    function duck() {
      duckTimer = null;
      if (!voicing || ducked || committed) return;
      ducked = true;
      stats.duckAt = now();
      sink.duck(duckDb);
      if (!recoverTimer) recoverTimer = setT(recover, recoverMs);
    }

    function recover() {
      recoverTimer = null;
      if (!ducked || committed) return;
      ducked = false;
      stats.restoreAt = now();
      sink.restore();
    }

    return {
      stats,
      setAssistantActive(value) {
        const next = !!value;
        if (next && !active) committed = false;
        if (!next) { clearTimers(); ducked = false; voicing = false; }
        active = next;
      },
      onSpeechStart() {
        if (!active || committed) return;
        voicing = true;
        windowUntil = now() + recoverMs;
        if (partialOnly) return;
        if (!ducked && !duckTimer) duckTimer = setT(duck, duckVoicedMs);
        clearT(commitTimer);
        commitTimer = setT(() => { commitTimer = null; if (voicing) commit("duration"); }, commitVoicedMs);
      },
      onSpeechEnd() {
        if (partialOnly && voicing) windowUntil = now() + recoverMs;
        voicing = false;
        clearT(commitTimer);
        clearT(duckTimer);
        commitTimer = duckTimer = null;
      },
      onPartial(text) {
        const open = ducked || now() <= windowUntil || (partialOnly && voicing);
        if (!active || committed || !open) return;
        if (!isBackchannel(text)) commit("partial");
      },
      reset() { clearTimers(); committed = false; ducked = false; voicing = false; windowUntil = 0; },
      dispose() { clearTimers(); active = false; ducked = false; voicing = false; },
    };
  }

  return Object.freeze({ createBargeIn, isBackchannel });
});

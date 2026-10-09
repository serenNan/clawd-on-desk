"use strict";

const { resolveVoiceReadiness } = require("./voice-settings");
const { createHistoryJournal } = require("./voice-history");
const { createSentenceChunker } = require("./voice-sentence");
const { createReplyPipeline } = require("./voice-reply-pipeline");
const { createSessionBridge, countSentences } = require("./voice-session-bridge");
const { isBackchannel } = require("./voice-barge-in");
const { isEchoText } = require("./voice-echo");
const { createUtterances } = require("./voice-utterances");
const { createVadFeed } = require("./voice-vad-feed");
const { createUtteranceMerger } = require("./voice-utterance-merge");
const { errorFields } = require("./voice-debug-log");

// Main-process call controller. Providers (STT / TTS / brain) are injected so
// tests never touch the network or spawn processes; the renderer owns capture,
// VAD, local ducking and PCM playback and talks to us through voice-ipc.
function createVoiceRuntime({
  getVoice,
  env = process.env,
  createProviders,
  sendToRenderer,
  onStateChange = () => {},
  history = createHistoryJournal(),
  createChunker = createSentenceChunker,
  log = () => {},
  mergeGapMs = 600,
  onCue = () => {},
  cueMaskMs = 650,
  setTimeout: setT = setTimeout,
  clearTimeout: clearT = clearTimeout,
} = {}) {
  let active = false;
  let starting = null;
  let providers = null;
  let epoch = 0;
  let phase = "idle";
  let error = null;
  let muted = false;
  let pipeline = null;
  let startedAt = 0;
  let vadFeed = null;
  let session = null; // bridge, only when brain === "session"
  let merger = null; // session mode: joins segments split by a short pause
  let paused = false; // temporary mic mute for the whole call
  let cueMasked = false; // start cue is playing: the mic would hear it
  let maskTimer = null;

  const snapshot = () => ({
    phase, epoch, muted, error, active, inflight: pipeline ? pipeline.inflightIds() : [], sessionMode: !!session, paused,
  });
  const emit = () => { try { onStateChange(snapshot()); } catch (e) { log("exception", { where: "onStateChange", ...errorFields(e) }); } };
  const setPhase = (p) => {
    if (p === "listening" && session) session.onIdle();
    const shown = paused && p === "listening" ? "paused" : p;
    if (phase !== shown) { phase = shown; emit(); }
  };
  const send = (channel, payload) => sendToRenderer(channel, payload);
  const echoing = (text) => !!pipeline && pipeline.isActive() && isEchoText(text, pipeline.recentSpoken());
  const sendUts = (channel, payload) => {
    if (channel === "voice:partial" && payload && echoing(payload.text)) { log("barge_echo_ignored", { textLen: payload.text.length }); return; }
    send(channel, payload);
  };
  function cue(name, mask = false) {
    try { onCue(name); } catch (e) { log("exception", { where: "onCue", ...errorFields(e) }); }
    clearT(maskTimer);
    cueMasked = mask;
    if (cueMasked) maskTimer = setT(() => { cueMasked = false; maskTimer = null; }, cueMaskMs);
  }
  const notice = (code) => send("voice:notice", { code });

  function fail(code) {
    log("fail", { code, phase });
    stop("error", code);
  }

  function stop(reason, errorCode = null) {
    if (!active) return;
    active = false;
    log("session_stop", { reason, error: errorCode, epoch, durationMs: Date.now() - startedAt });
    uts.cancelAll();
    if (pipeline) pipeline.cancel();
    cue("end");
    if (merger) { merger.dispose(); merger = null; }
    if (session) { session.dispose(); session = null; }
    paused = false;
    const p = providers;
    providers = null;
    pipeline = null;
    try { if (p && p.tts && p.tts.dispose) p.tts.dispose(); } catch (e) { log("exception", { where: "tts.dispose", ...errorFields(e) }); }
    try { if (p && p.brain) p.brain.dispose(); } catch (e) { log("exception", { where: "brain.dispose", ...errorFields(e) }); }
    history.clear();
    if (p && p.vad) { try { p.vad.reset(); } catch (e) { log("exception", { where: "vad.reset", ...errorFields(e) }); } }
    epoch += 1;
    error = errorCode;
    phase = errorCode ? "error" : "idle";
    send("voice:stop", { reason, error: errorCode });
    emit();
  }

  function restartEpoch() {
    epoch += 1;
    log("epoch", { epoch, cause: "restart" });
    send("voice:stop-playback", { epoch });
    if (pipeline) pipeline.retag();
  }

  function interrupt(reason, { playingSentenceId = null } = {}) {
    if (!active) return;
    epoch += 1;
    log("epoch", { epoch, cause: reason });
    if (pipeline) pipeline.cancel();
    if (providers) providers.brain.cancel();
    history.interrupt({ playingSentenceId });
    if (session) session.onInterrupt();
    send("voice:stop-playback", { epoch, reason });
    setPhase("listening");
  }

  const createSession = () => createSessionBridge({
    speak(text) {
      if (paused) { log("converse_text_dropped_paused", { textLen: text.length }); return null; }
      if (pipeline.isActive()) interrupt("converse");
      const turnId = history.startTurn("");
      pipeline.begin({ text, turnId });
      return { turnId, total: countSentences(createChunker, text) };
    },
    heard: (turnId) => history.heardSentences(turnId),
    isPaused: () => paused,
    setTimeout: setT,
    clearTimeout: clearT,
    countSentences: (text) => countSentences(createChunker, text),
    setPhase,
    log,
  });

  function submitUtterance(text) {
    if (session) {
      if (pipeline.isActive()) { if (isBackchannel(text) || echoing(text)) return; interrupt("final"); }
      log("session_final", { textLen: text.length });
      merger.onFinal(text, { awaitingNext: uts.count() > 0 });
      return;
    }
    if (pipeline.isActive()) {
      if (isBackchannel(text) || echoing(text)) return;
      interrupt("final");
    }
    let input = text;
    if (history.needsRebuild()) {
      providers.brain.reset();
      input = history.buildBrainInput(text);
      history.acknowledgeRebuild();
    }
    const turnId = history.startTurn(text);
    log("turn_submit", { turnId, textLen: text.length });
    setPhase("thinking");
    pipeline.begin({ text: input, turnId });
  }

  const uts = createUtterances({
    isActive: () => active,
    isPaused: () => paused,
    getProviders: () => providers,
    getVoice, log, send: sendUts, notice, fail, interrupt,
    onText: submitUtterance,
    onDiscard: () => { if (merger) merger.onDiscard(); },
    onSpeechStart: () => { if (merger) merger.onSpeechStart(); },
    onCancelError: (e) => log("exception", { where: "stt.cancel", ...errorFields(e) }),
  });

  function setPaused(value) {
    const next = !!value;
    if (!active || next === paused) return;
    paused = next;
    log("pause", { paused });
    send("voice:paused", { paused });
    cue(paused ? "end" : "start", !paused);
    if (paused) {
      uts.cancelAll();
      if (merger) merger.dispose();
      if (vadFeed) { vadFeed.reset(); providers.vad.reset(); }
      if (pipeline.isActive()) interrupt("pause");
    }
    setPhase("listening");
  }

  async function doStart() {
    const voice = getVoice();
    const readiness = resolveVoiceReadiness({ voice, env, requireEnabled: true });
    if (!readiness.ready) { log("start_rejected", { reasons: readiness.reasons.join(",") }); return { status: "error", reasons: readiness.reasons }; }
    const p = createProviders(voice);
    const probe = p.brain && p.brain.probe ? await p.brain.probe() : { ok: true };
    if (!probe.ok) {
      try { p.brain.dispose(); } catch (e) { log("exception", { where: "brain.dispose", ...errorFields(e) }); }
      log("start_rejected", { reasons: probe.reason || "brain-unavailable" });
      return { status: "error", reasons: [probe.reason || "brain-unavailable"] };
    }
    providers = p;
    active = true;
    epoch = 0;
    error = null;
    muted = false;
    paused = false;
    pipeline = createReplyPipeline({
      tts: () => providers.tts,
      brain: () => providers.brain,
      fallbackTts: () => providers.fallbackTts,
      localFallbackEnabled: () => { const v = getVoice(); return !!v.localFallback || v.tts === "edge"; },
      history, createChunker, send, notice, fail, restartEpoch, setPhase,
      log,
      epoch: () => epoch,
      isMuted: () => muted,
    });
    session = voice.brain === "session" ? createSession() : null;
    merger = session ? createUtteranceMerger({
      deliver: (t) => session.onUserFinal(t), gapMs: mergeGapMs, log, setTimeout: setT, clearTimeout: clearT,
    }) : null;
    vadFeed = p.vad ? createVadFeed({
      vad: p.vad, send, log,
      onSpeechStart: (preRoll) => { uts.begin(); uts.push(preRoll); },
      onAudio: uts.push,
      onSpeechEnd: uts.end,
    }) : null;
    startedAt = Date.now();
    log("session_start", { stt: p.stt.id, tts: p.tts.id, brain: p.brain && p.brain.id, version: probe.version });
    send("voice:start", { sampleRate: p.stt.capabilities.sampleRate, stt: p.stt.id, tts: p.tts.id, vad: p.vad ? "main" : "renderer" });
    try { if (p.tts.warm) p.tts.warm(); } catch (e) { log("exception", { where: "tts.warm", ...errorFields(e) }); }
    cue("start");
    setPhase("listening");
    return { status: "ok" };
  }

  return {
    start() {
      if (active) return Promise.resolve({ status: "ok" });
      if (!starting) starting = doStart().finally(() => { starting = null; });
      return starting;
    },
    stop,
    getState: snapshot,
    needsRebuild: () => history.needsRebuild(),
    converse: (opts) => (active && session ? session.converse(opts) : Promise.resolve({ error: "not-in-session" })),
    setPaused,
    setMuted(value) {
      muted = !!value;
      send("voice:muted", { muted });
      if (muted && pipeline && pipeline.isActive()) interrupt("mute");
      emit();
    },
    handleSpeechStart() { if (!paused && !cueMasked && !(providers && providers.vad)) uts.begin(); },
    handleAudio(buf) {
      if (paused || cueMasked) return;
      if (vadFeed) { if (active) vadFeed.feed(buf); return; }
      uts.push(buf);
    },
    handleSpeechEnd(info) { if (!paused && !cueMasked && !(providers && providers.vad)) uts.end(info); },
    handleBargeCommit(payload) { if (paused) return; log("barge_commit", { sentenceId: payload && payload.playingSentenceId }); interrupt("barge", payload || {}); },
    handleAck({ epoch: e, sentenceId } = {}) {
      log("ack", { epoch: e, current: epoch, sentenceId, stale: e !== epoch });
      if (active && e === epoch && pipeline) pipeline.ack(sentenceId);
    },
    handleBuffered(ms) { if (active && pipeline) pipeline.setBuffered(ms); },
    handleRendererGone() { stop("renderer-gone"); },
    handleRendererError({ code } = {}) { fail(code || "renderer_error"); },
  };
}

module.exports = { createVoiceRuntime };

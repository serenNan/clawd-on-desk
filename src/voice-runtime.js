"use strict";

const { createHistoryJournal } = require("./voice-history");
const { createSentenceChunker } = require("./voice-sentence");
const { createReplyPipeline } = require("./voice-reply-pipeline");
const { createSessionBridge, countSentences } = require("./voice-session-bridge");
const { isBackchannel } = require("./voice-barge-in");
const { isEchoText, hasChinese } = require("./voice-echo");
const { createUtterances } = require("./voice-utterances");
const { createVadFeed } = require("./voice-vad-feed");
const { createCaptureSource } = require("./voice-capture-source");
const { createUtteranceMerger } = require("./voice-utterance-merge");
const { errorFields } = require("./voice-debug-log");
const { openProviders, disposeProviders } = require("./voice-runtime-providers");
const { createCueMask } = require("./voice-cue-mask");
const { isMuteCommand, isResumeCommand } = require("./voice-commands");

const MAX_CAPTION_CHARS = 160;

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
  summarize = null,
  cueMaskMs = 650,
  canHelperCapture = () => false, onCaptureSource = () => {}, onHelperSilent = () => {},
  now = Date.now,
  setTimeout: setT = setTimeout,
  clearTimeout: clearT = clearTimeout,
} = {}) {
  let active = false;
  let starting = null;
  let providers = null;
  let epoch = 0;
  let phase = "idle";
  let error = null; let muted = false;
  let pipeline = null;
  let startedAt = 0; let vadFeed = null;
  let capture = null; // who records the mic: bundled helper or renderer
  let session = null; // bridge, only when brain === "session"
  let merger = null; // session mode: joins segments split by a short pause
  let paused = false; // muted (shortcut or voice): user speech is not input; mic stays open, playback carries on
  let wanted = "idle"; // phase the pipeline/bridge asked for; `phase` is what the pet shows

  const snapshot = () => ({
    phase, epoch, muted, error, active, inflight: pipeline ? pipeline.inflightIds() : [], sessionMode: !!session, paused,
  });
  const emit = () => { try { onStateChange(snapshot()); } catch (e) { log("exception", { where: "onStateChange", ...errorFields(e) }); } };
  const send = (channel, payload) => sendToRenderer(channel, payload);
  // While paused only real playback may show (speaking); idle and thinking art become paused.
  const show = () => {
    const shown = paused && wanted !== "speaking" ? "paused" : wanted;
    if (phase !== shown) { phase = shown; emit(); }
  };
  const setPhase = (p) => { if (p === "listening" && session) session.onIdle(); wanted = p; show(); };
  // Captions go to the pet window only and are never logged; voice.captions=false sends nothing.
  const caption = (role, text, final) => {
    if (getVoice().captions === false || !text) return;
    send("voice:caption", { role, text: String(text).slice(0, MAX_CAPTION_CHARS), final });
  };
  const echoing = (text) => !!pipeline && pipeline.isActive() && isEchoText(text, pipeline.recentSpoken());
  const sendUts = (channel, payload) => {
    if (paused && channel === "voice:partial") return; // muted: nothing reaches barge-in or captions
    if (channel === "voice:partial" && payload && isMuteCommand(payload.text)) return; // the command must not barge in
    if (channel === "voice:partial" && payload && payload.text && !hasChinese(payload.text)) { log("non_chinese_ignored", { textLen: payload.text.length }); return; }
    if (channel === "voice:partial" && payload && echoing(payload.text)) { log("barge_echo_ignored", { textLen: payload.text.length }); return; }
    if (channel === "voice:partial" && payload && payload.text && !isBackchannel(payload.text)) caption("user", payload.text, false);
    send(channel, payload);
  };
  const { cue, isMasked: cueMasked } = createCueMask({ onCue, log, maskMs: cueMaskMs, setTimeout: setT, clearTimeout: clearT });
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
    if (capture) { capture.end(); capture = null; }
    if (merger) { merger.dispose(); merger = null; }
    if (session) { session.dispose(); session = null; }
    paused = false;
    const p = providers;
    providers = null;
    pipeline = null;
    disposeProviders(p, log);
    history.clear();
    epoch += 1;
    error = errorCode;
    phase = errorCode ? "error" : "idle";
    wanted = "idle";
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
    summarize,
    summarizeOver: () => getVoice().summarizeOver,
  });

  function submitUtterance(text) {
    if (paused) { // muted: only the wake phrase is still listened for, everything else is dropped
      if (isResumeCommand(text) && !echoing(text)) { log("voice_cmd_resume"); setPaused(false); }
      return;
    }
    if (!hasChinese(text)) { log("non_chinese_ignored", { textLen: text.length, final: true }); return; }
    if (isMuteCommand(text)) {
      if (echoing(text)) return;
      log("voice_cmd_mute");
      setPaused(true);
      return;
    }
    if (session) {
      if (pipeline.isActive()) { if (isBackchannel(text) || echoing(text)) return; interrupt("final"); }
      caption("user", text, true);
      log("session_final", { textLen: text.length });
      merger.onFinal(text, { awaitingNext: uts.count() > 0 });
      return;
    }
    if (pipeline.isActive()) {
      if (isBackchannel(text) || echoing(text)) return;
      interrupt("final");
    }
    caption("user", text, true);
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
    // Muted audio is only for the wake phrase and must stay on this machine: a cloud STT is never used then.
    sttFor: () => {
      if (!paused) return providers.stt;
      return [providers.stt, providers.fallbackStt].find((x) => x && !/^aliyun-/.test(x.id)) || null;
    },
    getProviders: () => providers,
    getVoice, log, send: sendUts, notice, fail, interrupt,
    onText: submitUtterance,
    onDiscard: () => { if (merger && !paused) merger.onDiscard(); },
    onSpeechStart: () => { if (merger && !paused) merger.onSpeechStart(); },
    onCancelError: (e) => log("exception", { where: "stt.cancel", ...errorFields(e) }),
  });

  function setPaused(value, { cue: withCue = true } = {}) { // cue:false when the system already chimed (AirPods stem)
    const next = !!value;
    if (!active || next === paused) return;
    paused = next;
    log("pause", { paused });
    send("voice:paused", { paused });
    if (withCue) cue(paused ? "end" : "start", !paused);
    uts.cancelAll(); // a half-heard utterance belongs to the other mode
    if (paused && merger) merger.dispose();
    if (vadFeed) { vadFeed.reset(); providers.vad.reset(); }
    if (paused && !uts.canListen()) log("mute_no_local_stt"); // cloud-only STT: only the shortcut can resume
    show(); // playback (if any) is untouched: the pet keeps speaking, else sleeps / resumes its art
  }

  async function doStart() {
    const voice = getVoice();
    const opened = await openProviders({ voice, env, createProviders, log });
    if (opened.rejected) return opened.rejected;
    const { providers: p, probe } = opened;
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
      history, createChunker, send, caption, notice, fail, restartEpoch, setPhase,
      log,
      epoch: () => epoch,
      isMuted: () => muted,
    });
    session = voice.brain === "session" ? createSession() : null;
    merger = session ? createUtteranceMerger({
      deliver: (t) => session.onUserFinal(t), gapMs: mergeGapMs, log, setTimeout: setT, clearTimeout: clearT,
    }) : null;
    capture = createCaptureSource({ canHelper: canHelperCapture, onSource: onCaptureSource, onHelperSilent, send, log, now });
    vadFeed = p.vad ? createVadFeed({
      vad: p.vad, send: (ch, payload) => { if (!paused) send(ch, payload); }, log,
      onSpeechStart: (preRoll) => { uts.begin(); uts.push(preRoll); },
      onAudio: uts.push,
      onSpeechEnd: uts.end,
    }) : null;
    startedAt = Date.now();
    log("session_start", { stt: p.stt.id, tts: p.tts.id, brain: p.brain && p.brain.id, version: probe.version });
    const captureSource = capture.begin({ hasMainVad: !!p.vad });
    send("voice:start", { capture: captureSource, sampleRate: p.stt.capabilities.sampleRate, stt: p.stt.id, tts: p.tts.id, vad: p.vad ? "main" : "renderer", micDeviceId: voice.micDeviceId || "", micLabel: voice.micLabel || "" });
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
    takeOver() {
      if (!active || !session) return;
      session.takeOver();
      if (pipeline.isActive()) interrupt("takeover");
    },
    setPaused,
    selectMic(info) { if (active) send("voice:mic-select", info); },
    setMuted(value) {
      muted = !!value;
      send("voice:muted", { muted });
      if (muted && pipeline && pipeline.isActive()) interrupt("mute");
      emit();
    },
    handleSpeechStart() { if (!cueMasked() && !(providers && providers.vad)) uts.begin(); },
    refreshCapture() { if (capture) capture.refresh(); },
    captureFailed(reason) { if (capture) capture.fail(reason); },
    handleAudio(buf, from = "renderer") {
      if (cueMasked() || !capture || from !== capture.source()) return;
      if (active) capture.feedWatch(buf);
      if (vadFeed) { if (active) vadFeed.feed(buf); return; }
      uts.push(buf);
    },
    handleSpeechEnd(info) { if (!cueMasked() && !(providers && providers.vad)) uts.end(info); },
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

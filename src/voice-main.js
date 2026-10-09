"use strict";

const { createVoiceRuntime } = require("./voice-runtime");
const { createSessionBrain } = require("./voice-brain-session");
const { registerVoiceIpc, createVoicePermissionPolicy } = require("./voice-ipc");
const { errorFields } = require("./voice-debug-log");
const { resolveVoiceReadiness, normalizeVoice, DASHSCOPE_KEY_ENV } = require("./voice-settings");

const OVERLAY_BY_PHASE = Object.freeze({ listening: "listening", thinking: "thinking", speaking: "speaking", paused: "paused" });
const PROVIDER_KEYS = ["stt", "tts", "brain", "ttsVoice", "ttsVoiceId", "localTtsVoice", "edgeVoice", "endSilenceMs", "ttsSpeed", "claudePath"];
const USER_NOTICES = new Set(["aec-unavailable", "fallback-local-stt", "fallback-local-tts", "reply-too-long", "segment_truncated"]);

// Composition root for realtime voice: wires the runtime to IPC, provider
// factories, the display overlay and lifecycle. main.js only calls into this.
function createVoiceMain(deps) {
  const {
    ipcMain, getPetWebContents, getVoice, applyVoiceUpdate, systemPreferences,
    isMiniTransitioning, setVoiceOverlay, playCue, notify, confirmCloudConsent, factories,
  } = deps;
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const log = deps.debugLog ? deps.debugLog.log : () => {};
  let lastErrorShown = null;
  let ipc = null;
  let startedWith = null;
  let pendingNotice = null; // shown only once the call actually starts
  let brainOverride = null; // "session" while started via the /voice/session HTTP API; never persisted

  // Local streaming stack (sherpa-onnx STT + Silero VAD). Missing models or a
  // native-load failure degrade to whisper with a visible notice, never silently.
  function trySherpa(voice) {
    pendingNotice = null;
    const status = factories.sherpaStatus ? factories.sherpaStatus() : { ready: false };
    if (!status.ready) {
      log("sherpa_fallback", { reason: "model-missing", missing: status.missing ? status.missing.length : 0 });
      pendingNotice = "sherpa-model-missing";
      return null;
    }
    const t0 = Date.now();
    try {
      const stack = factories.createSherpa({ log, endSilenceMs: voice.endSilenceMs });
      log("sherpa_loaded", { ms: Date.now() - t0 });
      return stack;
    } catch (e) {
      log("sherpa_fallback", { reason: "load-failed", ...errorFields(e) });
      pendingNotice = "sherpa-load-failed";
      return null;
    }
  }

  function buildProviders(voice) {
    const key = env[DASHSCOPE_KEY_ENV];
    const cloudStt = voice.stt === "aliyun-paraformer";
    const sherpa = voice.stt === "sherpa-onnx" ? trySherpa(voice) : null;
    const stt = cloudStt ? factories.createAliyunStt({ apiKey: key }) : (sherpa ? sherpa.stt : factories.createLocalStt());
    const cloudTts = voice.tts !== "local-kokoro";
    const edgeTts = voice.tts === "edge";
    const tts = edgeTts
      ? factories.createEdgeTts({ voice: voice.edgeVoice, speed: voice.ttsSpeed, log })
      : cloudTts
        ? factories.createAliyunTts({
          apiKey: key,
          model: voice.tts === "aliyun-cosyvoice-v3.5-flash" ? "cosyvoice-v3.5-flash" : "cosyvoice-v3-flash",
          voice: voice.ttsVoice,
          voiceId: voice.ttsVoiceId || undefined,
        })
        : factories.createLocalTts({ voice: voice.localTtsVoice, speed: voice.ttsSpeed });
    return {
      stt, tts,
      vad: sherpa ? sherpa.vad : null,
      fallbackStt: voice.localFallback && (cloudStt || sherpa) ? factories.createLocalStt() : null,
      // Edge always falls back to Kokoro (no setting needed); Aliyun only when localFallback is on.
      fallbackTts: (edgeTts || voice.localFallback) && cloudTts ? factories.createLocalTts({ voice: voice.localTtsVoice, speed: voice.ttsSpeed }) : null,
      brain: voice.brain === "session"
        ? createSessionBrain()
        : factories.createClaudeBrain({ claudePath: voice.claudePath || undefined, env, log }),
    };
  }

  function onStateChange(state) {
    if (!state.active) brainOverride = null;
    setVoiceOverlay(OVERLAY_BY_PHASE[state.phase] || null);
    if (state.phase === "error" && state.error && state.error !== lastErrorShown) {
      lastErrorShown = state.error;
      notify(state.error);
    }
    if (state.phase !== "error") lastErrorShown = null;
  }

  const runtime = createVoiceRuntime({
    getVoice: () => normalizeVoice(brainOverride ? { ...getVoice(), brain: brainOverride } : getVoice()),
    env,
    createProviders: buildProviders,
    sendToRenderer: (channel, payload) => {
      if (channel === "voice:notice" && payload && USER_NOTICES.has(payload.code)) notify(payload.code);
      ipc.sendToRenderer(channel, payload);
    },
    onStateChange,
    onCue: (name) => { if (playCue) playCue(name); },
    log,
  });

  if (typeof ipcMain.handle === "function") {
    ipcMain.handle("voice:models-status", () => (factories.sherpaStatus ? factories.sherpaStatus() : { ready: false, missing: [] }));
  }
  ipc = registerVoiceIpc({ ipcMain, runtime, getTrustedWebContents: getPetWebContents, log: deps.debugLog });
  log("module_loaded", { platform });
  const permissionPolicy = createVoicePermissionPolicy({
    getTrustedWebContents: getPetWebContents,
    isCallActive: () => runtime.getState().active,
  });

  async function ensureCloudConsent(voice) {
    const readiness = resolveVoiceReadiness({ voice, env, requireEnabled: true });
    if (readiness.ready || !readiness.cloud) return readiness;
    if (readiness.reasons.length !== 1 || readiness.reasons[0] !== "cloud-consent-missing") return readiness;
    if (!(await confirmCloudConsent(voice))) return readiness;
    await applyVoiceUpdate({ ...voice, cloudConsent: true });
    return resolveVoiceReadiness({ voice: getVoice(), env, requireEnabled: true });
  }

  async function ensureMicAccess() {
    if (platform !== "darwin" || !systemPreferences) return true;
    try {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      let granted = status === "granted";
      if (status === "not-determined") granted = !!(await systemPreferences.askForMediaAccess("microphone"));
      log("mic_permission", { status, granted });
      return granted;
    } catch (e) {
      log("exception", { where: "mic_permission", ...errorFields(e) });
      return false;
    }
  }

  async function start() {
    log("start_request");
    if (isMiniTransitioning()) { log("start_rejected", { reasons: "mini-transitioning" }); return { status: "rejected" }; }
    const readiness = await ensureCloudConsent(normalizeVoice(getVoice()));
    if (!readiness.ready) {
      log("start_rejected", { reasons: readiness.reasons.join(",") });
      notify(readiness.reasons[0]);
      return { status: "error", reasons: readiness.reasons };
    }
    if (!(await ensureMicAccess())) {
      notify("mic-denied");
      return { status: "error", reasons: ["mic-denied"] };
    }
    startedWith = normalizeVoice(getVoice());
    const res = await runtime.start();
    if (res.status !== "ok") notify(res.reasons[0]);
    else {
      log("start_ok");
      if (pendingNotice) notify(pendingNotice);
    }
    pendingNotice = null;
    return res;
  }

  function stop(reason) { runtime.stop(reason); }

  // Claude Code session mode (/voice/session/*): the external session is the brain.
  async function sessionStart() {
    const t0 = Date.now();
    const st = runtime.getState();
    if (st.active && st.sessionMode) return { status: "ok", already: true };
    if (st.active) stop("session-switch");
    brainOverride = "session";
    const res = await start();
    if (res.status !== "ok") brainOverride = null;
    log("session_api_start", { status: res.status, reasons: (res.reasons || []).join(","), ms: Date.now() - t0 });
    return res;
  }

  async function sessionStop() {
    const st = runtime.getState();
    log("session_api_stop", { wasActive: !!(st.active && st.sessionMode) });
    if (st.active && st.sessionMode) stop("session-api");
    return { status: "ok" };
  }

  // Pause / resume the mic of a live call (shortcut, menu). No call: behaves like toggle().
  function togglePause() {
    const st = runtime.getState();
    if (!st.active) return { status: "rejected" };
    runtime.setPaused(!st.paused);
    return { status: "ok", paused: runtime.getState().paused };
  }

  return {
    async shortcutToggle() { return runtime.getState().active ? togglePause() : start(); },
    togglePause,
    async toggle() {
      if (runtime.getState().active) { stop("user"); return { status: "ok", ended: true }; }
      return start();
    },
    start,
    stop,
    sessionStart,
    sessionStop,
    converse: runtime.converse,
    getState: runtime.getState,
    permissionPolicy,
    onSettingsChanged(next) {
      if (!runtime.getState().active) return;
      const v = normalizeVoice(next);
      const changed = PROVIDER_KEYS.some((k) => v[k] !== (startedWith || v)[k]);
      if (!v.enabled) stop("disabled");
      else if (changed) stop("settings-changed");
    },
    onLifecycle(event) { stop(event); },
    dispose() {
      stop("dispose");
      ipc.dispose();
      if (typeof ipcMain.removeHandler === "function") ipcMain.removeHandler("voice:models-status");
    },
  };
}

module.exports = { createVoiceMain };

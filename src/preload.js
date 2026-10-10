const { contextBridge, ipcRenderer } = require("electron");

// Parse theme config from additionalArguments (synchronous, available on first load)
const themeArg = process.argv.find(a => a.startsWith("--theme-config="));
const themeConfig = themeArg ? JSON.parse(themeArg.slice("--theme-config=".length)) : null;

contextBridge.exposeInMainWorld("themeConfig", themeConfig);

contextBridge.exposeInMainWorld("electronAPI", {
  // Theme config push (for hot-switch; additionalArguments won't update on reload)
  onThemeConfig: (cb) => ipcRenderer.on("theme-config", (_, cfg) => cb(cfg)),
  // PR #751 Codex review #12 (rework batch B-8, non-blocking): normalize a
  // non-finite value (NaN, +/-Infinity, or anything main.js might someday
  // send that isn't a plain number) to 0 right at the IPC bridge boundary,
  // instead of trusting main.js to always send a legal number. The renderer
  // side already defends against this independently (renderer.js's own
  // offset handlers), but that's a second, redundant line of defense, not a
  // reason to let an illegal value cross the bridge in the first place.
  onViewportOffset: (cb) => ipcRenderer.on("viewport-offset", (_, offsetY) => cb(Number.isFinite(offsetY) ? offsetY : 0)),
  onViewportOffsetX: (cb) => ipcRenderer.on("viewport-offset-x", (_, offsetX) => cb(Number.isFinite(offsetX) ? offsetX : 0)),
  onPetTintChange: (cb) => ipcRenderer.on("pet-tint-change", (_, payload) => cb(payload)),
  onPetAccessoryChange: (cb) => ipcRenderer.on("pet-accessory-change", (_, payload) => cb(payload)),
  onPetAccessorySlotsChange: (cb) => ipcRenderer.on("pet-accessory-slots-change", (_, snapshot) => cb(snapshot)),
  // State sync from main
  onStateChange: (callback) => ipcRenderer.on("state-change", (_, requestOrState, legacySvg) => callback(requestOrState, legacySvg)),
  onKimiPermissionPulse: (callback) => ipcRenderer.on("kimi-permission-pulse", () => callback()),
  onEyeMove: (callback) => ipcRenderer.on("eye-move", (_, dx, dy) => callback(dx, dy)),
  onCloudlingPointer: (callback) => ipcRenderer.on("cloudling-pointer", (_, payload) => callback(payload)),
  onRoamHeading: (callback) => ipcRenderer.on("roam-heading", (_, headingLeft) => callback(headingLeft)),
  onPetScreenSide: (callback) => ipcRenderer.on("pet-screen-side", (_, onRight) => callback(onRight)),
  onWakeFromDoze: (callback) => ipcRenderer.on("wake-from-doze", () => callback()),
  onDndChange: (callback) => ipcRenderer.on("dnd-change", (_, enabled) => callback(enabled)),
  onMiniModeChange: (cb) => ipcRenderer.on("mini-mode-change", (_, enabled, edge, options) => cb(enabled, edge, options)),
  onMiniClip: (cb) => ipcRenderer.on("mini-clip", (_, info) => cb(info)),
  onLowPowerIdleModeChange: (cb) => ipcRenderer.on("low-power-idle-mode-change", (_, enabled) => cb(enabled)),
  onSystemWake: (cb) => ipcRenderer.on("system-wake", (_, payload) => cb(payload)),
  // Reaction control (from main, relayed from hit window)
  onStartDragReaction: (cb) => ipcRenderer.on("start-drag-reaction", (_, requestOrDirection, legacyDirection) => cb(requestOrDirection, legacyDirection)),
  onEndDragReaction: (cb) => ipcRenderer.on("end-drag-reaction", () => cb()),
  onPlayClickReaction: (cb) => ipcRenderer.on("play-click-reaction", (_, requestOrSvg, duration, options) => cb(requestOrSvg, duration, options)),
  onCancelClickReaction: (cb) => ipcRenderer.on("cancel-click-reaction", () => cb()),
  onPlayTestReaction: (cb) => ipcRenderer.on("play-test-reaction", (_, result) => {
    if (result === "pass" || result === "fail") cb(result);
  }),
  // Sound playback (from main)
  onPreloadSounds: (cb) => ipcRenderer.on("preload-sounds", (_, payload) => cb(payload)),
  onPlaySound: (cb) => ipcRenderer.on("play-sound", (_, payload) => cb(payload)),
  onInvalidateSoundCache: (cb) => ipcRenderer.on("invalidate-sound-cache", (_, url) => cb(url)),
  reportSoundPlaybackError: (payload) => ipcRenderer.send("sound-playback-error", payload),
  // Render window → main (cursor polling control during reactions)
  pauseCursorPolling: () => ipcRenderer.send("pause-cursor-polling"),
  resumeFromReaction: () => ipcRenderer.send("resume-from-reaction"),
  notifyPetVisualReady: () => ipcRenderer.send("pet-visual-ready"),
  notifyPetVisualSettled: (payload) => {
    if (!payload || typeof payload !== "object") return;
    const safe = {
      themeId: typeof payload.themeId === "string" ? payload.themeId : null,
      displayState: typeof payload.displayState === "string" ? payload.displayState : null,
      requestedFile: typeof payload.requestedFile === "string" ? payload.requestedFile : null,
      actualFile: typeof payload.actualFile === "string" ? payload.actualFile : null,
      channel: typeof payload.channel === "string" ? payload.channel : null,
      verified: payload.verified === true,
      visualGeneration: Number.isSafeInteger(payload.visualGeneration) ? payload.visualGeneration : null,
      outcome: typeof payload.outcome === "string" ? payload.outcome : null,
    };
    ipcRenderer.send("pet-visual-settled", safe);
  },
  setLowPowerIdlePaused: (paused) => ipcRenderer.send("low-power-idle-paused", !!paused),
  reportSystemWakeStatus: (payload) => ipcRenderer.send("system-wake-status", payload),
  reportAccessoryMirror: (mirrored) => ipcRenderer.send("accessory-mirror", !!mirrored),
  // Realtime voice: fixed voice:* channels only. Audio/PCM crosses as typed arrays;
  // main re-validates every payload and checks this window is the trusted sender.
  voice: {
    onStart: (cb) => ipcRenderer.on("voice:start", (_, info) => cb(info)),
    onStop: (cb) => ipcRenderer.on("voice:stop", (_, info) => cb(info)),
    onStopPlayback: (cb) => ipcRenderer.on("voice:stop-playback", (_, info) => cb(info)),
    onTtsPcm: (cb) => ipcRenderer.on("voice:tts-pcm", (_, chunk) => cb(chunk)),
    onTtsEnd: (cb) => ipcRenderer.on("voice:tts-end", (_, info) => cb(info)),
    onPartial: (cb) => ipcRenderer.on("voice:partial", (_, info) => cb(info)),
    onVad: (cb) => ipcRenderer.on("voice:vad", (_, info) => cb(info)),
    onMuted: (cb) => ipcRenderer.on("voice:muted", (_, info) => cb(info)),
    onPaused: (cb) => ipcRenderer.on("voice:paused", (_, info) => cb(info)),
    onMicRestart: (cb) => ipcRenderer.on("voice:mic-restart", (_, info) => cb(info)),
    micDevices: (list) => ipcRenderer.send("voice:mic-devices", list),
    onCapture: (cb) => ipcRenderer.on("voice:capture", (_, info) => cb(info)),
    onMicSelect: (cb) => ipcRenderer.on("voice:mic-select", (_, info) => cb(info)),
    speechStart: () => ipcRenderer.send("voice:speech-start"),
    audio: (bytes) => ipcRenderer.send("voice:audio", bytes),
    speechEnd: (info) => ipcRenderer.send("voice:speech-end", info),
    bargeCommit: (info) => ipcRenderer.send("voice:barge-commit", info),
    ack: (info) => ipcRenderer.send("voice:ack", info),
    buffered: (ms) => ipcRenderer.send("voice:buffered", ms),
    rendererError: (info) => ipcRenderer.send("voice:renderer-error", info),
    debugLog: (info) => ipcRenderer.send("voice:debug-log", info),
  },
});

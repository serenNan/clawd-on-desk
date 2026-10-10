"use strict";

// Wires the voice renderer controller to the preload bridge. Loaded by
// index.html after voice-renderer.js; does nothing if the bridge is absent.
(function bootVoice() {
  const bridge = window.electronAPI && window.electronAPI.voice;
  if (!bridge || !window.ClawdVoiceRenderer) return;

  const setActive = (on) => {
    document.body.classList.toggle("voice-active", !!on);
  };

  const makeContext = () => {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  };

  const renderer = window.ClawdVoiceRenderer.createVoiceRenderer({
    api: bridge,
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    enumerateDevices: () => navigator.mediaDevices.enumerateDevices(),
    createContext: makeContext,
    createWorkletNode: (ctx) => new AudioWorkletNode(ctx, "clawd-voice-capture"),
    workletUrl: "voice-capture-worklet.js",
    onNotice: () => {},
    onLevel: () => {},
  });

  bridge.onStart((info) => { setActive(true); renderer.start(info); });
  bridge.onStop(() => { setActive(false); renderer.stop(); });
  bridge.onStopPlayback((info) => renderer.handleStopPlayback(info));
  bridge.onTtsPcm((chunk) => renderer.handleTtsPcm(chunk));
  bridge.onTtsEnd((info) => renderer.handleTtsEnd(info));
  bridge.onPartial((info) => renderer.handlePartial(info));
  bridge.onVad((info) => renderer.handleVad(info));
  bridge.onMuted((info) => renderer.handleMuted(info));
  bridge.onPaused((info) => renderer.handlePaused(info));
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", () => renderer.handleDeviceChange());
  if (bridge.onCapture) bridge.onCapture((info) => renderer.handleCapture(info));
  if (bridge.onMicSelect) bridge.onMicSelect((info) => renderer.handleMicSelect(info));
  if (bridge.onMicRestart) bridge.onMicRestart((info) => renderer.handleMicRestart(info));
})();

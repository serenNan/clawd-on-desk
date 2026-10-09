"use strict";

// Wires the voice renderer controller to the preload bridge. Loaded by
// index.html after voice-renderer.js; does nothing if the bridge is absent.
(function bootVoice() {
  const bridge = window.electronAPI && window.electronAPI.voice;
  if (!bridge || !window.ClawdVoiceRenderer) return;

  const indicator = document.getElementById("voice-indicator");
  let decayTimer = null;
  const setLevel = (v) => document.body.style.setProperty("--voice-level", String(Math.min(1, Math.max(0, v))));
  // Playback levels arrive per PCM chunk, so fall back to rest shortly after the last one.
  const pulse = (level) => {
    setLevel(level * 4);
    clearTimeout(decayTimer);
    if (level > 0) decayTimer = setTimeout(() => setLevel(0), 160);
  };
  // Always-visible mic badge: hidden (no call) / green (listening) / grey slashed (paused).
  const setPausedBadge = (paused) => {
    if (indicator) indicator.classList.toggle("paused", !!paused);
    if (paused) pulse(0);
  };
  const setActive = (on) => {
    if (indicator) indicator.classList.toggle("active", !!on);
    if (!on) setPausedBadge(false);
    document.body.classList.toggle("voice-active", !!on);
    if (!on) pulse(0);
  };

  const makeContext = () => {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  };

  const renderer = window.ClawdVoiceRenderer.createVoiceRenderer({
    api: bridge,
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    createContext: makeContext,
    createWorkletNode: (ctx) => new AudioWorkletNode(ctx, "clawd-voice-capture"),
    workletUrl: "voice-capture-worklet.js",
    onNotice: () => {},
    onLevel: (_source, rms) => pulse(rms),
  });

  bridge.onStart((info) => { setActive(true); renderer.start(info); });
  bridge.onStop(() => { setActive(false); renderer.stop(); });
  bridge.onStopPlayback((info) => renderer.handleStopPlayback(info));
  bridge.onTtsPcm((chunk) => renderer.handleTtsPcm(chunk));
  bridge.onTtsEnd((info) => renderer.handleTtsEnd(info));
  bridge.onPartial((info) => renderer.handlePartial(info));
  bridge.onVad((info) => renderer.handleVad(info));
  bridge.onMuted((info) => renderer.handleMuted(info));
  bridge.onPaused((info) => { renderer.handlePaused(info); setPausedBadge(info && info.paused); });
})();

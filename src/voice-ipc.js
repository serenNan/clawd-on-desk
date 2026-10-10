"use strict";

// Restricted IPC surface for realtime voice. Only the registered pet render
// window may talk to the runtime; payloads are size/type checked here so the
// runtime never sees renderer-controlled shapes.

const MAX_AUDIO_BYTES = 64 * 1024;
const END_REASONS = new Set(["silence", "limit", "noise"]);
const OUT_CHANNELS = new Set([
  "voice:start", "voice:stop", "voice:stop-playback", "voice:tts-pcm", "voice:tts-end",
  "voice:partial", "voice:vad", "voice:notice", "voice:muted", "voice:paused", "voice:mic-restart", "voice:mic-select", "voice:capture",
]);

const isId = (v) => typeof v === "string" && v.length > 0 && v.length <= 64;

function createVoicePermissionPolicy({ getTrustedWebContents, isCallActive }) {
  const trustedAudio = (wc) => {
    const trusted = getTrustedWebContents();
    return !!wc && !!trusted && wc.id === trusted.id && !!isCallActive();
  };
  return {
    check(wc, permission, details = {}) {
      if (permission !== "media") return true; // preserve pre-existing behaviour
      return details.mediaType === "audio" && trustedAudio(wc);
    },
    request(wc, permission, callback, details = {}) {
      if (permission !== "media") { callback(true); return; }
      const types = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
      callback(types.length > 0 && types.every((t) => t === "audio") && trustedAudio(wc));
    },
  };
}

function registerVoiceIpc({ ipcMain, runtime, getTrustedWebContents, log, onMicDevices }) {
  const registered = [];
  const isTrusted = (sender) => {
    const wc = getTrustedWebContents();
    return !!sender && !!wc && sender.id === wc.id && !(wc.isDestroyed && wc.isDestroyed());
  };

  function on(channel, handle) {
    const listener = (event, payload) => { if (isTrusted(event && event.sender)) handle(payload || {}, payload); };
    ipcMain.on(channel, listener);
    registered.push([channel, listener]);
  }

  on("voice:speech-start", () => runtime.handleSpeechStart());
  on("voice:audio", (_, raw) => {
    const view = ArrayBuffer.isView(raw) ? raw : (raw instanceof ArrayBuffer ? new Uint8Array(raw) : null);
    if (!view || view.byteLength === 0 || view.byteLength > MAX_AUDIO_BYTES || view.byteLength % 2) return;
    runtime.handleAudio(Buffer.from(view.buffer, view.byteOffset, view.byteLength));
  });
  on("voice:speech-end", (p) => {
    if (END_REASONS.has(p.reason)) runtime.handleSpeechEnd({ reason: p.reason });
  });
  on("voice:barge-commit", (p) => {
    runtime.handleBargeCommit({ playingSentenceId: isId(p.playingSentenceId) ? p.playingSentenceId : null });
  });
  on("voice:ack", (p) => {
    if (Number.isSafeInteger(p.epoch) && isId(p.sentenceId)) runtime.handleAck({ epoch: p.epoch, sentenceId: p.sentenceId });
  });
  on("voice:buffered", (_, raw) => {
    if (Number.isFinite(raw) && raw >= 0 && raw < 600000) runtime.handleBuffered(raw);
  });
  // Renderer debug events: the log module whitelists names and sanitises fields.
  on("voice:debug-log", (_, raw) => { if (log) log.logRenderer(raw); });
  // Device names for the settings picker (only the pet window holds mic permission, so it reports them).
  on("voice:mic-devices", (_, raw) => {
    if (!onMicDevices || !Array.isArray(raw)) return;
    onMicDevices(raw.slice(0, 32).filter((d) => d && isId(d.deviceId) && d.deviceId.length <= 256 && typeof d.label === "string")
      .map((d) => ({ deviceId: d.deviceId, label: d.label.slice(0, 128) })));
  });
  on("voice:renderer-error", (p) => runtime.handleRendererError({ code: isId(p.code) ? p.code : "renderer_error" }));

  return {
    sendToRenderer(channel, payload) {
      if (!OUT_CHANNELS.has(channel)) return;
      const wc = getTrustedWebContents();
      if (!wc || (wc.isDestroyed && wc.isDestroyed())) return;
      wc.send(channel, payload);
    },
    dispose() {
      for (const [channel, listener] of registered.splice(0)) ipcMain.removeListener(channel, listener);
    },
  };
}

module.exports = { registerVoiceIpc, createVoicePermissionPolicy, MAX_AUDIO_BYTES };

"use strict";

// Single-line JSON debug log for the realtime voice chain (userData/voice-debug.log).
// Privacy: only primitives are written; recognised/reply text, keys and audio keys
// are dropped by name, so callers log lengths and durations, never content.
const nodeFs = require("fs");
const path = require("path");

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_STR = 300;
const MAX_FIELDS = 12;
const BLOCKED_KEY = /^(text|content|reply|transcript|prompt|input|audio|pcm|data|payload|token)$|key$|secret|password|authorization/i;

const RENDERER_EVENTS = new Set([
  "renderer_start", "mic_ok", "mic_error", "vad_speech_start", "vad_speech_end",
  "barge_duck", "barge_commit", "barge_restore", "playback_start", "playback_ack",
  "playback_stop", "renderer_exception", "mic_released", "mic_reacquired",
  "track_mute", "track_unmute", "track_ended", "ctx_state", "mic_restart", "mic_restarted",
  "mic_device", "mic_device_fallback", "mic_devices", "mic_select",
]);

function errorFields(err) {
  const message = String((err && err.message) || err || "").slice(0, 200);
  const stack = err && typeof err.stack === "string" ? err.stack.split("\n").slice(0, 4).join("\n") : "";
  return { message, stack: stack.slice(0, 500) };
}

function sanitize(fields) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(fields || {})) {
    if (n >= MAX_FIELDS) break;
    if (BLOCKED_KEY.test(k)) continue;
    if (typeof v === "string") out[k] = v.length > MAX_STR ? `${v.slice(0, MAX_STR)}...` : v;
    else if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || v === null) out[k] = v;
    else continue;
    n += 1;
  }
  return out;
}

function createVoiceDebugLog({ filePath, now = () => new Date(), fs = nodeFs, maxBytes = MAX_BYTES } = {}) {
  let size = null;

  function ensureSize() {
    if (size !== null) return;
    try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch { /* best effort */ }
    try { size = fs.statSync(filePath).size; } catch { size = 0; }
  }

  function log(event, fields) {
    if (!filePath || typeof event !== "string") return;
    try {
      ensureSize();
      const line = `${JSON.stringify({ t: now().toISOString(), event, ...sanitize(fields) })}\n`;
      if (size + line.length > maxBytes) {
        try { fs.renameSync(filePath, `${filePath}.1`); } catch { /* ignore */ }
        size = 0;
      }
      fs.appendFileSync(filePath, line);
      size += line.length;
    } catch { /* logging must never break a call */ }
  }

  function logRenderer(payload) {
    if (!payload || typeof payload !== "object" || !RENDERER_EVENTS.has(payload.event)) return;
    const { event, ...rest } = payload;
    log(`r:${event}`, rest);
  }

  return { log, logRenderer, filePath };
}

module.exports = { createVoiceDebugLog, errorFields, RENDERER_EVENTS };

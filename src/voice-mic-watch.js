"use strict";

// Detects a dead microphone: the renderer keeps sending PCM frames but every
// sample is 0 (OS/driver muted the input, e.g. after an audio route change).
// After `silentMs` of pure zeros, asks the renderer to rebuild its capture
// chain; at most `maxRetries` times per session. Frame gaps (pause, cue mask)
// restart the window so they never count as silence.
const GAP_RESET_MS = 500;

function isAllZero(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

function createMicWatch({ now = Date.now, log = () => {}, onSilent, silentMs = 3000, maxRetries = 3 } = {}) {
  let since = null;
  let last = 0;
  let retries = 0;
  return {
    feed(buf) {
      const t = now();
      if (since !== null && t - last > GAP_RESET_MS) since = null;
      last = t;
      if (!isAllZero(buf)) { since = null; return; }
      if (since === null) { since = t; return; }
      if (t - since < silentMs || retries >= maxRetries) return;
      retries += 1;
      log("mic_silent_restart", { attempt: retries, silentMs: t - since });
      since = t; // give the rebuilt chain a fresh window
      onSilent({ attempt: retries });
    },
  };
}

module.exports = { createMicWatch };

"use strict";

// Runtime harness with a fake clock and recording STT / TTS / brain providers.
// brain "session" drives converse(); "claude-code" records CLI brain sends.
const { createVoiceRuntime } = require("../../src/voice-runtime");
const { createSessionBrain } = require("../../src/voice-brain-session");
const { cloneDefaultVoice } = require("../../src/voice-settings");

function createClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

function makeHarness({ brain = "session", voice = {}, runtimeOptions = {}, fallbackTts = false, ttsId = "local-kokoro" } = {}) {
  const clock = createClock();
  const rec = { sent: [], stt: [], tts: [], logs: [], phases: [], brainSends: [], brainCancels: 0, cues: [] };
  const stt = {
    id: "local-whisper", capabilities: { sampleRate: 16000 },
    begin(handlers) {
      const s = { handlers, cancelled: false, writeAudio() {}, finish() {}, cancel() { this.cancelled = true; } };
      rec.stt.push(s);
      return s;
    },
  };
  const makeTts = (id, list) => ({
    id, capabilities: { sampleRate: 24000, channels: 1, format: "s16le" },
    warm() { rec.warmed = (rec.warmed || 0) + 1; },
    dispose() { rec.disposed = (rec.disposed || 0) + 1; },
    begin(handlers) {
      const s = { handlers, texts: [], cancelled: false, writeText(t) { this.texts.push(t); }, finish() {}, cancel() { this.cancelled = true; } };
      list.push(s);
      return s;
    },
  });
  rec.fbTts = [];
  const tts = makeTts(ttsId, rec.tts);
  const fb = fallbackTts ? makeTts("local-kokoro", rec.fbTts) : null;
  const cli = {
    id: "claude-code", probe: async () => ({ ok: true }),
    send(req, h) { rec.brainSends.push({ req, h }); }, cancel() { rec.brainCancels++; }, reset() {}, dispose() {},
  };
  const runtime = createVoiceRuntime({
    getVoice: () => ({ ...cloneDefaultVoice(), enabled: true, tts: ttsId === "edge" ? "edge" : "local-kokoro", stt: "local-whisper", cloudConsent: true, brain, ...voice }),
    env: {},
    createProviders: () => ({ stt, tts, fallbackTts: fb, brain: brain === "session" ? createSessionBrain() : cli }),
    sendToRenderer: (channel, payload) => rec.sent.push({ channel, payload }),
    onStateChange: (s) => rec.phases.push(s.phase),
    log: (event, fields) => rec.logs.push([event, fields]),
    onCue: (name) => rec.cues.push(name),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    ...runtimeOptions,
  });
  return { runtime, rec, clock };
}

// One user segment as the renderer VAD would report it: start, audio, end, then the STT final.
function say(h, text, { final = true } = {}) {
  const before = h.rec.stt.length;
  h.runtime.handleSpeechStart();
  h.runtime.handleAudio(Buffer.alloc(4));
  h.runtime.handleSpeechEnd({ reason: "silence" });
  if (final) h.rec.stt[before].handlers.onFinal(text);
  return h.rec.stt[before];
}

module.exports = { makeHarness, say, createClock };

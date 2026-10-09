"use strict";

// Renderer test rig: fake mic/context/worklet/sink and a manual clock.
const { createVoiceRenderer } = require("../../src/voice-renderer");

function makeEnv({ settings = { echoCancellation: true }, denyMic = false } = {}) {
  const calls = [];
  const timers = [];
  let t = 0;
  const mkTrack = () => ({ stopped: false, stop() { this.stopped = true; }, getSettings: () => settings, kind: "audio" });
  const track = mkTrack();
  const tracks = [track];
  const mkStream = (t) => ({ getTracks: () => [t], getAudioTracks: () => [t] });
  const sources = [];
  const ctx = {
    sampleRate: 48000, state: "running", closed: false,
    audioWorklet: { addModule: async (url) => calls.push(["addModule", url]) },
    createMediaStreamSource: (st) => { const src = { stream: st, disconnected: false, connect() {}, disconnect() { this.disconnected = true; } }; sources.push(src); return src; },
    suspend: async () => { ctx.state = "suspended"; },
    close: async () => { ctx.closed = true; },
  };
  const node = { port: {}, connect() {}, disconnect() {} };
  const sink = {
    ops: [], active: false,
    duck(db) { this.ops.push(["duck", db]); },
    restore() { this.ops.push(["restore"]); },
    stop() { this.ops.push(["stop"]); this.active = false; return { playingSentenceId: "1-1", droppedSentenceIds: [] }; },
    enqueue(c) { this.ops.push(["enqueue", c.sentenceId]); this.active = true; },
    endSentence(c) { this.ops.push(["end", c.sentenceId]); },
    setEpoch(e) { this.ops.push(["epoch", e]); },
    setMuted(m) { this.ops.push(["muted", m]); },
    isActive() { return this.active; },
    dispose() { this.ops.push(["dispose"]); },
  };
  const api = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const env = {
    calls, timers, track, tracks, sources, ctx, node, sink, api,
    advance(ms) {
      t += ms;
      for (const x of timers.slice()) if (!x.done && x.at <= t) { x.done = true; x.fn(); }
    },
  };
  env.renderer = createVoiceRenderer({
    api,
    getUserMedia: async (c) => { calls.push(["getUserMedia", c]); if (denyMic) throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); if (tracks.length === 1 && calls.filter((x) => x[0] === "getUserMedia").length === 1) return mkStream(track); const t = mkTrack(); tracks.push(t); return mkStream(t); },
    createContext: () => ctx,
    createWorkletNode: () => node,
    createSink: (_ctx, handlers) => { sink.handlers = handlers; return sink; },
    workletUrl: "voice-capture-worklet.js",
    now: () => t,
    setTimeout: (fn, ms) => { const x = { fn, at: t + ms, done: false }; timers.push(x); return x; },
    clearTimeout: (x) => { if (x) x.done = true; },
    onNotice: (c) => calls.push(["notice", c]),
    onLevel: (src, v) => calls.push(["level", src, v]),
  });
  return env;
}

const frame = (amp) => new Float32Array(960).fill(amp); // 20ms @ 48k
function feed(env, amp, ms) {
  for (let i = 0; i < ms / 20; i++) { env.node.port.onmessage({ data: frame(amp) }); env.advance(20); }
}

module.exports = { makeEnv, feed };

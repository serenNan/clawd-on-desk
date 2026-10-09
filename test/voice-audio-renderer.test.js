"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createAudioSink } = require("../src/voice-audio-renderer");

function makeContext() {
  const ctx = {
    currentTime: 10,
    gains: [],
    sources: [],
    buffers: [],
    destination: { id: "dest" },
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      const buf = { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, data, getChannelData: (i) => data[i] };
      ctx.buffers.push(buf);
      return buf;
    },
    createGain() {
      const calls = [];
      const g = {
        calls,
        disconnected: false,
        gain: {
          value: 1,
          cancelScheduledValues: (t) => calls.push(["cancel", t]),
          setTargetAtTime: (v, t, k) => calls.push(["target", v, t, k]),
          linearRampToValueAtTime: (v, t) => calls.push(["ramp", v, t]),
          setValueAtTime: (v, t) => calls.push(["set", v, t]),
        },
        connect(dst) { g.dst = dst; },
        disconnect() { g.disconnected = true; },
      };
      ctx.gains.push(g);
      return g;
    },
    createBufferSource() {
      const s = {
        buffer: null, startedAt: null, stoppedAt: null, onended: null, connectedTo: null,
        connect(dst) { s.connectedTo = dst; },
        start(when) { s.startedAt = when; },
        stop(when) { s.stoppedAt = when === undefined ? ctx.currentTime : when; },
      };
      ctx.sources.push(s);
      return s;
    },
  };
  return ctx;
}

// n 个 s16le 样本，全部 = value
function pcm(n, value = 16384) {
  const u = new Uint8Array(n * 2);
  const dv = new DataView(u.buffer);
  for (let i = 0; i < n; i++) dv.setInt16(i * 2, value, true);
  return u;
}

function setup(extra = {}) {
  const ctx = makeContext();
  const acks = [];
  const buffered = [];
  const levels = [];
  const sink = createAudioSink({
    context: ctx,
    onAck: (a) => acks.push(a),
    onBuffered: (ms) => buffered.push(ms),
    onLevel: (r) => levels.push(r),
    ...extra,
  });
  sink.setEpoch(1);
  return { ctx, sink, acks, buffered, levels };
}

test("sources are scheduled gaplessly and in order through one master gain", () => {
  const { ctx, sink } = setup();
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: pcm(2400), sampleRate: 24000 }); // 100ms
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: pcm(4800), sampleRate: 24000 }); // 200ms
  const [s1, s2] = ctx.sources;
  assert.ok(s1.startedAt >= 10);
  assert.ok(Math.abs(s2.startedAt - (s1.startedAt + 0.1)) < 1e-9);
  assert.equal(s1.connectedTo, ctx.gains[0]);
  assert.equal(ctx.gains[0].dst, ctx.destination);
  assert.equal(ctx.buffers[0].sampleRate, 24000, "buffer keeps provider sample rate");
  assert.ok(Math.abs(ctx.buffers[0].getChannelData(0)[0] - 0.5) < 1e-3);
});

test("half-sample splits are rejoined, not shifted", () => {
  const { ctx, sink } = setup();
  const whole = pcm(10, 8192);
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: whole.slice(0, 7), sampleRate: 16000 }); // 3 samples + 1 byte
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: whole.slice(7), sampleRate: 16000 });
  const total = ctx.buffers.reduce((n, b) => n + b.length, 0);
  assert.equal(total, 10);
  for (const b of ctx.buffers) for (const v of b.getChannelData(0)) assert.ok(Math.abs(v - 0.25) < 1e-3);
});

test("accepts ArrayBuffer input", () => {
  const { ctx, sink } = setup();
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: pcm(100).buffer, sampleRate: 16000 });
  assert.equal(ctx.buffers[0].length, 100);
});

test("stale epoch chunks are dropped", () => {
  const { ctx, sink } = setup();
  sink.setEpoch(2);
  sink.enqueue({ epoch: 1, sentenceId: "old", pcm: pcm(100), sampleRate: 16000 });
  assert.equal(ctx.sources.length, 0);
  assert.equal(sink.isActive(), false);
});

test("ack fires only when the sentence's last source really ends after endSentence", () => {
  const { ctx, sink, acks } = setup();
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: pcm(1600), sampleRate: 16000 });
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: pcm(1600), sampleRate: 16000 });
  ctx.sources[0].onended();
  assert.deepEqual(acks, []);
  sink.endSentence({ epoch: 1, sentenceId: "a" });
  assert.deepEqual(acks, []);
  ctx.sources[1].onended();
  assert.deepEqual(acks, [{ epoch: 1, sentenceId: "a" }]);
  assert.equal(sink.isActive(), false);
});

test("ack fires immediately when endSentence arrives after all sources ended", () => {
  const { ctx, sink, acks } = setup();
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: pcm(1600), sampleRate: 16000 });
  ctx.sources[0].onended();
  assert.deepEqual(acks, []);
  sink.endSentence({ epoch: 1, sentenceId: "a" });
  assert.deepEqual(acks, [{ epoch: 1, sentenceId: "a" }]);
});

test("stop fades gain, stops all sources, reports playing/dropped, and produces no ack", () => {
  const { ctx, sink, acks } = setup();
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: pcm(16000), sampleRate: 16000 }); // 1s, playing
  sink.enqueue({ epoch: 1, sentenceId: "b", pcm: pcm(16000), sampleRate: 16000 }); // queued
  sink.endSentence({ epoch: 1, sentenceId: "a" });
  sink.endSentence({ epoch: 1, sentenceId: "b" });
  ctx.currentTime = 10.3;
  const old = ctx.gains[0];
  const res = sink.stop({ fadeMs: 20 });
  assert.equal(res.playingSentenceId, "a");
  assert.deepEqual(res.droppedSentenceIds, ["b"]);
  assert.ok(old.calls.some((c) => (c[0] === "ramp" || c[0] === "target") && c[1] === 0), "fades to 0");
  for (const s of ctx.sources) assert.ok(Math.abs(s.stoppedAt - 10.32) < 1e-9);
  for (const s of ctx.sources) s.onended && s.onended();
  assert.deepEqual(acks, []);
  assert.equal(sink.isActive(), false);
  assert.equal(sink.getBufferedMs(), 0);
  // later audio uses a fresh gain at full level
  sink.enqueue({ epoch: 1, sentenceId: "c", pcm: pcm(160), sampleRate: 16000 });
  assert.equal(ctx.gains.length, 2);
  assert.notEqual(ctx.sources.at(-1).connectedTo, old);
});

test("stop drops pending half-sample remainder", () => {
  const { ctx, sink } = setup();
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: pcm(10).slice(0, 5), sampleRate: 16000 });
  sink.stop();
  sink.enqueue({ epoch: 1, sentenceId: "b", pcm: pcm(10).slice(0, 4), sampleRate: 16000 });
  assert.equal(ctx.buffers.at(-1).length, 2);
});

test("duck and restore smoothly set master gain; muted yields gain 0 and no ack", () => {
  const { ctx, sink, acks } = setup();
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: pcm(1600), sampleRate: 16000 });
  sink.duck(-18);
  const g = ctx.gains[0];
  const duckCall = g.calls.filter((c) => c[0] === "target").pop();
  assert.ok(Math.abs(duckCall[1] - Math.pow(10, -18 / 20)) < 1e-6);
  assert.ok(duckCall[3] <= 0.05 / 3 + 1e-9, "settles within 50ms");
  sink.restore();
  assert.equal(g.calls.filter((c) => c[0] === "target").pop()[1], 1);
  sink.setMuted(true);
  assert.equal(g.calls.filter((c) => c[0] === "target").pop()[1], 0);
  sink.endSentence({ epoch: 1, sentenceId: "a" });
  ctx.sources[0].onended();
  assert.deepEqual(acks, []);
});

test("buffer cap: canAccept false above 2000ms and onBuffered reports", () => {
  const { ctx, sink, buffered } = setup();
  assert.equal(sink.canAccept(), true);
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: pcm(16000 * 2.5), sampleRate: 16000 });
  assert.equal(sink.canAccept(), false);
  assert.ok(sink.getBufferedMs() > 2000);
  assert.ok(buffered.at(-1) > 2000);
  ctx.currentTime = 12;
  ctx.sources[0].onended();
  assert.equal(sink.canAccept(), true);
  assert.ok(buffered.at(-1) < 2000);
});

test("onLevel reports chunk rms; stop reports 0; dispose stops and refuses audio", () => {
  const { ctx, sink, levels } = setup();
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: pcm(160, 16384), sampleRate: 16000 });
  assert.ok(Math.abs(levels[0] - 0.5) < 1e-3);
  sink.dispose();
  assert.equal(levels.at(-1), 0);
  const n = ctx.sources.length;
  sink.enqueue({ epoch: 1, sentenceId: "b", pcm: pcm(160), sampleRate: 16000 });
  assert.equal(ctx.sources.length, n);
});

test("stereo input is split into channels", () => {
  const { ctx, sink } = setup();
  sink.enqueue({ epoch: 1, sentenceId: "a", pcm: pcm(20), sampleRate: 16000, channels: 2 });
  assert.equal(ctx.buffers[0].numberOfChannels, 2);
  assert.equal(ctx.buffers[0].length, 10);
});

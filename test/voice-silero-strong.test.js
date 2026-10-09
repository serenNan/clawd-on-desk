"use strict";

// Two thresholds: the normal one segments speech for STT, the strict one (0.8)
// is what the renderer trusts for ducking while the assistant speaks.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSileroDetector, STRONG_THRESHOLD } = require("../src/voice-sherpa-native");
const { createSileroVad } = require("../src/voice-vad-silero");
const { createVadFeed } = require("../src/voice-vad-feed");

function fakeSherpa() {
  const vads = [];
  class Vad {
    constructor(cfg) { this.cfg = cfg; this.detected = false; vads.push(this); }
    acceptWaveform() {}
    isEmpty() { return true; }
    pop() {}
    isDetected() { return this.detected; }
    reset() {}
  }
  return { sherpa: { Vad }, vads };
}

test("detector runs a normal (0.5) and a strict (0.8) Silero; accept stays the normal flag", () => {
  const { sherpa, vads } = fakeSherpa();
  const d = createSileroDetector({ sherpa, paths: { vad: "v.onnx" } });
  assert.equal(STRONG_THRESHOLD, 0.8);
  assert.deepEqual(vads.map((v) => v.cfg.sileroVad.threshold), [0.5, 0.8]);
  vads[0].detected = true;
  assert.equal(d.accept(new Float32Array(512)), true);
  assert.equal(d.isStrong(), false, "weak voice (echo-like) is voiced but not strong");
  vads[1].detected = true;
  d.accept(new Float32Array(512));
  assert.equal(d.isStrong(), true);
});

test("frame events carry strong; detectors without isStrong fall back to voiced", () => {
  const frame = new Int16Array(320);
  const a = createSileroVad({ detector: { accept: () => true, isStrong: () => false } });
  assert.deepEqual(a.processChunk(frame)[0], { type: "frame", voiced: true, strong: false });
  const b = createSileroVad({ detector: { accept: () => true } });
  assert.equal(b.processChunk(frame)[0].strong, true);
});

test("vad feed forwards strong to the renderer while speaking", () => {
  const sent = [];
  const events = [[{ type: "frame", voiced: true, strong: false }, { type: "speech-start", preRoll: Buffer.alloc(2) }], [{ type: "frame", voiced: true, strong: true }]];
  const feed = createVadFeed({
    vad: { processChunk: () => events.shift() }, send: (c, p) => sent.push(p), log() {},
    onSpeechStart() {}, onAudio() {}, onSpeechEnd() {},
  });
  feed.feed(Buffer.alloc(640)); feed.feed(Buffer.alloc(640));
  assert.deepEqual(sent, [{ type: "speech-start" }, { type: "frame", voiced: true, strong: true }]);
});

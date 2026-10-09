"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function load(sampleRate) {
  const registered = {};
  class FakeProcessor { constructor() { this.port = { posts: [], postMessage: (m, t) => this.port.posts.push([m, t]) }; } }
  const sandbox = {
    AudioWorkletProcessor: FakeProcessor,
    registerProcessor: (name, cls) => { registered[name] = cls; },
    sampleRate,
    Float32Array,
  };
  sandbox.globalThis = sandbox;
  const src = fs.readFileSync(path.join(__dirname, "../src/voice-capture-worklet.js"), "utf8");
  vm.runInNewContext(src, sandbox);
  return registered;
}

test("registers clawd-voice-capture", () => {
  assert.equal(typeof load(48000)["clawd-voice-capture"], "function");
});

test("accumulates 128-sample blocks into ~20ms frames and posts a transferable copy", () => {
  const P = load(48000)["clawd-voice-capture"]; // 20ms = 960 samples
  const p = new P();
  const block = new Float32Array(128).fill(0.5);
  let posted = 0;
  for (let i = 0; i < 7; i++) {
    assert.equal(p.process([[block]], []), true);
    posted = p.port.posts.length;
  }
  assert.equal(posted, 0, "896 samples < 960");
  p.process([[block]], []);
  assert.equal(p.port.posts.length, 1);
  const [frame, transfer] = p.port.posts[0];
  assert.equal(frame.length, 960);
  assert.equal(frame[0], 0.5);
  assert.equal(transfer.length, 1);
  assert.equal(transfer[0], frame.buffer);
  block.fill(0);
  assert.equal(frame[0], 0.5, "frame is a copy, not a view of the input");
});

test("keeps leftover samples across frames and survives missing input", () => {
  const P = load(16000)["clawd-voice-capture"]; // 320 samples
  const p = new P();
  const ramp = new Float32Array(128).map((_, i) => i);
  for (let i = 0; i < 5; i++) p.process([[ramp]], []); // 640 samples -> 2 frames
  assert.equal(p.port.posts.length, 2);
  assert.equal(p.port.posts[0][0].length, 320);
  assert.equal(p.process([], []), true);
  assert.equal(p.process([[]], []), true);
  assert.equal(p.port.posts.length, 2);
});

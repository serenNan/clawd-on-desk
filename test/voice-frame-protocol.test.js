"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { encodeFrame, createFrameParser, HEADER_BYTES } = require("../src/voice-frame-protocol");

function collect() {
  const frames = []; const errors = [];
  const p = createFrameParser({ onFrame: (b) => frames.push(Buffer.from(b)), onError: (e) => errors.push(e) });
  return { p, frames, errors };
}
const pcm = (n, v) => Buffer.alloc(n, v);

test("encodeFrame: magic + uint16 LE length + payload", () => {
  const f = encodeFrame(pcm(640, 1));
  assert.equal(f.length, HEADER_BYTES + 640);
  assert.equal(f.readUInt16LE(2), 640);
});

test("one chunk with one frame", () => {
  const c = collect();
  c.p.push(encodeFrame(pcm(640, 7)));
  assert.equal(c.frames.length, 1);
  assert.deepEqual(c.frames[0], pcm(640, 7));
});

test("split across chunks (header split, payload split, byte by byte)", () => {
  const whole = encodeFrame(pcm(640, 9));
  for (const cut of [1, 3, 4, 5, 300, 643]) {
    const c = collect();
    c.p.push(whole.subarray(0, cut)); assert.equal(c.frames.length, 0);
    c.p.push(whole.subarray(cut));
    assert.equal(c.frames.length, 1, `cut ${cut}`);
  }
  const c = collect();
  for (const b of whole) c.p.push(Buffer.from([b]));
  assert.equal(c.frames.length, 1);
});

test("several frames glued into one chunk, plus a trailing partial", () => {
  const c = collect();
  const a = encodeFrame(pcm(640, 1)); const b = encodeFrame(pcm(640, 2)); const d = encodeFrame(pcm(640, 3));
  c.p.push(Buffer.concat([a, b, d.subarray(0, 100)]));
  assert.deepEqual(c.frames.map((f) => f[0]), [1, 2]);
  c.p.push(d.subarray(100));
  assert.deepEqual(c.frames.map((f) => f[0]), [1, 2, 3]);
});

test("bad magic is reported once and the buffer is dropped (caller restarts the helper)", () => {
  const c = collect();
  c.p.push(Buffer.from("garbage text from a stray print\n"));
  assert.equal(c.frames.length, 0);
  assert.equal(c.errors.length, 1);
  assert.equal(c.errors[0], "bad-magic");
});

test("zero-length frames are skipped", () => {
  const c = collect();
  c.p.push(Buffer.concat([encodeFrame(Buffer.alloc(0)), encodeFrame(pcm(4, 5))]));
  assert.equal(c.frames.length, 1);
});

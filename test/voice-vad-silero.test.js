"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSileroVad } = require("../src/voice-vad-silero");

const FRAME = 320; // 20 ms @ 16 kHz
const frame = (fill = 1) => new Int16Array(FRAME).fill(fill);

// Fake detector driven by a per-frame boolean script (what Silero would say).
function harness(script, options = {}) {
  let i = 0;
  const detector = { accept: () => !!script[i++], reset() { i = 0; } };
  const vad = createSileroVad({ detector, ...options });
  const events = [];
  const feed = (n) => { for (let k = 0; k < n; k++) events.push(...vad.processChunk(frame(k + 1))); };
  return { vad, events, feed, types: () => events.filter((e) => e.type !== "frame").map((e) => e.type) };
}

const bits = (s) => s.split("").map((c) => c === "1");

test("speech-start fires after startMs of voiced frames and carries pre-roll", () => {
  const h = harness(bits("0000111100"), { startMs: 60, preRollMs: 100 });
  h.feed(10);
  const start = h.events.find((e) => e.type === "speech-start");
  assert.ok(start);
  // pre-roll = up to preRollMs of audio before the voiced run + the run itself
  assert.ok(start.preRoll.length >= 3 * FRAME * 2);
  assert.ok(Buffer.isBuffer(start.preRoll));
});

test("a single voiced frame is below startMs and never starts speech", () => {
  const h = harness(bits("0001000000"), { startMs: 60 });
  h.feed(10);
  assert.deepEqual(h.types(), []);
});

test("speech-end after endSilenceMs with reason silence", () => {
  const h = harness(bits("11111111" + "0".repeat(22)), { startMs: 60, endSilenceMs: 400, minSpeechMs: 100 });
  h.feed(30);
  assert.deepEqual(h.types().filter((t) => t.startsWith("speech")), ["speech-start", "speech-end"]);
  assert.equal(h.events.find((e) => e.type === "speech-end").reason, "silence");
});

test("a short blip ends as noise, so STT is cancelled upstream", () => {
  const h = harness(bits("111" + "0".repeat(22)), { startMs: 60, endSilenceMs: 400, minSpeechMs: 200 });
  h.feed(25);
  assert.equal(h.events.find((e) => e.type === "speech-end").reason, "noise");
});

test("speech continuing within the silence window cancels the end timer", () => {
  const h = harness(bits("11111100000111111000000000000000000000"), { startMs: 60, endSilenceMs: 350, minSpeechMs: 100 });
  h.feed(38);
  assert.equal(h.events.filter((e) => e.type === "speech-start").length, 1);
  assert.equal(h.events.filter((e) => e.type === "speech-end").length, 1);
});

test("audio events stream every frame while speaking", () => {
  const h = harness(bits("1111111100000"), { startMs: 60, endSilenceMs: 500 });
  h.feed(13);
  const audio = h.events.filter((e) => e.type === "audio");
  assert.ok(audio.length >= 8);
  assert.equal(audio[0].pcm.length, FRAME * 2);
});

test("frame events expose per-frame voiced for the barge-in tracker", () => {
  const h = harness(bits("0110"));
  h.feed(4);
  assert.deepEqual(h.events.filter((e) => e.type === "frame").map((e) => e.voiced), [false, true, true, false]);
});

test("maxSegmentMs forces an end(limit) and restarts the segment", () => {
  const h = harness(new Array(200).fill(true), { startMs: 60, maxSegmentMs: 1000 });
  h.feed(120);
  assert.ok(h.events.some((e) => e.type === "speech-end" && e.reason === "limit"));
  assert.ok(h.events.filter((e) => e.type === "speech-start").length >= 2);
});

test("endSilenceMs defaults to 800 and is clamped to 400-1500 and adjustable", () => {
  assert.equal(harness([]).vad.getEndSilenceMs(), 800);
  const { vad } = harness([], { endSilenceMs: 9999 });
  assert.equal(vad.getEndSilenceMs(), 1500);
  vad.setEndSilenceMs(10);
  assert.equal(vad.getEndSilenceMs(), 400);
});

test("a 600ms pause inside a sentence does not split it; a 900ms pause does", () => {
  const short = harness(bits("1".repeat(10) + "0".repeat(30) + "1".repeat(10) + "0".repeat(50)));
  short.feed(100);
  assert.deepEqual(short.types().filter((t) => t.startsWith("speech")), ["speech-start", "speech-end"]);
  const long = harness(bits("1".repeat(10) + "0".repeat(46) + "1".repeat(10) + "0".repeat(50)));
  long.feed(116);
  assert.deepEqual(long.types().filter((t) => t.startsWith("speech")), ["speech-start", "speech-end", "speech-start", "speech-end"]);
});

test("reset clears state and resets the detector", () => {
  const h = harness(bits("11111111"), { startMs: 60 });
  h.feed(8);
  assert.equal(h.vad.isSpeaking(), true);
  h.vad.reset();
  assert.equal(h.vad.isSpeaking(), false);
});

test("accepts arbitrary chunk sizes by timing on samples, not call count", () => {
  const h = harness(bits("11111111"), { startMs: 60 });
  // 640-sample (40 ms) chunks: two voiced chunks already exceed startMs
  const out = [...h.vad.processChunk(new Int16Array(640)), ...h.vad.processChunk(new Int16Array(640))];
  assert.ok(out.some((e) => e.type === "speech-start"));
});

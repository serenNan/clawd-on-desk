"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createVad, createResampler, floatToInt16 } = require("../src/voice-vad");

const SR = 16000;
const N = 320; // 20ms
const frame = (amp) => new Float32Array(N).fill(amp);
const feed = (vad, amp, count, out = []) => {
  for (let i = 0; i < count; i++) out.push(...vad.processFrame(frame(amp)));
  return out;
};
const types = (evs) => evs.filter((e) => e.type !== "level").map((e) => e.type + (e.reason ? ":" + e.reason : ""));
const calibrated = (opts) => {
  const vad = createVad({ sampleRate: SR, ...opts });
  feed(vad, 0.002, 15); // 300ms noise floor
  return vad;
};

test("calibration frames never trigger speech", () => {
  const vad = createVad({ sampleRate: SR });
  assert.deepEqual(types(feed(vad, 0.002, 15)), []);
});

test("speech-start after ~100ms voiced, carrying 150ms pre-roll", () => {
  const vad = calibrated();
  feed(vad, 0.002, 10);
  const evs = feed(vad, 0.3, 4);
  assert.deepEqual(types(evs), []);
  const more = feed(vad, 0.3, 1);
  assert.deepEqual(types(more), ["speech-start"]);
  const start = more.find((e) => e.type === "speech-start");
  assert.ok(start.preRoll.length >= SR * 0.15, "pre-roll covers at least 150ms");
  assert.ok(start.preRoll.length <= SR * 0.3 + N * 5, "pre-roll includes the voiced frames, bounded");
});

test("800ms trailing silence ends the segment; a 600ms pause does not", () => {
  const vad = calibrated();
  let evs = feed(vad, 0.3, 20);
  evs = feed(vad, 0.002, 30, evs); // 600ms pause: short pause must not split the sentence
  feed(vad, 0.3, 5, evs); // speech resumes: silence timer cancelled
  assert.deepEqual(types(evs), ["speech-start"]);
  const end = feed(vad, 0.002, 39); // 780ms
  assert.deepEqual(types(end), []);
  const done = feed(vad, 0.002, 1);
  const e = done.find((x) => x.type === "speech-end");
  assert.equal(e.reason, "silence");
  assert.ok(e.durationMs >= 400);
});

test("setEndSilenceMs clamps to 400-1500ms", () => {
  const vad = calibrated();
  assert.equal(vad.getEndSilenceMs(), 800);
  vad.setEndSilenceMs(100);
  assert.equal(vad.getEndSilenceMs(), 400);
  vad.setEndSilenceMs(9999);
  assert.equal(vad.getEndSilenceMs(), 1500);
  vad.setEndSilenceMs(400);
  feed(vad, 0.3, 20);
  assert.deepEqual(types(feed(vad, 0.002, 19)), []);
  assert.deepEqual(types(feed(vad, 0.002, 1)), ["speech-end:silence"]);
});

test("voiced burst shorter than minSpeech is reported as noise (speech-end reason 'noise', upper layer discards)", () => {
  const vad = calibrated({ startMs: 60, minSpeechMs: 150 });
  let evs = feed(vad, 0.3, 4); // 80ms: start fires, still < minSpeech
  evs = feed(vad, 0.002, 40, evs);
  assert.deepEqual(types(evs), ["speech-start", "speech-end:noise"]);
});

test("bursts shorter than startMs emit nothing", () => {
  const vad = calibrated();
  assert.deepEqual(types([...feed(vad, 0.3, 3), ...feed(vad, 0.002, 30)]), []);
});

test("15s cap emits limit then seamlessly starts a new segment", () => {
  const vad = calibrated({ maxSegmentMs: 1000 });
  const evs = feed(vad, 0.3, 60);
  const t = types(evs);
  assert.deepEqual(t.slice(0, 3), ["speech-start", "speech-end:limit", "speech-start"]);
  const restart = evs.filter((e) => e.type === "speech-start")[1];
  assert.ok(restart.preRoll.length <= SR * 0.1);
});

test("level events carry rms and keep flowing (input never paused)", () => {
  const vad = calibrated();
  const lv = vad.processFrame(frame(0.5)).find((e) => e.type === "level");
  assert.ok(Math.abs(lv.rms - 0.5) < 1e-6);
});

test("hysteresis: mid-level wobble between thresholds keeps speech open", () => {
  const vad = calibrated();
  feed(vad, 0.3, 10);
  const evs = feed(vad, 0.02, 40); // above exit, below enter
  assert.deepEqual(types(evs), []);
});

test("resampler 48k->16k is streaming: chunk boundaries do not drop samples", () => {
  const whole = createResampler(48000, 16000);
  const input = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 50));
  const a = whole.process(input);
  const split = createResampler(48000, 16000);
  const b1 = split.process(input.subarray(0, 1001));
  const b2 = split.process(input.subarray(1001));
  assert.equal(b1.length + b2.length, a.length);
  const joined = new Int16Array(a.length);
  joined.set(b1, 0); joined.set(b2, b1.length);
  assert.deepEqual(Array.from(joined), Array.from(a));
  assert.ok(Math.abs(a.length - 1600) <= 1);
  assert.ok(a instanceof Int16Array);
});

test("floatToInt16 clamps and scales", () => {
  assert.deepEqual(Array.from(floatToInt16(Float32Array.of(0, 1, -1, 2, -2, 0.5))), [0, 32767, -32768, 32767, -32768, 16384]);
});

test("level events flag whether the frame is voiced (enter threshold idle, exit threshold in speech)", () => {
  const vad = calibrated();
  const lv = (amp) => vad.processFrame(frame(amp)).find((e) => e.type === "level");
  assert.equal(lv(0.002).voiced, false);
  assert.equal(lv(0.3).voiced, true);
  feed(vad, 0.3, 4);
  assert.equal(lv(0.02).voiced, true, "above exit threshold while speaking");
  assert.equal(lv(0.001).voiced, false);
});

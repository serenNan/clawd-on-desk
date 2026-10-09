"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSherpaStt, normalizeSherpaText } = require("../src/voice-stt-sherpa");

// Fake engine: each accepted chunk advances a script of cumulative texts.
function fakeEngine(script, { finalText } = {}) {
  const streams = [];
  return {
    streams,
    createStream() {
      const s = { n: 0, chunks: 0, pending: 0, finished: false, released: false, tail: 0 };
      streams.push(s);
      return s;
    },
    accept(s, f32) { s.chunks += 1; s.pending += 1; s.tail += f32.every((v) => v === 0) ? 1 : 0; },
    ready(s) { return s.pending > 0; },
    decode(s) { s.pending -= 1; s.n += 1; },
    text(s) { return s.finished && finalText !== undefined ? finalText : (script[Math.min(s.n, script.length) - 1] || ""); },
    finish(s) { s.finished = true; s.pending += 1; },
    release(s) { s.released = true; },
  };
}

const pcm = (n = 640) => Buffer.alloc(n);
const collect = () => {
  const ev = { partials: [], finals: [], errors: [], warnings: [] };
  return { ev, cb: {
    onPartial: (t) => ev.partials.push(t), onFinal: (t) => ev.finals.push(t),
    onError: (e) => ev.errors.push(e), onWarning: (w) => ev.warnings.push(w),
  } };
};

test("normalizeSherpaText strips spaces between CJK and keeps latin word gaps", () => {
  assert.equal(normalizeSherpaText("你好， 今天天气怎么样"), "你好，今天天气怎么样");
  assert.equal(normalizeSherpaText(" 我 喜欢 hello  world 啊 "), "我喜欢hello world啊");
  assert.equal(normalizeSherpaText(""), "");
  assert.equal(normalizeSherpaText(null), "");
});

test("emits a partial only when the text changes", () => {
  const engine = fakeEngine(["你", "你", "你好"]);
  const { ev, cb } = collect();
  const s = createSherpaStt({ engine }).begin(cb);
  s.writeAudio(pcm()); s.writeAudio(pcm()); s.writeAudio(pcm());
  assert.deepEqual(ev.partials, ["你", "你好"]);
});

test("finish pads the tail, decodes and emits exactly one final", () => {
  const engine = fakeEngine(["你好"], { finalText: " 你好， 世界" });
  const { ev, cb } = collect();
  const s = createSherpaStt({ engine, tailPaddingMs: 300 }).begin(cb);
  s.writeAudio(pcm());
  s.finish();
  s.finish(); // duplicate finish must not duplicate the final
  assert.deepEqual(ev.finals, ["你好，世界"]);
  assert.ok(engine.streams[0].tail >= 1, "tail padding chunk was fed");
  assert.equal(engine.streams[0].released, true);
});

test("final is emitted once even when text equals the last partial", () => {
  const engine = fakeEngine(["你好"]);
  const { ev, cb } = collect();
  const s = createSherpaStt({ engine }).begin(cb);
  s.writeAudio(pcm());
  s.finish();
  assert.deepEqual(ev.partials, ["你好"]);
  assert.deepEqual(ev.finals, ["你好"]);
});

test("cancel drops everything: no later partial, final or error", () => {
  const engine = fakeEngine(["你", "你好"]);
  const { ev, cb } = collect();
  const s = createSherpaStt({ engine }).begin(cb);
  s.writeAudio(pcm());
  s.cancel();
  s.writeAudio(pcm());
  s.finish();
  assert.deepEqual(ev.partials, ["你"]);
  assert.deepEqual(ev.finals, []);
  assert.equal(engine.streams[0].released, true);
});

test("sessions are isolated: audio for one never reaches another's callbacks", () => {
  const engine = fakeEngine(["甲", "甲乙"]);
  const stt = createSherpaStt({ engine });
  const a = collect(); const b = collect();
  const sa = stt.begin(a.cb); const sb = stt.begin(b.cb);
  sa.writeAudio(pcm());
  sa.cancel();
  sb.writeAudio(pcm());
  sb.finish();
  assert.deepEqual(a.ev.finals, []);
  assert.equal(b.ev.finals.length, 1);
  assert.equal(engine.streams.length, 2);
});

test("engine failure surfaces as stt_sherpa_failed once, then goes quiet", () => {
  const engine = fakeEngine([]);
  engine.decode = () => { throw new Error("boom"); };
  const { ev, cb } = collect();
  const s = createSherpaStt({ engine }).begin(cb);
  s.writeAudio(pcm()); s.writeAudio(pcm()); s.finish();
  assert.equal(ev.errors.length, 1);
  assert.equal(ev.errors[0].code, "stt_sherpa_failed");
  assert.deepEqual(ev.finals, []);
});

test("input beyond maxSegmentMs is dropped with a one-time warning", () => {
  const engine = fakeEngine(["a"]);
  const { ev, cb } = collect();
  const s = createSherpaStt({ engine, maxSegmentMs: 100 }).begin(cb);
  for (let i = 0; i < 10; i++) s.writeAudio(pcm(640)); // 20 ms each
  assert.deepEqual(ev.warnings, [{ code: "segment_truncated" }]);
  assert.equal(engine.streams[0].chunks, 5);
});

test("debug log records timings only, never text", () => {
  const lines = [];
  const engine = fakeEngine(["机密内容"]);
  const { cb } = collect();
  const s = createSherpaStt({ engine, log: (e, f) => lines.push([e, f]) }).begin(cb);
  s.writeAudio(pcm()); s.finish();
  const names = lines.map((l) => l[0]);
  assert.ok(names.includes("sherpa_first_partial"));
  assert.ok(names.includes("sherpa_final"));
  assert.ok(!JSON.stringify(lines).includes("机密内容"));
});

test("declares streaming capability and 16k input", () => {
  const stt = createSherpaStt({ engine: fakeEngine([]) });
  assert.equal(stt.id, "sherpa-onnx");
  assert.equal(stt.capabilities.streaming, true);
  assert.equal(stt.capabilities.sampleRate, 16000);
});

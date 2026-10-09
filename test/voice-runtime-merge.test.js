"use strict";

// Session mode: a short pause must not split one sentence into two converse results.
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeHarness, say } = require("./fixtures/voice-runtime-harness");

async function started() {
  const h = makeHarness();
  await h.runtime.start();
  const results = [];
  const next = () => h.runtime.converse({ timeoutS: 600 }).then((r) => { results.push(r); return r; });
  return { h, results, next };
}
const flushMicrotasks = () => new Promise((r) => setImmediate(r));

test("a pause shorter than the merge window does not cut the sentence", async () => {
  const { h, results, next } = await started();
  next();
  say(h, "你这个音调太");
  h.clock.advance(400); // user pauses 400ms (< 600ms window)
  say(h, "太平静了");
  h.clock.advance(599);
  await flushMicrotasks();
  assert.deepEqual(results, []);
  h.clock.advance(1);
  await flushMicrotasks();
  assert.deepEqual(results, [{ interrupted: false, user: "你这个音调太太平静了" }]);
  assert.ok(h.rec.logs.some(([e, f]) => e === "utterance_merged" && f.parts === 2));
});

test("a pause longer than the merge window ends the sentence", async () => {
  const { h, results, next } = await started();
  next();
  say(h, "你这个音调太");
  h.clock.advance(601);
  await flushMicrotasks();
  assert.deepEqual(results, [{ interrupted: false, user: "你这个音调太" }]);
  next();
  say(h, "太平静了");
  h.clock.advance(601);
  await flushMicrotasks();
  assert.deepEqual(results[1], { interrupted: false, user: "太平静了" });
});

test("the second segment is still being recognised when the window would elapse: keep waiting", async () => {
  const { h, results, next } = await started();
  next();
  say(h, "前半句");
  h.clock.advance(300);
  h.runtime.handleSpeechStart(); // speech-start inside the window
  h.runtime.handleAudio(Buffer.alloc(4));
  h.clock.advance(5000);
  await flushMicrotasks();
  assert.deepEqual(results, [], "held while the user keeps talking");
  h.runtime.handleSpeechEnd({ reason: "silence" });
  h.rec.stt[h.rec.stt.length - 1].handlers.onFinal("后半句");
  h.clock.advance(600);
  await flushMicrotasks();
  assert.deepEqual(results, [{ interrupted: false, user: "前半句后半句" }]);
});

test("a noise blip after the first final does not swallow the sentence", async () => {
  const { h, results, next } = await started();
  next();
  say(h, "你好");
  h.runtime.handleSpeechStart();
  h.runtime.handleAudio(Buffer.alloc(4));
  h.runtime.handleSpeechEnd({ reason: "noise" });
  h.clock.advance(600);
  await flushMicrotasks();
  assert.deepEqual(results, [{ interrupted: false, user: "你好" }]);
});

test("the CLI brain (non-session) is not delayed by merging", async () => {
  const h = makeHarness({ brain: "claude-code" });
  await h.runtime.start();
  say(h, "立刻发送");
  assert.equal(h.rec.brainSends.length, 1);
});

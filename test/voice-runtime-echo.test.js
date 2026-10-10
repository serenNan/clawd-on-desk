"use strict";

// Speaker echo recognised as text must not count as the user talking over us.
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeHarness } = require("./fixtures/voice-runtime-harness");

const partials = (h) => h.rec.sent.filter((e) => e.channel === "voice:partial").map((e) => e.payload.text);

async function speaking(h) {
  await h.runtime.start();
  h.runtime.converse({ text: "今天北京天气不错，气温二十度。", timeoutS: 30 });
}
function partialOf(h, text) {
  h.runtime.handleSpeechStart();
  const s = h.rec.stt[h.rec.stt.length - 1];
  s.handlers.onPartial(text);
  return s;
}

test("an echo-like partial while speaking is not forwarded to barge-in", async () => {
  const h = makeHarness();
  await speaking(h);
  partialOf(h, "今天北京天气不错");
  assert.deepEqual(partials(h), []);
  assert.ok(h.rec.logs.some(([e]) => e === "barge_echo_ignored"));
});

test("a real, different partial while speaking is forwarded", async () => {
  const h = makeHarness();
  await speaking(h);
  partialOf(h, "等一下我有问题");
  assert.deepEqual(partials(h), ["等一下我有问题"]);
});

test("an echo-like final does not interrupt the reply", async () => {
  const h = makeHarness();
  await speaking(h);
  const epoch = h.runtime.getState().epoch;
  const s = partialOf(h, "今天北京天气");
  h.runtime.handleSpeechEnd({ reason: "silence" });
  s.handlers.onFinal("今天北京天气不错");
  assert.equal(h.runtime.getState().epoch, epoch);
  assert.equal(h.rec.logs.some(([e]) => e === "session_final"), false);
});

test("the same words are forwarded when nothing is being spoken", async () => {
  const h = makeHarness();
  await h.runtime.start();
  partialOf(h, "今天北京天气不错");
  assert.deepEqual(partials(h), ["今天北京天气不错"]);
});

// Background music with English lyrics gets transcribed; the user talks Chinese.
test("a partial without Chinese characters is not forwarded to barge-in", async () => {
  const h = makeHarness();
  await speaking(h);
  partialOf(h, "No just in time to see");
  assert.deepEqual(partials(h), []);
  assert.ok(h.rec.logs.some(([e]) => e === "non_chinese_ignored"));
});

test("a final without Chinese characters neither interrupts nor reaches the session", async () => {
  const h = makeHarness();
  await speaking(h);
  const epoch = h.runtime.getState().epoch;
  const s = partialOf(h, "You're lonely");
  h.runtime.handleSpeechEnd({ reason: "silence" });
  s.handlers.onFinal("You're lonely drone with a cock.");
  assert.equal(h.runtime.getState().epoch, epoch);
  assert.equal(h.rec.logs.some(([e]) => e === "session_final"), false);
});

test("mixed Chinese with English terms still counts as speech", async () => {
  const h = makeHarness();
  await speaking(h);
  partialOf(h, "帮我打开 GitHub");
  assert.deepEqual(partials(h), ["帮我打开 GitHub"]);
});

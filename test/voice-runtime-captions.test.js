"use strict";

// Captions: the latest sentence, forwarded to the pet window only (never logged, never when off).
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeHarness, say } = require("./fixtures/voice-runtime-harness");

const captions = (h) => h.rec.sent.filter((e) => e.channel === "voice:caption").map((e) => e.payload);

test("user partial and final are captioned; final is marked", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.handleSpeechStart();
  h.rec.stt[0].handlers.onPartial("今天天气");
  assert.deepEqual(captions(h), [{ role: "user", text: "今天天气", final: false }]);
  h.runtime.handleSpeechEnd({ reason: "silence" });
  h.rec.stt[0].handlers.onFinal("今天天气怎么样");
  assert.deepEqual(captions(h).at(-1), { role: "user", text: "今天天气怎么样", final: true });
});

test("the sentence being played is captioned once, at its first PCM", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.converse({ text: "第一句话。第二句话。", timeoutS: 30 });
  const s = h.rec.tts[0];
  s.handlers.onAudio({ pcm: Buffer.alloc(4), sampleRate: 24000, channels: 1 });
  s.handlers.onAudio({ pcm: Buffer.alloc(4), sampleRate: 24000, channels: 1 });
  assert.deepEqual(captions(h), [{ role: "assistant", text: "第一句话。", final: true }]);
});

test("voice.captions=false sends no caption at all", async () => {
  const h = makeHarness({ voice: { captions: false } });
  await h.runtime.start();
  h.runtime.handleSpeechStart();
  h.rec.stt[0].handlers.onPartial("今天天气");
  h.runtime.converse({ text: "你好呀。", timeoutS: 30 });
  h.rec.tts[0].handlers.onAudio({ pcm: Buffer.alloc(4), sampleRate: 24000, channels: 1 });
  assert.deepEqual(captions(h), []);
});

test("echo of our own speech and non-Chinese noise are not captioned", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.converse({ text: "今天北京天气不错，气温二十度。", timeoutS: 30 });
  const before = captions(h).length;
  h.runtime.handleSpeechStart();
  const s = h.rec.stt.at(-1);
  s.handlers.onPartial("今天北京天气不错");
  s.handlers.onPartial("No just in time");
  assert.equal(captions(h).length, before);
});

test("caption text is clipped and never reaches the debug log", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.handleSpeechStart();
  h.rec.stt[0].handlers.onPartial("甲".repeat(500));
  assert.ok(captions(h)[0].text.length <= 160);
  assert.equal(JSON.stringify(h.rec.logs).includes("甲甲甲"), false);
});

test("filler-only partials (呃, 嗯 ...) are not captioned, real words are", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.handleSpeechStart();
  const stt = h.rec.stt[0];
  stt.handlers.onPartial("呃,");
  stt.handlers.onPartial("嗯嗯");
  assert.deepEqual(captions(h), []);
  stt.handlers.onPartial("呃我想问一下");
  assert.equal(captions(h).length, 1);
});

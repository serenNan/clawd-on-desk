"use strict";

// Edge TTS failure falls back to Kokoro automatically (no localFallback setting needed).
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeHarness } = require("./fixtures/voice-runtime-harness");

test("edge failure: the unplayed sentence is re-synthesised by Kokoro, tts_fallback is logged", async () => {
  const h = makeHarness({ ttsId: "edge", fallbackTts: true });
  await h.runtime.start();
  h.runtime.converse({ text: "你好呀。", timeoutS: 5 });
  assert.equal(h.rec.tts.length, 1);
  h.rec.tts[0].handlers.onError({ code: "tts_edge_network", message: "connection failed" });
  assert.equal(h.runtime.getState().active, true, "call survives");
  assert.deepEqual(h.rec.fbTts.map((s) => s.texts[0]), ["你好呀。"]);
  const entry = h.rec.logs.find(([e]) => e === "tts_fallback");
  assert.ok(entry, "tts_fallback logged");
  assert.equal(entry[1].code, "tts_edge_network");
  assert.match(entry[1].from, /edge/);
  assert.equal(entry[1].to, "local-kokoro");
  assert.ok(h.rec.sent.some((e) => e.channel === "voice:notice" && e.payload.code === "fallback-local-tts"));
});

test("without a fallback provider a TTS error still stops the call visibly", async () => {
  const h = makeHarness({ ttsId: "local-kokoro", fallbackTts: false });
  await h.runtime.start();
  h.runtime.converse({ text: "你好呀。", timeoutS: 5 });
  h.rec.tts[0].handlers.onError({ code: "tts_local_unreachable", message: "x" });
  assert.equal(h.runtime.getState().active, false);
  assert.equal(h.runtime.getState().error, "tts_local_unreachable");
});

test("fallback never loops: a failing Kokoro after the switch ends the call", async () => {
  const h = makeHarness({ ttsId: "edge", fallbackTts: true });
  await h.runtime.start();
  h.runtime.converse({ text: "你好呀。", timeoutS: 5 });
  h.rec.tts[0].handlers.onError({ code: "tts_edge_network" });
  h.rec.fbTts[0].handlers.onError({ code: "tts_local_unreachable" });
  assert.equal(h.runtime.getState().active, false);
});

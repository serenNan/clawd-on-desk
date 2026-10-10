"use strict";

// Runtime behaviour when a main-process neural VAD (Silero) is injected:
// renderer streams continuous PCM, main segments it, STT gets partial/final.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createVoiceRuntime } = require("../src/voice-runtime");
const { cloneDefaultVoice } = require("../src/voice-settings");

function makeHarness() {
  const rec = { sent: [], sessions: [], logs: [], brainSends: [], vadChunks: 0 };
  const stt = {
    id: "sherpa-onnx",
    capabilities: { streaming: true, sampleRate: 16000 },
    begin(handlers) {
      const s = { handlers, writes: [], finished: false, cancelled: false,
        writeAudio(b) { this.writes.push(b); }, finish() { this.finished = true; }, cancel() { this.cancelled = true; } };
      rec.sessions.push(s);
      return s;
    },
  };
  // Scripted VAD: one event list per processChunk call.
  const script = [];
  let speaking = false;
  const vad = {
    processChunk() {
      rec.vadChunks += 1;
      const evs = script.shift() || [{ type: "frame", voiced: false }];
      for (const e of evs) { if (e.type === "speech-start") speaking = true; if (e.type === "speech-end") speaking = false; }
      return evs;
    },
    isSpeaking: () => speaking,
    reset() { speaking = false; },
  };
  const tts = { id: "local-kokoro", capabilities: { sampleRate: 24000, channels: 1, format: "s16le" },
    begin: () => ({ writeText() {}, finish() {}, cancel() {} }) };
  const brain = { id: "claude-code", probe: async () => ({ ok: true }), send(req) { rec.brainSends.push(req); }, cancel() {}, reset() {}, dispose() {} };
  const runtime = createVoiceRuntime({
    getVoice: () => ({ ...cloneDefaultVoice(), brain: "claude-code", tts: "local-kokoro", enabled: true }),
    env: {},
    createProviders: () => ({ stt, tts, brain, vad }),
    sendToRenderer: (channel, payload) => rec.sent.push({ channel, payload }),
    log: (event, fields) => rec.logs.push([event, fields]),
  });
  return { runtime, rec, script };
}

const chunk = () => Buffer.alloc(640);
const sentTo = (h, ch) => h.rec.sent.filter((e) => e.channel === ch).map((e) => e.payload);

test("voice:start tells the renderer to stream raw PCM for the main-process VAD", async () => {
  const h = makeHarness();
  await h.runtime.start();
  assert.equal(sentTo(h, "voice:start")[0].vad, "main");
});

test("VAD speech-start opens one STT session with pre-roll, relays vad events", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.script.push([{ type: "frame", voiced: true }, { type: "speech-start", preRoll: Buffer.alloc(1920) }]);
  h.script.push([{ type: "frame", voiced: true }, { type: "audio", pcm: chunk() }]);
  h.runtime.handleAudio(chunk());
  h.runtime.handleAudio(chunk());
  assert.equal(h.rec.sessions.length, 1);
  assert.equal(h.rec.sessions[0].writes[0].length, 1920);
  assert.equal(h.rec.sessions[0].writes.length, 2);
  const vadMsgs = sentTo(h, "voice:vad");
  assert.deepEqual(vadMsgs.map((m) => m.type), ["speech-start", "frame"]);
  assert.equal(vadMsgs[1].voiced, true);
});

test("partials reach the renderer for barge-in, and nothing logs their text", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.script.push([{ type: "speech-start", preRoll: chunk() }]);
  h.runtime.handleAudio(chunk());
  h.rec.sessions[0].handlers.onPartial("我想问一下机密文本");
  assert.deepEqual(sentTo(h, "voice:partial"), [{ text: "我想问一下机密文本" }]);
  assert.ok(!JSON.stringify(h.rec.logs).includes("机密文本"));
  assert.ok(h.rec.logs.some(([e]) => e === "stt_partial_first"));
});

test("speech-end finishes STT; the final is submitted to the brain exactly once", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.script.push([{ type: "speech-start", preRoll: chunk() }]);
  h.script.push([{ type: "speech-end", reason: "silence", durationMs: 800 }]);
  h.runtime.handleAudio(chunk());
  h.runtime.handleAudio(chunk());
  const s = h.rec.sessions[0];
  assert.equal(s.finished, true);
  s.handlers.onFinal("你好");
  s.handlers.onFinal("你好"); // duplicate final from the provider
  assert.equal(h.rec.brainSends.length, 1);
  assert.ok(h.rec.logs.some(([e]) => e === "vad_end"));
});

test("noise end cancels the STT session without any final", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.script.push([{ type: "speech-start", preRoll: chunk() }]);
  h.script.push([{ type: "speech-end", reason: "noise", durationMs: 100 }]);
  h.runtime.handleAudio(chunk());
  h.runtime.handleAudio(chunk());
  assert.equal(h.rec.sessions[0].cancelled, true);
  h.rec.sessions[0].handlers.onFinal("幽灵");
  assert.equal(h.rec.brainSends.length, 0);
});

test("epoch isolation: results from a session cancelled by stop never surface", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.script.push([{ type: "speech-start", preRoll: chunk() }]);
  h.runtime.handleAudio(chunk());
  const s = h.rec.sessions[0];
  h.runtime.stop("user");
  const before = sentTo(h, "voice:partial").length;
  s.handlers.onPartial("迟到");
  s.handlers.onFinal("迟到");
  assert.equal(sentTo(h, "voice:partial").length, before);
  assert.equal(h.rec.brainSends.length, 0);
  h.runtime.handleAudio(chunk()); // audio after stop is ignored
  assert.equal(h.rec.vadChunks, 1);
});

test("renderer-side speech events are ignored while the main VAD owns segmentation", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.handleSpeechStart();
  assert.equal(h.rec.sessions.length, 0);
});

test("vad timing is logged as aggregate perf, never per-text", async () => {
  const h = makeHarness();
  await h.runtime.start();
  for (let i = 0; i < 250; i++) h.runtime.handleAudio(chunk());
  const perf = h.rec.logs.find(([e]) => e === "vad_perf");
  assert.ok(perf);
  assert.equal(perf[1].chunks, 250);
  assert.ok(Number.isFinite(perf[1].maxUs));
});

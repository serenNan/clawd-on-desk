"use strict";

// Capture source selection (bundled helper vs renderer getUserMedia) and what the
// runtime does with helper PCM: main-process VAD/STT, mute/wake phrase, mic watch.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createVoiceRuntime } = require("../src/voice-runtime");
const { cloneDefaultVoice } = require("../src/voice-settings");

function make({ helper = true, vad = true } = {}) {
  const rec = { sent: [], sessions: [], logs: [], brainSends: [], vadChunks: 0, sources: [], silent: [] };
  const flags = { helper };
  let clock = 0;
  const stt = {
    id: "sherpa-onnx", capabilities: { streaming: true, sampleRate: 16000 },
    begin(handlers) {
      const s = { handlers, writes: [], writeAudio(b) { this.writes.push(b); }, finish() {}, cancel() {} };
      rec.sessions.push(s);
      return s;
    },
  };
  const script = [];
  const vadObj = {
    processChunk() { rec.vadChunks += 1; return script.shift() || [{ type: "frame", voiced: false }]; },
    isSpeaking: () => false, reset() {},
  };
  const tts = { id: "local-kokoro", capabilities: { sampleRate: 24000, channels: 1, format: "s16le" }, begin: () => ({ writeText() {}, finish() {}, cancel() {} }) };
  const brain = { id: "claude-code", probe: async () => ({ ok: true }), send(req) { rec.brainSends.push(req); }, cancel() {}, reset() {}, dispose() {} };
  const runtime = createVoiceRuntime({
    getVoice: () => ({ ...cloneDefaultVoice(), brain: "claude-code", tts: "local-kokoro", enabled: true }),
    env: {},
    createProviders: () => ({ stt, tts, brain, vad: vad ? vadObj : null }),
    sendToRenderer: (channel, payload) => rec.sent.push({ channel, payload }),
    log: (event, fields) => rec.logs.push([event, fields]),
    canHelperCapture: () => flags.helper,
    onCaptureSource: (s) => rec.sources.push(s),
    onHelperSilent: (info) => rec.silent.push(info),
    now: () => clock,
  });
  return { runtime, rec, script, flags, advance: (ms) => { clock += ms; } };
}
const pcm = () => Buffer.alloc(640, 1);
const zeros = () => Buffer.alloc(640);
const sentTo = (h, ch) => h.rec.sent.filter((e) => e.channel === ch).map((e) => e.payload);
const speak = (h, text) => {
  h.script.push([{ type: "speech-start", preRoll: Buffer.alloc(64) }]);
  h.script.push([{ type: "speech-end", reason: "silence" }]);
  h.runtime.handleAudio(pcm(), "helper");
  h.runtime.handleAudio(pcm(), "helper");
  h.rec.sessions[h.rec.sessions.length - 1].handlers.onFinal(text);
};

test("switch on + main VAD -> helper capture announced to the renderer and the host", async () => {
  const h = make();
  await h.runtime.start();
  assert.equal(sentTo(h, "voice:start")[0].capture, "helper");
  assert.deepEqual(h.rec.sources, ["helper"]);
  assert.ok(h.rec.logs.some(([e, f]) => e === "capture_source" && f.source === "helper"));
});

test("switch off -> renderer capture, helper never requested", async () => {
  const h = make({ helper: false });
  await h.runtime.start();
  assert.equal(sentTo(h, "voice:start")[0].capture, "renderer");
  assert.deepEqual(h.rec.sources, ["renderer"]);
  assert.ok(h.rec.logs.some(([e, f]) => e === "capture_source" && f.source === "renderer"));
});

test("no main-process VAD (non-sherpa STT) -> renderer capture even with the switch on", async () => {
  const h = make({ vad: false });
  await h.runtime.start();
  assert.equal(sentTo(h, "voice:start")[0].capture, "renderer");
});

test("helper PCM reaches the main VAD; renderer PCM is ignored while the helper records", async () => {
  const h = make();
  await h.runtime.start();
  h.runtime.handleAudio(pcm(), "helper");
  assert.equal(h.rec.vadChunks, 1);
  h.runtime.handleAudio(pcm());
  h.runtime.handleAudio(pcm(), "renderer");
  assert.equal(h.rec.vadChunks, 1);
});

test("helper PCM starts an STT session and a final goes to the brain", async () => {
  const h = make();
  await h.runtime.start();
  speak(h, "今天天气怎么样");
  assert.equal(h.rec.sessions.length, 1);
  assert.equal(h.rec.brainSends.length, 1);
});

test("muted: helper PCM still feeds the wake-phrase STT but never becomes user input", async () => {
  const h = make();
  await h.runtime.start();
  h.runtime.setPaused(true);
  const sentBefore = sentTo(h, "voice:caption").length;
  speak(h, "帮我看看这个文件");
  assert.equal(h.rec.sessions.length, 1, "audio was recognised locally");
  assert.equal(h.rec.brainSends.length, 0, "no user turn while muted");
  assert.equal(sentTo(h, "voice:caption").length, sentBefore);
  speak(h, "好了恢复语音吧");
  assert.equal(h.runtime.getState().paused, false);
  assert.equal(h.rec.brainSends.length, 0, "the wake phrase itself is not a turn");
});

test("all-zero helper PCM asks the host to restart the helper, not the renderer", async () => {
  const h = make();
  await h.runtime.start();
  for (let i = 0; i < 200; i++) { h.runtime.handleAudio(zeros(), "helper"); h.advance(20); }
  assert.equal(h.rec.silent.length, 1);
  assert.equal(sentTo(h, "voice:mic-restart").length, 0);
});

test("the silent-mic watch allows a 4th request so the host can fall back", async () => {
  const h = make();
  await h.runtime.start();
  for (let i = 0; i < 1000; i++) { h.runtime.handleAudio(zeros(), "helper"); h.advance(20); }
  assert.equal(h.rec.silent.length, 4);
});

test("renderer capture keeps the old behaviour: zero PCM -> voice:mic-restart", async () => {
  const h = make({ helper: false });
  await h.runtime.start();
  for (let i = 0; i < 200; i++) { h.runtime.handleAudio(zeros()); h.advance(20); }
  assert.equal(sentTo(h, "voice:mic-restart").length, 1);
  assert.equal(h.rec.silent.length, 0);
});

test("switching the setting mid-call re-picks the source without ending the call", async () => {
  const h = make();
  await h.runtime.start();
  h.flags.helper = false;
  h.runtime.refreshCapture();
  assert.deepEqual(sentTo(h, "voice:capture"), [{ source: "renderer" }]);
  assert.deepEqual(h.rec.sources, ["helper", "renderer"]);
  assert.equal(h.runtime.getState().active, true);
  h.runtime.handleAudio(pcm(), "helper");
  assert.equal(h.rec.vadChunks, 0, "helper PCM ignored after the switch");
  h.runtime.handleAudio(pcm());
  assert.equal(h.rec.vadChunks, 1);
  h.runtime.refreshCapture(); // unchanged: nothing more
  assert.equal(sentTo(h, "voice:capture").length, 1);
  h.flags.helper = true;
  h.runtime.refreshCapture();
  assert.deepEqual(sentTo(h, "voice:capture").map((p) => p.source), ["renderer", "helper"]);
});

test("helper failure forces renderer capture for the rest of the call, and resets on the next call", async () => {
  const h = make();
  await h.runtime.start();
  h.runtime.captureFailed("exit");
  assert.deepEqual(sentTo(h, "voice:capture"), [{ source: "renderer" }]);
  h.runtime.refreshCapture();
  assert.equal(sentTo(h, "voice:capture").length, 1, "stays on the renderer");
  h.runtime.stop("user");
  assert.equal(h.rec.sources[h.rec.sources.length - 1], null, "call end releases the helper");
  await h.runtime.start();
  assert.equal(sentTo(h, "voice:start")[1].capture, "helper");
});

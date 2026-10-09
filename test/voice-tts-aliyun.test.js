"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createFakeWebSocket } = require("./fixtures/fake-ws");
const { createAliyunTts } = require("../src/voice-tts-aliyun");

function setup(extra = {}) {
  const { FakeWebSocket, instances } = createFakeWebSocket();
  const tts = createAliyunTts({ apiKey: "k-test", WebSocketImpl: FakeWebSocket, ...extra });
  const events = [];
  const handlers = {
    onAudio: (a) => events.push(["audio", [...a.pcm], a.sampleRate, a.channels]),
    onError: (e) => events.push(["error", e.code]),
    onEnd: () => events.push(["end"]),
  };
  return { tts, instances, events, handlers };
}
const started = { header: { event: "task-started" } };
const finished = { header: { event: "task-finished" } };

test("no key: unusable and never opens a socket", () => {
  const { FakeWebSocket, instances } = createFakeWebSocket();
  assert.throws(() => createAliyunTts({ apiKey: "", WebSocketImpl: FakeWebSocket }), /key/i);
  assert.equal(instances.length, 0);
});

test("capabilities default to v3-flash / 22050 mono s16le", () => {
  const { tts } = setup();
  assert.equal(tts.id, "aliyun-cosyvoice-v3-flash");
  assert.deepEqual(tts.capabilities, { streaming: true, sampleRate: 22050, channels: 1, format: "s16le" });
});

test("run-task carries model, system voice and pcm format", () => {
  const { tts, instances, handlers } = setup();
  tts.begin(handlers);
  const ws = instances[0];
  assert.equal(ws.opts.headers.Authorization, "bearer k-test");
  ws.open();
  const run = ws.jsonSent()[0];
  assert.equal(run.header.action, "run-task");
  assert.equal(run.payload.model, "cosyvoice-v3-flash");
  assert.equal(run.payload.parameters.voice, "longanyang");
  assert.equal(run.payload.parameters.format, "pcm");
  assert.equal(run.payload.parameters.sample_rate, 22050);
});

test("text before task-started is buffered; finish sent after text", () => {
  const { tts, instances, handlers } = setup();
  const s = tts.begin(handlers);
  const ws = instances[0];
  ws.open();
  s.writeText("你好，");
  s.writeText("世界。");
  s.finish();
  assert.equal(ws.jsonSent().length, 1, "only run-task before started");
  ws.serverJson(started);
  const acts = ws.jsonSent().map((j) => j.header.action);
  assert.deepEqual(acts, ["run-task", "continue-task", "continue-task", "finish-task"]);
  assert.equal(ws.jsonSent()[1].payload.input.text, "你好，");
  s.writeText("ignored after finish");
  assert.equal(ws.jsonSent().length, 4);
});

test("binary frames are PCM, half samples are carried over", () => {
  const { tts, instances, events, handlers } = setup();
  tts.begin(handlers);
  const ws = instances[0];
  ws.open(); ws.serverJson(started);
  ws.serverBinary([1, 2, 3]);
  ws.serverBinary([4, 5, 6, 7]);
  assert.deepEqual(events, [["audio", [1, 2], 22050, 1], ["audio", [3, 4, 5, 6], 22050, 1]]);
});

test("task-finished -> onEnd once and socket closed", () => {
  const { tts, instances, events, handlers } = setup();
  const s = tts.begin(handlers);
  const ws = instances[0];
  ws.open(); ws.serverJson(started); s.finish(); ws.serverJson(finished); ws.serverJson(finished);
  assert.deepEqual(events, [["end"]]);
  assert.equal(ws.closed, true);
});

test("task-failed maps to auth / voice / generic codes", () => {
  const cases = [["InvalidApiKey", "tts_auth"], ["InvalidParameter.Voice", "tts_voice"], ["Whatever", "tts_failed"]];
  for (const [code, expected] of cases) {
    const c = setup();
    c.tts.begin(c.handlers);
    c.instances[0].serverJson({ header: { event: "task-failed", error_code: code, error_message: "m" } });
    assert.deepEqual(c.events, [["error", expected]], code);
  }
});

test("disconnect / socket error -> tts_network once; 401 -> tts_auth", () => {
  let c = setup();
  c.tts.begin(c.handlers); c.instances[0].open(); c.instances[0].drop();
  assert.deepEqual(c.events, [["error", "tts_network"]]);
  c = setup();
  c.tts.begin(c.handlers); c.instances[0].emit("error", new Error("sk"));
  assert.deepEqual(c.events, [["error", "tts_network"]]);
  c = setup();
  c.tts.begin(c.handlers); c.instances[0].emit("unexpected-response", {}, { statusCode: 403 });
  assert.deepEqual(c.events, [["error", "tts_auth"]]);
});

test("cancel closes immediately and silences everything", () => {
  const { tts, instances, events, handlers } = setup();
  const s = tts.begin(handlers);
  const ws = instances[0];
  ws.open(); ws.serverJson(started);
  s.cancel();
  assert.equal(ws.closed, true);
  ws.serverBinary([1, 2]); ws.serverJson(finished); ws.emit("error", new Error("x"));
  s.writeText("x"); s.finish();
  assert.deepEqual(events, []);
});

test("v3.5-flash requires voiceId and never opens a socket without it", () => {
  const c = setup({ model: "cosyvoice-v3.5-flash" });
  const s = c.tts.begin(c.handlers);
  assert.equal(c.instances.length, 0);
  assert.deepEqual(c.events, [["error", "tts_voice"]]);
  s.writeText("x"); s.finish(); s.cancel();
  const ok = setup({ model: "cosyvoice-v3.5-flash", voiceId: "cosyvoice-v3.5-flash-abc" });
  ok.tts.begin(ok.handlers); ok.instances[0].open();
  assert.equal(ok.instances[0].jsonSent()[0].payload.parameters.voice, "cosyvoice-v3.5-flash-abc");
  assert.equal(ok.tts.id, "aliyun-cosyvoice-v3.5-flash");
});

test("only the Beijing region is accepted", () => {
  const { FakeWebSocket } = createFakeWebSocket();
  assert.throws(() => createAliyunTts({ apiKey: "k", WebSocketImpl: FakeWebSocket, region: "singapore" }), /region/i);
});

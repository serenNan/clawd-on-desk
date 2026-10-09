"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createFakeWebSocket } = require("./fixtures/fake-ws");
const { createAliyunStt } = require("../src/voice-stt-aliyun");

function setup(extra = {}) {
  const { FakeWebSocket, instances } = createFakeWebSocket();
  const timers = [];
  const stt = createAliyunStt({
    apiKey: "k-test", WebSocketImpl: FakeWebSocket,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    ...extra,
  });
  const events = [];
  const handlers = {
    onPartial: (t) => events.push(["partial", t]),
    onFinal: (t) => events.push(["final", t]),
    onError: (e) => events.push(["error", e.code]),
  };
  return { stt, instances, timers, events, handlers };
}
const result = (text, end) => ({ header: { event: "result-generated" }, payload: { output: { sentence: { text, sentence_end: end } } } });
const started = { header: { event: "task-started" } };
const finished = { header: { event: "task-finished" } };

test("no key: unusable and never opens a socket", () => {
  const { FakeWebSocket, instances } = createFakeWebSocket();
  assert.throws(() => createAliyunStt({ apiKey: "", WebSocketImpl: FakeWebSocket }), /key/i);
  assert.equal(instances.length, 0);
});

test("capabilities and id", () => {
  const { stt } = setup();
  assert.equal(stt.id, "aliyun-paraformer");
  assert.deepEqual(stt.capabilities, { streaming: true, endpointing: true, sampleRate: 16000, maxSegmentMs: 15000 });
});

test("begin connects with bearer header and sends run-task on open", () => {
  const { stt, instances, handlers } = setup();
  assert.equal(instances.length, 0, "no socket until begin");
  stt.begin(handlers);
  const ws = instances[0];
  assert.match(ws.url, /^wss:\/\/dashscope\.aliyuncs\.com\/api-ws\/v1\/inference/);
  assert.equal(ws.opts.headers.Authorization, "bearer k-test");
  ws.open();
  const [run] = ws.jsonSent();
  assert.equal(run.header.action, "run-task");
  assert.equal(run.payload.model, "paraformer-realtime-v2");
  assert.equal(run.payload.parameters.format, "pcm");
  assert.equal(run.payload.parameters.sample_rate, 16000);
});

test("audio written before task-started is buffered then flushed in order", () => {
  const { stt, instances, handlers } = setup();
  const s = stt.begin(handlers);
  const ws = instances[0];
  ws.open();
  s.writeAudio(Buffer.from([1, 2]));
  s.writeAudio(Buffer.from([3, 4]));
  assert.equal(ws.binarySent().length, 0);
  ws.serverJson(started);
  assert.deepEqual(ws.binarySent().map((b) => [...b]), [[1, 2], [3, 4]]);
  s.writeAudio(Buffer.from([5, 6]));
  assert.equal(ws.binarySent().length, 3);
});

test("pre-start buffer is capped at 15s of audio", () => {
  const { stt, instances, handlers } = setup();
  const s = stt.begin(handlers);
  const ws = instances[0];
  ws.open();
  for (let i = 0; i < 40; i++) s.writeAudio(Buffer.alloc(16000)); // 40 * 0.5s
  ws.serverJson(started);
  const total = ws.binarySent().reduce((n, b) => n + b.length, 0);
  assert.ok(total <= 15 * 16000 * 2, `flushed ${total}`);
  assert.ok(total >= 14 * 16000 * 2);
});

test("partials go to onPartial; final fires once after finish with accumulated text", () => {
  const { stt, instances, events, handlers } = setup();
  const s = stt.begin(handlers);
  const ws = instances[0];
  ws.open(); ws.serverJson(started);
  ws.serverJson(result("你好", false));
  ws.serverJson(result("你好世界", true));
  ws.serverJson(result("再", false));
  ws.serverJson(result("再见", true));
  assert.deepEqual(events.map((e) => e[0]), ["partial", "partial", "partial", "partial"]);
  s.finish();
  assert.equal(ws.jsonSent().at(-1).header.action, "finish-task");
  ws.serverJson(finished);
  assert.deepEqual(events.at(-1), ["final", "你好世界再见"]);
  ws.serverJson(finished);
  assert.equal(events.filter((e) => e[0] === "final").length, 1);
  assert.equal(ws.closed, true);
});

test("empty speech yields an empty final", () => {
  const { stt, instances, events, handlers } = setup();
  const s = stt.begin(handlers);
  const ws = instances[0];
  ws.open(); ws.serverJson(started); s.finish(); ws.serverJson(finished);
  assert.deepEqual(events, [["final", ""]]);
});

test("finish before started still ends the task once started", () => {
  const { stt, instances, events, handlers } = setup();
  const s = stt.begin(handlers);
  const ws = instances[0];
  ws.open(); s.writeAudio(Buffer.from([1, 2])); s.finish();
  assert.equal(ws.jsonSent().filter((j) => j.header.action === "finish-task").length, 0);
  ws.serverJson(started);
  assert.equal(ws.binarySent().length, 1);
  assert.equal(ws.jsonSent().at(-1).header.action, "finish-task");
  ws.serverJson(result("嗯", true)); ws.serverJson(finished);
  assert.deepEqual(events.at(-1), ["final", "嗯"]);
});

test("final timeout after finish -> stt_timeout once, socket closed", () => {
  const { stt, instances, timers, events, handlers } = setup();
  const s = stt.begin(handlers);
  const ws = instances[0];
  ws.open(); ws.serverJson(started); s.finish();
  const t = timers.find((x) => x.ms === 3000 && !x.cleared);
  assert.ok(t);
  t.fn();
  assert.deepEqual(events, [["error", "stt_timeout"]]);
  assert.equal(ws.closed, true);
  ws.serverJson(finished);
  assert.equal(events.length, 1);
});

test("disconnect before final -> stt_network once", () => {
  const { stt, instances, events, handlers } = setup();
  stt.begin(handlers);
  const ws = instances[0];
  ws.open(); ws.serverJson(started); ws.drop();
  assert.deepEqual(events, [["error", "stt_network"]]);
});

test("socket error event -> stt_network; auth failure -> stt_auth", () => {
  let c = setup();
  c.stt.begin(c.handlers);
  c.instances[0].emit("error", new Error("boom sk-secret"));
  assert.deepEqual(c.events, [["error", "stt_network"]]);
  c = setup();
  c.stt.begin(c.handlers);
  c.instances[0].emit("unexpected-response", {}, { statusCode: 401 });
  assert.deepEqual(c.events, [["error", "stt_auth"]]);
});

test("task-failed -> stt_failed (auth codes -> stt_auth), no secret/text in message", () => {
  let c = setup();
  c.stt.begin(c.handlers);
  c.instances[0].open();
  c.instances[0].serverJson({ header: { event: "task-failed", error_code: "InvalidApiKey", error_message: "bad" } });
  assert.deepEqual(c.events, [["error", "stt_auth"]]);
  c = setup();
  c.stt.begin(c.handlers);
  c.instances[0].serverJson({ header: { event: "task-failed", error_code: "X", error_message: "oops" } });
  assert.deepEqual(c.events, [["error", "stt_failed"]]);
});

test("cancel closes socket and silences all callbacks", () => {
  const { stt, instances, events, handlers } = setup();
  const s = stt.begin(handlers);
  const ws = instances[0];
  ws.open(); ws.serverJson(started);
  s.cancel();
  assert.equal(ws.closed, true);
  ws.serverJson(result("late", false));
  ws.serverJson(finished);
  ws.emit("error", new Error("x"));
  s.writeAudio(Buffer.from([1, 2]));
  s.finish();
  assert.deepEqual(events, []);
  assert.equal(ws.binarySent().length, 0);
});

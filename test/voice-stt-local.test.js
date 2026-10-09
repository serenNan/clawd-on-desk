"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createLocalStt } = require("../src/voice-stt-local");

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const collect = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const pcm = (n) => Buffer.alloc(n * 2, 1);
const waitFor = (fn, ms = 1000) => new Promise((res, rej) => {
  const t0 = Date.now();
  (function loop() { if (fn()) return res(); if (Date.now() - t0 > ms) return rej(new Error("wait timeout")); setTimeout(loop, 5); })();
});

test("capabilities 声明非流式", () => {
  const stt = createLocalStt();
  assert.equal(stt.id, "local-whisper");
  assert.deepEqual(stt.capabilities, { streaming: false, endpointing: false, sampleRate: 16000, maxSegmentMs: 15000 });
});

test("finish 时 POST multipart WAV(zh)，onFinal 一次且不出 partial", async () => {
  let seen;
  const { server, base } = await serve(async (req, res) => {
    seen = { url: req.url, ct: req.headers["content-type"], body: await collect(req) };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text: " 你好,桌宠 " }));
  });
  const ev = [];
  try {
    const s = createLocalStt({ baseUrl: base }).begin({
      onPartial: (t) => ev.push(["partial", t]), onFinal: (t) => ev.push(["final", t]), onError: (e) => ev.push(["err", e.code]),
    });
    s.writeAudio(pcm(1600)); s.writeAudio(pcm(1600));
    s.finish(); s.finish();
    await waitFor(() => ev.length > 0);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(ev, [["final", "你好,桌宠"]]);
    assert.equal(seen.url, "/v1/audio/transcriptions");
    assert.match(seen.ct, /^multipart\/form-data; boundary=/);
    const text = seen.body.toString("latin1");
    assert.match(text, /name="language"\r\n\r\nzh\r\n/);
    assert.match(text, /name="response_format"\r\n\r\njson\r\n/);
    assert.match(text, /name="file"; filename="audio\.wav"/);
    const riff = seen.body.indexOf("RIFF");
    assert.ok(riff > 0);
    const wav = seen.body.subarray(riff);
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 6400);
  } finally { server.close(); }
});

test("超过 15s 的 PCM 被截断并 onWarning", async () => {
  let bodyLen = 0;
  const { server, base } = await serve(async (req, res) => { bodyLen = (await collect(req)).length; res.end('{"text":""}'); });
  const warns = []; const fin = [];
  try {
    const s = createLocalStt({ baseUrl: base }).begin({ onFinal: (t) => fin.push(t), onError() {}, onWarning: (w) => warns.push(w.code) });
    s.writeAudio(pcm(16000 * 10)); s.writeAudio(pcm(16000 * 10));
    s.finish();
    await waitFor(() => fin.length);
    assert.deepEqual(warns, ["segment_truncated"]);
    assert.deepEqual(fin, [""]);
    assert.ok(bodyLen > 16000 * 15 * 2 && bodyLen < 16000 * 15 * 2 + 1000);
  } finally { server.close(); }
});

test("HTTP 非 200 -> stt_local_http；连接失败 -> stt_local_unreachable", async () => {
  const { server, base } = await serve((req, res) => { res.statusCode = 500; res.end("x"); });
  const errs = [];
  try {
    const s = createLocalStt({ baseUrl: base }).begin({ onFinal() { errs.push("final"); }, onError: (e) => errs.push(e.code) });
    s.writeAudio(pcm(100)); s.finish();
    await waitFor(() => errs.length);
    assert.deepEqual(errs, ["stt_local_http"]);
  } finally { server.close(); }
  const errs2 = [];
  const s2 = createLocalStt({ baseUrl: base }).begin({ onFinal() {}, onError: (e) => errs2.push(e.code) });
  s2.writeAudio(pcm(100)); s2.finish();
  await waitFor(() => errs2.length);
  assert.deepEqual(errs2, ["stt_local_unreachable"]);
});

test("超时 -> stt_timeout", async () => {
  const { server, base } = await serve(() => {});
  const errs = [];
  try {
    const s = createLocalStt({ baseUrl: base, timeoutMs: 40 }).begin({ onFinal() {}, onError: (e) => errs.push(e.code) });
    s.writeAudio(pcm(100)); s.finish();
    await waitFor(() => errs.length);
    assert.deepEqual(errs, ["stt_timeout"]);
  } finally { server.closeAllConnections(); server.close(); }
});

test("cancel 之后没有任何回调", async () => {
  let hit = false;
  const { server, base } = await serve((req, res) => { hit = true; setTimeout(() => res.end('{"text":"late"}'), 80); });
  const ev = [];
  try {
    const s = createLocalStt({ baseUrl: base }).begin({ onFinal: (t) => ev.push(t), onError: (e) => ev.push(e.code) });
    s.writeAudio(pcm(100)); s.finish();
    await waitFor(() => hit);
    s.cancel();
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(ev, []);
  } finally { server.closeAllConnections(); server.close(); }
});

test("非 JSON 响应 -> stt_local_http", async () => {
  const { server, base } = await serve((req, res) => res.end("not json"));
  const errs = [];
  try {
    const s = createLocalStt({ baseUrl: base }).begin({ onFinal() {}, onError: (e) => errs.push(e.code) });
    s.writeAudio(pcm(100)); s.finish();
    await waitFor(() => errs.length);
    assert.deepEqual(errs, ["stt_local_http"]);
  } finally { server.close(); }
});

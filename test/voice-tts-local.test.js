"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createLocalTts } = require("../src/voice-tts-local");

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const collect = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
const waitFor = (fn, ms = 1000) => new Promise((res, rej) => {
  const t0 = Date.now();
  (function loop() { if (fn()) return res(); if (Date.now() - t0 > ms) return rej(new Error("wait timeout")); setTimeout(loop, 5); })();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("capabilities", () => {
  const t = createLocalTts();
  assert.equal(t.id, "local-kokoro");
  assert.deepEqual(t.capabilities, { streaming: true, sampleRate: 24000, channels: 1, format: "s16le" });
});

test("POST /v1/audio/speech：stream/pcm/voice，拼接多次 writeText，onEnd 一次", async () => {
  let req0;
  const { server, base } = await serve(async (req, res) => {
    req0 = { url: req.url, body: JSON.parse((await collect(req)).toString()) };
    res.end(Buffer.alloc(100, 1));
  });
  const ev = [];
  try {
    const s = createLocalTts({ baseUrl: base }).begin({
      onAudio: (a) => ev.push(["audio", a.pcm.length, a.sampleRate, a.channels]), onError: (e) => ev.push(["err", e.code]), onEnd: () => ev.push(["end"]),
    });
    s.writeText("你好，"); s.writeText("世界。");
    s.finish();
    await waitFor(() => ev.some((e) => e[0] === "end"));
    assert.equal(req0.url, "/v1/audio/speech");
    assert.deepEqual(req0.body, { model: "kokoro", input: "你好，世界。", voice: "zf_xiaoxiao", response_format: "pcm", stream: true, speed: 1.2 });
    assert.deepEqual(ev, [["audio", 100, 24000, 1], ["end"]]);
  } finally { server.close(); }
});

test("奇数字节半样本：余字节并入下一块，不吐半个样本", async () => {
  const { server, base } = await serve((req, res) => {
    res.write(Buffer.from([1, 2, 3]));
    setTimeout(() => { res.write(Buffer.from([4, 5])); setTimeout(() => res.end(Buffer.from([6])), 30); }, 30);
  });
  const got = []; let ended = false;
  try {
    const s = createLocalTts({ baseUrl: base }).begin({ onAudio: (a) => got.push(a.pcm), onError() {}, onEnd: () => { ended = true; } });
    s.writeText("x"); s.finish();
    await waitFor(() => ended);
    for (const b of got) assert.equal(b.length % 2, 0);
    assert.deepEqual([...Buffer.concat(got)], [1, 2, 3, 4, 5, 6]);
  } finally { server.close(); }
});

test("HTTP 头到达不算首音频，也不触发 onAudio", async () => {
  const { server, base } = await serve((req, res) => { res.writeHead(200); res.flushHeaders(); setTimeout(() => res.end(Buffer.alloc(4)), 80); });
  const t0 = Date.now(); let first = 0;
  try {
    const s = createLocalTts({ baseUrl: base }).begin({ onAudio: () => { first ||= Date.now() - t0; }, onError() {}, onEnd() {} });
    s.writeText("x"); s.finish();
    await waitFor(() => first);
    assert.ok(first >= 70);
  } finally { server.close(); }
});

test("失败：HTTP 非 200 / 不可达，各只报一次", async () => {
  const { server, base } = await serve((req, res) => { res.statusCode = 500; res.end("bad"); });
  const errs = [];
  try {
    const s = createLocalTts({ baseUrl: base }).begin({ onAudio() {}, onError: (e) => errs.push(e.code), onEnd() { errs.push("end"); } });
    s.writeText("x"); s.finish();
    await waitFor(() => errs.length); await sleep(30);
    assert.deepEqual(errs, ["tts_local_http"]);
  } finally { server.close(); }
  const errs2 = [];
  const s2 = createLocalTts({ baseUrl: base }).begin({ onAudio() {}, onError: (e) => errs2.push(e.code), onEnd() { errs2.push("end"); } });
  s2.writeText("x"); s2.finish();
  await waitFor(() => errs2.length); await sleep(30);
  assert.deepEqual(errs2, ["tts_local_unreachable"]);
});

test("中途断流报错", async () => {
  const { server, base } = await serve((req, res) => { res.write(Buffer.alloc(10)); setTimeout(() => res.destroy(), 20); });
  const ev = [];
  try {
    const s = createLocalTts({ baseUrl: base }).begin({ onAudio: () => ev.push("a"), onError: (e) => ev.push(e.code), onEnd: () => ev.push("end") });
    s.writeText("x"); s.finish();
    await waitFor(() => ev.includes("tts_local_unreachable") || ev.includes("end"));
    assert.deepEqual(ev, ["a", "tts_local_unreachable"]);
  } finally { server.close(); }
});

test("cancel 立刻销毁请求，之后无回调", async () => {
  let serverClosed = false;
  const { server, base } = await serve((req, res) => {
    res.write(Buffer.alloc(10));
    req.on("close", () => { serverClosed = true; });
    res.on("close", () => { serverClosed = true; });
  });
  const ev = [];
  try {
    const s = createLocalTts({ baseUrl: base }).begin({ onAudio: () => ev.push("a"), onError: (e) => ev.push(e.code), onEnd: () => ev.push("end") });
    s.writeText("x"); s.finish();
    await waitFor(() => ev.length === 1);
    s.cancel();
    await waitFor(() => serverClosed);
    await sleep(50);
    assert.deepEqual(ev, ["a"]);
  } finally { server.closeAllConnections(); server.close(); }
});

test("cancel 在 finish 之前也安全；空文本直接 onEnd 不发请求", async () => {
  const ev = [];
  const t = createLocalTts({ baseUrl: "http://127.0.0.1:1" });
  const a = t.begin({ onAudio() {}, onError: (e) => ev.push(e.code), onEnd: () => ev.push("end") });
  a.cancel(); a.finish();
  const b = t.begin({ onAudio() {}, onError: (e) => ev.push(e.code), onEnd: () => ev.push("end") });
  b.writeText("   "); b.finish();
  await sleep(30);
  assert.deepEqual(ev, ["end"]);
});

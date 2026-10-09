"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { loopbackRequest, parseLoopbackUrl } = require("../src/voice-loopback-http");

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("parseLoopbackUrl 只接受 loopback 主机和白名单端口", () => {
  assert.equal(parseLoopbackUrl("http://127.0.0.1:2022/x", [2022]).port, 2022);
  assert.throws(() => parseLoopbackUrl("http://example.com:2022/x", [2022]), /loopback/);
  assert.throws(() => parseLoopbackUrl("http://127.0.0.1:9999/x", [2022]), /port/);
  assert.throws(() => parseLoopbackUrl("https://127.0.0.1:2022/x", [2022]), /loopback/);
});

test("请求直连目标，不受 http_proxy 环境变量影响", async () => {
  const saved = { a: process.env.http_proxy, b: process.env.HTTP_PROXY };
  process.env.http_proxy = "http://127.0.0.1:1";
  process.env.HTTP_PROXY = "http://127.0.0.1:1";
  const { server, port } = await serve((req, res) => { res.end("hi"); });
  try {
    const res = await loopbackRequest({ url: `http://127.0.0.1:${port}/p`, ports: [port] });
    assert.equal(res.statusCode, 200);
    const chunks = [];
    for await (const c of res.stream) chunks.push(c);
    assert.equal(Buffer.concat(chunks).toString(), "hi");
  } finally {
    process.env.http_proxy = saved.a; process.env.HTTP_PROXY = saved.b;
    if (saved.a === undefined) delete process.env.http_proxy;
    if (saved.b === undefined) delete process.env.HTTP_PROXY;
    server.close();
  }
});

test("3xx 重定向一律报错，不跟随", async () => {
  const { server, port } = await serve((req, res) => {
    res.writeHead(302, { location: "http://example.com/" }); res.end();
  });
  try {
    await assert.rejects(
      loopbackRequest({ url: `http://127.0.0.1:${port}/`, ports: [port] }),
      (e) => e.code === "redirect_blocked",
    );
  } finally { server.close(); }
});

test("AbortSignal 中止请求", async () => {
  const { server, port } = await serve(() => {});
  const ac = new AbortController();
  try {
    const p = loopbackRequest({ url: `http://127.0.0.1:${port}/`, ports: [port], signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(p, (e) => e.code === "aborted");
  } finally { server.closeAllConnections(); server.close(); }
});

test("超时报 timeout，连接失败报 unreachable", async () => {
  const { server, port } = await serve(() => {});
  try {
    await assert.rejects(
      loopbackRequest({ url: `http://127.0.0.1:${port}/`, ports: [port], timeoutMs: 30 }),
      (e) => e.code === "timeout",
    );
  } finally { server.closeAllConnections(); server.close(); }
  await assert.rejects(
    loopbackRequest({ url: `http://127.0.0.1:${port}/`, ports: [port] }),
    (e) => e.code === "unreachable",
  );
});

test("发送 body 与 headers", async () => {
  let got;
  const { server, port } = await serve((req, res) => {
    const c = []; req.on("data", (d) => c.push(d));
    req.on("end", () => { got = { m: req.method, ct: req.headers["content-type"], b: Buffer.concat(c).toString() }; res.end("ok"); });
  });
  try {
    const res = await loopbackRequest({ url: `http://127.0.0.1:${port}/`, ports: [port], method: "POST", headers: { "content-type": "text/plain" }, body: "abc" });
    for await (const _ of res.stream); // drain
    assert.deepEqual(got, { m: "POST", ct: "text/plain", b: "abc" });
  } finally { server.close(); }
});

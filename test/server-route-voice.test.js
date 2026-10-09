"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { handleVoicePost, VOICE_ROUTES } = require("../src/server-route-voice");

function makeReq(body, { remoteAddress = "127.0.0.1", headers = {} } = {}) {
  const req = new EventEmitter();
  req.headers = { host: "127.0.0.1:23333", "content-type": "application/json", ...headers };
  req.socket = { remoteAddress };
  setImmediate(() => {
    if (body != null) req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function makeRes() {
  const res = new EventEmitter();
  res.writableEnded = false;
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (data) => { res.writableEnded = true; res.body = data ? JSON.parse(data) : null; res.emit("finish"); };
  return res;
}

function run(url, req, api, reject = () => false) {
  const res = makeRes();
  const done = new Promise((resolve) => res.on("finish", resolve));
  handleVoicePost(req, res, { url, api, reject });
  return done.then(() => res);
}

const api = (over = {}) => ({
  sessionStart: async () => ({ status: "ok" }),
  sessionStop: async () => ({ status: "ok" }),
  converse: async () => ({ interrupted: false, user: "你好" }),
  ...over,
});

test("routes are the three documented paths", () => {
  assert.deepEqual([...VOICE_ROUTES].sort(), ["/voice/converse", "/voice/session/start", "/voice/session/stop"]);
});

test("session/start and stop answer with the voice-main result", async () => {
  const a = api({ sessionStart: async () => ({ status: "error", reasons: ["voice-disabled"] }) });
  const r1 = await run("/voice/session/start", makeReq("{}"), a);
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, { status: "error", reasons: ["voice-disabled"] });
  const r2 = await run("/voice/session/stop", makeReq(null), api());
  assert.deepEqual(r2.body, { status: "ok" });
});

test("converse passes text/timeout_s and returns the result", async () => {
  let got;
  const a = api({ converse: async (o) => { got = o; return { interrupted: true, played: "甲", unplayed_count: 1, user: "停" }; } });
  const res = await run("/voice/converse", makeReq({ text: "测试一下", timeout_s: 3 }), a);
  assert.equal(got.text, "测试一下");
  assert.equal(got.timeoutS, 3);
  assert.ok(got.signal);
  assert.deepEqual(res.body, { interrupted: true, played: "甲", unplayed_count: 1, user: "停" });
});

test("converse returns 409 when no session call is running", async () => {
  const res = await run("/voice/converse", makeReq({ text: "x" }), api({ converse: async () => ({ error: "not-in-session" }) }));
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: "not-in-session" });
});

test("non-loopback peers are rejected before the body is used", async () => {
  let called = false;
  const a = api({ sessionStart: async () => { called = true; return {}; } });
  const res = await run("/voice/session/start", makeReq("{}", { remoteAddress: "192.168.1.9" }), a);
  assert.equal(res.status, 403);
  assert.equal(called, false);
});

test("loopback IPv6 / mapped IPv4 peers are accepted", async () => {
  for (const remoteAddress of ["::1", "::ffff:127.0.0.1"]) {
    assert.equal((await run("/voice/session/stop", makeReq("{}", { remoteAddress }), api())).status, 200);
  }
});

test("the shared transport guard (origin/host/content-type) can veto", async () => {
  const res = makeRes();
  let called = false;
  handleVoicePost(makeReq("{}"), res, {
    url: "/voice/session/start",
    api: api({ sessionStart: async () => { called = true; return {}; } }),
    reject: (_req, r) => { r.writeHead(403); r.end(); return true; },
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(res.status, 403);
  assert.equal(called, false);
});

test("bad JSON -> 400; oversized body -> 413; bad timeout_s ignored", async () => {
  assert.equal((await run("/voice/converse", makeReq("{nope"), api())).status, 400);
  assert.equal((await run("/voice/converse", makeReq("x".repeat(20000)), api())).status, 413);
  let got;
  await run("/voice/converse", makeReq({ text: 5, timeout_s: "abc" }), api({ converse: async (o) => { got = o; return { timeout: true }; } }));
  assert.equal(got.text, "");
  assert.equal(got.timeoutS, undefined);
});

test("client disconnect aborts the pending converse", async () => {
  let signal;
  const res = makeRes();
  const a = api({ converse: (o) => { signal = o.signal; return new Promise(() => {}); } });
  handleVoicePost(makeReq({ text: "x" }), res, { url: "/voice/converse", api: a, reject: () => false });
  await new Promise((r) => setTimeout(r, 10));
  res.emit("close");
  assert.equal(signal.aborted, true);
});

test("server.js dispatches /voice/* through the transport guard; unknown ctx -> 404", async () => {
  const initServer = require("../src/server");
  let handler;
  const mk = (extra) => {
    initServer({
      createHttpServer: (h) => { handler = h; return Object.assign(new EventEmitter(), { listen() {}, close() {}, address: () => null }); },
      setImmediate: () => {},
      getPortCandidates: () => [23333],
      writeRuntimeConfig: () => true, clearRuntimeConfig: () => true, readRuntimePort: () => null,
      ...extra,
    }).startHttpServer();
    return handler;
  };
  const call = async (h, req) => { const res = makeRes(); const p = new Promise((r) => res.on("finish", r)); h(req, res); await Promise.race([p, new Promise((r) => setTimeout(r, 50))]); return res; };
  const post = (url, headers) => Object.assign(makeReq("{}", { headers }), { method: "POST", url });

  const withVoice = mk({ voiceSession: api() });
  assert.equal((await call(withVoice, post("/voice/session/start"))).status, 200);
  assert.equal((await call(withVoice, post("/voice/session/start", { origin: "http://evil.example" }))).status, 403, "browser origin rejected");
  assert.equal((await call(withVoice, post("/voice/session/start", { host: "evil.example" }))).status, 403, "rebinding host rejected");
  assert.equal((await call(withVoice, post("/voice/session/start", { "content-type": "text/plain" }))).status, 415);
  const without = mk({});
  assert.equal((await call(without, post("/voice/session/start"))).status, 404);
});

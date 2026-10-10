"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createFakeWebSocket } = require("./fixtures/fake-ws");
const { createEdgeConnection } = require("../src/voice-edge-conn");

function setup(extra = {}) {
  const { FakeWebSocket, instances } = createFakeWebSocket();
  let t = 0;
  const timers = [];
  const logs = [];
  const conn = createEdgeConnection({
    openSocket: () => new FakeWebSocket("wss://x"),
    configFrame: () => "CONFIG",
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms, live: true }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.live = false; },
    log: (e, f) => logs.push([e, f]),
    ...extra,
  });
  const advance = (ms) => {
    const target = t + ms;
    for (;;) {
      const next = timers.filter((h) => h.live && h.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false; t = next.at; next.fn();
    }
    t = target;
  };
  const events = [];
  const route = (name) => ({
    onAudio: (b) => events.push([name, "audio", b.length]),
    onEnd: () => events.push([name, "end"]),
    onError: (code, msg) => events.push([name, "error", code, msg]),
  });
  return { conn, instances, events, route, advance, logs, FakeWebSocket };
}
const head = (id, path) => `X-RequestId:${id}\r\nPath:${path}\r\n\r\n`;
const audio = (id, n) => {
  const h = Buffer.from(`X-RequestId:${id}\r\nPath:audio\r\n`);
  const len = Buffer.alloc(2); len.writeUInt16BE(h.length);
  return Buffer.concat([len, h, Buffer.alloc(n, 1)]);
};

test("warm opens one socket and sends the config frame on open, once", () => {
  const s = setup();
  s.conn.warm(); s.conn.warm();
  assert.equal(s.instances.length, 1);
  assert.deepEqual(s.instances[0].sent, []);
  s.instances[0].open();
  assert.deepEqual(s.instances[0].sent, ["CONFIG"]);
});

test("requests submitted while connecting are sent after open; later ones reuse the socket", () => {
  const s = setup();
  s.conn.warm();
  s.conn.submit("a", "FRAME-a", s.route("a"));
  assert.deepEqual(s.instances[0].sent, []);
  s.instances[0].open();
  assert.deepEqual(s.instances[0].sent, ["CONFIG", "FRAME-a"]);
  s.conn.submit("b", "FRAME-b", s.route("b"));
  assert.equal(s.instances.length, 1);
  assert.deepEqual(s.instances[0].sent, ["CONFIG", "FRAME-a", "FRAME-b"]);
});

test("audio and turn.end are routed by X-RequestId even when interleaved", () => {
  const s = setup();
  s.conn.submit("a", "A", s.route("a")); s.conn.submit("b", "B", s.route("b"));
  const ws = s.instances[0]; ws.open();
  ws.serverBinary(audio("b", 5)); ws.serverBinary(audio("a", 3));
  ws.emit("message", Buffer.from(head("b", "turn.end")), false);
  ws.serverBinary(audio("a", 2));
  ws.emit("message", Buffer.from(head("a", "turn.end")), false);
  assert.deepEqual(s.events, [["b", "audio", 5], ["a", "audio", 3], ["b", "end"], ["a", "audio", 2], ["a", "end"]]);
  assert.equal(ws.closed, false);
});

test("cancel silences that request only; the socket stays", () => {
  const s = setup();
  const h = s.conn.submit("a", "A", s.route("a")); s.conn.submit("b", "B", s.route("b"));
  s.instances[0].open();
  h.cancel();
  s.instances[0].serverBinary(audio("a", 3)); s.instances[0].serverBinary(audio("b", 4));
  assert.deepEqual(s.events, [["b", "audio", 4]]);
  assert.equal(s.instances[0].closed, false);
});

test("idle for idleMs closes the socket; the next request reconnects", () => {
  const s = setup({ idleMs: 60_000, keepAliveMs: 0 });
  s.conn.submit("a", "A", s.route("a")); s.instances[0].open();
  s.instances[0].emit("message", Buffer.from(head("a", "turn.end")), false);
  s.advance(59_000);
  assert.equal(s.instances[0].closed, false);
  s.advance(2_000);
  assert.equal(s.instances[0].closed, true);
  assert.deepEqual(s.events, [["a", "end"]], "idle close is silent");
  s.conn.submit("b", "B", s.route("b"));
  assert.equal(s.instances.length, 2);
});

test("an in-flight request keeps the connection from going idle", () => {
  const s = setup({ responseTimeoutMs: 600_000 });
  s.conn.submit("a", "A", s.route("a")); s.instances[0].open();
  s.advance(120_000);
  assert.equal(s.instances[0].closed, false);
});

test("a dropped idle connection is re-warmed immediately, every time it was healthy", () => {
  const s = setup();
  s.conn.warm(); s.instances[0].open();
  s.advance(40_000);
  s.instances[0].drop();
  assert.equal(s.instances.length, 2, "reconnect without waiting for the next sentence");
  s.instances[1].open(); s.advance(40_000);
  s.instances[1].drop();
  assert.equal(s.instances.length, 3, "and again: no one-shot limit");
  assert.ok(s.logs.some(([e, f]) => e === "edge_ws_drop" && f.wasOpen));
});

test("reconnect attempts that never open back off 1s/2s/4s and then give up", () => {
  const s = setup();
  s.conn.warm(); s.instances[0].open(); s.advance(40_000);
  s.instances[0].drop();
  s.instances[1].drop(); assert.equal(s.instances.length, 2); s.advance(1_000);
  assert.equal(s.instances.length, 3);
  s.instances[2].drop(); s.advance(1_999); assert.equal(s.instances.length, 3); s.advance(1);
  assert.equal(s.instances.length, 4);
  s.instances[3].drop(); s.advance(4_000);
  assert.equal(s.instances.length, 5);
  s.instances[4].drop(); s.advance(60_000);
  assert.equal(s.instances.length, 5, "gave up; the next submit connects on demand");
  s.conn.submit("a", "A", s.route("a"));
  assert.equal(s.instances.length, 6);
});

test("a connection that dies right after opening counts as a failure, not a healthy drop", () => {
  const s = setup();
  s.conn.warm(); s.instances[0].open(); s.advance(40_000);
  s.instances[0].drop();
  assert.equal(s.instances.length, 2);
  s.instances[1].open(); s.instances[1].drop();
  assert.equal(s.instances.length, 2, "quick drop: wait for backoff instead of looping");
  s.advance(1_000);
  assert.equal(s.instances.length, 3);
});

test("keepalive: an open socket is ws-pinged every 20s, also while idle, and stops on close", () => {
  const s = setup();
  s.conn.warm();
  s.advance(5_000);
  assert.equal(s.instances[0].pings || 0, 0, "no ping before the socket is open");
  s.instances[0].open();
  s.advance(19_999); assert.equal(s.instances[0].pings || 0, 0);
  s.advance(1); assert.equal(s.instances[0].pings, 1);
  s.advance(60_000); assert.equal(s.instances[0].pings, 4);
  assert.equal(s.instances[0].closed, false, "pings keep the idle timer from closing a live session");
  s.instances[0].drop();
  const n = s.instances[0].pings;
  s.advance(100_000);
  assert.equal(s.instances[0].pings, n);
  assert.deepEqual(s.instances[0].sent, ["CONFIG"], "ping is a ws control frame, no text frame");
});

test("keepalive survives a ping that throws and dispose stops it", () => {
  const s = setup();
  s.conn.warm(); s.instances[0].open();
  s.instances[0].ping = () => { throw new Error("not open"); };
  s.advance(20_000);
  s.conn.dispose();
  s.advance(60_000);
  assert.equal(s.instances.length, 1);
});

test("a stale connection dropped before any audio retries once on a fresh socket", () => {
  const s = setup();
  s.conn.submit("a", "A", s.route("a")); s.instances[0].open();
  s.instances[0].drop();
  assert.equal(s.instances.length, 2);
  assert.deepEqual(s.events, []);
  s.instances[1].open();
  assert.deepEqual(s.instances[1].sent, ["CONFIG", "A"]);
  s.instances[1].drop();
  assert.deepEqual(s.events, [["a", "error", "tts_edge_network", "connection closed"]]);
});

test("a drop after audio started is an error, not a replay", () => {
  const s = setup();
  s.conn.submit("a", "A", s.route("a")); s.instances[0].open();
  s.instances[0].serverBinary(audio("a", 3));
  s.instances[0].drop();
  assert.deepEqual(s.events[1], ["a", "error", "tts_edge_network", "connection closed"]);
  s.advance(1_000);
  assert.equal(s.instances.length, 2, "only the background re-warm, no replay of the request");
  assert.deepEqual(s.instances[1].sent, []);
});

test("401/403 upgrade -> tts_edge_auth, connect failure and timeouts -> tts_edge_network", () => {
  const a = setup();
  a.conn.submit("a", "A", a.route("a"));
  a.instances[0].emit("unexpected-response", {}, { statusCode: 403 });
  assert.deepEqual(a.events, [["a", "error", "tts_edge_auth", "HTTP 403"]]);

  const b = setup();
  b.conn.submit("a", "A", b.route("a"));
  b.advance(10_001);
  assert.deepEqual(b.events, [["a", "error", "tts_edge_network", "timeout"]]);
  assert.equal(b.instances[0].closed, true);

  const c = setup();
  c.conn.submit("a", "A", c.route("a")); c.instances[0].open();
  c.advance(15_001);
  assert.deepEqual(c.events, [["a", "error", "tts_edge_network", "timeout"]]);
  assert.equal(c.instances[0].closed, true);
});

test("dispose closes the socket silently and stops reconnecting", () => {
  const s = setup();
  s.conn.submit("a", "A", s.route("a")); s.instances[0].open();
  s.conn.dispose();
  assert.equal(s.instances[0].closed, true);
  assert.deepEqual(s.events, []);
  s.advance(120_000);
  assert.equal(s.instances.length, 1);
});

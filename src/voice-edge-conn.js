"use strict";

// One shared, long-lived Edge TTS WebSocket. Requests are multiplexed by
// X-RequestId (the service interleaves concurrent requests on one socket,
// measured), so only the first request pays the WSS handshake. The socket is
// pre-warmed, ws-pinged every KEEPALIVE_MS (the service drops idle sockets after
// 35-105s), reconnected right after drops, retried once for stale-socket drops,
// and closed after idleMs without traffic. Text is never logged here.
const IDLE_MS = 600000;
const KEEPALIVE_MS = 20000;
const QUICK_DROP_MS = 2000; // a socket that died sooner counts as a failed connect
const MAX_RECONNECTS = 3; // backoff 1s, 2s, 4s; after that the next submit connects on demand
const CONNECT_TIMEOUT_MS = 10000;
const RESPONSE_TIMEOUT_MS = 15000;

const idOf = (s) => (/X-RequestId:(\w+)/.exec(s) || [])[1];

function createEdgeConnection(o) {
  const now = o.now || Date.now;
  const setT = o.setTimeout || setTimeout;
  const clearT = o.clearTimeout || clearTimeout;
  const idleMs = o.idleMs ?? IDLE_MS;
  const keepAliveMs = o.keepAliveMs ?? KEEPALIVE_MS;
  const connectMs = o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const responseMs = o.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;
  const log = o.log || (() => {});
  const routes = new Map(); // id -> { id, frame, handlers, sent, audio, retried, timer }
  let sock = null;
  let isOpen = false;
  let connTimer = null;
  let idleTimer = null;
  let openedAt = 0;
  let failStreak = 0;
  let kaTimer = null;
  let reconnectTimer = null;
  let disposed = false;

  const clearIdle = () => { clearT(idleTimer); idleTimer = null; };
  function touchIdle() {
    clearIdle();
    if (isOpen && !routes.size && !disposed) idleTimer = setT(() => { log("edge_ws_idle_close", { idleMs }); closeSock(); }, idleMs);
    if (idleTimer && idleTimer.unref) idleTimer.unref(); // housekeeping must not keep the process alive
  }

  function closeSock() {
    const s = sock;
    sock = null; isOpen = false;
    clearT(connTimer); connTimer = null; clearIdle();
    clearT(kaTimer); kaTimer = null;
    try { s && s.close(); } catch { /* best effort */ }
  }

  function keepAlive(s) {
    if (!keepAliveMs) return;
    kaTimer = setT(() => {
      if (sock !== s || !isOpen) return;
      try { s.ping(); } catch { /* the close event reports a dead socket */ }
      keepAlive(s);
    }, keepAliveMs);
    if (kaTimer && kaTimer.unref) kaTimer.unref(); // a ping alone must not keep the process alive
  }

  function scheduleReconnect() {
    if (failStreak === 0) { connect(); return; }
    if (failStreak > MAX_RECONNECTS) return;
    reconnectTimer = setT(() => { reconnectTimer = null; if (!sock && !disposed && !routes.size) connect(); }, 1000 * 2 ** (failStreak - 1));
  }

  function sendRoute(r) {
    r.sent = true;
    sock.send(r.frame);
    clearT(r.timer);
    r.timer = setT(() => { r.retried = true; dropAll("tts_edge_network", "timeout"); }, responseMs);
  }

  function connect() {
    const s = o.openSocket();
    sock = s; isOpen = false;
    const t0 = now();
    connTimer = setT(() => dropAll("tts_edge_network", "timeout"), connectMs);
    const mine = (fn) => (...a) => { if (sock === s) fn(...a); };
    s.on("open", mine(() => {
      clearT(connTimer); connTimer = null;
      isOpen = true; openedAt = now();
      log("edge_ws_open", { ms: openedAt - t0 });
      s.send(o.configFrame());
      for (const r of routes.values()) sendRoute(r);
      keepAlive(s);
      touchIdle();
    }));
    s.on("message", mine((data, isBinary) => onMessage(Buffer.from(data), isBinary)));
    s.on("close", mine(() => dropAll("tts_edge_network", isOpen ? "connection closed" : "connection failed")));
    s.on("error", mine(() => dropAll("tts_edge_network", "socket error")));
    s.on("unexpected-response", mine((_req, res) => {
      const code = res && res.statusCode;
      dropAll(code === 401 || code === 403 ? "tts_edge_auth" : "tts_edge_network", `HTTP ${code}`);
    }));
  }

  function onMessage(buf, isBinary) {
    let id;
    if (isBinary) {
      if (buf.length < 2) return;
      const hl = buf.readUInt16BE(0);
      id = idOf(buf.subarray(2, 2 + hl).toString("utf8"));
      const r = routes.get(id);
      const body = buf.subarray(2 + hl);
      if (r && body.length) { r.audio = true; r.handlers.onAudio(body); }
      return;
    }
    const text = buf.toString("utf8");
    if (!/Path:turn\.end/.test(text)) return;
    const r = routes.get(idOf(text));
    if (!r) return;
    routes.delete(r.id);
    clearT(r.timer);
    r.handlers.onEnd();
    touchIdle();
  }

  // Socket gone: requests that never got audio on a once-open socket are replayed
  // once on a fresh one (stale keep-alive); everything else fails visibly.
  function dropAll(code, message) {
    const wasOpen = isOpen;
    closeSock();
    const rs = [...routes.values()];
    routes.clear();
    for (const r of rs) clearT(r.timer);
    const aliveMs = wasOpen ? now() - openedAt : 0;
    log("edge_ws_drop", { code, message, wasOpen, inflight: rs.length, aliveMs });
    if (disposed) return;
    failStreak = wasOpen && aliveMs >= QUICK_DROP_MS ? 0 : failStreak + 1;
    const retry = code === "tts_edge_network" && wasOpen ? rs.filter((r) => !r.audio && !r.retried) : [];
    for (const r of rs) {
      if (retry.includes(r)) { r.retried = true; r.sent = false; routes.set(r.id, r); } else r.handlers.onError(code, message);
    }
    if (routes.size) connect();
    else if (code === "tts_edge_network" && !reconnectTimer) scheduleReconnect();
  }

  return {
    warm() { if (!sock && !disposed) connect(); },
    submit(id, frame, handlers) {
      const r = { id, frame, handlers, sent: false, audio: false, retried: false, timer: null };
      routes.set(id, r);
      clearIdle();
      if (!sock) { clearT(reconnectTimer); reconnectTimer = null; connect(); } else if (isOpen) sendRoute(r);
      return { cancel() { if (routes.get(id) === r) { routes.delete(id); clearT(r.timer); touchIdle(); } } };
    },
    dispose() { disposed = true; routes.clear(); clearT(reconnectTimer); reconnectTimer = null; closeSock(); },
    isOpen: () => isOpen,
  };
}

module.exports = { createEdgeConnection, IDLE_MS, KEEPALIVE_MS };

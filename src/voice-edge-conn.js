"use strict";

// One shared, long-lived Edge TTS WebSocket. Requests are multiplexed by
// X-RequestId (the service interleaves concurrent requests on one socket,
// measured), so only the first request pays the WSS handshake. The socket is
// pre-warmed, reconnected after drops, retried once for stale-socket drops, and
// closed after idleMs without traffic. Text is never logged here.
const IDLE_MS = 60000;
const CONNECT_TIMEOUT_MS = 10000;
const RESPONSE_TIMEOUT_MS = 15000;
const MAX_AUTO_REWARM = 1;

const idOf = (s) => (/X-RequestId:(\w+)/.exec(s) || [])[1];

function createEdgeConnection(o) {
  const now = o.now || Date.now;
  const setT = o.setTimeout || setTimeout;
  const clearT = o.clearTimeout || clearTimeout;
  const idleMs = o.idleMs ?? IDLE_MS;
  const connectMs = o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const responseMs = o.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS;
  const log = o.log || (() => {});
  const routes = new Map(); // id -> { id, frame, handlers, sent, audio, retried, timer }
  let sock = null;
  let isOpen = false;
  let connTimer = null;
  let idleTimer = null;
  let openedAt = 0;
  let rewarms = 0;
  let disposed = false;

  const clearIdle = () => { clearT(idleTimer); idleTimer = null; };
  function touchIdle() {
    clearIdle();
    if (isOpen && !routes.size && !disposed) idleTimer = setT(() => { log("edge_ws_idle_close", { idleMs }); closeSock(); }, idleMs);
  }

  function closeSock() {
    const s = sock;
    sock = null; isOpen = false;
    clearT(connTimer); connTimer = null; clearIdle();
    try { s && s.close(); } catch { /* best effort */ }
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
    rewarms = 0;
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
    log("edge_ws_drop", { code, message, wasOpen, inflight: rs.length, aliveMs: wasOpen ? now() - openedAt : 0 });
    if (disposed) return;
    const retry = code === "tts_edge_network" && wasOpen ? rs.filter((r) => !r.audio && !r.retried) : [];
    for (const r of rs) {
      if (retry.includes(r)) { r.retried = true; r.sent = false; routes.set(r.id, r); } else r.handlers.onError(code, message);
    }
    if (routes.size) connect();
    else if (wasOpen && code === "tts_edge_network" && rewarms < MAX_AUTO_REWARM) { rewarms += 1; connect(); }
  }

  return {
    warm() { if (!sock && !disposed) connect(); },
    submit(id, frame, handlers) {
      const r = { id, frame, handlers, sent: false, audio: false, retried: false, timer: null };
      routes.set(id, r);
      clearIdle();
      if (!sock) connect(); else if (isOpen) sendRoute(r);
      return { cancel() { if (routes.get(id) === r) { routes.delete(id); clearT(r.timer); touchIdle(); } } };
    },
    dispose() { disposed = true; routes.clear(); closeSock(); },
    isOpen: () => isOpen,
  };
}

module.exports = { createEdgeConnection, IDLE_MS };

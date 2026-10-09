"use strict";

// POST /voice/session/{start,stop} and /voice/converse: loopback-only control
// plane for the Claude Code session voice mode. The mic only opens for users
// who enabled voice in settings (voice-main enforces readiness).

const MAX_VOICE_BODY_BYTES = 8 * 1024;
const VOICE_ROUTES = new Set(["/voice/session/start", "/voice/session/stop", "/voice/converse"]);
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, cb) {
  const chunks = [];
  let size = 0;
  let over = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_VOICE_BODY_BYTES) { over = true; chunks.length = 0; return; }
    if (!over) chunks.push(c);
  });
  req.on("end", () => {
    if (over) return cb({ status: 413 });
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return cb(null, {});
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? cb(null, parsed) : cb({ status: 400 });
    } catch { return cb({ status: 400 }); }
  });
  req.on("error", () => cb({ status: 400 }));
}

function handleVoicePost(req, res, { url, api, reject }) {
  const peer = req.socket && req.socket.remoteAddress;
  if (!LOOPBACK_PEERS.has(peer)) { sendJson(res, 403, { error: "loopback-only" }); return; }
  if (reject(req, res, url)) return;
  readJsonBody(req, (err, body) => {
    if (err) { sendJson(res, err.status, { error: err.status === 413 ? "too-large" : "bad-json" }); return; }
    const done = (result) => sendJson(res, result && result.error ? 409 : 200, result);
    const fail = () => sendJson(res, 500, { error: "voice-internal" });
    if (url === "/voice/session/start") api.sessionStart().then(done, fail);
    else if (url === "/voice/session/stop") api.sessionStop().then(done, fail);
    else {
      const ac = new AbortController();
      res.on("close", () => { if (!res.writableEnded) ac.abort(); });
      const t = Number(body.timeout_s);
      api.converse({
        text: typeof body.text === "string" ? body.text : "",
        timeoutS: Number.isFinite(t) && t > 0 ? t : undefined,
        signal: ac.signal,
      }).then(done, fail);
    }
  });
}

module.exports = { handleVoicePost, VOICE_ROUTES, MAX_VOICE_BODY_BYTES };

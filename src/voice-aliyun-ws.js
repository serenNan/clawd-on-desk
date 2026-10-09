"use strict";

// DashScope (Aliyun Bailian) WebSocket helpers shared by the STT / TTS adapters.
// Protocol shape follows the public duplex task protocol (header.action
// run-task / continue-task / finish-task; events task-started /
// result-generated / task-finished / task-failed). NOT verified against the
// live service. Never log audio, text or the key.
const crypto = require("node:crypto");

const ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const AUTH_CODES = /InvalidApiKey|Unauthorized|AccessDenied|Forbidden|InvalidAccessKey/i;

function requireKey(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new Error("DashScope API key is required");
  return apiKey.trim();
}

function resolveWebSocket(impl) {
  return impl || require("ws");
}

function newTaskId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function buildFrame(action, taskId, extra = {}) {
  const { model, parameters, input } = extra;
  const payload = { input: input || {} };
  if (action === "run-task") {
    payload.task_group = extra.taskGroup;
    payload.task = extra.task;
    payload.function = extra.fn;
    payload.model = model;
    payload.parameters = parameters || {};
  }
  return JSON.stringify({ header: { action, task_id: taskId, streaming: "duplex" }, payload });
}

function isAuthFailure(errorCode) {
  return typeof errorCode === "string" && AUTH_CODES.test(errorCode);
}

// Opens the socket and normalises events. `h` = { onOpen, onJson(obj), onBinary(buf), onClose(), onFail(kind) }
// kind is "auth" (HTTP 401/403 upgrade rejection) or "network".
function openSocket(WebSocketImpl, apiKey, h) {
  const WS = resolveWebSocket(WebSocketImpl);
  const ws = new WS(ENDPOINT, { headers: { Authorization: `bearer ${apiKey}` } });
  ws.on("open", () => h.onOpen());
  ws.on("message", (data, isBinary) => {
    if (isBinary) return h.onBinary(Buffer.from(data));
    let obj = null;
    try { obj = JSON.parse(Buffer.from(data).toString("utf8")); } catch { return; }
    if (obj && obj.header) h.onJson(obj);
  });
  ws.on("close", () => h.onClose());
  ws.on("error", () => h.onFail("network"));
  ws.on("unexpected-response", (_req, res) => {
    const code = res && res.statusCode;
    h.onFail(code === 401 || code === 403 ? "auth" : "network");
  });
  return ws;
}

module.exports = { ENDPOINT, requireKey, newTaskId, buildFrame, isAuthFailure, openSocket };

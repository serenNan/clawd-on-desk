#!/usr/bin/env node
"use strict";

// clawd-voice: minimal stdio MCP server (hand-rolled JSON-RPC, no SDK dependency)
// that lets a Claude Code session drive Clawd's voice ears/mouth over loopback HTTP.

const http = require("http");

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_TIMEOUT_S = 120;
const TIMEOUT_GRACE_MS = 90 * 1000;
const START_STOP_TIMEOUT_MS = 30 * 1000;
// Own agent: Node http never reads proxy env vars (also in Node 24+ unless the
// agent opts in with proxyEnv), but an explicit agent keeps loopback direct.
const directAgent = new http.Agent({ keepAlive: false });

const TOOLS = [
  {
    name: "voice_start",
    description: "开启桌宠麦克风，进入 Claude Code 会话语音模式（桌宠只当耳朵和嘴）。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "voice_converse",
    description: "把 text 用语音播给用户（可为空，只听不说），然后阻塞等待用户下一句话。返回 JSON：{interrupted:false,user} | {interrupted:true,played,unplayed_count,user} | {timeout:true} | {ended:true} | {superseded:true}。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要说的话：口语化短句，不用 Markdown。" },
        timeout_s: { type: "number", description: "播报完后等待用户开口的秒数，默认 120。" },
      },
      required: [],
    },
  },
  {
    name: "voice_stop",
    description: "关闭桌宠麦克风，结束语音模式。",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

const ROUTES = { voice_start: "/voice/session/start", voice_converse: "/voice/converse", voice_stop: "/voice/session/stop" };

function candidatePorts() {
  if (process.env.CLAWD_VOICE_PORT) return [Number(process.env.CLAWD_VOICE_PORT)];
  try { return require("./server-config").getPortCandidates(); } catch { return [23333, 23334, 23335, 23336, 23337]; }
}

function postOnce(port, route, body, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port, path: route, method: "POST", agent: directAgent,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : {} }); } catch { resolve({ status: res.statusCode, json: {} }); }
      });
    });
    if (signal) {
      const onAbort = () => req.destroy(Object.assign(new Error("cancelled"), { code: "ECANCELLED" }));
      if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    }
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(data);
  });
}

function createPetClient({ ports } = {}) {
  let known = null;
  async function call(route, body, timeoutMs = START_STOP_TIMEOUT_MS, signal) {
    const list = known ? [known] : (ports || candidatePorts());
    let sawServer = false;
    for (const port of list) {
      try {
        const res = await postOnce(port, route, body, timeoutMs, signal);
        if (res.status === 404) { sawServer = true; continue; }
        known = port;
        return res;
      } catch (e) {
        if (e && e.code === "ECANCELLED") throw e;
        if (e && e.code === "ETIMEDOUT") throw Object.assign(new Error("桌宠长时间无响应（请求超时）"), { code: "pet-timeout" });
        if (known) known = null;
      }
    }
    throw Object.assign(new Error(sawServer
      ? "桌宠在运行，但这个版本没有语音路由（需要带 feat/realtime-voice 的开发版）。"
      : "桌宠(clawd-on-desk)没有运行，或本机 23333-23337 端口不可达。请先启动桌宠。"), { code: "pet-unavailable" });
  }
  return { call };
}

function toolResult(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function validateArgs(name, args) {
  if (name !== "voice_converse") return null;
  if (args.text !== undefined && typeof args.text !== "string") return "text 必须是字符串";
  if (args.timeout_s !== undefined && !(typeof args.timeout_s === "number" && args.timeout_s > 0)) return "timeout_s 必须是正数";
  return null;
}

function createMcpServer({ callPet }) {
  const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
  const inflight = new Map(); // request id -> AbortController (notifications/cancelled)
  const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  async function callTool(id, params) {
    const name = params && params.name;
    if (!ROUTES[name]) return fail(id, -32602, `unknown tool: ${name}`);
    const args = (params && params.arguments) || {};
    const bad = validateArgs(name, args);
    if (bad) return ok(id, toolResult(bad, true));
    const timeoutMs = name === "voice_converse" ? (args.timeout_s || DEFAULT_TIMEOUT_S) * 1000 + TIMEOUT_GRACE_MS : undefined;
    try {
      const body = name === "voice_converse" ? { text: args.text || "", ...(args.timeout_s ? { timeout_s: args.timeout_s } : {}) } : {};
      const ac = new AbortController();
      inflight.set(id, ac);
      const res = await callPet(ROUTES[name], body, timeoutMs, ac.signal);
      return ok(id, toolResult(res.json, res.status >= 400 || (res.json && res.json.status === "error")));
    } catch (e) {
      return ok(id, toolResult(`clawd-voice 调用失败：${(e && e.message) || e}`, true));
    } finally { inflight.delete(id); }
  }

  return {
    async handle(msg) {
      if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return null;
      const isRequest = msg.id !== undefined && msg.id !== null;
      switch (msg.method) {
        case "initialize": {
          const asked = msg.params && msg.params.protocolVersion;
          return ok(msg.id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: "clawd-voice", version: "1.0.0" },
          });
        }
        case "notifications/cancelled": {
          const ac = inflight.get(msg.params && msg.params.requestId);
          if (ac) ac.abort();
          return null;
        }
        case "ping": return isRequest ? ok(msg.id, {}) : null;
        case "tools/list": return ok(msg.id, { tools: TOOLS });
        case "tools/call": return callTool(msg.id, msg.params);
        default: return isRequest ? fail(msg.id, -32601, `method not found: ${msg.method}`) : null;
      }
    },
  };
}

function runStdio() {
  const mcp = createMcpServer({ callPet: createPetClient().call });
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`); continue; }
      mcp.handle(msg).then((out) => { if (out) process.stdout.write(`${JSON.stringify(out)}\n`); });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (require.main === module) runStdio();

module.exports = { createMcpServer, createPetClient, TOOLS };

"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const { createMcpServer, createPetClient, TOOLS } = require("../hooks/clawd-voice-mcp");

const SCRIPT = path.join(__dirname, "..", "hooks", "clawd-voice-mcp.js");

function fakePet(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url, body, type: req.headers["content-type"] });
      const out = handler(req.url, body);
      res.writeHead(out.status || 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port })));
}

const rpc = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const parseText = (res) => JSON.parse(res.result.content[0].text);

test("initialize / initialized / ping / tools/list", async () => {
  const mcp = createMcpServer({ callPet: async () => ({}) });
  const init = await mcp.handle(rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } }));
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, "clawd-voice");
  assert.equal(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.deepEqual((await mcp.handle(rpc(2, "ping"))).result, {});
  const list = await mcp.handle(rpc(3, "tools/list"));
  assert.deepEqual(list.result.tools.map((t) => t.name), ["voice_start", "voice_converse", "voice_stop"]);
  assert.equal(TOOLS.length, 3);
  assert.deepEqual(list.result.tools[1].inputSchema.required, []);
  assert.equal((await mcp.handle(rpc(4, "nope"))).error.code, -32601);
});

test("tools/call round trip against a fake pet over real HTTP", async () => {
  const pet = await fakePet((url, body) => {
    if (url === "/voice/session/start") return { json: { status: "ok" } };
    if (url === "/voice/converse") return { json: { interrupted: false, user: `听到:${body.text}` } };
    return { json: { status: "ok" } };
  });
  try {
    const mcp = createMcpServer({ callPet: createPetClient({ ports: [pet.port] }).call });
    const s = await mcp.handle(rpc(1, "tools/call", { name: "voice_start", arguments: {} }));
    assert.deepEqual(parseText(s), { status: "ok" });
    const c = await mcp.handle(rpc(2, "tools/call", { name: "voice_converse", arguments: { text: "你好", timeout_s: 5 } }));
    assert.deepEqual(parseText(c), { interrupted: false, user: "听到:你好" });
    assert.equal(c.result.isError, undefined);
    assert.equal(pet.seen[1].body.timeout_s, 5);
    assert.equal(pet.seen[1].type, "application/json");
    await mcp.handle(rpc(3, "tools/call", { name: "voice_stop", arguments: {} }));
    assert.equal(pet.seen[2].url, "/voice/session/stop");
  } finally { pet.server.close(); }
});

test("pet not running gives a clear tool error, not a protocol error", async () => {
  const mcp = createMcpServer({ callPet: createPetClient({ ports: [1] }).call });
  const res = await mcp.handle(rpc(1, "tools/call", { name: "voice_start", arguments: {} }));
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /没有运行|not running/);
});

test("a server without voice routes (404) and HTTP 409 are reported clearly", async () => {
  const pet = await fakePet((url) => (url === "/voice/converse" ? { status: 409, json: { error: "not-in-session" } } : { status: 404, json: {} }));
  try {
    const mcp = createMcpServer({ callPet: createPetClient({ ports: [pet.port] }).call });
    const a = await mcp.handle(rpc(1, "tools/call", { name: "voice_start", arguments: {} }));
    assert.equal(a.result.isError, true);
    const b = await mcp.handle(rpc(2, "tools/call", { name: "voice_converse", arguments: { text: "x" } }));
    assert.equal(b.result.isError, true);
    assert.match(b.result.content[0].text, /not-in-session/);
  } finally { pet.server.close(); }
});

test("unknown tool and bad arguments", async () => {
  const mcp = createMcpServer({ callPet: async () => ({}) });
  assert.equal((await mcp.handle(rpc(1, "tools/call", { name: "zzz" }))).error.code, -32602);
  const bad = await mcp.handle(rpc(2, "tools/call", { name: "voice_converse", arguments: { text: 5 } }));
  assert.equal(bad.result.isError, true);
});

test("stdio: newline-delimited JSON-RPC end to end, ignoring proxy env", async () => {
  const pet = await fakePet(() => ({ json: { status: "ok" } }));
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...process.env, CLAWD_VOICE_PORT: String(pet.port), http_proxy: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "", no_proxy: "" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    const lines = [];
    let buf = "";
    const waiter = new Promise((resolve) => {
      child.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
        if (lines.length >= 3) resolve();
      });
    });
    child.stdin.write(`${JSON.stringify(rpc(1, "initialize", { protocolVersion: "2025-06-18" }))}\n`);
    child.stdin.write(`${JSON.stringify(rpc(2, "tools/list"))}\n`);
    child.stdin.write(`${JSON.stringify(rpc(3, "tools/call", { name: "voice_start", arguments: {} }))}\n`);
    await waiter;
    assert.equal(lines[0].result.serverInfo.name, "clawd-voice");
    assert.equal(lines[1].result.tools.length, 3);
    assert.deepEqual(parseText(lines[2]), { status: "ok" });
  } finally { child.kill(); pet.server.close(); }
});

test("notifications/cancelled aborts the in-flight pet request", async () => {
  let aborted = false;
  const mcp = createMcpServer({
    callPet: (_r, _b, _t, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); })),
  });
  const pending = mcp.handle(rpc(7, "tools/call", { name: "voice_converse", arguments: { text: "x" } }));
  assert.equal(await mcp.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }), null);
  assert.equal(aborted, true);
  assert.equal((await pending).result.isError, true);
});

test("owner token from voice_start rides on converse/stop and is hidden from the model", async () => {
  let n = 0;
  const pet = await fakePet((url) => (url === "/voice/session/start" ? { json: { status: "ok", owner: `tok-${++n}` } } : { json: { ended: true, reason: "taken_over" } }));
  try {
    const mcp = createMcpServer({ callPet: createPetClient({ ports: [pet.port] }).call });
    const s = await mcp.handle(rpc(1, "tools/call", { name: "voice_start", arguments: {} }));
    assert.deepEqual(parseText(s), { status: "ok" });
    const c = await mcp.handle(rpc(2, "tools/call", { name: "voice_converse", arguments: { text: "x" } }));
    assert.deepEqual(parseText(c), { ended: true, reason: "taken_over" });
    await mcp.handle(rpc(3, "tools/call", { name: "voice_stop", arguments: {} }));
    assert.equal(pet.seen[1].body.owner, "tok-1");
    assert.equal(pet.seen[2].body.owner, "tok-1");
    await mcp.handle(rpc(4, "tools/call", { name: "voice_start", arguments: {} }));
    await mcp.handle(rpc(5, "tools/call", { name: "voice_converse", arguments: {} }));
    assert.equal(pet.seen[4].body.owner, "tok-2", "a new start replaces the token");
  } finally { pet.server.close(); }
});

test("voice_start reports which Claude session drives the call (project dir + short session id)", async () => {
  const { sessionLabel } = require("../hooks/clawd-voice-mcp");
  assert.equal(sessionLabel({ CLAUDE_PROJECT_DIR: "/Users/me/Projects/clawd-on-desk", CLAUDE_CODE_SESSION_ID: "a1b2c3d4-e5f6" }, "/ignored"), "clawd-on-desk·a1b2c3");
  assert.equal(sessionLabel({}, "/Users/me/work/api"), "api");
  assert.equal(sessionLabel({ CLAUDE_CODE_SESSION_ID: "bad id!" }, "/x/y"), "y");
  assert.equal(sessionLabel({}, "/"), "");
  const pet = await fakePet(() => ({ json: { status: "ok" } }));
  try {
    const mcp = createMcpServer({ callPet: createPetClient({ ports: [pet.port] }).call, env: { CLAUDE_PROJECT_DIR: "/a/proj" }, cwd: "/z" });
    await mcp.handle(rpc(1, "tools/call", { name: "voice_start", arguments: {} }));
    assert.equal(pet.seen[0].body.label, "proj");
    await mcp.handle(rpc(2, "tools/call", { name: "voice_converse", arguments: { text: "x" } }));
    assert.equal(pet.seen[1].body.label, undefined);
  } finally { pet.server.close(); }
});

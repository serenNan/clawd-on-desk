"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { createClaudeBrain, VOICE_SYSTEM_PROMPT, CLAUDE_ENV_SCRUB } = require("../src/voice-brain-claude");

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.writes = [];
  c.kills = [];
  c.stdin = { write: (s) => { c.writes.push(s); return true; }, end: () => { c.stdinEnded = true; }, on() {} };
  c.kill = (sig) => { c.kills.push(sig); return true; };
  c.emitLine = (obj) => c.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  return c;
}

function harness(opts = {}) {
  const children = [];
  const calls = [];
  const timers = [];
  const brain = createClaudeBrain({
    claudePath: "/bin/claude",
    spawn: (cmd, args, o) => { const c = fakeChild(); children.push(c); calls.push({ cmd, args, o }); return c; },
    env: { PATH: "/usr/bin", HOME: "/h", ...(opts.env || {}) },
    platform: opts.platform || "darwin",
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    ...opts.extra,
  });
  const events = { deltas: [], done: [], errors: [] };
  const handlers = {
    onTextDelta: (t) => events.deltas.push(t),
    onCompleted: (t) => events.done.push(t),
    onError: (e) => events.errors.push(e),
  };
  return { brain, children, calls, timers, events, handlers };
}

const delta = (text) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const init = (over = {}) => ({ type: "system", subtype: "init", tools: [], mcp_servers: [], ...over });

test("spawn uses arg array with the safe template and no forbidden flags", () => {
  const h = harness();
  h.brain.send({ requestId: "r1", text: "你好" }, h.handlers);
  const { cmd, args, o } = h.calls[0];
  assert.equal(cmd, "/bin/claude");
  assert.ok(!o || !o.shell);
  for (const f of ["-p", "--input-format", "stream-json", "--include-partial-messages", "--strict-mcp-config", "--safe-mode", "--no-session-persistence"]) {
    assert.ok(args.includes(f), f);
  }
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--disallowedTools") + 1], "*");
  assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.equal(args[args.indexOf("--settings") + 1], '{"disableAllHooks":true}');
  assert.equal(args[args.indexOf("--system-prompt") + 1], VOICE_SYSTEM_PROMPT);
  const joined = args.join(" ");
  for (const bad of ["--bare", "--dangerously-skip-permissions", "bypassPermissions", "--allowedTools", "api-key"]) {
    assert.ok(!joined.includes(bad), bad);
  }
});

test("child runs in a neutral cwd so project CLAUDE.md/settings never apply", () => {
  const os = require("node:os");
  const h = harness();
  h.brain.send({ requestId: "r1", text: "x" }, h.handlers);
  assert.equal(h.calls[0].o.cwd, os.tmpdir());
  const h2 = harness({ extra: { cwd: "/custom" } });
  h2.brain.send({ requestId: "r1", text: "x" }, h2.handlers);
  assert.equal(h2.calls[0].o.cwd, "/custom");
});

test("child env scrubs outer Claude Code session variables", () => {
  const env = {};
  for (const k of CLAUDE_ENV_SCRUB) env[k] = "x";
  const h = harness({ env });
  h.brain.send({ requestId: "r1", text: "a" }, h.handlers);
  for (const k of CLAUDE_ENV_SCRUB) assert.equal(k in h.calls[0].o.env, false, k);
  assert.equal(h.calls[0].o.env.PATH, "/usr/bin");
  assert.ok(CLAUDE_ENV_SCRUB.includes("CLAUDE_CODE_SESSION_ID"));
  assert.ok(CLAUDE_ENV_SCRUB.includes("CLAUDE_CODE_FORCE_SESSION_PERSISTENCE"));
});

test("multi-turn keeps stdin open and writes one user JSONL per turn", () => {
  const h = harness();
  h.brain.send({ requestId: "r1", text: "你好" }, h.handlers);
  const c = h.children[0];
  c.emitLine(init());
  c.emitLine(delta("嗨"));
  c.emitLine({ type: "result", subtype: "success", is_error: false, result: "嗨" });
  assert.equal(c.stdinEnded, undefined);
  h.brain.send({ requestId: "r2", text: "第二轮" }, h.handlers);
  assert.equal(h.children.length, 1, "no respawn");
  assert.equal(c.writes.length, 2);
  const m = JSON.parse(c.writes[1]);
  assert.equal(m.type, "user");
  assert.equal(m.message.role, "user");
  assert.deepEqual(m.message.content, [{ type: "text", text: "第二轮" }]);
  assert.equal(typeof m.uuid, "string");
  assert.ok(c.writes[1].endsWith("\n"));
});

test("only main-session text_delta is forwarded; completed does not repeat streamed text", () => {
  const h = harness();
  h.brain.send({ requestId: "r1", text: "x" }, h.handlers);
  const c = h.children[0];
  c.emitLine(init());
  c.emitLine({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "secret" } } });
  c.emitLine({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } } });
  c.emitLine({ type: "log", text: "noise" });
  c.emitLine(delta("你"));
  c.stdout.emit("data", Buffer.from(JSON.stringify(delta("好")).slice(0, 20)));
  c.stdout.emit("data", Buffer.from(JSON.stringify(delta("好")).slice(20) + "\n"));
  c.emitLine({ type: "result", subtype: "success", is_error: false, result: "你好" });
  assert.deepEqual(h.events.deltas, ["你", "好"]);
  assert.deepEqual(h.events.done, ["你好"]);
});

test("completed without streaming deltas still delivers the result text once as delta-free completion", () => {
  const h = harness();
  h.brain.send({ requestId: "r1", text: "x" }, h.handlers);
  h.children[0].emitLine({ type: "result", subtype: "success", is_error: false, result: "整段" });
  assert.deepEqual(h.events.deltas, ["整段"]);
  assert.deepEqual(h.events.done, ["整段"]);
});

test("second send while in flight reports brain_busy", () => {
  const h = harness();
  h.brain.send({ requestId: "r1", text: "x" }, h.handlers);
  h.brain.send({ requestId: "r2", text: "y" }, h.handlers);
  assert.equal(h.events.errors[0].code, "brain_busy");
  assert.equal(h.children[0].writes.length, 1);
});

test("unsafe init (tools or connected mcp) fails closed and kills own child", () => {
  for (const bad of [{ tools: ["Bash"] }, { mcp_servers: [{ name: "x", status: "connected" }] }]) {
    const h = harness();
    h.brain.send({ requestId: "r1", text: "x" }, h.handlers);
    h.children[0].emitLine(init(bad));
    assert.equal(h.events.errors[0].code, "brain_unsafe");
    assert.ok(h.children[0].kills.length > 0);
  }
});

test("error results map to auth / quota / failed codes without leaking text", () => {
  const cases = [
    [{ subtype: "error_during_execution", result: "Invalid API key / please run /login" }, "brain_auth"],
    [{ subtype: "error_during_execution", result: "usage limit reached, quota exceeded" }, "brain_quota"],
    [{ subtype: "error_during_execution", result: "boom" }, "brain_failed"],
  ];
  for (const [r, code] of cases) {
    const h = harness();
    h.brain.send({ requestId: "r1", text: "x" }, h.handlers);
    h.children[0].emitLine({ type: "result", is_error: true, ...r });
    assert.equal(h.events.errors[0].code, code);
    assert.equal(JSON.stringify(h.events.errors[0]).includes("boom"), false);
  }
});

test("child exit reports brain_exited, stderr never forwarded, next send respawns", () => {
  const h = harness();
  h.brain.send({ requestId: "r1", text: "x" }, h.handlers);
  h.children[0].stderr.emit("data", Buffer.from("secret-stderr"));
  h.children[0].emit("exit", 1, null);
  assert.equal(h.events.errors[0].code, "brain_exited");
  assert.equal(JSON.stringify(h.events.errors).includes("secret"), false);
  h.brain.send({ requestId: "r2", text: "y" }, h.handlers);
  assert.equal(h.children.length, 2);
});

test("cancel: SIGINT, old turn callbacks go silent, kill after timeout and respawn", () => {
  const h = harness();
  h.brain.send({ requestId: "r1", text: "x" }, h.handlers);
  const c = h.children[0];
  c.emitLine(init());
  c.emitLine(delta("a"));
  h.brain.cancel();
  assert.deepEqual(c.kills, ["SIGINT"]);
  c.emitLine(delta("late"));
  c.emitLine({ type: "result", is_error: false, result: "late" });
  assert.deepEqual(h.events.deltas, ["a"]);
  assert.deepEqual(h.events.done, []);
  assert.equal(h.timers.at(-1).ms, 500);
});

test("cancel: no confirmation within timeout kills own process and forces respawn", () => {
  const h = harness();
  h.brain.send({ requestId: "r1", text: "x" }, h.handlers);
  const c = h.children[0];
  h.brain.cancel();
  h.timers.at(-1).fn();
  assert.ok(c.kills.includes("SIGKILL"));
  h.brain.send({ requestId: "r2", text: "y" }, h.handlers);
  assert.equal(h.children.length, 2);
});

test("cancel: a result arriving before the timeout counts as confirmation and keeps the process", () => {
  const h = harness();
  h.brain.send({ requestId: "r1", text: "x" }, h.handlers);
  const c = h.children[0];
  h.brain.cancel();
  c.emitLine({ type: "result", is_error: true, subtype: "error_during_execution", result: "interrupted" });
  assert.ok(h.timers.at(-1).cleared);
  h.brain.send({ requestId: "r2", text: "y" }, h.handlers);
  assert.equal(h.children.length, 1);
  assert.equal(c.writes.length, 2);
  assert.deepEqual(h.events.errors, []);
});

test("cancel on win32 terminates own process without relying on SIGINT", () => {
  const h = harness({ platform: "win32" });
  h.brain.send({ requestId: "r1", text: "x" }, h.handlers);
  h.brain.cancel();
  assert.ok(!h.children[0].kills.includes("SIGINT"));
  assert.ok(h.children[0].kills.length > 0);
  h.brain.send({ requestId: "r2", text: "y" }, h.handlers);
  assert.equal(h.children.length, 2);
});

test("reset terminates the child; dispose also rejects later sends", () => {
  const h = harness();
  h.brain.send({ requestId: "r1", text: "x" }, h.handlers);
  h.brain.reset();
  assert.ok(h.children[0].kills.length > 0);
  h.brain.dispose();
  h.brain.send({ requestId: "r2", text: "y" }, h.handlers);
  assert.equal(h.children.length, 1);
  assert.equal(h.events.errors.at(-1).code, "brain_disposed");
});

// ── probe ──
const HELP = "-p --input-format --output-format --verbose --include-partial-messages --tools --disallowedTools --strict-mcp-config --mcp-config --safe-mode --settings --no-session-persistence --system-prompt";
function probeHarness({ help = HELP, auth = { loggedIn: true, authMethod: "claude.ai" }, env = {}, managed = null } = {}) {
  const execFile = (cmd, args, o, cb) => {
    const a = args.join(" ");
    if (a === "--version") return cb(null, "2.1.295 (Claude Code)\n", "");
    if (a === "--help") return cb(null, help, "");
    if (a === "auth status") return cb(null, JSON.stringify(auth), "");
    return cb(new Error("unexpected " + a));
  };
  return createClaudeBrain({
    claudePath: "/bin/claude", execFile, spawn: () => { throw new Error("no spawn in probe"); },
    env: { PATH: "/usr/bin", ...env }, platform: "darwin",
    readFile: (p) => (managed && p.includes("managed-settings.json") ? managed : null),
  });
}

test("probe ok on subscription auth with all flags", async () => {
  const r = await probeHarness().probe();
  assert.equal(r.ok, true);
  assert.match(r.version, /2\.1\.295/);
});

test("probe reports missing flag, api auth, logged out, env conflict, managed hooks", async () => {
  assert.equal((await probeHarness({ help: HELP.replace("--safe-mode", "") }).probe()).reason, "missing-flag:--safe-mode");
  assert.equal((await probeHarness({ auth: { loggedIn: true, authMethod: "api_key" } }).probe()).reason, "auth-not-subscription");
  assert.equal((await probeHarness({ auth: { loggedIn: false } }).probe()).reason, "not-logged-in");
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
    const r = await probeHarness({ env: { [k]: "1" } }).probe();
    assert.equal(r.reason, "auth-conflict-env");
    assert.equal(JSON.stringify(r).includes('"1"'), false);
  }
  const managed = JSON.stringify({ hooks: { PreToolUse: [] }, allowManagedHooksOnly: true });
  assert.equal((await probeHarness({ managed }).probe()).reason, "managed-hooks");
});

test("missing claude binary yields a clear error", async () => {
  const b = createClaudeBrain({
    claudePath: "/nope/claude", env: {}, platform: "darwin",
    execFile: (c, a, o, cb) => cb(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
  });
  assert.equal((await b.probe()).reason, "claude-not-found");
});

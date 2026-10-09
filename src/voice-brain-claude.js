"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { randomUUID } = require("node:crypto");
const P = require("./voice-brain-claude-protocol");
const { errorFields } = require("./voice-debug-log");

const MANAGED_PATHS = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/etc/claude-code/managed-settings.json",
];

const readText = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };

function createClaudeBrain(opts = {}) {
  const claudePath = opts.claudePath || path.join(os.homedir(), ".local", "bin", "claude");
  const spawn = opts.spawn || cp.spawn;
  const execFile = opts.execFile || cp.execFile;
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  const cancelTimeoutMs = opts.cancelTimeoutMs ?? 500;
  const readFile = opts.readFile || readText;
  const systemPrompt = opts.systemPrompt || P.VOICE_SYSTEM_PROMPT;
  const log = opts.log || (() => {});

  // child: only ever our own process. turn: the single in-flight request.
  const s = { child: null, buf: "", turn: null, cancelTimer: null, cancelPending: false, disposed: false, inited: false };

  function killChild(signal = "SIGKILL") {
    const c = s.child;
    if (!c) return;
    try { c.kill(signal); } catch { /* already gone */ }
  }

  function dropChild() {
    if (s.cancelTimer) clearT(s.cancelTimer);
    s.cancelTimer = null;
    s.cancelPending = false;
    s.child = null;
    s.buf = "";
    s.inited = false;
  }

  function terminate() {
    killChild("SIGKILL");
    dropChild();
  }

  function failTurn(code) {
    const t = s.turn;
    s.turn = null;
    if (t) t.handlers.onError({ code });
  }

  function handleResult(msg) {
    if (s.cancelPending) {
      // Interrupt confirmed: keep the process, drop the old turn silently.
      if (s.cancelTimer) clearT(s.cancelTimer);
      s.cancelTimer = null;
      s.cancelPending = false;
      return;
    }
    const t = s.turn;
    if (!t) return;
    if (P.isErrorResult(msg)) return failTurn(P.classifyError(msg));
    s.turn = null;
    const result = typeof msg.result === "string" ? msg.result : "";
    if (!t.text && result) t.handlers.onTextDelta(result);
    t.handlers.onCompleted(t.text || result);
  }

  function handleMessage(msg) {
    if (msg.type === "system" && msg.subtype === "init") {
      if (!s.inited && P.isInitUnsafe(msg)) {
        terminate();
        failTurn("brain_unsafe");
        return;
      }
      s.inited = true;
      return;
    }
    if (msg.type === "result") return handleResult(msg);
    const delta = P.extractTextDelta(msg);
    if (delta && s.turn && !s.cancelPending) {
      s.turn.text += delta;
      s.turn.handlers.onTextDelta(delta);
    }
  }

  function onStdout(child, chunk) {
    if (child !== s.child) return;
    s.buf += chunk.toString("utf8");
    let idx;
    while (child === s.child && (idx = s.buf.indexOf("\n")) >= 0) {
      const line = s.buf.slice(0, idx);
      s.buf = s.buf.slice(idx + 1);
      const msg = P.parseLine(line);
      if (msg) handleMessage(msg);
    }
  }

  function onGone(child) {
    if (child !== s.child) return;
    dropChild();
    failTurn("brain_exited");
  }

  function start() {
    const child = spawn(claudePath, P.buildClaudeArgs(systemPrompt), {
      env: P.scrubEnv(env),
      cwd: opts.cwd || os.tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    s.child = child;
    s.buf = "";
    s.inited = false;
    s.stderr = "";
    log("brain_spawn", { pid: child.pid, claudePath });
    child.stdout.on("data", (c) => onStdout(child, c));
    // Never forwarded to the user/renderer; only the first 300 chars go to the local debug log.
    child.stderr.on("data", (c) => { if (s.stderr.length < 300) s.stderr += c.toString("utf8"); });
    child.on("exit", (code, signal) => {
      log("brain_exit", { code, signal, stderr: s.stderr.slice(0, 300) });
      onGone(child);
    });
    child.on("error", (e) => {
      log("brain_spawn_error", { ...errorFields(e), code: e && e.code });
      onGone(child);
    });
    return child;
  }

  function send({ requestId, text }, handlers) {
    if (s.disposed) return handlers.onError({ code: "brain_disposed" });
    if (s.turn) return handlers.onError({ code: "brain_busy" });
    // An unconfirmed interrupt may still emit the old turn's result: start clean.
    if (s.cancelPending) terminate();
    const child = s.child || start();
    s.turn = { requestId, handlers, text: "" };
    const line = JSON.stringify({
      type: "user",
      uuid: randomUUID(),
      message: { role: "user", content: [{ type: "text", text: String(text) }] },
    });
    try { child.stdin.write(line + "\n"); } catch (e) { log("exception", { where: "brain.stdin.write", ...errorFields(e) }); onGone(child); }
  }

  function cancel() {
    if (!s.turn) return;
    s.turn = null;
    if (platform === "win32") return terminate();
    s.cancelPending = true;
    killChild("SIGINT");
    const child = s.child;
    s.cancelTimer = setT(() => { if (child === s.child) terminate(); }, cancelTimeoutMs);
  }

  const reset = () => { s.turn = null; terminate(); };
  const dispose = () => { s.disposed = true; reset(); };

  function run(args) {
    return new Promise((resolve) => {
      execFile(claudePath, args, { env: P.scrubEnv(env), timeout: 15000 }, (err, stdout) => {
        resolve({ err, out: String(stdout || "") });
      });
    });
  }

  async function probe() {
    const conflict = P.AUTH_CONFLICT_ENV.find((k) => env[k]);
    if (conflict) return { ok: false, reason: "auth-conflict-env" };
    if (MANAGED_PATHS.some((p) => P.managedHooksBlock(readFile(p)))) return { ok: false, reason: "managed-hooks" };
    const ver = await run(["--version"]);
    if (ver.err) return { ok: false, reason: ver.err.code === "ENOENT" ? "claude-not-found" : "version-failed" };
    const help = await run(["--help"]);
    const missing = P.REQUIRED_FLAGS.find((f) => !help.out.includes(f));
    if (help.err || missing) return { ok: false, reason: `missing-flag:${missing || "--help"}` };
    const auth = await run(["auth", "status"]);
    let info = null;
    try { info = JSON.parse(auth.out); } catch { /* handled below */ }
    if (!info || info.loggedIn !== true) return { ok: false, reason: "not-logged-in" };
    if (info.authMethod !== "claude.ai") return { ok: false, reason: "auth-not-subscription" };
    return { ok: true, version: ver.out.trim() };
  }

  return { id: "claude-code", probe, send, cancel, reset, dispose };
}

module.exports = {
  createClaudeBrain,
  VOICE_SYSTEM_PROMPT: P.VOICE_SYSTEM_PROMPT,
  CLAUDE_ENV_SCRUB: P.CLAUDE_ENV_SCRUB,
};

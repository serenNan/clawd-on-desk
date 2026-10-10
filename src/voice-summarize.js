"use strict";

// Long converse text -> 1-3 spoken sentences via a one-shot Haiku call through
// the user's Claude CLI login (no API key). Same lockdown as the voice brain:
// no tools, no MCP, no hooks, no session file. On timeout/failure the first two
// sentences are read instead. Only lengths and timings are logged, never text.
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const P = require("./voice-brain-claude-protocol");

const SUMMARY_MODEL = "claude-haiku-5-5";
const SUMMARY_TIMEOUT_MS = 8000;
const FALLBACK_SENTENCES = 2;
const MAX_INPUT_CHARS = 12000;
const MAX_OUTPUT_CHARS = 300;
const SUMMARY_SYSTEM_PROMPT = "你把一段较长的文字压成语音播报稿。只输出要念出来的口语，一到三句自然中文，不要 Markdown、列表、路径、代码或链接。保留结论，以及需要用户决定或确认的事；细节一律省略。不要加开场白，不要说“摘要”。";

const visibleLength = (text) => String(text || "").replace(/\s+/g, "").length;

function firstSentences(text, n = FALLBACK_SENTENCES) {
  const parts = String(text || "").replace(/\s+/g, " ").trim().match(/[^。！？!?；;\n]+[。！？!?；;]?/g) || [];
  return parts.slice(0, n).join("").trim().slice(0, MAX_OUTPUT_CHARS);
}

function buildSummaryArgs(model = SUMMARY_MODEL) {
  return [
    "-p", "--model", model, "--output-format", "text",
    "--tools", "", "--disallowedTools", "*",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--safe-mode", "--settings", '{"disableAllHooks":true}',
    "--no-session-persistence", "--system-prompt", SUMMARY_SYSTEM_PROMPT,
  ];
}

function createSummarizer(opts = {}) {
  const spawn = opts.spawn || cp.spawn;
  const getClaudePath = opts.getClaudePath || (() => "");
  const timeoutMs = opts.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  const log = opts.log || (() => {});
  const now = opts.now || Date.now;
  const baseEnv = P.scrubEnv(opts.env || process.env);
  for (const k of P.AUTH_CONFLICT_ENV) delete baseEnv[k]; // stay on the subscription login

  // Always resolves: { text, summarized } where summarized=false means the fallback was used.
  function summarize(text) {
    const t0 = now();
    const input = String(text || "").slice(0, MAX_INPUT_CHARS);
    return new Promise((resolve) => {
      let done = false;
      let child = null;
      let out = "";
      const finish = (summary, reason) => {
        if (done) return;
        done = true;
        clearT(timer);
        try { if (child) child.kill("SIGKILL"); } catch { /* already gone */ }
        const clean = String(summary || "").replace(/\s+/g, " ").trim().slice(0, MAX_OUTPUT_CHARS);
        if (clean && !reason) {
          log("summarize_done", { inLen: visibleLength(text), outLen: clean.length, ms: now() - t0 });
          resolve({ text: clean, summarized: true });
        } else {
          log("summarize_fallback", { reason, inLen: visibleLength(text), ms: now() - t0 });
          resolve({ text: firstSentences(text), summarized: false });
        }
      };
      const timer = setT(() => finish("", "timeout"), timeoutMs);
      try {
        child = spawn(getClaudePath() || path.join(os.homedir(), ".local", "bin", "claude"), buildSummaryArgs(opts.model), {
          cwd: os.tmpdir(), env: baseEnv, stdio: ["pipe", "pipe", "ignore"],
        });
        child.on("error", () => finish("", "spawn_error"));
        child.on("close", (code) => finish(out, code === 0 ? (out.trim() ? "" : "empty") : "exit_nonzero"));
        child.stdout.on("data", (c) => { out += c.toString("utf8"); });
        child.stdin.on("error", () => {});
        child.stdin.end(input);
      } catch {
        finish("", "spawn_error");
      }
    });
  }

  return { summarize };
}

module.exports = { createSummarizer, firstSentences, buildSummaryArgs, visibleLength, SUMMARY_MODEL, SUMMARY_SYSTEM_PROMPT };

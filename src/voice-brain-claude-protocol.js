"use strict";

// Pure helpers for Claude Code's stream-json protocol. No process handling here.

const VOICE_SYSTEM_PROMPT = "你是桌宠语音聊天伙伴。用自然中文口语和短句回答，通常一到三句。先直接回应，再补必要信息。不用 Markdown、列表、代码块或朗读格式符号。遇到电脑操作请求，说明当前只聊天，不执行工具。你只知道实际已播完的对话；被打断的后半句不要当作用户已听见。";

function buildClaudeArgs(systemPrompt = VOICE_SYSTEM_PROMPT) {
  return [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--include-partial-messages",
    "--tools", "", "--disallowedTools", "*",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--safe-mode", "--settings", '{"disableAllHooks":true}',
    "--no-session-persistence", "--system-prompt", systemPrompt,
  ];
}

const REQUIRED_FLAGS = [
  "--input-format", "--output-format", "--verbose", "--include-partial-messages",
  "--tools", "--disallowedTools", "--strict-mcp-config", "--mcp-config",
  "--safe-mode", "--settings", "--no-session-persistence", "--system-prompt",
];

// Inherited from an outer Claude Code session; would pollute session/persistence.
const CLAUDE_ENV_SCRUB = Object.freeze([
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE", "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED",
]);

// Would silently move billing off the subscription login.
const AUTH_CONFLICT_ENV = Object.freeze([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
]);

function scrubEnv(env) {
  const out = { ...env };
  for (const k of CLAUDE_ENV_SCRUB) delete out[k];
  return out;
}

function parseLine(line) {
  const s = line.trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function extractTextDelta(msg) {
  if (!msg || msg.type !== "stream_event" || !msg.event) return null;
  const { event } = msg;
  if (event.type !== "content_block_delta" || !event.delta) return null;
  return event.delta.type === "text_delta" && typeof event.delta.text === "string" ? event.delta.text : null;
}

function isInitUnsafe(msg) {
  const tools = Array.isArray(msg.tools) ? msg.tools : [];
  const mcp = Array.isArray(msg.mcp_servers) ? msg.mcp_servers : [];
  return tools.length > 0 || mcp.length > 0;
}

function classifyError(msg) {
  const text = typeof msg.result === "string" ? msg.result : "";
  if (/login|api key|authenticat|unauthori[sz]ed|\b401\b/i.test(text)) return "brain_auth";
  if (/usage limit|quota|rate limit|\b429\b|overloaded|credit/i.test(text)) return "brain_quota";
  return "brain_failed";
}

function isErrorResult(msg) {
  return msg.is_error === true || (typeof msg.subtype === "string" && msg.subtype.startsWith("error"));
}

function managedHooksBlock(raw) {
  if (!raw) return false;
  try {
    const cfg = JSON.parse(raw);
    const hooks = cfg && cfg.hooks;
    return cfg.allowManagedHooksOnly === true || (!!hooks && typeof hooks === "object" && Object.keys(hooks).length > 0);
  } catch { return false; }
}

module.exports = {
  VOICE_SYSTEM_PROMPT, REQUIRED_FLAGS, CLAUDE_ENV_SCRUB, AUTH_CONFLICT_ENV,
  buildClaudeArgs, scrubEnv, parseLine, extractTextDelta, isInitUnsafe,
  classifyError, isErrorResult, managedHooksBlock,
};

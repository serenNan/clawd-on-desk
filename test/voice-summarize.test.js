"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { createSummarizer, firstSentences, buildSummaryArgs, SUMMARY_MODEL } = require("../src/voice-summarize");
const { REQUIRED_FLAGS } = require("../src/voice-brain-claude-protocol");

function fakeCli(behaviour) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end(data) { child.stdinData = data; setImmediate(() => behaviour(child)); } });
    child.killed = false;
    child.kill = () => { child.killed = true; };
    calls.push({ bin, args, opts, child });
    return child;
  };
  return { spawn, calls };
}
const harness = (behaviour, extra = {}) => {
  const cli = fakeCli(behaviour);
  const logs = [];
  const s = createSummarizer({ spawn: cli.spawn, log: (e, f) => logs.push([e, f]), env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-x", CLAUDE_CODE_SESSION_ID: "abc" }, ...extra });
  return { s, cli, logs };
};

test("runs Haiku one-shot with the voice brain lockdown, text on stdin, subscription env", async () => {
  const h = harness((c) => { c.stdout.emit("data", Buffer.from("  结论是测试通过了，\n要不要合并？ ")); c.emit("close", 0); });
  const r = await h.s.summarize("很长的一段文字");
  assert.deepEqual(r, { text: "结论是测试通过了， 要不要合并？", summarized: true });
  const { args, opts, child } = h.cli.calls[0];
  assert.equal(args[args.indexOf("--model") + 1], SUMMARY_MODEL);
  for (const f of ["--tools", "--disallowedTools", "--strict-mcp-config", "--mcp-config", "--safe-mode", "--settings", "--no-session-persistence", "--system-prompt"]) assert.ok(args.includes(f), f);
  assert.ok(args.includes("-p") && REQUIRED_FLAGS.includes("--safe-mode"));
  assert.equal(args.join(" ").includes("很长的一段文字"), false, "text never on argv");
  assert.equal(child.stdinData, "很长的一段文字");
  assert.equal(opts.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(opts.env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.match(args[args.indexOf("--system-prompt") + 1], /Markdown/);
});

test("timeout falls back to the first two sentences and logs summarize_fallback with lengths only", async () => {
  let fire;
  const h = harness(() => {}, { setTimeout: (fn, ms) => { fire = { fn, ms }; return 1; }, clearTimeout() {} });
  const p = h.s.summarize("第一句。第二句！第三句？");
  await new Promise((r) => setImmediate(r));
  assert.equal(fire.ms, 8000);
  fire.fn();
  assert.deepEqual(await p, { text: "第一句。第二句！", summarized: false });
  assert.equal(h.cli.calls[0].child.killed, true);
  const [ev, f] = h.logs.at(-1);
  assert.equal(ev, "summarize_fallback");
  assert.equal(f.reason, "timeout");
  assert.equal(JSON.stringify(h.logs).includes("第一句"), false);
});

test("non-zero exit, empty output and spawn errors all fall back", async () => {
  for (const [b, reason] of [
    [(c) => c.emit("close", 1), "exit_nonzero"],
    [(c) => c.emit("close", 0), "empty"],
    [(c) => c.emit("error", new Error("ENOENT")), "spawn_error"],
  ]) {
    const h = harness(b);
    const r = await h.s.summarize("甲。乙。丙。");
    assert.deepEqual(r, { text: "甲。乙。", summarized: false });
    assert.equal(h.logs.at(-1)[1].reason, reason);
  }
  const h = harness(() => {}, { spawn: () => { throw new Error("boom"); } });
  assert.equal((await h.s.summarize("甲。乙。丙。")).summarized, false);
});

test("firstSentences keeps two sentences and caps length", () => {
  assert.equal(firstSentences("一。二。三。"), "一。二。");
  assert.equal(firstSentences("没有标点的很长文字".repeat(50)).length, 300);
  assert.ok(buildSummaryArgs().length > 10);
});

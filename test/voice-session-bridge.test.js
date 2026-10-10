"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createSessionBridge, isEndPhrase } = require("../src/voice-session-bridge");

function makeHarness({ total = 3, heard = [] } = {}) {
  const h = { phases: [], speaks: [], cancels: 0, logs: [], heard, timers: [] };
  const setTimeoutFn = (fn, ms) => { const t = { fn, ms, cleared: false }; h.timers.push(t); return t; };
  const clearTimeoutFn = (t) => { if (t) t.cleared = true; };
  h.bridge = createSessionBridge({
    speak: (text) => { h.speaks.push(text); return { turnId: h.speaks.length, total }; },
    heard: () => h.heard,
    countSentences: () => total,
    setPhase: (p) => h.phases.push(p),
    log: (e, f) => h.logs.push([e, f]),
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
  });
  h.live = () => h.timers.filter((t) => !t.cleared);
  return h;
}

test("normal round: speaks, waits for idle, returns the next final", async () => {
  const h = makeHarness();
  const p = h.bridge.converse({ text: "你好" });
  assert.deepEqual(h.speaks, ["你好"]);
  h.bridge.onIdle();
  h.bridge.onUserFinal("今天天气怎么样");
  assert.deepEqual(await p, { interrupted: false, user: "今天天气怎么样" });
  assert.equal(h.phases.at(-1), "thinking");
});

test("interrupted while speaking returns played / unplayed_count / user", async () => {
  const h = makeHarness({ total: 3, heard: ["第一句。"] });
  const p = h.bridge.converse({ text: "第一句。第二句。第三句。" });
  h.bridge.onInterrupt();
  h.bridge.onIdle();
  h.bridge.onUserFinal("等一下");
  assert.deepEqual(await p, { interrupted: true, played: "第一句。", unplayed_count: 2, user: "等一下" });
});

test("timeout fires only after speech is idle; returns {timeout:true}", async () => {
  const h = makeHarness();
  const p = h.bridge.converse({ text: "测试一下", timeoutS: 3 });
  assert.equal(h.live().some((t) => t.ms === 3000), false);
  h.bridge.onIdle();
  const t = h.live().find((x) => x.ms === 3000);
  assert.ok(t);
  t.fn();
  assert.deepEqual(await p, { timeout: true });
});

test("empty text waits immediately in listening and default timeout is 120s", async () => {
  const h = makeHarness();
  const p = h.bridge.converse({});
  assert.equal(h.phases.at(-1), "listening");
  assert.ok(h.live().find((t) => t.ms === 120000));
  h.bridge.onUserFinal("在吗");
  assert.deepEqual(await p, { interrupted: false, user: "在吗" });
});

test("new converse supersedes the pending one", async () => {
  const h = makeHarness();
  const first = h.bridge.converse({ text: "a" });
  const second = h.bridge.converse({ text: "b" });
  assert.deepEqual(await first, { superseded: true });
  h.bridge.onIdle();
  h.bridge.onUserFinal("好");
  assert.deepEqual(await second, { interrupted: false, user: "好" });
});

test("end phrase returns {ended:true}", async () => {
  const h = makeHarness();
  const p = h.bridge.converse({});
  h.bridge.onUserFinal("好了，结束语音吧。");
  assert.deepEqual(await p, { ended: true });
  assert.equal(isEndPhrase("退出语音"), true);
  assert.equal(isEndPhrase("我想了解一下怎么结束语音通话这个功能的原理"), false);
});

test("speech while Claude is thinking is queued and delivered by the next converse", async () => {
  const h = makeHarness({ total: 2 });
  h.bridge.onUserFinal("补充一句");
  h.bridge.onUserFinal("还有一句");
  const p = h.bridge.converse({ text: "旧的回复。还有。" });
  assert.deepEqual(h.speaks, []);
  assert.deepEqual(await p, { interrupted: true, played: "", unplayed_count: 2, user: "补充一句，还有一句" });
  const q = h.bridge.converse({});
  h.bridge.onUserFinal("x");
  assert.equal((await q).user, "x");
});

test("dispose ends the pending converse; abort signal resolves quietly", async () => {
  const h = makeHarness();
  const p = h.bridge.converse({});
  h.bridge.dispose();
  assert.deepEqual(await p, { ended: true, reason: "stopped" });
  const ac = new AbortController();
  const q = h.bridge.converse({ signal: ac.signal });
  ac.abort();
  assert.deepEqual(await q, { aborted: true });
});

test("logs carry outcome and timing but never text", async () => {
  const h = makeHarness();
  const p = h.bridge.converse({ text: "机密内容" });
  h.bridge.onIdle();
  h.bridge.onUserFinal("用户机密");
  await p;
  const dump = JSON.stringify(h.logs);
  assert.ok(h.logs.some(([e, f]) => e === "converse_done" && f.outcome === "user" && typeof f.ms === "number"));
  assert.equal(dump.includes("机密"), false);
});

test("takeOver ends the pending converse with taken_over and drops queued finals", async () => {
  const h = makeHarness();
  h.bridge.onUserFinal("排队的话");
  const p = h.bridge.converse({ text: "" });
  assert.equal((await p).user, "排队的话");
  const p2 = h.bridge.converse({ text: "你好" });
  h.bridge.takeOver();
  assert.deepEqual(await p2, { ended: true, reason: "taken_over" });
  assert.equal(h.bridge.hasWaiter(), false);
  assert.equal(h.live().length, 0, "timers cleared");
  h.bridge.onUserFinal("旧的残留");
  h.bridge.takeOver();
  const p3 = h.bridge.converse({ text: "" });
  h.live()[0].fn();
  assert.deepEqual(await p3, { timeout: true }, "stale queued text did not leak to the new waiter");
});

// ---- long text is summarized before it is spoken ----
function summarizingHarness({ over = 20, result = { text: "简短摘要。", summarized: true }, heard = [] } = {}) {
  const h = makeHarness({ heard });
  h.sums = [];
  h.pending = null;
  h.bridge = createSessionBridge({
    speak: (text) => { h.speaks.push(text); return { turnId: 1, total: 1 }; },
    heard: () => h.heard,
    countSentences: () => 1,
    setPhase: (p) => h.phases.push(p),
    log: (e, f) => h.logs.push([e, f]),
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; h.timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
    summarizeOver: () => over,
    summarize: (text) => { h.sums.push(text); return new Promise((resolve) => { h.pending = () => resolve(result); }); },
  });
  return h;
}
const LONG = "这是一段很长很长的文字，".repeat(10);

test("text over the threshold is summarized first; the summary is spoken and reported as played", async () => {
  const h = summarizingHarness();
  const p = h.bridge.converse({ text: LONG });
  assert.deepEqual(h.speaks, [], "nothing spoken while summarizing");
  assert.equal(h.phases.at(-1), "thinking");
  h.pending(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(h.speaks, ["简短摘要。"]);
  h.bridge.onIdle();
  h.bridge.onUserFinal("好的");
  assert.deepEqual(await p, { interrupted: false, user: "好的", played: "简短摘要。", summarized: true });
});

test("short text, threshold 0, or fallback summaries behave as documented", async () => {
  const short = summarizingHarness();
  short.bridge.converse({ text: "短" });
  assert.deepEqual(short.speaks, ["短"]);
  assert.deepEqual(short.sums, []);
  const off = summarizingHarness({ over: 0 });
  off.bridge.converse({ text: LONG });
  assert.deepEqual(off.speaks, [LONG]);
  const fb = summarizingHarness({ result: { text: "前两句。", summarized: false } });
  const p = fb.bridge.converse({ text: LONG });
  fb.pending(); await Promise.resolve(); await Promise.resolve();
  fb.bridge.onIdle(); fb.bridge.onUserFinal("嗯");
  const r = await p;
  assert.equal(r.summarized, true, "user only heard a shortened version either way");
  assert.equal(r.played, "前两句。");
});

test("interrupted summary keeps the heard sentences in played; takeOver/dispose during summarizing ends cleanly", async () => {
  const h = summarizingHarness({ heard: ["简短摘要。"] });
  const p = h.bridge.converse({ text: LONG });
  h.pending(); await Promise.resolve(); await Promise.resolve();
  h.bridge.onInterrupt(); h.bridge.onIdle(); h.bridge.onUserFinal("等等");
  assert.deepEqual(await p, { interrupted: true, played: "简短摘要。", unplayed_count: 0, user: "等等", summarized: true });
  const g = summarizingHarness();
  const q = g.bridge.converse({ text: LONG });
  g.bridge.takeOver();
  assert.deepEqual(await q, { ended: true, reason: "taken_over" });
  g.pending(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(g.speaks, [], "late summary of a dead converse is never spoken");
});

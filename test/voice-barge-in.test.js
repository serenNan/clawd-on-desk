"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createBargeIn, isBackchannel } = require("../src/voice-barge-in");

function rig(opts = {}) {
  let t = 1000;
  const timers = [];
  const calls = [];
  const sink = {
    duck: (db) => calls.push(["duck", db]),
    restore: () => calls.push(["restore"]),
    stop: () => calls.push(["stop"]),
  };
  const commits = [];
  const b = createBargeIn({
    sink,
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms, live: true }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.live = false; },
    onCommit: (r) => { calls.push(["commit", r]); commits.push(r); },
    ...opts,
  });
  const advance = (ms) => {
    const target = t + ms;
    for (;;) {
      const next = timers.filter((h) => h.live && h.at <= target).sort((a, c) => a.at - c.at)[0];
      if (!next) break;
      next.live = false; t = next.at; next.fn();
    }
    t = target;
  };
  return { b, calls, commits, advance, names: () => calls.map((c) => c[0]) };
}

test("isBackchannel: filler words and punctuation only", () => {
  for (const s of ["嗯", "对", "好的", "嗯嗯", "嗯，对对。", "是的", "哦哦", "啊", "呃", "  ", "...", "嗯哼", "哈"]) {
    assert.equal(isBackchannel(s), true, s);
  }
  for (const s of ["等一下", "不对", "好的但是我想问", "你说什么", "stop"]) {
    assert.equal(isBackchannel(s), false, s);
  }
});

test("defaults: duck -8dB after 200ms of continuous voice, commit at 300ms", () => {
  const r = rig();
  r.b.setAssistantActive(true);
  r.b.onSpeechStart();
  r.advance(199);
  assert.deepEqual(r.calls, [], "no duck before 200ms");
  r.advance(1);
  assert.deepEqual(r.calls, [["duck", -8]]);
  assert.equal(r.b.stats.duckAt, 1200);
});

test("short noise (<200ms voiced) never ducks and never touches the volume", () => {
  const r = rig();
  r.b.setAssistantActive(true);
  r.b.onSpeechStart();
  r.advance(150);
  r.b.onSpeechEnd();
  r.advance(2000);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.commits, []);
});

test("speech-start is ignored while the assistant is silent", () => {
  const r = rig();
  r.b.onSpeechStart();
  r.advance(1000);
  assert.deepEqual(r.calls, []);
});

test("duck depth, duck delay and commit time are options", () => {
  const r = rig({ duckDb: -12, duckVoicedMs: 100, commitVoicedMs: 500 });
  r.b.setAssistantActive(true);
  r.b.onSpeechStart();
  r.advance(100);
  assert.deepEqual(r.calls, [["duck", -12]]);
  r.advance(399);
  assert.deepEqual(r.commits, []);
  r.advance(1);
  assert.deepEqual(r.commits, ["duration"]);
});

test("voiced >=300ms commits by duration (no partial needed): stop then onCommit", () => {
  const r = rig();
  r.b.setAssistantActive(true);
  r.b.onSpeechStart();
  r.advance(299);
  assert.deepEqual(r.names(), ["duck"]);
  r.advance(1);
  assert.deepEqual(r.calls.slice(1), [["stop"], ["commit", "duration"]]);
  assert.equal(r.b.stats.commitReason, "duration");
  assert.equal(r.b.stats.commitAt, 1300);
  r.advance(2000);
  assert.deepEqual(r.commits, ["duration"], "commits once");
});

test("substantive partial commits immediately, even before the duck delay", () => {
  const r = rig();
  r.b.setAssistantActive(true);
  r.b.onSpeechStart();
  r.advance(120);
  r.b.onPartial("等一下");
  assert.deepEqual(r.calls, [["stop"], ["commit", "partial"]]);
  r.b.onPartial("等一下我想");
  r.advance(1000);
  assert.deepEqual(r.commits, ["partial"]);
});

test("backchannel partial does not interrupt; volume restored 600ms after the duck", () => {
  const r = rig();
  r.b.setAssistantActive(true);
  r.b.onSpeechStart();
  r.advance(250);
  r.b.onPartial("嗯");
  r.b.onSpeechEnd();
  assert.deepEqual(r.names(), ["duck"]);
  r.advance(549); // 250 + 549 = duck(200) + 599
  assert.deepEqual(r.names(), ["duck"]);
  r.advance(1);
  assert.deepEqual(r.names(), ["duck", "restore"]);
  assert.equal(r.calls.some((c) => c[0] === "stop"), false);
  assert.equal(r.commits.length, 0);
});

test("late substantive partial after a short utterance still commits inside the window", () => {
  const r = rig();
  r.b.setAssistantActive(true);
  r.b.onSpeechStart();
  r.advance(150);
  r.b.onSpeechEnd();
  r.advance(200);
  r.b.onPartial("停一下");
  assert.deepEqual(r.commits, ["partial"]);
});

test("partial after the window is ignored; reset/reactivation re-arms commit", () => {
  const r = rig();
  r.b.setAssistantActive(true);
  r.b.onSpeechStart();
  r.advance(100);
  r.b.onSpeechEnd();
  r.advance(700);
  r.b.onPartial("等一下");
  assert.deepEqual(r.commits, []);
  r.b.onSpeechStart();
  r.advance(300);
  assert.deepEqual(r.commits, ["duration"]);
  r.b.setAssistantActive(false);
  r.b.setAssistantActive(true);
  r.b.onSpeechStart();
  r.advance(300);
  assert.deepEqual(r.commits, ["duration", "duration"]);
});

test("dispose clears pending timers", () => {
  const r = rig();
  r.b.setAssistantActive(true);
  r.b.onSpeechStart();
  r.b.dispose();
  r.advance(2000);
  assert.deepEqual(r.calls, []);
});

test("partialOnly: continuous non-speech sound (music) never ducks or stops playback", () => {
  const { b, calls, advance } = rig({ partialOnly: true });
  b.setAssistantActive(true);
  b.onSpeechStart();
  advance(5000);
  b.onPartial("");
  b.onPartial("嗯");
  b.onSpeechEnd();
  advance(2000);
  assert.deepEqual(calls, []);
});

test("partialOnly: substantive partial stops playback even if it arrives late in the utterance", () => {
  const { b, commits, advance } = rig({ partialOnly: true });
  b.setAssistantActive(true);
  b.onSpeechStart();
  advance(1500);
  b.onPartial("等一下");
  assert.deepEqual(commits, ["partial"]);
});

test("partialOnly: partial shortly after speech end still counts, stale partial does not", () => {
  const late = rig({ partialOnly: true });
  late.b.setAssistantActive(true);
  late.b.onSpeechStart(); late.advance(400); late.b.onSpeechEnd(); late.advance(300);
  late.b.onPartial("等一下");
  assert.deepEqual(late.commits, ["partial"]);
  const stale = rig({ partialOnly: true });
  stale.b.setAssistantActive(true);
  stale.b.onSpeechStart(); stale.advance(400); stale.b.onSpeechEnd(); stale.advance(5000);
  stale.b.onPartial("等一下");
  assert.deepEqual(stale.commits, []);
});

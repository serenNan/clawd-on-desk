"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createUtteranceMerger } = require("../src/voice-utterance-merge");

function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

function make(opts = {}) {
  const c = clock();
  const out = [];
  const logs = [];
  const m = createUtteranceMerger({ deliver: (t) => out.push(t), gapMs: 600, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout, log: (e, f) => logs.push([e, f]), ...opts });
  return { m, c, out, logs };
}

test("a final is held for the gap, then delivered alone (long pause cuts the sentence)", () => {
  const h = make();
  h.m.onFinal("你好");
  h.c.advance(599);
  assert.deepEqual(h.out, []);
  h.c.advance(1);
  assert.deepEqual(h.out, ["你好"]);
});

test("speech-start within the gap holds delivery; the next final is merged into one sentence", () => {
  const h = make();
  h.m.onFinal("你这个音调太");
  h.c.advance(400);
  h.m.onSpeechStart();
  h.c.advance(5000); // user is still talking: nothing delivered
  assert.deepEqual(h.out, []);
  h.m.onFinal("太平静了");
  h.c.advance(599);
  assert.deepEqual(h.out, []);
  h.c.advance(1);
  assert.deepEqual(h.out, ["你这个音调太太平静了"]);
  assert.deepEqual(h.logs.filter(([e]) => e === "utterance_merged").map(([, f]) => f.parts), [2]);
});

test("speech-start after the gap has elapsed starts a fresh utterance", () => {
  const h = make();
  h.m.onFinal("第一句");
  h.c.advance(601);
  h.m.onSpeechStart();
  h.m.onFinal("第二句");
  h.c.advance(601);
  assert.deepEqual(h.out, ["第一句", "第二句"]);
});

test("three segments chain; latin words keep a space", () => {
  const h = make();
  h.m.onFinal("open");
  h.m.onSpeechStart();
  h.m.onFinal("the door");
  h.c.advance(300);
  h.m.onSpeechStart();
  h.m.onFinal("请");
  h.c.advance(600);
  assert.deepEqual(h.out, ["open the door请"]);
});

test("a noise/empty segment after speech-start does not hold the sentence forever", () => {
  const h = make();
  h.m.onFinal("你好");
  h.m.onSpeechStart();
  h.c.advance(2000);
  h.m.onDiscard();
  h.c.advance(599);
  assert.deepEqual(h.out, []);
  h.c.advance(1);
  assert.deepEqual(h.out, ["你好"]);
});

test("if the awaited final never comes, a safety timeout still delivers", () => {
  const h = make({ holdMaxMs: 10000 });
  h.m.onFinal("你好");
  h.m.onSpeechStart();
  h.c.advance(10000);
  assert.deepEqual(h.out, ["你好"]);
});

test("awaitingNext: a later segment is already in progress when the final arrives", () => {
  const h = make();
  h.m.onFinal("前半句", { awaitingNext: true });
  h.c.advance(3000);
  assert.deepEqual(h.out, []);
  h.m.onFinal("后半句");
  h.c.advance(600);
  assert.deepEqual(h.out, ["前半句后半句"]);
});

test("speech-start with nothing pending is a no-op; dispose drops the pending text", () => {
  const h = make();
  h.m.onSpeechStart();
  h.m.onFinal("丢掉");
  h.m.dispose();
  h.c.advance(5000);
  assert.deepEqual(h.out, []);
});

test("gapMs 0 delivers synchronously (merging off)", () => {
  const h = make({ gapMs: 0 });
  h.m.onFinal("立刻");
  assert.deepEqual(h.out, ["立刻"]);
});

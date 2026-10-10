"use strict";

// Voice mute / wake commands, handled locally in the runtime (never reach the Claude session).
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeHarness, say } = require("./fixtures/voice-runtime-harness");
const { isMuteCommand, isResumeCommand } = require("../src/voice-commands");

const flush = () => new Promise((r) => setImmediate(r));
const logged = (h, ev) => h.rec.logs.filter(([e]) => e === ev);

test("isMuteCommand: whole short sentence only", () => {
  for (const t of ["静音", "静音。", "先静音", "静音吧", "静音一下", "请静音", "静音啊！", "先静音一下吧"]) assert.equal(isMuteCommand(t), true, t);
  for (const t of ["这个静音功能怎么样", "我想把电视静音然后继续", "", "静音模式是什么意思", "不要静音"]) assert.equal(isMuteCommand(t), false, t);
});

test("isResumeCommand: contains 恢复语音 once punctuation is stripped", () => {
  for (const t of ["恢复语音", "恢复语音。", "好了，恢复语音吧", "恢复，语音"]) assert.equal(isResumeCommand(t), true, t);
  for (const t of ["恢复", "语音", "继续说"]) assert.equal(isResumeCommand(t), false, t);
});

test("saying 静音 mutes: end cue, paused state, no user to the session, playback untouched", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const results = [];
  h.runtime.converse({ text: "第一句。第二句。", timeoutS: 5 }).then((r) => results.push(r));
  h.rec.tts[0].handlers.onAudio({ pcm: Buffer.alloc(4), sampleRate: 24000, channels: 1 });
  const epoch = h.runtime.getState().epoch;
  say(h, "静音");
  assert.equal(h.runtime.getState().paused, true);
  assert.deepEqual(h.rec.cues, ["start", "end"]);
  assert.equal(logged(h, "voice_cmd_mute").length, 1);
  assert.equal(h.runtime.getState().epoch, epoch);
  assert.ok(h.rec.tts.every((s) => !s.cancelled));
  assert.equal(h.runtime.getState().phase, "speaking");
  h.clock.advance(5000);
  await flush();
  assert.deepEqual(results.filter((r) => r.user !== undefined), []);
});

test("variants mute too", async () => {
  for (const t of ["先静音", "静音吧", "静音一下"]) {
    const h = makeHarness();
    await h.runtime.start();
    say(h, t);
    assert.equal(h.runtime.getState().paused, true, t);
  }
});

test("静音 inside a longer sentence is ordinary input", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const results = [];
  h.runtime.converse({ timeoutS: 600 }).then((r) => results.push(r));
  say(h, "这个静音功能怎么样");
  h.clock.advance(700);
  await flush();
  assert.equal(h.runtime.getState().paused, false);
  assert.deepEqual(results, [{ interrupted: false, user: "这个静音功能怎么样" }]);
  assert.equal(logged(h, "voice_cmd_mute").length, 0);
});

test("while muted other speech is dropped: no user, no interruption", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const results = [];
  h.runtime.converse({ timeoutS: 3 }).then((r) => results.push(r));
  say(h, "静音");
  const epoch = h.runtime.getState().epoch;
  say(h, "你好呀今天怎么样");
  h.clock.advance(3000);
  await flush();
  assert.equal(h.runtime.getState().epoch, epoch);
  assert.deepEqual(results, [{ timeout: true, paused: true }]);
  assert.equal(h.runtime.getState().paused, true);
});

test("恢复语音 resumes: start cue, listening again, 650ms mask, then input works", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const results = [];
  h.runtime.converse({ timeoutS: 600 }).then((r) => results.push(r));
  say(h, "静音");
  say(h, "好了，恢复语音吧。");
  assert.equal(h.runtime.getState().paused, false);
  assert.deepEqual(h.rec.cues, ["start", "end", "start"]);
  assert.equal(logged(h, "voice_cmd_resume").length, 1);
  assert.equal(h.runtime.getState().phase, "listening");
  h.runtime.handleSpeechStart();
  const n = h.rec.stt.length;
  h.clock.advance(650);
  say(h, "我回来了");
  h.clock.advance(700);
  await flush();
  assert.ok(h.rec.stt.length > n);
  assert.deepEqual(results, [{ interrupted: false, user: "我回来了" }]);
});

test("shortcut mute can be resumed by voice; voice mute can be resumed by the shortcut", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setPaused(true); // shortcut
  say(h, "恢复语音");
  assert.equal(h.runtime.getState().paused, false);
  h.clock.advance(650);
  say(h, "静音");
  assert.equal(h.runtime.getState().paused, true);
  h.runtime.setPaused(false); // shortcut toggles back
  assert.equal(h.runtime.getState().paused, false);
});

test("the assistant's own 静音 (echo) neither mutes nor resumes", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.converse({ text: "说一声静音就能静音。", timeoutS: 30 });
  h.rec.tts[0].handlers.onAudio({ pcm: Buffer.alloc(4), sampleRate: 24000, channels: 1 });
  say(h, "静音");
  assert.equal(h.runtime.getState().paused, false);
  assert.equal(logged(h, "voice_cmd_mute").length, 0);
});

test("command logs carry no transcript text", async () => {
  const h = makeHarness();
  await h.runtime.start();
  say(h, "静音");
  say(h, "恢复语音");
  assert.ok(logged(h, "voice_cmd_mute").length && logged(h, "voice_cmd_resume").length);
  assert.equal(JSON.stringify(h.rec.logs).includes("恢复语音"), false);
  assert.equal(JSON.stringify(h.rec.logs).includes("静音"), false);
});

test("CLI brain mode: voice mute works the same", async () => {
  const h = makeHarness({ brain: "claude-code" });
  await h.runtime.start();
  say(h, "静音");
  assert.equal(h.runtime.getState().paused, true);
  assert.equal(h.rec.brainSends.length, 0);
});

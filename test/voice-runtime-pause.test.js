"use strict";

// Pause = mute (shortcut or voice command): user speech is not input any more, playback and converse text carry on.
// The mic stays open; audio is only recognised locally to hear the wake phrase.
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeHarness, say } = require("./fixtures/voice-runtime-harness");

const flush = () => new Promise((r) => setImmediate(r));
const sent = (h, ch) => h.rec.sent.filter((e) => e.channel === ch);

test("pause: state flag, non-listening phase, call stays active", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setPaused(true);
  const st = h.runtime.getState();
  assert.equal(st.paused, true);
  assert.equal(st.active, true);
  assert.equal(st.phase, "paused");
  h.runtime.setPaused(true); // idempotent
  assert.equal(h.rec.phases.filter((p) => p === "paused").length, 1);
});

test("pause does not stop playback: no cancel, no stop-playback, no epoch bump", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.converse({ text: "第一句。第二句。", timeoutS: 5 });
  assert.ok(h.rec.tts.length > 0);
  const epoch = h.runtime.getState().epoch;
  h.runtime.setPaused(true);
  assert.ok(h.rec.tts.every((s) => !s.cancelled));
  assert.equal(sent(h, "voice:stop-playback").length, 0);
  assert.equal(h.runtime.getState().epoch, epoch);
});

test("while paused user speech is discarded: no barge-in, no partial to the pet, no caption, no final", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setPaused(true);
  const epoch = h.runtime.getState().epoch;
  const s = say(h, "不该被听到", { final: false });
  s.handlers.onPartial("不该被听到");
  h.runtime.handleBargeCommit({ playingSentenceId: "x" });
  s.handlers.onFinal("不该被听到");
  assert.equal(h.runtime.getState().epoch, epoch);
  assert.equal(sent(h, "voice:partial").length, 0);
  assert.equal(sent(h, "voice:caption").length, 0);
  assert.equal(h.rec.logs.some(([e]) => e === "session_final"), false);
});

test("pause cancels a half-heard utterance and drops a merge-held final", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const results = [];
  h.runtime.converse({ timeoutS: 600 }).then((r) => results.push(r));
  say(h, "要被丢弃"); // held by the merge window
  h.runtime.handleSpeechStart();
  h.runtime.handleAudio(Buffer.alloc(4));
  h.runtime.setPaused(true);
  assert.equal(h.rec.stt[h.rec.stt.length - 1].cancelled, true);
  h.clock.advance(60000);
  await flush();
  assert.deepEqual(results, []);
});

test("a pending converse is NOT ended by pause; its timeout returns timeout (+paused hint)", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const results = [];
  h.runtime.converse({ timeoutS: 3 }).then((r) => results.push(r));
  h.runtime.setPaused(true);
  await flush();
  assert.deepEqual(results, []);
  h.clock.advance(3000);
  await flush();
  assert.deepEqual(results, [{ timeout: true, paused: true }]);
  assert.equal(h.runtime.getState().active, true, "session survives");
});

test("converse text sent while paused is synthesized and played; queued sentences finish; then timeout+paused", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setPaused(true);
  const results = [];
  h.runtime.converse({ text: "暂停期间照常播。第二句。", timeoutS: 2 }).then((r) => results.push(r));
  assert.ok(h.rec.tts.length > 0, "spoken while paused");
  assert.equal(h.rec.logs.some(([e]) => e === "converse_text_dropped_paused"), false);
  for (const s of h.rec.tts) { s.handlers.onAudio({ pcm: Buffer.alloc(4), sampleRate: 24000, channels: 1 }); s.handlers.onEnd && s.handlers.onEnd(); }
  assert.ok(sent(h, "voice:tts-pcm").length >= 1);
  assert.equal(h.runtime.getState().phase, "speaking");
  for (const id of h.runtime.getState().inflight.slice()) h.runtime.handleAck({ epoch: 0, sentenceId: id });
  assert.equal(h.runtime.getState().phase, "paused", "playback done -> sleeps again");
  h.clock.advance(2000);
  await flush();
  assert.deepEqual(results, [{ timeout: true, paused: true }]);
  assert.equal(h.runtime.getState().active, true);
});

test("speech while paused (even during playback) triggers no barge-in and no user", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const results = [];
  h.runtime.converse({ text: "第一句。第二句。", timeoutS: 5 }).then((r) => results.push(r));
  h.rec.tts[0].handlers.onAudio({ pcm: Buffer.alloc(4), sampleRate: 24000, channels: 1 });
  h.runtime.setPaused(true);
  const epoch = h.runtime.getState().epoch;
  say(h, "别打断我");
  h.runtime.handleBargeCommit({ playingSentenceId: "x" });
  h.clock.advance(5000);
  await flush();
  assert.equal(h.runtime.getState().epoch, epoch);
  assert.ok(h.rec.tts.every((s) => !s.cancelled));
  assert.deepEqual(results.filter((r) => r.user !== undefined), []);
});

test("the mic stays open while paused: all-zero frames still trigger the mic-restart check", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setPaused(true);
  for (let i = 0; i < 400; i++) { h.runtime.handleAudio(Buffer.alloc(640)); h.clock.advance(20); }
  assert.ok(sent(h, "voice:mic-restart").length >= 1);
});

test("while paused the renderer VAD stream is not forwarded (no ducking / barge-in)", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setPaused(true);
  say(h, "随便", { final: false });
  assert.equal(sent(h, "voice:vad").length, 0);
});

test("resume restores listening and the mic works again", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const results = [];
  h.runtime.converse({ timeoutS: 600 }).then((r) => results.push(r));
  h.runtime.setPaused(true);
  h.runtime.setPaused(false);
  assert.equal(h.runtime.getState().paused, false);
  assert.equal(h.runtime.getState().phase, "listening");
  h.clock.advance(650); // resume cue mask
  say(h, "我回来了");
  h.clock.advance(600);
  await flush();
  assert.deepEqual(results, [{ interrupted: false, user: "我回来了" }]);
});

test("stopping the call while paused ends the converse and clears paused", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const p = h.runtime.converse({ timeoutS: 600 });
  h.runtime.setPaused(true);
  h.runtime.stop("user");
  assert.deepEqual(await p, { ended: true, reason: "stopped" });
  assert.equal(h.runtime.getState().paused, false);
});

test("setPaused without a call is a no-op", () => {
  const h = makeHarness();
  h.runtime.setPaused(true);
  assert.equal(h.runtime.getState().paused, false);
});

test("CLI brain mode: pause leaves the running reply alone and ignores the mic", async () => {
  const h = makeHarness({ brain: "claude-code" });
  await h.runtime.start();
  say(h, "讲个长故事");
  assert.equal(h.rec.brainSends.length, 1);
  h.runtime.setPaused(true);
  assert.equal(h.rec.brainCancels, 0);
  say(h, "无效");
  assert.equal(h.rec.brainSends.length, 1, "muted speech never reaches the brain");
  assert.equal(h.runtime.getState().phase, "paused", "thinking art is not kept while paused");
  h.runtime.setPaused(false);
  assert.equal(h.runtime.getState().phase, "thinking", "reply still pending: resume shows it again");
});

const audio = (h, i = 0) => h.rec.tts[i].handlers.onAudio({ pcm: Buffer.alloc(4), sampleRate: 24000, channels: 1 });

test("phase while paused: speaking when audio plays, paused when idle, never thinking", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setPaused(true);
  assert.equal(h.runtime.getState().phase, "paused");
  const p = h.runtime.converse({ text: "第一句。", timeoutS: 5 });
  assert.equal(h.runtime.getState().phase, "paused", "synthesizing, no audio yet");
  audio(h);
  assert.equal(h.runtime.getState().phase, "speaking");
  h.rec.tts[0].handlers.onEnd && h.rec.tts[0].handlers.onEnd();
  h.runtime.converse({ text: "", timeoutS: 1 }); // supersedes -> bridge asks for "thinking"
  assert.notEqual(h.runtime.getState().phase, "thinking");
  h.clock.advance(1500);
  await p;
  assert.notEqual(h.runtime.getState().phase, "thinking");
});

test("pausing while speaking keeps speaking; resuming while speaking keeps speaking", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.converse({ text: "第一句。第二句。", timeoutS: 5 });
  audio(h);
  assert.equal(h.runtime.getState().phase, "speaking");
  h.runtime.setPaused(true);
  assert.equal(h.runtime.getState().phase, "speaking");
  h.runtime.setPaused(false);
  assert.equal(h.runtime.getState().phase, "speaking");
});

test("pausing while waiting for the brain (thinking) shows paused; resume restores thinking", async () => {
  const h = makeHarness({ brain: "claude-code" });
  await h.runtime.start();
  say(h, "讲个故事");
  assert.equal(h.runtime.getState().phase, "thinking");
  h.runtime.setPaused(true);
  assert.equal(h.runtime.getState().phase, "paused");
  h.runtime.setPaused(false);
  assert.equal(h.runtime.getState().phase, "thinking");
});

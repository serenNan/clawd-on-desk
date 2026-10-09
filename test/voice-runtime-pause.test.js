"use strict";

// Pause = temporary mic mute for the whole call (session and CLI brain alike).
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

test("pause stops playback immediately and cancels in-flight TTS", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.converse({ text: "第一句。第二句。", timeoutS: 5 });
  assert.ok(h.rec.tts.length > 0);
  const epoch = h.runtime.getState().epoch;
  h.runtime.setPaused(true);
  assert.ok(h.rec.tts.every((s) => s.cancelled));
  assert.ok(sent(h, "voice:stop-playback").length >= 1);
  assert.ok(h.runtime.getState().epoch > epoch);
  assert.equal(h.runtime.getState().phase, "paused");
});

test("while paused the mic is ignored: no STT, no barge-in, no final", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setPaused(true);
  const epoch = h.runtime.getState().epoch;
  say(h, "不该被听到", { final: false });
  h.runtime.handleBargeCommit({ playingSentenceId: "x" });
  assert.equal(h.rec.stt.length, 0);
  assert.equal(h.runtime.getState().epoch, epoch);
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

test("converse text sent while paused is dropped (not queued) and the call re-arms its timeout", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setPaused(true);
  const results = [];
  h.runtime.converse({ text: "暂停期间别播", timeoutS: 2 }).then((r) => results.push(r));
  assert.equal(h.rec.tts.length, 0, "nothing spoken");
  h.clock.advance(2000);
  await flush();
  assert.deepEqual(results, [{ timeout: true, paused: true }]);
  h.runtime.setPaused(false);
  assert.equal(h.rec.tts.length, 0, "nothing replays on resume");
  assert.ok(h.rec.logs.some(([e]) => e === "converse_text_dropped_paused"));
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

test("CLI brain mode: pause cancels the running reply and ignores the mic", async () => {
  const h = makeHarness({ brain: "claude-code" });
  await h.runtime.start();
  say(h, "讲个长故事");
  assert.equal(h.rec.brainSends.length, 1);
  h.runtime.setPaused(true);
  assert.ok(h.rec.brainCancels >= 1);
  say(h, "无效", { final: false });
  assert.equal(h.rec.stt.length, 1);
  assert.equal(h.runtime.getState().phase, "paused");
  h.runtime.setPaused(false);
  assert.equal(h.runtime.getState().phase, "listening");
});

"use strict";

// Echo robustness (strict-threshold gating) and real mic release on pause.
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeEnv, feed } = require("./fixtures/voice-renderer-env");

const startPlayback = (env) => env.renderer.handleTtsPcm({ epoch: 0, sentenceId: "1-1", pcm: new Uint8Array(4), sampleRate: 24000, channels: 1 });

// ---- echo robustness while the assistant speaks ----
const strongFrames = (env, n, strong) => { for (let i = 0; i < n; i++) { env.renderer.handleVad({ type: "frame", voiced: true, strong }); env.advance(20); } };

test("vad:main weak (non-strong) voiced frames while we speak never duck or commit (leaked echo)", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  startPlayback(env);
  env.renderer.handleVad({ type: "speech-start" });
  strongFrames(env, 100, false); // 2s of weak "voice"
  assert.equal(env.sink.ops.some((o) => o[0] === "duck" || o[0] === "stop"), false);
  assert.equal(env.calls.some((c) => c[0] === "bargeCommit"), false);
});

test("vad:main short strong noise (<200ms) does not duck", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  startPlayback(env);
  env.renderer.handleVad({ type: "speech-start" });
  strongFrames(env, 6, true); // 120ms
  strongFrames(env, 5, false);
  env.advance(1000);
  assert.equal(env.sink.ops.some((o) => o[0] === "duck"), false);
});

test("vad:main when the assistant is silent, plain voiced frames still count (no strict gate)", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  env.renderer.handleVad({ type: "speech-start" });
  strongFrames(env, 5, false);
  assert.equal(env.calls.some((c) => c[0] === "bargeCommit"), false);
  assert.equal(env.sink.ops.some((o) => o[0] === "duck"), false);
});

// ---- mute keeps the microphone open (wake phrase is recognised locally) ----
test("pause keeps the mic track and source alive; frames keep flowing; barge-in is disarmed", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  startPlayback(env);
  await env.renderer.handlePaused({ paused: true });
  assert.equal(env.tracks[0].stopped, false);
  assert.equal(env.sources[0].disconnected, false);
  assert.equal(env.calls.filter((c) => c[0] === "getUserMedia").length, 1);
  env.calls.length = 0;
  feed(env, 0.3, 100);
  assert.ok(env.calls.some((c) => c[0] === "audio"), "frames still flow to main");
  env.renderer.handleVad({ type: "speech-start" });
  for (let i = 0; i < 50; i++) { env.renderer.handleVad({ type: "frame", voiced: true, strong: true }); env.advance(20); }
  assert.equal(env.sink.ops.some((o) => o[0] === "duck" || o[0] === "stop"), false);
  assert.equal(env.calls.some((c) => c[0] === "bargeCommit"), false);
  await env.renderer.handlePaused({ paused: false });
  assert.equal(env.calls.filter((c) => c[0] === "getUserMedia").length, 0, "no re-acquire on resume");
});

test("a dead track while paused is still rebuilt", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  await env.renderer.handlePaused({ paused: true });
  await env.renderer.handleMicRestart({ attempt: 1 });
  assert.equal(env.tracks[0].stopped, true);
  assert.equal(env.calls.filter((c) => c[0] === "getUserMedia").length, 2);
});

test("stopping the call while paused leaves nothing open", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  await env.renderer.handlePaused({ paused: true });
  await env.renderer.stop();
  assert.equal(env.ctx.closed, true);
});

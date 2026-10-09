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

// ---- pause really releases the microphone ----
test("pause stops the mic track and detaches the source; resume re-acquires with the same constraints", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  assert.equal(env.calls.filter((c) => c[0] === "getUserMedia").length, 1);
  await env.renderer.handlePaused({ paused: true });
  assert.equal(env.tracks[0].stopped, true);
  assert.equal(env.sources[0].disconnected, true);
  assert.ok(env.calls.some((c) => c[0] === "debugLog" && c[1].event === "mic_released"));
  assert.equal(env.renderer.isRunning(), true, "the call itself stays up");
  await env.renderer.handlePaused({ paused: true }); // idempotent
  assert.equal(env.calls.filter((c) => c[0] === "getUserMedia").length, 1);
  await env.renderer.handlePaused({ paused: false });
  const gums = env.calls.filter((c) => c[0] === "getUserMedia");
  assert.equal(gums.length, 2);
  assert.deepEqual(gums[1][1], gums[0][1]);
  assert.equal(env.tracks.length, 2);
  assert.equal(env.tracks[1].stopped, false);
  assert.equal(env.sources.length, 2);
  assert.equal(env.sources[1].stream.getAudioTracks()[0], env.tracks[1]);
  feed(env, 0.3, 100);
  assert.ok(env.calls.some((c) => c[0] === "audio"), "frames flow again");
});

test("stopping the call while paused leaves nothing open", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  await env.renderer.handlePaused({ paused: true });
  await env.renderer.stop();
  assert.equal(env.ctx.closed, true);
});

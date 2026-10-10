"use strict";

// Renderer side of helper capture: no getUserMedia while the bundled helper
// records; playback, barge-in and ducking keep working; the source can flip mid-call.
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeEnv, feed } = require("./fixtures/voice-renderer-env");

const gum = (env) => env.calls.filter((c) => c[0] === "getUserMedia").length;
const audioCalls = (env) => env.calls.filter((c) => c[0] === "audio").length;

test("capture=helper: no getUserMedia, no rendererError even if the browser mic is denied", async () => {
  const env = makeEnv({ denyMic: true });
  await env.renderer.start({ vad: "main", capture: "helper" });
  assert.equal(gum(env), 0);
  assert.equal(env.calls.some((c) => c[0] === "rendererError"), false);
  assert.equal(env.renderer.isRunning(), true);
});

test("capture=helper: playback and remote-VAD barge-in still work", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main", capture: "helper" });
  env.renderer.handleTtsPcm({ epoch: 0, sentenceId: "1-1", pcm: new Uint8Array(4), sampleRate: 24000, channels: 1 });
  assert.ok(env.sink.ops.some((o) => o[0] === "enqueue"));
  env.renderer.handleVad({ type: "speech-start" });
  for (let i = 0; i < 12; i++) { env.renderer.handleVad({ type: "frame", voiced: true, strong: true }); env.advance(20); }
  env.renderer.handlePartial({ text: "嗯，等一下我有问题" });
  assert.equal(env.calls.filter((c) => c[0] === "bargeCommit").length, 1, "barge-in is driven by main VAD events + partials");
});

test("capture=helper: device changes do not open the browser mic", async () => {
  const env = makeEnv({ devices: [{ deviceId: "default", label: "Default" }] });
  await env.renderer.start({ vad: "main", capture: "helper" });
  env.renderer.handleDeviceChange();
  env.advance(3000);
  assert.equal(gum(env), 0);
});

test("handleCapture(renderer) mid-call opens the mic and streams PCM; handleCapture(helper) releases it", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main", capture: "helper" });
  await env.renderer.handleCapture({ source: "renderer" });
  assert.equal(gum(env), 1);
  feed(env, 0.2, 100);
  assert.ok(audioCalls(env) > 0, "frames reach main again");
  await env.renderer.handleCapture({ source: "helper" });
  assert.equal(env.track.stopped, true);
  assert.equal(env.sources[0].disconnected, true);
  const n = audioCalls(env);
  assert.equal(env.node.port.onmessage, null, "worklet no longer wired");
  assert.equal(audioCalls(env), n);
});

test("handleCapture(renderer) with a denied mic reports the error to main", async () => {
  const env = makeEnv({ denyMic: true });
  await env.renderer.start({ vad: "main", capture: "helper" });
  await env.renderer.handleCapture({ source: "renderer" });
  assert.ok(env.calls.some((c) => c[0] === "rendererError"));
});

test("handleCapture to the same source is a no-op", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main", capture: "renderer" });
  await env.renderer.handleCapture({ source: "renderer" });
  assert.equal(gum(env), 1);
  await env.renderer.handleCapture({ source: "helper" });
  await env.renderer.handleCapture({ source: "helper" });
  assert.equal(gum(env), 1);
});

test("start with capture=renderer (or no field) keeps the old behaviour", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  assert.equal(gum(env), 1);
});

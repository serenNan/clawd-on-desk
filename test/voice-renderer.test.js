"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { makeEnv, feed } = require("./fixtures/voice-renderer-env");

const names = (env) => env.calls.map((c) => c[0]);

test("start asks for audio-only with AEC/NS/AGC, loads the worklet and keeps video off", async () => {
  const env = makeEnv();
  await env.renderer.start({ sampleRate: 16000 });
  const gum = env.calls.find((c) => c[0] === "getUserMedia")[1];
  assert.equal(gum.video, false);
  assert.equal(gum.audio.echoCancellation, true);
  assert.equal(gum.audio.noiseSuppression, true);
  assert.equal(gum.audio.autoGainControl, true);
  assert.ok(env.calls.some((c) => c[0] === "addModule"));
});

test("mic denied is reported once and nothing is left open", async () => {
  const env = makeEnv({ denyMic: true });
  await env.renderer.start({});
  const errs = env.calls.filter((c) => c[0] === "rendererError");
  assert.equal(errs.length, 1);
  assert.equal(errs[0][1].code, "mic_denied");
  assert.equal(env.renderer.isRunning(), false);
});

test("AEC not actually enabled raises a visible notice (no silent half-duplex)", async () => {
  const env = makeEnv({ settings: { echoCancellation: false } });
  await env.renderer.start({});
  assert.ok(env.calls.some((c) => c[0] === "notice" && c[1] === "aec-unavailable"));
});

test("voiced frames produce speech-start with pre-roll, 16k PCM, then speech-end", async () => {
  const env = makeEnv();
  await env.renderer.start({});
  feed(env, 0.001, 400); // calibrate noise floor
  feed(env, 0.3, 300);
  feed(env, 0.001, 1000);
  const n = names(env);
  assert.ok(n.includes("speechStart"));
  assert.ok(n.includes("audio"));
  assert.ok(n.includes("speechEnd"));
  assert.ok(n.indexOf("speechStart") < n.indexOf("audio"));
  const audio = env.calls.find((c) => c[0] === "audio")[1];
  assert.ok(audio instanceof Uint8Array);
  assert.equal(audio.byteLength % 2, 0);
  assert.equal(env.calls.find((c) => c[0] === "speechEnd")[1].reason, "silence");
});

test("speaking while the assistant plays: duck first, then commit stops locally and notifies main", async () => {
  const env = makeEnv();
  await env.renderer.start({});
  feed(env, 0.001, 400);
  env.renderer.handleTtsPcm({ epoch: 0, sentenceId: "1-1", pcm: new Uint8Array(4), sampleRate: 24000, channels: 1 });
  feed(env, 0.3, 280);
  assert.ok(env.sink.ops.some((o) => o[0] === "duck" && o[1] === -8));
  assert.equal(env.sink.ops.some((o) => o[0] === "stop"), false, "not yet confirmed");
  feed(env, 0.3, 300);
  assert.ok(env.sink.ops.some((o) => o[0] === "stop"));
  const commit = env.calls.find((c) => c[0] === "bargeCommit");
  assert.equal(commit[1].playingSentenceId, "1-1");
  assert.equal(env.track.stopped, false, "mic stays open");
  assert.equal(env.ctx.state, "running", "capture context is never suspended");
});

test("short backchannel-like burst only ducks and then restores", async () => {
  const env = makeEnv();
  await env.renderer.start({});
  feed(env, 0.001, 400);
  env.renderer.handleTtsPcm({ epoch: 0, sentenceId: "1-1", pcm: new Uint8Array(4), sampleRate: 24000, channels: 1 });
  feed(env, 0.3, 260);
  feed(env, 0.001, 200);
  env.advance(700);
  assert.ok(env.sink.ops.some((o) => o[0] === "restore"));
  assert.equal(env.calls.some((c) => c[0] === "bargeCommit"), false);
});

test("a substantive STT partial confirms the barge-in even for a short burst", async () => {
  const env = makeEnv();
  await env.renderer.start({});
  feed(env, 0.001, 400);
  env.renderer.handleTtsPcm({ epoch: 0, sentenceId: "1-1", pcm: new Uint8Array(4), sampleRate: 24000, channels: 1 });
  feed(env, 0.3, 140);
  env.renderer.handlePartial({ text: "嗯" });
  assert.equal(env.calls.some((c) => c[0] === "bargeCommit"), false);
  env.renderer.handlePartial({ text: "等一下我有问题" });
  assert.equal(env.calls.filter((c) => c[0] === "bargeCommit").length, 1);
});

test("playback events: pcm enqueued, tts-end closes the sentence, ack goes to main", async () => {
  const env = makeEnv();
  await env.renderer.start({});
  env.renderer.handleTtsPcm({ epoch: 2, sentenceId: "3-1", pcm: new Uint8Array(4), sampleRate: 24000, channels: 1 });
  env.renderer.handleTtsEnd({ epoch: 2, sentenceId: "3-1" });
  assert.deepEqual(env.sink.ops.filter((o) => o[0] === "enqueue" || o[0] === "end").map((o) => o[0]), ["enqueue", "end"]);
  env.sink.handlers.onAck({ epoch: 2, sentenceId: "3-1" });
  assert.deepEqual(env.calls.find((c) => c[0] === "ack")[1], { epoch: 2, sentenceId: "3-1" });
  env.sink.handlers.onBuffered(1500);
  assert.equal(env.calls.find((c) => c[0] === "buffered")[1], 1500);
});

test("stop-playback from main stops the sink and adopts the new epoch", async () => {
  const env = makeEnv();
  await env.renderer.start({});
  env.renderer.handleStopPlayback({ epoch: 4 });
  assert.ok(env.sink.ops.some((o) => o[0] === "stop"));
  assert.ok(env.sink.ops.some((o) => o[0] === "epoch" && o[1] === 4));
});

test("stop releases tracks, context and sink and is idempotent", async () => {
  const env = makeEnv();
  await env.renderer.start({});
  await env.renderer.stop();
  await env.renderer.stop();
  assert.equal(env.track.stopped, true);
  assert.equal(env.ctx.closed, true);
  assert.equal(env.sink.ops.filter((o) => o[0] === "dispose").length, 1);
  const before = env.calls.length;
  env.node.port.onmessage && env.node.port.onmessage({ data: frame(0.5) });
  assert.equal(env.calls.length, before, "no frames are processed after stop");
});

// ---- main-process (Silero) VAD mode: renderer streams raw PCM, main drives ducking ----
const speechTo = (env) => env.calls.filter((c) => c[0] === "speechStart" || c[0] === "speechEnd");
const startPlayback = (env) => env.renderer.handleTtsPcm({ epoch: 0, sentenceId: "1-1", pcm: new Uint8Array(4), sampleRate: 24000, channels: 1 });

test("vad:main streams every frame as 16k PCM and never segments locally", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  feed(env, 0.3, 200);
  feed(env, 0.001, 200);
  assert.ok(env.calls.filter((c) => c[0] === "audio").length >= 15);
  assert.deepEqual(speechTo(env), []);
});

test("vad:main sustained voiced sound without words (music) neither ducks nor stops playback", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  startPlayback(env);
  env.renderer.handleVad({ type: "speech-start" });
  for (let i = 0; i < 100; i++) { env.renderer.handleVad({ type: "frame", voiced: true, strong: true }); env.advance(20); }
  assert.equal(env.sink.ops.some((o) => o[0] === "duck" || o[0] === "stop"), false);
  assert.equal(env.calls.some((c) => c[0] === "bargeCommit"), false);
});

test("vad:main backchannel partial does not interrupt; substantive partial commits", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  startPlayback(env);
  env.renderer.handleVad({ type: "speech-start" });
  for (let i = 0; i < 12; i++) { env.renderer.handleVad({ type: "frame", voiced: true, strong: true }); env.advance(20); }
  env.renderer.handlePartial({ text: "嗯，" });
  assert.equal(env.calls.some((c) => c[0] === "bargeCommit"), false);
  env.renderer.handlePartial({ text: "嗯，等一下我有问题" });
  assert.equal(env.calls.filter((c) => c[0] === "bargeCommit").length, 1);
});

test("vad events are ignored in renderer-VAD mode", async () => {
  const env = makeEnv();
  await env.renderer.start({});
  startPlayback(env);
  env.renderer.handleVad({ type: "speech-start" });
  assert.equal(env.sink.ops.some((o) => o[0] === "duck"), false);
});

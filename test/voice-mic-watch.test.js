"use strict";

// Mic self-heal: all-zero PCM for 3s while the call is live -> renderer rebuilds capture.
const assert = require("node:assert/strict");
const test = require("node:test");
const { createMicWatch } = require("../src/voice-mic-watch");
const { makeHarness } = require("./fixtures/voice-runtime-harness");
const { makeEnv, feed } = require("./fixtures/voice-renderer-env");

const ZERO = Buffer.alloc(640);
const LOUD = Buffer.from(new Int16Array(320).fill(500).buffer);

function rig(opts) {
  let t = 0;
  const fired = [];
  const logs = [];
  const w = createMicWatch({ now: () => t, log: (e, f) => logs.push([e, f]), onSilent: (i) => fired.push(i), ...opts });
  const run = (buf, ms) => { for (let i = 0; i < ms / 20; i++) { w.feed(buf); t += 20; } };
  return { w, fired, logs, run, skip: (ms) => { t += ms; } };
}

test("3s of zero frames fires once and logs mic_silent_restart", () => {
  const r = rig();
  r.run(ZERO, 2900);
  assert.equal(r.fired.length, 0);
  r.run(ZERO, 200);
  assert.deepEqual(r.fired, [{ attempt: 1 }]);
  assert.equal(r.logs[0][0], "mic_silent_restart");
  assert.ok(r.logs[0][1].silentMs >= 3000);
});

test("any non-zero frame resets the window", () => {
  const r = rig();
  r.run(ZERO, 2800); r.run(LOUD, 20); r.run(ZERO, 2800);
  assert.equal(r.fired.length, 0);
});

test("frame gap (pause / cue mask) does not count as silence", () => {
  const r = rig();
  r.run(ZERO, 2000); r.skip(5000); r.run(ZERO, 2000);
  assert.equal(r.fired.length, 0);
});

test("at most 3 restarts per session, each gets a fresh 3s window", () => {
  const r = rig();
  r.run(ZERO, 20000);
  assert.deepEqual(r.fired.map((f) => f.attempt), [1, 2, 3]);
});

test("runtime: zero PCM on a live, unpaused call sends voice:mic-restart; muted still does (the mic stays open)", async () => {
  let t = 1000;
  const h = makeHarness({ runtimeOptions: { now: () => t } });
  await h.runtime.start();
  const restarts = () => h.rec.sent.filter((e) => e.channel === "voice:mic-restart");
  for (let i = 0; i < 200; i++) { h.runtime.handleAudio(ZERO); t += 20; }
  assert.equal(restarts().length, 1);
  assert.ok(h.rec.logs.some(([e]) => e === "mic_silent_restart"));
  h.runtime.setPaused(true);
  for (let i = 0; i < 400; i++) { h.runtime.handleAudio(ZERO); t += 20; }
  assert.ok(restarts().length >= 2);
});

test("renderer: mic restart stops the dead track and rebuilds track, source and worklet node", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  feed(env, 0, 200);
  await env.renderer.handleMicRestart({ attempt: 1 });
  assert.equal(env.tracks[0].stopped, true);
  assert.equal(env.sources[0].disconnected, true);
  assert.equal(env.tracks.length, 2);
  assert.equal(env.sources.length, 2);
  assert.equal(env.sources[1].stream.getAudioTracks()[0], env.tracks[1]);
  assert.ok(env.calls.some((c) => c[0] === "debugLog" && c[1].event === "mic_restarted"));
  feed(env, 0.3, 100);
  assert.ok(env.calls.some((c) => c[0] === "audio"), "frames flow after rebuild");
});

test("renderer: playback_start logged once per sentence even when chunks interleave", async () => {
  const env = makeEnv();
  await env.renderer.start({ vad: "main" });
  const chunk = (id) => ({ epoch: 0, sentenceId: id, pcm: new Uint8Array(4), sampleRate: 24000, channels: 1 });
  for (let i = 0; i < 5; i++) { env.renderer.handleTtsPcm(chunk("1-1")); env.renderer.handleTtsPcm(chunk("1-2")); }
  assert.equal(env.calls.filter((c) => c[0] === "debugLog" && c[1].event === "playback_start").length, 2);
});

test("renderer: track mute/unmute/end and ctx state changes are logged; suspended ctx is resumed", async () => {
  const env = makeEnv();
  let resumed = 0;
  env.ctx.resume = async () => { resumed++; env.ctx.state = "running"; };
  await env.renderer.start({ vad: "main" });
  env.track.onmute(); env.track.onunmute(); env.track.onended();
  env.ctx.state = "suspended"; env.ctx.onstatechange();
  const evs = env.calls.filter((c) => c[0] === "debugLog").map((c) => c[1].event);
  for (const e of ["track_mute", "track_unmute", "track_ended", "ctx_state"]) assert.ok(evs.includes(e), e);
  assert.equal(resumed, 1);
});

test("renderer: attempt 2 rotates to another real input, skipping virtual, iPhone, default and dead ones", async () => {
  const env = makeEnv();
  const devs = [
    { kind: "audioinput", deviceId: "default", label: "Default - MacBook Air Mic" },
    { kind: "audioinput", deviceId: "v1", label: "OrayVirtualAudioDevice" },
    { kind: "audioinput", deviceId: "mac", label: "MacBook Air Mic" },
    { kind: "audioinput", deviceId: "phone", label: "iPhone Mic" },
    { kind: "audioinput", deviceId: "usb", label: "USB Mic" },
  ];
  let clock = 0;
  const r = require("../src/voice-renderer").createVoiceRenderer({
    api: env.api, getUserMedia: async (c) => { env.calls.push(["getUserMedia", c]); return { getTracks: () => [env.track], getAudioTracks: () => [env.track] }; },
    createContext: () => env.ctx, createWorkletNode: () => env.node, createSink: () => env.sink,
    workletUrl: "w.js", enumerateDevices: async () => devs, now: () => (clock += 2000),
  });
  env.track.label = "Default - MacBook Air Mic";
  await r.start({ vad: "main" });
  await r.handleMicRestart({ attempt: 1 });
  assert.equal(env.calls.filter((c) => c[0] === "getUserMedia").pop()[1].audio.deviceId, undefined, "attempt 1: plain default");
  await r.handleMicRestart({ attempt: 2 });
  assert.deepEqual(env.calls.filter((c) => c[0] === "getUserMedia").pop()[1].audio.deviceId, { exact: "usb" });
});

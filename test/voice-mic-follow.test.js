"use strict";

// Mid-call device changes: refresh the published list, and follow a changed system default
// (unless a device is pinned, the mic is paused, or the events are still bursting).
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeEnv } = require("./fixtures/voice-renderer-env");

const D = (deviceId, label) => ({ kind: "audioinput", deviceId, label });
const BUILTIN = D("id-mb", "MacBook Pro Microphone");
const PODS = D("id-pods", "AirPods Pro");
const mkDevices = () => [D("default", "Default - MacBook Pro Microphone"), BUILTIN];
const connectPods = (devices) => { devices[0] = D("default", "Default - AirPods Pro"); devices.push(PODS); };
const gums = (env) => env.calls.filter((c) => c[0] === "getUserMedia");
const follows = (env) => env.calls.filter((c) => c[0] === "debugLog" && c[1].event === "mic_follow_default").map((c) => c[1]);
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const devchange = async (env, ms = 1000) => { env.renderer.handleDeviceChange(); env.advance(ms); await settle(); };

test("default input changed mid-call: capture rebuilt on the new default, call stays up, republished", async () => {
  const devices = mkDevices();
  const env = makeEnv({ devices });
  await env.renderer.start({ vad: "main" });
  await settle();
  const pubs = env.calls.filter((c) => c[0] === "micDevices").length;
  connectPods(devices);
  await devchange(env);
  assert.equal(gums(env).length, 2);
  assert.equal(env.tracks[0].stopped, true);
  assert.equal(env.sources.at(-1).stream.getAudioTracks()[0].label, "Default - AirPods Pro");
  assert.deepEqual(follows(env).map((f) => f.label), ["Default - AirPods Pro"]);
  assert.equal(env.renderer.isRunning(), true);
  assert.ok(env.calls.filter((c) => c[0] === "micDevices").length > pubs, "list re-published");
});

test("device list change without a new default does not restart the mic (only republishes)", async () => {
  const devices = mkDevices();
  const env = makeEnv({ devices });
  await env.renderer.start({ vad: "main" });
  devices.push(D("id-usb", "USB Mic"));
  await devchange(env);
  assert.equal(gums(env).length, 1);
  assert.equal(follows(env).length, 0);
});

test("a pinned device is never auto-followed", async () => {
  const devices = mkDevices();
  const env = makeEnv({ devices });
  await env.renderer.start({ vad: "main", micDeviceId: "id-mb", micLabel: "MacBook Pro Microphone" });
  connectPods(devices);
  await devchange(env);
  assert.equal(gums(env).length, 1);
  assert.equal(follows(env).length, 0);
});

test("muted: no switch while muted; resuming re-checks the default at once", async () => {
  const devices = mkDevices();
  const env = makeEnv({ devices });
  await env.renderer.start({ vad: "main" });
  await env.renderer.handlePaused({ paused: true });
  connectPods(devices);
  await devchange(env);
  assert.equal(gums(env).length, 1);
  assert.equal(follows(env).length, 0);
  await env.renderer.handlePaused({ paused: false });
  await settle();
  assert.equal(env.sources.at(-1).stream.getAudioTracks()[0].label, "Default - AirPods Pro");
});

test("1s debounce: a burst of devicechange events rebuilds once, after the quiet second", async () => {
  const devices = mkDevices();
  const env = makeEnv({ devices });
  await env.renderer.start({ vad: "main" });
  connectPods(devices);
  for (let i = 0; i < 5; i++) { env.renderer.handleDeviceChange(); env.advance(400); await settle(); }
  assert.equal(gums(env).length, 1, "still bursting");
  env.advance(600); await settle();
  assert.equal(gums(env).length, 2);
  assert.equal(follows(env).length, 1);
});

test("a default whose input already went silent this call is not followed back onto", async () => {
  const devices = mkDevices();
  const env = makeEnv({ devices });
  await env.renderer.start({ vad: "main" });
  await env.renderer.handleMicRestart({ attempt: 1 }); // marks MacBook Pro Microphone dead
  env.advance(2000);
  const t = env.tracks.at(-1); t.label = "USB Mic"; // self-heal moved us elsewhere
  await devchange(env);
  assert.equal(follows(env).length, 0);
});

test("devicechange before the call starts or after it stops does nothing", async () => {
  const env = makeEnv({ devices: mkDevices() });
  env.renderer.handleDeviceChange(); env.advance(1000); await settle();
  assert.equal(gums(env).length, 0);
});

"use strict";

// Mic selection: device matching, virtual/iPhone skipping, instant restart on track end, live switch.
const assert = require("node:assert/strict");
const test = require("node:test");
const dev = require("../src/voice-mic-device");
const { makeEnv } = require("./fixtures/voice-renderer-env");

const D = (deviceId, label) => ({ kind: "audioinput", deviceId, label });
const MACBOOK = D("id-mb", "MacBook Pro Microphone");
const USB = D("id-usb", "USB Mic");
const DEVICES = [D("default", "Default - MacBook Pro Microphone"), D("id-oray", "OrayVirtualAudioDevice"), D("id-iph", "Serennan's iPhone Microphone"), MACBOOK, USB];
const exactId = (c) => c[1].audio.deviceId && c[1].audio.deviceId.exact;
const gums = (env) => env.calls.filter((c) => c[0] === "getUserMedia");
const logs = (env, event) => env.calls.filter((c) => c[0] === "debugLog" && c[1].event === event).map((c) => c[1]);

test("resolvePreferred: id hit, label fallback when the id changed, miss, no preference", () => {
  assert.deepEqual(dev.resolvePreferred(DEVICES, { id: "id-usb", label: "x" }), { device: USB, via: "id" });
  assert.deepEqual(dev.resolvePreferred(DEVICES, { id: "stale", label: "Default - USB Mic" }), { device: USB, via: "label" });
  assert.deepEqual(dev.resolvePreferred(DEVICES, { id: "stale", label: "Gone Mic" }), { device: null, via: null });
  assert.equal(dev.resolvePreferred(DEVICES, { id: "", label: "" }), null);
});

test("pickAlternate skips virtual drivers and the iPhone mic, and already-dead labels", () => {
  for (const l of ["iPhone", "Continuity Mic", "Oray", "ToDesk Audio", "BlackHole 2ch", "Loopback", "Virtual", "Aggregate Device", "“serenNan”的麦克风"]) assert.equal(dev.isSkippable(l), true, l);
  const base = { audio: { echoCancellation: true } };
  const alt = dev.pickAlternate(DEVICES, new Set(), base);
  assert.equal(alt.audio.deviceId.exact, "id-mb");
  assert.equal(alt.audio.echoCancellation, true);
  assert.equal(dev.pickAlternate(DEVICES, new Set(["MacBook Pro Microphone"]), base).audio.deviceId.exact, "id-usb");
  assert.equal(dev.pickAlternate(DEVICES, new Set(["MacBook Pro Microphone", "USB Mic"]), base), null);
});

test("start with micDeviceId opens exactly that device and keeps the AEC/NS/AGC constraints", async () => {
  const env = makeEnv({ devices: DEVICES });
  await env.renderer.start({ vad: "main", micDeviceId: "id-usb", micLabel: "USB Mic" });
  const c = gums(env)[0][1].audio;
  assert.deepEqual(c.deviceId, { exact: "id-usb" });
  assert.deepEqual([c.echoCancellation, c.noiseSuppression, c.autoGainControl], [true, true, true]);
  assert.equal(logs(env, "mic_device")[0].label, "USB Mic");
});

test("stale id falls back to the label; unknown device falls back to system default with mic_device_fallback", async () => {
  let env = makeEnv({ devices: DEVICES });
  await env.renderer.start({ vad: "main", micDeviceId: "stale", micLabel: "USB Mic" });
  assert.equal(exactId(gums(env)[0]), "id-usb");
  assert.equal(logs(env, "mic_device")[0].via, "label");
  env = makeEnv({ devices: DEVICES });
  await env.renderer.start({ vad: "main", micDeviceId: "stale", micLabel: "Gone Mic" });
  assert.equal(exactId(gums(env)[0]), undefined);
  assert.equal(logs(env, "mic_device_fallback").length, 1);
});

const flush = (env) => env.renderer.handlePaused({ paused: false }); // no-op that awaits the queued mic work
const endLast = (env) => { const t = env.tracks[env.tracks.length - 1]; t.onended(t); return flush(env); };

test("track_ended rebuilds capture immediately (no clock advance), capped at 3 per call", async () => {
  const env = makeEnv({ devices: DEVICES });
  await env.renderer.start({ vad: "main" });
  await endLast(env);
  assert.equal(gums(env).length, 2);
  assert.equal(logs(env, "mic_restart")[0].reason, "track_ended");
  assert.equal(logs(env, "mic_restarted").length, 1);
  for (let i = 0; i < 5; i++) await endLast(env);
  assert.equal(logs(env, "mic_restart").length, 3);
});

test("self-heal with a chosen device re-opens only that device, never another input", async () => {
  const env = makeEnv({ devices: DEVICES });
  await env.renderer.start({ vad: "main", micDeviceId: "id-usb", micLabel: "USB Mic" });
  for (let i = 0; i < 3; i++) await endLast(env);
  assert.deepEqual(gums(env).map(exactId), ["id-usb", "id-usb", "id-usb", "id-usb"]);
});

test("without a chosen device the second self-heal rotates to a real input, skipping iPhone/virtual", async () => {
  const env = makeEnv({ devices: DEVICES });
  await env.renderer.start({ vad: "main" });
  await env.renderer.handleMicRestart({ attempt: 1 });
  env.advance(2000);
  await env.renderer.handleMicRestart({ attempt: 2 });
  const ids = gums(env).map(exactId);
  assert.equal(ids[1], undefined);
  assert.ok(["id-mb", "id-usb"].includes(ids[2]), ids.join(","));
});

test("switching the mic mid-call rebuilds only the capture chain; the call stays up", async () => {
  const env = makeEnv({ devices: DEVICES });
  await env.renderer.start({ vad: "main" });
  const ctxClosed = () => env.ctx.closed;
  await env.renderer.handleMicSelect({ micDeviceId: "id-usb", micLabel: "USB Mic" });
  assert.equal(env.tracks[0].stopped, true);
  assert.equal(exactId(gums(env)[1]), "id-usb");
  assert.equal(env.renderer.isRunning(), true);
  assert.equal(ctxClosed(), false);
  assert.equal(env.sources[env.sources.length - 1].stream.getAudioTracks()[0].label, "USB Mic");
  assert.equal(logs(env, "mic_select").length, 1);
  await env.renderer.handleMicSelect({ micDeviceId: "", micLabel: "" }); // back to default
  assert.equal(exactId(gums(env)[2]), undefined);
});

// ---- main side: settings -> voice:start / voice:mic-select ----
const { makeHarness } = require("./fixtures/voice-main-harness");
const { cloneDefaultVoice, validateVoice, normalizeVoice } = require("../src/voice-settings");

test("voice:start carries the saved mic; changing it mid-call sends voice:mic-select and keeps the call", async () => {
  const h = makeHarness({ voice: { micDeviceId: "id-mb", micLabel: "MacBook Pro Microphone" } });
  await h.vm.toggle();
  const start = h.log.sent.find(([c]) => c === "voice:start")[1];
  assert.deepEqual([start.micDeviceId, start.micLabel], ["id-mb", "MacBook Pro Microphone"]);
  h.vm.onSettingsChanged({ ...cloneDefaultVoice(), brain: "claude-code", tts: "local-kokoro", enabled: true, micDeviceId: "id-usb", micLabel: "USB Mic" });
  assert.equal(h.vm.getState().active, true);
  const sel = h.log.sent.filter(([c]) => c === "voice:mic-select");
  assert.deepEqual(sel, [["voice:mic-select", { micDeviceId: "id-usb", micLabel: "USB Mic" }]]);
  h.vm.onSettingsChanged({ ...cloneDefaultVoice(), brain: "claude-code", tts: "local-kokoro", enabled: true, micDeviceId: "id-usb", micLabel: "USB Mic" });
  assert.equal(h.log.sent.filter(([c]) => c === "voice:mic-select").length, 1, "unchanged mic is not re-sent");
});

test("voice settings accept and clamp micDeviceId / micLabel", () => {
  assert.equal(validateVoice({ micDeviceId: "abc", micLabel: "USB Mic" }).status, "ok");
  assert.equal(validateVoice({ micDeviceId: 5 }).status, "error");
  assert.equal(normalizeVoice({ micDeviceId: "x".repeat(999) }).micDeviceId.length, 256);
  assert.equal(cloneDefaultVoice().micDeviceId, "");
});

test("the call window publishes labeled input names (no aliases) for the settings picker; main caches and serves them", async () => {
  const env = makeEnv({ devices: DEVICES });
  await env.renderer.start({ vad: "main" });
  await new Promise((r) => setImmediate(r));
  const sent = env.calls.find((c) => c[0] === "micDevices")[1];
  assert.deepEqual(sent.map((d) => d.label), ["OrayVirtualAudioDevice", "Serennan's iPhone Microphone", "MacBook Pro Microphone", "USB Mic"]);
  const h = makeHarness();
  assert.deepEqual(await h.log.handlers.get("voice:mic-devices-list")(), []);
  h.emit("voice:mic-devices", [{ deviceId: "id-usb", label: "USB Mic" }, { deviceId: "", label: "bad" }]);
  assert.deepEqual(await h.log.handlers.get("voice:mic-devices-list")(), [{ deviceId: "id-usb", label: "USB Mic" }]);
});

"use strict";

// voice-main wiring for helper capture: source choice per setting, PCM into the
// runtime, stem mute, crash -> fallback, mid-call toggle, device switching.
const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { makeHarness } = require("./fixtures/voice-main-harness");
const { encodeFrame } = require("../src/voice-frame-protocol");

function fakeSpawn() {
  const spawned = [];
  const spawn = (bin, args, opts) => {
    const c = new EventEmitter();
    c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
    c.writes = [];
    c.stdin.on("data", (b) => c.writes.push(...String(b).split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    c.killed = false;
    c.kill = () => { c.killed = true; c.emit("exit", null, "SIGTERM"); return true; };
    c.bin = bin; c.args = args;
    spawned.push(c);
    return c;
  };
  return { spawn, spawned };
}
const ctl = (c, o) => { c.stderr.write(`${JSON.stringify(o)}\n`); };
const tick = () => new Promise((r) => setImmediate(r));
const sentTo = (h, ch) => h.log.sent.filter(([c]) => c === ch).map(([, p]) => p);
const dbg = (h, ev) => h.log.dbg.filter(([e]) => e === ev).map(([, f]) => f);

function setup({ voice = {}, ...rest } = {}) {
  const f = fakeSpawn();
  const h = makeHarness({
    sherpa: "ready", voice,
    extraDeps: { muteHelperPath: "/x/h", osRelease: "25.0.0", spawnMuteHelper: f.spawn, existsSync: () => true },
    ...rest,
  });
  return { h, f };
}

test("switch on: helper spawned, voice:start says capture=helper, capture_source logged", async () => {
  const { h, f } = setup({ voice: { micLabel: "AirPods 4" } });
  await h.vm.shortcutToggle();
  assert.equal(f.spawned.length, 1);
  assert.deepEqual(f.spawned[0].args, ["--device", "AirPods 4"]);
  assert.equal(sentTo(h, "voice:start")[0].capture, "helper");
  assert.ok(dbg(h, "capture_source").some((x) => x.source === "helper"));
});

test("switch off: no helper is ever spawned, renderer records", async () => {
  const { h, f } = setup({ voice: { airpodsMuteCapture: false } });
  await h.vm.shortcutToggle();
  assert.equal(f.spawned.length, 0);
  assert.equal(sentTo(h, "voice:start")[0].capture, "renderer");
  assert.ok(dbg(h, "capture_source").some((x) => x.source === "renderer"));
});

test("unsupported OS (macOS 13) with the switch on: renderer records, no spawn", async () => {
  const f = fakeSpawn();
  const h = makeHarness({ sherpa: "ready", extraDeps: { muteHelperPath: "/x/h", osRelease: "22.6.0", spawnMuteHelper: f.spawn, existsSync: () => true } });
  await h.vm.shortcutToggle();
  assert.equal(f.spawned.length, 0);
  assert.equal(sentTo(h, "voice:start")[0].capture, "renderer");
});

test("helper stdout PCM reaches the main-process VAD", async () => {
  const { h, f } = setup();
  await h.vm.shortcutToggle();
  const whole = Buffer.concat([encodeFrame(Buffer.alloc(640, 1)), encodeFrame(Buffer.alloc(640, 1))]);
  f.spawned[0].stdout.write(whole.subarray(0, 500));
  f.spawned[0].stdout.write(whole.subarray(500));
  await tick();
  assert.equal(h.log.vadChunks, 2);
});

test("stem mute pauses the call (no pet cue: AirPods chimes), unmute resumes; shortcut pushes set; call end kills", async () => {
  const { h, f } = setup();
  await h.vm.shortcutToggle();
  const c = f.spawned[0];
  ctl(c, { ready: true, muted: false });
  ctl(c, { mute: true }); await tick();
  assert.equal(h.vm.getState().paused, true);
  assert.deepEqual(h.log.cues, ["start"]);
  assert.deepEqual(c.writes, []);
  h.vm.togglePause();
  assert.deepEqual(c.writes, [{ set: false }]);
  h.vm.togglePause();
  assert.deepEqual(c.writes, [{ set: false }, { set: true }]);
  ctl(c, { mute: false }); await tick();
  assert.equal(h.vm.getState().paused, false);
  h.vm.stop("user");
  assert.equal(c.killed, true);
});

test("helper keeps sending PCM while muted (wake phrase), pause does not stop the helper", async () => {
  const { h, f } = setup();
  await h.vm.shortcutToggle();
  const c = f.spawned[0];
  ctl(c, { ready: true, muted: false });
  ctl(c, { mute: true }); await tick();
  const before = h.log.vadChunks || 0;
  c.stdout.write(encodeFrame(Buffer.alloc(640, 1))); await tick();
  assert.equal(h.log.vadChunks, before + 1);
  assert.equal(c.killed, false);
});

test("helper crashes 3 times -> restarted; the 4th -> renderer capture and capture_fallback_renderer", async () => {
  const { h, f } = setup();
  await h.vm.shortcutToggle();
  for (let i = 0; i < 3; i++) f.spawned[i].emit("exit", 1, null);
  assert.equal(f.spawned.length, 4);
  assert.equal(sentTo(h, "voice:capture").length, 0);
  f.spawned[3].emit("exit", 1, null);
  assert.equal(f.spawned.length, 4);
  assert.deepEqual(sentTo(h, "voice:capture"), [{ source: "renderer" }]);
  assert.equal(dbg(h, "capture_fallback_renderer").length, 1);
  assert.equal(h.vm.getState().active, true, "the call survives");
});

test("silent (all-zero) helper PCM restarts the helper", async () => {
  const realNow = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  try {
    const { h, f } = setup();
    await h.vm.shortcutToggle();
    for (let i = 0; i < 200; i++) { f.spawned[0].stdout.write(encodeFrame(Buffer.alloc(640))); t += 20; await tick(); }
    assert.equal(f.spawned.length, 2);
    assert.equal(sentTo(h, "voice:mic-restart").length, 0);
  } finally { Date.now = realNow; }
});

test("toggling the setting mid-call rebuilds capture without ending the call", async () => {
  const { h, f } = setup();
  await h.vm.shortcutToggle();
  h.setVoice({ airpodsMuteCapture: false });
  h.vm.onSettingsChanged(h.getVoice());
  assert.equal(f.spawned[0].killed, true);
  assert.deepEqual(sentTo(h, "voice:capture"), [{ source: "renderer" }]);
  assert.equal(h.vm.getState().active, true);
  h.setVoice({ airpodsMuteCapture: true });
  h.vm.onSettingsChanged(h.getVoice());
  assert.equal(f.spawned.length, 2);
  assert.deepEqual(sentTo(h, "voice:capture").map((p) => p.source), ["renderer", "helper"]);
});

test("picking another microphone mid-call tells the helper by label", async () => {
  const { h, f } = setup();
  await h.vm.shortcutToggle();
  h.setVoice({ micDeviceId: "abc", micLabel: "USB Mic" });
  h.vm.onSettingsChanged(h.getVoice());
  assert.deepEqual(f.spawned[0].writes.filter((m) => "device" in m), [{ device: "USB Mic" }]);
  assert.equal(f.spawned.length, 1);
});

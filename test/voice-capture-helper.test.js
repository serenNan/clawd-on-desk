"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const { createCaptureHelper } = require("../src/voice-capture-helper");
const { encodeFrame } = require("../src/voice-frame-protocol");

function fakeSpawn() {
  const spawned = [];
  const spawn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.writes = [];
    child.stdin.on("data", (b) => child.writes.push(...String(b).split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit("exit", null, "SIGTERM"); return true; };
    child.bin = bin; child.args = args; child.opts = opts;
    spawned.push(child);
    return child;
  };
  return { spawn, spawned };
}

function make(over = {}) {
  const fs = fakeSpawn();
  const logs = []; const pcm = []; const fallbacks = []; const calls = [];
  let paused = false;
  const h = createCaptureHelper({
    platform: "darwin", osRelease: "25.0.0", binPath: "/x/clawd-mute-helper", existsSync: () => true,
    spawn: fs.spawn, log: (ev, f) => logs.push([ev, f]),
    getPaused: () => paused, setPaused: (v) => { calls.push(v); paused = v; },
    getDeviceLabel: () => "", onPcm: (b) => pcm.push(Buffer.from(b)), onFallback: (r) => fallbacks.push(r),
    ...over,
  });
  return { h, ...fs, logs, pcm, fallbacks, calls, setP: (v) => { paused = v; } };
}
const ctl = (c, o) => { c.stderr.write(`${JSON.stringify(o)}\n`); };
const tick = () => new Promise((r) => setImmediate(r));
const ev = (m, name) => m.logs.filter(([e]) => e === name);

test("start spawns with piped stdout/stderr and the chosen device label", () => {
  const m = make({ getDeviceLabel: () => "AirPods 4" });
  assert.equal(m.h.start(), true);
  assert.equal(m.spawned.length, 1);
  assert.deepEqual(m.spawned[0].args, ["--device", "AirPods 4"]);
  assert.deepEqual(m.spawned[0].opts.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(m.h.start(), true);
  assert.equal(m.spawned.length, 1, "no second spawn while running");
});

test("no device label -> no argument; unsupported platforms never spawn", () => {
  const m = make();
  m.h.start();
  assert.deepEqual(m.spawned[0].args, []);
  for (const over of [{ platform: "win32" }, { osRelease: "22.6.0" }, { existsSync: () => false }, { binPath: null }]) {
    const x = make(over);
    assert.equal(x.h.supported(), false);
    assert.equal(x.h.start(), false);
    assert.equal(x.spawned.length, 0);
  }
});

test("stdout frames (glued and split) become PCM buffers", () => {
  const m = make();
  m.h.start();
  const a = encodeFrame(Buffer.alloc(640, 1)); const b = encodeFrame(Buffer.alloc(640, 2));
  const both = Buffer.concat([a, b]);
  m.spawned[0].stdout.write(both.subarray(0, 700));
  m.spawned[0].stdout.write(both.subarray(700));
  return tick().then(() => {
    assert.deepEqual(m.pcm.map((x) => [x.length, x[0]]), [[640, 1], [640, 2]]);
  });
});

test("capture status from the control channel is logged with device + voiceProcessing", async () => {
  const m = make();
  m.h.start();
  ctl(m.spawned[0], { ready: true, muted: false });
  ctl(m.spawned[0], { capture: { device: "MacBook Mic", voiceProcessing: true, rate: 48000, channels: 1 } });
  ctl(m.spawned[0], { capture: { device: "AirPods", voiceProcessing: false, vpError: "nope" } });
  m.spawned[0].stderr.write("Swift runtime warning, not json\n");
  await tick();
  const started = ev(m, "helper_capture_started");
  assert.equal(started.length, 2);
  assert.equal(started[0][1].device, "MacBook Mic");
  assert.equal(started[0][1].voiceProcessing, true);
  assert.equal(started[1][1].voiceProcessing, false);
  assert.equal(started[1][1].vpError, "nope");
});

test("airpods mute / unmute drive the shared paused state", async () => {
  const m = make();
  m.h.start();
  const c = m.spawned[0];
  ctl(c, { ready: true, muted: false });
  ctl(c, { mute: true }); await tick();
  assert.deepEqual(m.calls, [true]);
  assert.ok(ev(m, "airpods_mute").some(([, f]) => f.mute === true && f.source === "airpods"));
  ctl(c, { mute: false }); await tick();
  assert.deepEqual(m.calls, [true, false]);
});

test("a mute report before ready (engine start-up echo) never changes the paused state", async () => {
  const m = make();
  m.setP(true);
  m.h.start();
  ctl(m.spawned[0], { mute: false }); await tick();
  assert.deepEqual(m.calls, []);
  ctl(m.spawned[0], { ready: true, muted: false }); await tick();
  assert.deepEqual(m.spawned[0].writes, [{ set: true }]);
});

test("no loop: helper-reported state is not written back, duplicates ignored", async () => {
  const m = make();
  m.h.start();
  const c = m.spawned[0];
  ctl(c, { ready: true, muted: false });
  ctl(c, { mute: true }); await tick();
  m.h.syncPaused(true);
  assert.deepEqual(c.writes, []);
  ctl(c, { mute: true }); await tick();
  assert.deepEqual(m.calls, [true]);
});

test("shortcut / voice command changes are pushed to the system; ready syncs state", async () => {
  const m = make();
  m.setP(true);
  m.h.start();
  const c = m.spawned[0];
  m.h.syncPaused(true); // before ready: nothing written yet
  ctl(c, { ready: true, muted: false }); await tick();
  assert.deepEqual(c.writes, [{ set: true }]);
  m.h.syncPaused(false);
  assert.deepEqual(c.writes, [{ set: true }, { set: false }]);
  assert.deepEqual(m.calls, []);
});

test("setDevice writes a device message; stop kills without fallback", () => {
  const m = make();
  m.h.start();
  m.h.setDevice("USB Mic");
  assert.deepEqual(m.spawned[0].writes, [{ device: "USB Mic" }]);
  m.h.stop();
  assert.equal(m.spawned[0].killed, true);
  assert.equal(m.fallbacks.length, 0);
  assert.ok(ev(m, "mute_helper_exit").some(([, f]) => f.expected === true));
});

test("crash restarts up to 3 times, then falls back to the renderer once", () => {
  const m = make();
  m.h.start();
  for (let i = 0; i < 3; i++) { m.spawned[i].emit("exit", 1, null); assert.equal(m.spawned.length, i + 2); }
  assert.equal(m.fallbacks.length, 0);
  m.spawned[3].emit("exit", 1, null);
  assert.equal(m.spawned.length, 4, "no 5th spawn");
  assert.deepEqual(m.fallbacks, ["exit"]);
  const fb = ev(m, "capture_fallback_renderer");
  assert.equal(fb.length, 1);
  assert.equal(fb[0][1].reason, "exit");
});

test("silent restarts share the same budget of 3", () => {
  const m = make();
  m.h.start();
  m.spawned[0].emit("exit", 1, null); // crash 1
  m.h.restart("silent"); // 2
  m.h.restart("silent"); // 3
  assert.equal(m.spawned.length, 4);
  assert.equal(m.fallbacks.length, 0);
  m.h.restart("silent"); // over budget
  assert.deepEqual(m.fallbacks, ["silent"]);
  assert.equal(m.spawned.length, 4);
  assert.equal(m.spawned[3].killed, true);
});

test("a new start after stop gets a fresh budget", () => {
  const m = make();
  m.h.start();
  for (let i = 0; i < 4; i++) m.spawned[i].emit("exit", 1, null);
  assert.equal(m.fallbacks.length, 1);
  m.h.stop();
  assert.equal(m.h.start(), true);
  m.spawned[m.spawned.length - 1].emit("exit", 1, null);
  assert.equal(m.fallbacks.length, 1, "restarted, not fallen back");
});

test("a corrupt stdout (bad magic) counts as a crash and restarts", async () => {
  const m = make();
  m.h.start();
  m.spawned[0].stdout.write(Buffer.from("oops this is text\n")); await tick();
  assert.equal(m.spawned.length, 2);
  assert.equal(m.spawned[0].killed, true);
});

test("spawn throwing is logged and falls back immediately", () => {
  const m = make({ spawn: () => { throw new Error("boom"); } });
  assert.equal(m.h.start(), false);
  assert.deepEqual(m.fallbacks, ["spawn-failed"]);
  assert.ok(ev(m, "capture_fallback_renderer").length === 1);
});

test("raw stem callbacks are logged but never change the paused state; mute carries its source", async () => {
  const m = make();
  m.h.start();
  const c = m.spawned[0];
  ctl(c, { ready: true, muted: false });
  ctl(c, { handler: true }); await tick();
  assert.deepEqual(m.calls, []);
  assert.ok(ev(m, "airpods_handler").some(([, f]) => f.shouldMute === true));
  ctl(c, { mute: true, via: "vp" }); await tick();
  assert.deepEqual(m.calls, [true]);
  assert.ok(ev(m, "airpods_mute").some(([, f]) => f.via === "vp"));
});

test("a helper that sends no audio frames for 5s is restarted, and over budget falls back", () => {
  let t = 0; let tickFn = null;
  const m = make({ now: () => t, setInterval: (fn) => { tickFn = fn; return 1; }, clearInterval: () => { tickFn = null; } });
  m.h.start();
  t = 4000; tickFn();
  assert.equal(m.spawned.length, 1, "start-up grace: no restart before 5s");
  m.spawned[0].stdout.write(encodeFrame(Buffer.alloc(640)));
  t = 8000; tickFn();
  assert.equal(m.spawned.length, 1, "frames keep it alive");
  for (let i = 0; i < 4; i += 1) { t += 5100; tickFn(); }
  assert.equal(m.spawned.length, 4, "3 restarts");
  assert.deepEqual(m.fallbacks, ["no-frames"]);
  assert.ok(ev(m, "capture_no_frames").length >= 1);
  assert.equal(tickFn, null, "watchdog stops with the helper");
});

test("stem mute changes pause without the pet's own cue (the system chimes)", async () => {
  const opts = [];
  const m = make({ setPaused: (v, o) => opts.push([v, o]) });
  m.h.start();
  const c = m.spawned[0];
  ctl(c, { ready: true, muted: false });
  ctl(c, { mute: true }); await tick();
  assert.deepEqual(opts, [[true, { cue: false }]]);
});

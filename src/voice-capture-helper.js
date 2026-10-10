"use strict";

const fs = require("node:fs");
const os = require("node:os");
const readline = require("node:readline");
const { spawn: nodeSpawn } = require("node:child_process");
const { createFrameParser } = require("./voice-frame-protocol");

const MIN_DARWIN_MAJOR = 23; // macOS 14: AVAudioApplication input-mute API
const MAX_RESTARTS = 3; // crashes + silent-mic restarts, per call
const NO_FRAMES_MS = 5000; // engine start-up takes ~2-3s; longer with no audio = stalled engine

// Bundled Swift helper (native/airpods-mute) that records the microphone itself
// and registers the AirPods-stem mute handler: the stem press is only delivered
// to the process that records. Wire protocol:
//   stdout  binary PCM frames (voice-frame-protocol), 16 kHz mono s16le, 20 ms
//   stderr  JSON lines: {"ready",muted} {"capture":{device,voiceProcessing,..}} {"mute":b}
//   stdin   JSON lines: {"set":b} system mute mirror, {"device":label} switch input
// The pet's `paused` stays the single source of truth for mute; the helper never
// zeroes audio (the wake phrase is still listened for while muted).
function createCaptureHelper({
  platform = process.platform, osRelease = os.release(), binPath, existsSync = fs.existsSync,
  spawn = nodeSpawn, getPaused, setPaused, getDeviceLabel = () => "", onPcm, onFallback = () => {}, log = () => {},
  now = Date.now, setInterval: setI = setInterval, clearInterval: clearI = clearInterval,
}) {
  let child = null;
  let ready = false;
  let systemMuted = false; // last mute state the system is known to have
  let restarts = 0;
  let lastFrameAt = 0;
  let watchdog = null;

  // A live helper whose engine stopped delivering audio (e.g. after a route change) is restarted.
  function startWatchdog() {
    if (watchdog) return;
    watchdog = setI(() => {
      if (!child || now() - lastFrameAt < NO_FRAMES_MS) return;
      log("capture_no_frames", { ms: now() - lastFrameAt });
      restart("no-frames");
    }, 1000);
    if (watchdog && watchdog.unref) watchdog.unref();
  }
  function stopWatchdog() { if (watchdog) { clearI(watchdog); watchdog = null; } }

  const supported = () => platform === "darwin"
    && parseInt(String(osRelease).split(".")[0], 10) >= MIN_DARWIN_MAJOR
    && !!binPath && existsSync(binPath);

  function write(obj) {
    if (!child || !child.stdin || child.stdin.destroyed) return;
    try { child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* helper is going away */ }
  }

  function pushToSystem(paused) {
    if (!ready || paused === systemMuted) return;
    systemMuted = paused;
    log("airpods_mute", { mute: paused, source: "app" });
    write({ set: paused });
  }

  function onControl(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; } // runtime warnings are not ours
    if (!msg || typeof msg !== "object") return;
    if (msg.ready) {
      ready = true;
      systemMuted = !!msg.muted;
      pushToSystem(!!getPaused());
    } else if (typeof msg.handler === "boolean") {
      log("airpods_handler", { shouldMute: msg.handler }); // raw stem callback, for diagnosis
    } else if (msg.capture && typeof msg.capture === "object") {
      log("helper_capture_started", msg.capture);
    } else if (typeof msg.mute === "boolean") {
      // The system reports the current state while the engine comes up; before `ready` it is not a stem press.
      if (!ready) { log("airpods_mute", { mute: msg.mute, source: "airpods", ignored: true, early: true }); return; }
      systemMuted = msg.mute;
      const changed = msg.mute !== !!getPaused();
      log("airpods_mute", { mute: msg.mute, source: "airpods", via: msg.via, ignored: !changed });
      if (changed) setPaused(msg.mute, { cue: false }); // AirPods already chimed
    }
  }

  function fallback(reason) {
    kill();
    stopWatchdog();
    log("capture_fallback_renderer", { reason, restarts });
    onFallback(reason);
  }

  function kill() {
    const c = child;
    if (!c) return;
    child = null; ready = false;
    try { c.kill(); } catch { /* already gone */ }
  }

  // Counted restart (crash, protocol error, silent mic); over budget -> renderer capture.
  function relaunch(reason) {
    if (restarts >= MAX_RESTARTS) { fallback(reason); return; }
    restarts += 1;
    spawnChild();
  }
  function restart(reason) {
    if (!child) return;
    kill();
    relaunch(reason);
  }

  function spawnChild() {
    const label = getDeviceLabel();
    let c;
    try {
      c = spawn(binPath, label ? ["--device", label] : [], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      log("mute_helper_exit", { error: e && e.message, spawnFailed: true });
      fallback("spawn-failed");
      return false;
    }
    child = c; ready = false; systemMuted = false; lastFrameAt = now();
    log("mute_helper_spawn", { restart: restarts, device: !!label });
    const parser = createFrameParser({
      onFrame: (b) => { if (child === c) { lastFrameAt = now(); onPcm(b); } },
      onError: (code) => { if (child === c) { log("capture_protocol_error", { code }); restart("protocol"); } },
    });
    if (c.stdin) c.stdin.on("error", () => {});
    if (c.stdout) c.stdout.on("data", (b) => parser.push(b));
    if (c.stderr) readline.createInterface({ input: c.stderr }).on("line", (l) => { if (child === c) onControl(l); });
    c.on("error", (e) => log("mute_helper_exit", { error: e && e.message }));
    c.on("exit", (code, signal) => {
      if (child !== c) return;
      child = null; ready = false;
      log("mute_helper_exit", { code, signal, expected: false });
      relaunch("exit");
    });
    return true;
  }

  return {
    supported,
    isRunning: () => !!child,
    start() {
      if (child) return true;
      if (!supported()) return false;
      restarts = 0;
      const ok = spawnChild();
      if (ok) startWatchdog();
      return ok;
    },
    stop() {
      stopWatchdog();
      if (!child) return;
      kill();
      log("mute_helper_exit", { expected: true });
    },
    restart,
    setDevice(label) { write({ device: label || "" }); },
    syncPaused: (paused) => pushToSystem(!!paused),
  };
}

module.exports = { createCaptureHelper };

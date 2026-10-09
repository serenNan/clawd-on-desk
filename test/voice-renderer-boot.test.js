"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const SRC = path.join(__dirname, "..", "src");
const BOOT = fs.readFileSync(path.join(SRC, "voice-renderer-boot.js"), "utf8");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const CSS = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");

function makeBridge() {
  const handlers = {};
  const bridge = new Proxy({}, {
    get: (_, name) => {
      if (typeof name === "string" && name.startsWith("on")) return (cb) => { handlers[name] = cb; };
      return () => {};
    },
  });
  return { bridge, handlers };
}

function run({ withBridge = true } = {}) {
  const { bridge, handlers } = makeBridge();
  const calls = [];
  const classes = new Set();
  const props = {};
  const indicator = {
    classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    style: { setProperty: (k, v) => { props[k] = v; } },
  };
  const bodyClasses = new Set();
  const win = {
    electronAPI: withBridge ? { voice: bridge } : {},
    ClawdVoiceRenderer: {
      createVoiceRenderer: (opts) => {
        calls.push(["create", Object.keys(opts).sort()]);
        calls.push(["opts", opts]);
        return new Proxy({}, { get: (_, n) => (...a) => calls.push([n, ...a]) });
      },
    },
  };
  const doc = {
    getElementById: (id) => (id === "voice-indicator" ? indicator : null),
    body: { classList: { toggle: (c, on) => (on ? bodyClasses.add(c) : bodyClasses.delete(c)) }, style: { setProperty: (k, v) => { props[`body${k}`] = v; } } },
  };
  vm.runInNewContext(BOOT, { window: win, document: doc, navigator: { mediaDevices: {} }, AudioContext: function () {}, AudioWorkletNode: function () {}, setTimeout: () => 0, clearTimeout: () => {} });
  return { handlers, calls, classes, bodyClasses, props, indicatorClasses: classes };
}

test("does nothing without the preload bridge", () => {
  const r = run({ withBridge: false });
  assert.deepEqual(r.calls, []);
});

test("voice:start activates indicator + capture, voice:stop releases both", () => {
  const r = run();
  r.handlers.onStart({});
  assert.ok(r.bodyClasses.has("voice-active"));
  assert.ok(r.calls.some((c) => c[0] === "start"));
  r.handlers.onStop({});
  assert.equal(r.bodyClasses.has("voice-active"), false);
  assert.ok(r.calls.some((c) => c[0] === "stop"));
});

test("playback and barge events are forwarded to the controller", () => {
  const r = run();
  r.handlers.onTtsPcm({ sentenceId: "1-1" });
  r.handlers.onTtsEnd({ sentenceId: "1-1" });
  r.handlers.onStopPlayback({ epoch: 3 });
  r.handlers.onPartial({ text: "x" });
  r.handlers.onMuted({ muted: true });
  const names = r.calls.map((c) => c[0]);
  for (const n of ["handleTtsPcm", "handleTtsEnd", "handleStopPlayback", "handlePartial", "handleMuted"]) {
    assert.ok(names.includes(n), n);
  }
});

test("audio level is clamped into the --voice-level custom property", () => {
  const r = run();
  const opts = r.calls.find((c) => c[0] === "opts")[1];
  opts.onLevel("mic", 0.5);
  assert.equal(r.props["body--voice-level"], "1");
  opts.onLevel("speaker", 0.1);
  assert.equal(r.props["body--voice-level"], "0.4");
  opts.onLevel("mic", -1);
  assert.equal(r.props["body--voice-level"], "0");
});

test("index.html loads the voice scripts in dependency order with no inline script", () => {
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const idx = (f) => order.indexOf(f);
  for (const f of ["voice-vad.js", "voice-barge-in.js", "voice-audio-renderer.js", "voice-renderer.js", "voice-renderer-boot.js"]) {
    assert.ok(idx(f) >= 0, `${f} is loaded`);
  }
  assert.ok(idx("voice-vad.js") < idx("voice-renderer.js"));
  assert.ok(idx("voice-renderer.js") < idx("voice-renderer-boot.js"));
  assert.ok(idx("voice-renderer-boot.js") < idx("renderer.js") || idx("renderer.js") >= 0);
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(HTML), false, "CSP forbids inline scripts");
  assert.ok(HTML.includes('id="voice-indicator"'));
  assert.ok(/script-src 'self'/.test(HTML));
});

test("styles drive the pulse from --voice-level and keep it inert when no call is active", () => {
  assert.ok(CSS.includes("#voice-indicator"));
  assert.ok(CSS.includes("body.voice-active #pet-motion-stage"));
  assert.ok(CSS.includes("var(--voice-level"));
});

test("mic badge has three states: hidden (no call), listening (active), paused (active + paused)", () => {
  const r = run();
  assert.equal(r.classes.has("active"), false, "no call: no badge");
  r.handlers.onStart({});
  assert.equal(r.classes.has("active"), true);
  assert.equal(r.classes.has("paused"), false, "listening");
  r.handlers.onPaused({ paused: true });
  assert.equal(r.classes.has("active"), true);
  assert.equal(r.classes.has("paused"), true, "paused");
  assert.ok(r.calls.some((c) => c[0] === "handlePaused" && c[1].paused === true), "renderer releases the mic");
  r.handlers.onPaused({ paused: false });
  assert.equal(r.classes.has("paused"), false);
  assert.ok(r.calls.some((c) => c[0] === "handlePaused" && c[1].paused === false));
  r.handlers.onPaused({ paused: true });
  r.handlers.onStop({});
  assert.equal(r.classes.has("active"), false, "call ended: badge gone");
  assert.equal(r.classes.has("paused"), false, "and the paused look is cleared");
});

test("badge markup: slash only when paused, never intercepts clicks, lives inside the pet stage", () => {
  assert.ok(HTML.includes('class="voice-slash"'));
  assert.ok(/#voice-indicator \{[^}]*pointer-events: none/.test(CSS));
  assert.ok(/#voice-indicator\.paused/.test(CSS));
  assert.ok(/#voice-indicator \.voice-slash \{ display: none; \}/.test(CSS));
  assert.ok(/#voice-indicator\.paused \.voice-slash \{ display: inline; \}/.test(CSS));
  const stage = HTML.indexOf('id="pet-motion-stage"');
  const root = HTML.indexOf('id="voice-indicator"');
  assert.ok(stage >= 0 && root > stage, "badge is inside the pet container, so it follows pet position and scale");
});

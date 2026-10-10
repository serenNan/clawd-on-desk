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
  const props = {};
  const attrs = {};
  const bodyClasses = new Set();
  const cap = { classes: new Set(), attrs: {}, textContent: "" };
  cap.classList = { add: (c) => cap.classes.add(c), remove: (c) => cap.classes.delete(c) };
  cap.setAttribute = (k, v) => { cap.attrs[k] = v; };
  const timers = [];
  const win = {
    electronAPI: withBridge ? { voice: bridge } : {},
    ClawdVoiceCaptions: require("../src/voice-captions"),
    ClawdVoiceRenderer: {
      createVoiceRenderer: (opts) => {
        calls.push(["create", Object.keys(opts).sort()]);
        calls.push(["opts", opts]);
        return new Proxy({}, { get: (_, n) => (...a) => calls.push([n, ...a]) });
      },
    },
  };
  const doc = {
    getElementById: (id) => ({ "voice-caption": cap })[id] || null,
    body: {
      classList: { toggle: (c, on) => (on ? bodyClasses.add(c) : bodyClasses.delete(c)) },
      style: { setProperty: (k, v) => { props[k] = v; } },
      setAttribute: (k, v) => { attrs[k] = v; },
    },
  };
  vm.runInNewContext(BOOT, { window: win, document: doc, navigator: { mediaDevices: {} }, AudioContext: function () {}, AudioWorkletNode: function () {}, setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {} });
  return { handlers, calls, bodyClasses, props, attrs, cap, timers };
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

test("index.html loads the voice scripts in dependency order with no inline script", () => {
  const order = [...HTML.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const idx = (f) => order.indexOf(f);
  for (const f of ["voice-vad.js", "voice-barge-in.js", "voice-audio-renderer.js", "voice-mic-device.js", "voice-renderer.js", "voice-renderer-boot.js"]) {
    assert.ok(idx(f) >= 0, `${f} is loaded`);
  }
  assert.ok(idx("voice-renderer.js") < idx("voice-renderer-boot.js"));
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/.test(HTML), false, "CSP forbids inline scripts");
  assert.ok(/script-src 'self'/.test(HTML));
  assert.equal(HTML.includes("voice-pet"), false, "no custom pet animation assets");
});

test("no custom pet visuals: badge, ears and fx layer are gone", () => {
  assert.equal(HTML.includes("voice-indicator") || HTML.includes("voice-fx") || HTML.includes("voice-ears"), false);
  assert.equal(CSS.includes("voice-indicator"), false);
  assert.equal(fs.existsSync(path.join(SRC, "voice-pet.css")) || fs.existsSync(path.join(SRC, "voice-pet-anim.js")), false);
});

test("voice:paused still releases the mic in the renderer", () => {
  const r = run();
  r.handlers.onPaused({ paused: true });
  assert.ok(r.calls.some((c) => c[0] === "handlePaused" && c[1].paused === true));
});

test("caption window: card style, 2-line clamp, click-through window files exist and CSP is strict", () => {
  const css = fs.readFileSync(path.join(SRC, "voice-caption.css"), "utf8");
  const html = fs.readFileSync(path.join(SRC, "voice-caption.html"), "utf8");
  assert.ok(/-webkit-line-clamp: 2/.test(css));
  assert.ok(/prefers-reduced-motion/.test(css) && /prefers-color-scheme: dark/.test(css));
  assert.ok(/script-src 'self'/.test(html) && !/<script(?![^>]*\bsrc=)[^>]*>/.test(html));
  assert.ok(fs.existsSync(path.join(SRC, "preload-voice-caption.js")));
});

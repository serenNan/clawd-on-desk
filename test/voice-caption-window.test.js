"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createVoiceCaptionWindow, CAPTION_SIZE } = require("../src/voice-caption-window");

function setup({ pet = { x: 1000, y: 400, width: 86, height: 86 }, work = { x: 0, y: 0, width: 1920, height: 1080 } } = {}) {
  const rec = { wins: [], timers: [] };
  class FakeWin {
    constructor(opts) {
      this.opts = opts; this.sent = []; this.visible = false; this.bounds = null; this.calls = [];
      this.webContents = { send: (c, p) => this.sent.push([c, p]), once: (e, cb) => cb(), isDestroyed: () => false };
      rec.wins.push(this);
    }
    setIgnoreMouseEvents(v) { this.ignore = v; }
    setAlwaysOnTop(...a) { this.calls.push(["top", ...a]); }
    setBounds(b) { this.bounds = b; }
    loadFile(f) { this.file = f; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    isDestroyed() { return false; }
    destroy() { this.destroyed = true; }
  }
  const cw = createVoiceCaptionWindow({
    BrowserWindow: FakeWin,
    screen: { getDisplayMatching: () => ({ workArea: work }) },
    getPetBounds: () => pet,
    preloadPath: "/p/preload.js",
    htmlPath: "/p/caption.html",
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; rec.timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
  });
  return { cw, rec, win: () => rec.wins[0] };
}

test("a click-through, non-focusable overlay window is created lazily and reused", () => {
  const s = setup();
  assert.equal(s.rec.wins.length, 0);
  s.cw.show({ role: "assistant", text: "你好" });
  s.cw.show({ role: "user", text: "再见" });
  assert.equal(s.rec.wins.length, 1);
  const o = s.win().opts;
  assert.equal(o.focusable, false); assert.equal(o.frame, false); assert.equal(o.transparent, true); assert.equal(o.skipTaskbar, true);
  assert.equal(o.webPreferences.contextIsolation, true); assert.equal(o.webPreferences.nodeIntegration, false);
  assert.equal(s.win().ignore, true);
  assert.equal(s.win().file, "/p/caption.html");
  assert.deepEqual(s.win().sent.map(([c, p]) => [c, p.text]), [["voice-caption:show", "你好"], ["voice-caption:show", "再见"]]);
  assert.equal(s.win().visible, true);
});

test("it sits just above the pet, centered, and never over the body", () => {
  const s = setup();
  s.cw.show({ role: "assistant", text: "x" });
  const b = s.win().bounds;
  assert.equal(b.width, CAPTION_SIZE.width);
  assert.equal(b.x, 1000 + 43 - CAPTION_SIZE.width / 2);
  assert.ok(b.y + b.height <= 400, "bottom edge is above the pet window top");
});

test("near the top of the screen it moves below the pet; at the screen edge x is clamped", () => {
  const top = setup({ pet: { x: 1000, y: 10, width: 86, height: 86 } });
  top.cw.show({ role: "assistant", text: "x" });
  assert.ok(top.win().bounds.y >= 10 + 86);
  const edge = setup({ pet: { x: 1880, y: 500, width: 86, height: 86 }, work: { x: 0, y: 0, width: 1920, height: 1080 } });
  edge.cw.show({ role: "assistant", text: "x" });
  assert.ok(edge.win().bounds.x + CAPTION_SIZE.width <= 1920);
});

test("it fades after the hold time (hint 3s) and the window hides after the fade; new text restarts the clock", () => {
  const s = setup();
  s.cw.show({ role: "hint", text: "先在 Claude Code 会话里输入 /clawd-voice" });
  const t1 = s.rec.timers.at(-1);
  assert.equal(t1.ms, 3000);
  s.cw.show({ role: "assistant", text: "好的" });
  assert.equal(t1.live, false);
  const t2 = s.rec.timers.at(-1);
  t2.fn();
  assert.equal(s.win().sent.at(-1)[0], "voice-caption:hide");
  assert.equal(s.win().visible, true, "still fading");
  s.rec.timers.at(-1).fn();
  assert.equal(s.win().visible, false);
});

test("clear hides immediately; dispose destroys; invalid payloads are ignored", () => {
  const s = setup();
  s.cw.show({ role: "bogus", text: "x" }); s.cw.show({ role: "user", text: "   " });
  assert.equal(s.rec.wins.length, 0);
  s.cw.show({ role: "user", text: "嗨" });
  s.cw.clear();
  assert.equal(s.win().visible, false);
  s.cw.dispose();
  assert.equal(s.win().destroyed, true);
});

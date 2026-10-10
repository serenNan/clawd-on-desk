"use strict";

// Subtitle bubble for voice calls: a small click-through window above the pet
// (the pet window itself is too small to hold text without covering the body).
// Text only travels main -> this window's renderer; it is never logged or stored.
const { holdMs } = require("./voice-captions");

const CAPTION_SIZE = Object.freeze({ width: 230, height: 48 });
const GAP = 4;
const FADE_MS = 300;
const ROLES = new Set(["user", "assistant", "hint"]);

function createVoiceCaptionWindow({ BrowserWindow, screen, getPetBounds, preloadPath, htmlPath, setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout }) {
  let win = null;
  let holdTimer = null;
  let fadeTimer = null;
  const alive = () => !!win && !win.isDestroyed();

  function ensure() {
    if (alive()) return win;
    win = new BrowserWindow({
      width: CAPTION_SIZE.width, height: CAPTION_SIZE.height, show: false, frame: false, transparent: true,
      resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, "screen-saver");
    win.loadFile(htmlPath);
    return win;
  }

  function place() {
    const pet = getPetBounds();
    if (!pet) return;
    const area = screen.getDisplayMatching(pet).workArea;
    const { width, height } = CAPTION_SIZE;
    const x = Math.min(area.x + area.width - width, Math.max(area.x, Math.round(pet.x + pet.width / 2 - width / 2)));
    const above = pet.y - height - GAP;
    const y = above >= area.y ? above : pet.y + pet.height + GAP; // no room above: below, still clear of the body
    win.setBounds({ x, y, width, height });
  }

  function hide() {
    clearT(holdTimer); clearT(fadeTimer);
    if (alive()) win.hide();
  }

  return {
    show({ role, text } = {}) {
      const clean = String(text || "").replace(/\s+/g, " ").trim();
      if (!ROLES.has(role) || !clean) return;
      ensure();
      place();
      win.webContents.send("voice-caption:show", { role, text: clean });
      win.showInactive();
      clearT(holdTimer); clearT(fadeTimer);
      holdTimer = setT(() => {
        if (!alive()) return;
        win.webContents.send("voice-caption:hide");
        fadeTimer = setT(() => { if (alive()) win.hide(); }, FADE_MS);
      }, holdMs(role, clean));
    },
    clear: hide,
    dispose() { hide(); if (alive()) win.destroy(); win = null; },
  };
}

module.exports = { createVoiceCaptionWindow, CAPTION_SIZE };

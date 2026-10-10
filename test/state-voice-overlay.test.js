"use strict";

const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const themeLoader = require("../src/theme-loader");
themeLoader.init(path.join(__dirname, "..", "src"));

function makeCtx(themeId) {
  return {
    theme: themeLoader.loadTheme(themeId),
    doNotDisturb: false, miniTransitioning: false, miniMode: false, mouseOverPet: false,
    idlePaused: false, forceEyeResend: false, mouseStillSince: Date.now(),
    playSound() {}, sendToRenderer() {}, syncHitWin() {}, sendToHitWin() {},
    miniPeekIn() {}, miniPeekOut() {}, buildContextMenu() {}, buildTrayMenu() {},
    pendingPermissions: [], resolvePermissionEntry() {}, t: (k) => k, focusTerminalWindow() {},
  };
}

describe("voice overlay display state", () => {
  let api;
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    api = require("../src/state")(makeCtx("clawd"));
  });
  afterEach(() => { mock.timers.reset(); });

  it("shows listening/speaking/thinking and restores the live state when cleared", () => {
    api.setVoiceOverlay("listening");
    assert.strictEqual(api.getCurrentState(), "listening");
    assert.strictEqual(api.getCurrentSvg(), "clawd-headphones-groove.svg");
    api.setVoiceOverlay("speaking");
    assert.strictEqual(api.getCurrentState(), "speaking");
    assert.strictEqual(api.getCurrentSvg(), "clawd-working-thinking.svg");
    api.setVoiceOverlay("voiceThinking");
    assert.strictEqual(api.getCurrentState(), "voiceThinking");
    assert.strictEqual(api.getCurrentSvg(), "clawd-idle-bubble.svg");
    api.setVoiceOverlay(null);
    assert.strictEqual(api.getCurrentState(), "idle");
  });

  it("does not create sessions or alter the HUD snapshot", () => {
    const before = JSON.stringify(api.buildSessionSnapshot());
    api.setVoiceOverlay("speaking");
    assert.strictEqual(JSON.stringify(api.buildSessionSnapshot()), before);
  });

  it("ending the call restores the CURRENT live state, not the one cached at start", () => {
    api.updateSession("s1", "working", "PreToolUse", { cwd: "/tmp", agentPid: process.pid, agentId: "cursor-agent", editor: "cursor" });
    mock.timers.tick(5000); // let the working display hold elapse
    api.setVoiceOverlay("speaking");
    assert.strictEqual(api.getCurrentState(), "speaking");
    api.updateSession("s1", "idle", "Stop", { cwd: "/tmp", agentPid: process.pid, agentId: "cursor-agent", editor: "cursor" });
    api.setVoiceOverlay(null);
    mock.timers.tick(5000);
    assert.notStrictEqual(api.getCurrentState(), "working");
    assert.notStrictEqual(api.getCurrentState(), "speaking");
  });

  const sess = { cwd: "/tmp", agentPid: process.pid, agentId: "cursor-agent", editor: "cursor" };

  it("voice states stay visible while a coding session is working/juggling/carrying", () => {
    for (const coding of ["working", "juggling", "carrying"]) {
      for (const voice of ["listening", "speaking", "voiceThinking", "paused"]) {
        const a = require("../src/state")(makeCtx("clawd"));
        a.updateSession("s1", coding, "PreToolUse", sess);
        a.setVoiceOverlay(voice);
        assert.strictEqual(a.resolveDisplayState(), voice, `${voice} over ${coding}`);
      }
    }
  });

  it("errors and permission requests still outrank voice states", () => {
    const { resolveDisplayStateFromSessions } = require("../src/state-priority");
    const errored = new Map([["s1", { state: "error" }]]);
    assert.strictEqual(resolveDisplayStateFromSessions(errored, { voiceState: "speaking" }), "error");
    assert.strictEqual(resolveDisplayStateFromSessions(new Map(), { voiceState: "speaking", permissionLocked: true }), "notification");
  });

  it("ignores unknown overlay names", () => {
    api.setVoiceOverlay("bogus");
    assert.strictEqual(api.getCurrentState(), "idle");
  });
});

describe("voice overlay on themes without voice art", () => {
  it("calico falls back to idle for listening and working for speaking", () => {
    const calico = makeCtx("calico");
    const api = require("../src/state")(calico);
    api.setVoiceOverlay("listening");
    assert.strictEqual(api.getCurrentState(), "listening");
    assert.ok(calico.theme.states.idle.includes(api.getCurrentSvg()));
    api.setVoiceOverlay("speaking");
    assert.ok(calico.theme.states.working.includes(api.getCurrentSvg()));
  });
});

describe("paused voice overlay", () => {
  for (const themeId of ["clawd", "calico", "cloudling"]) {
    it(`${themeId}: paused shows a sleeping-like visual, not idle`, () => {
      mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const api = require("../src/state")(makeCtx(themeId));
      const idleSvg = api.getCurrentSvg();
      api.setVoiceOverlay("paused");
      assert.strictEqual(api.getCurrentState(), "paused");
      const sleepSvg = makeCtx(themeId).theme.states.sleeping[0];
      assert.strictEqual(api.getCurrentSvg(), sleepSvg);
      assert.notStrictEqual(api.getCurrentSvg(), idleSvg);
      api.setVoiceOverlay(null);
      assert.strictEqual(api.getCurrentState(), "idle");
      mock.timers.reset();
    });
  }
});

describe("voice thinking art is independent of coding thinking", () => {
  it("clawd: coding thinking keeps its art, voice thinking uses idle-bubble; other themes fall back to thinking art", () => {
    const api = require("../src/state")(makeCtx("clawd"));
    assert.deepStrictEqual(makeCtx("clawd").theme.states.thinking, ["clawd-working-thinking.svg"]);
    api.setVoiceOverlay("voiceThinking");
    assert.strictEqual(api.getCurrentSvg(), "clawd-idle-bubble.svg");
    const calico = makeCtx("calico");
    const c = require("../src/state")(calico);
    c.setVoiceOverlay("voiceThinking");
    assert.ok(calico.theme.states.thinking.includes(c.getCurrentSvg()));
  });
});

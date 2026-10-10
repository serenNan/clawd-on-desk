const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");
const { describe, it } = require("node:test");

const MENU_MODULE_PATH = require.resolve("../src/menu");

function loadMenuWithElectron(fakeElectron, fakeTaskbar = null, platform = null) {
  delete require.cache[MENU_MODULE_PATH];
  const originalLoad = Module._load;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  if (platform) {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
  }
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    if (fakeTaskbar && request === "./taskbar") return fakeTaskbar;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/menu");
  } finally {
    Module._load = originalLoad;
    if (platform) Object.defineProperty(process, "platform", originalPlatform);
  }
}

function fakeElectron() {
  return {
    app: { quit: () => {}, setActivationPolicy: () => {}, dock: { show: () => {}, hide: () => {} } },
    BrowserWindow: function BrowserWindow() {},
    Menu: {
      buildFromTemplate(template) {
        return { template };
      },
    },
    Tray: function Tray() {},
    nativeImage: {
      createFromPath() {
        return {
          resize() { return this; },
          setTemplateImage() {},
        };
      },
    },
    screen: {
      getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ id: 1 }),
    },
  };
}

function buildBaseCtx(overrides = {}) {
  return {
    win: { isDestroyed: () => false },
    sessions: new Map(),
    currentSize: "P:15",
    doNotDisturb: false,
    lang: "en",
    showTray: true,
    showDock: true,
    openAtLogin: false,
    bubbleFollowPet: false,
    hideBubbles: false,
    soundMuted: false,
    menuOpen: false,
    tray: null,
    contextMenuOwner: null,
    contextMenu: null,
    isQuitting: false,
    petHidden: false,
    getMiniMode: () => false,
    getMiniTransitioning: () => false,
    getDisableMiniMode: () => false,
    getActiveThemeCapabilities: () => ({ miniMode: true, petTint: true }),
    openDashboard: () => {},
    openSettingsWindow: () => {},
    togglePetVisibility: () => {},
    bringPetToPrimaryDisplay: () => {},
    enableDoNotDisturb: () => {},
    disableDoNotDisturb: () => {},
    enterMiniViaMenu: () => {},
    exitMiniMode: () => {},
    miniHandleResize: () => false,
    getPetWindowBounds: () => ({ x: 10, y: 20, width: 120, height: 120 }),
    applyPetWindowBounds: () => {},
    getCurrentPixelSize: () => ({ width: 200, height: 200 }),
    isProportionalMode: () => true,
    repositionBubbles: () => {},
    syncHitWin: () => {},
    flushRuntimeStateToPrefs: () => {},
    reapplyMacVisibility: () => {},
    getSettingsWindow: () => null,
    clampToScreenVisual: (x, y) => ({ x, y }),
    ...overrides,
  };
}

describe("context and tray menu voice entry", () => {
  function labelsOf(template) { return template.map((i) => i.label).filter(Boolean); }

  it("hides the entry while voice is disabled and not in a call", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const ctx = buildBaseCtx({ getVoiceMenuState: () => ({ enabled: false, active: false }), toggleVoice: () => {} });
    initMenu(ctx).buildContextMenu();
    const labels = labelsOf(ctx.contextMenu.template);
    assert.ok(!labels.includes("Start Voice Chat"));
    assert.ok(!labels.includes("End Voice Chat"));
  });

  it("shows Start when enabled and calls the shared toggle", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const calls = [];
    const ctx = buildBaseCtx({ getVoiceMenuState: () => ({ enabled: true, active: false }), toggleVoice: () => calls.push("toggle") });
    initMenu(ctx).buildContextMenu();
    const item = ctx.contextMenu.template.find((i) => i.label === "Start Voice Chat");
    assert.ok(item, "context menu should expose Start Voice Chat");
    item.click();
    assert.deepStrictEqual(calls, ["toggle"]);
  });

  it("shows End during a call even if the preference was switched off meanwhile", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const ctx = buildBaseCtx({ getVoiceMenuState: () => ({ enabled: false, active: true }), toggleVoice: () => {} });
    initMenu(ctx).buildContextMenu();
    assert.ok(labelsOf(ctx.contextMenu.template).includes("End Voice Chat"));
  });

  it("during a call offers Pause Listening; while paused it reads Resume Listening (paused) so the state is visible", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const calls = [];
    let paused = false;
    const ctx = buildBaseCtx({
      getVoiceMenuState: () => ({ enabled: true, active: true, paused }),
      toggleVoice: () => {},
      toggleVoicePause: () => calls.push("pause"),
    });
    const api = initMenu(ctx);
    api.buildContextMenu();
    const pause = ctx.contextMenu.template.find((i) => i.label === "Pause Listening");
    assert.ok(pause);
    pause.click();
    paused = true;
    api.buildContextMenu();
    const resume = ctx.contextMenu.template.find((i) => i.label === "Resume Listening (paused)");
    assert.ok(resume);
    resume.click();
    assert.deepStrictEqual(calls, ["pause", "pause"]);
  });

  it("during a call a disabled row names the Claude session that drives it", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const ctx = buildBaseCtx({
      getVoiceMenuState: () => ({ enabled: true, active: true, ownerLabel: "clawd-on-desk·a1b2c3" }),
      toggleVoice: () => {},
      toggleVoicePause: () => {},
    });
    initMenu(ctx).buildContextMenu();
    const row = ctx.contextMenu.template.find((i) => /clawd-on-desk·a1b2c3/.test(i.label || ""));
    assert.ok(row, "owner row present");
    assert.strictEqual(row.enabled, false);
    assert.match(row.label, /Voice driven by/);
    const none = buildBaseCtx({ getVoiceMenuState: () => ({ enabled: true, active: true, ownerLabel: null }), toggleVoice: () => {}, toggleVoicePause: () => {} });
    initMenu(none).buildContextMenu();
    assert.ok(!none.contextMenu.template.some((i) => /driven by/i.test(i.label || "")));
  });

  it("no pause entry without a live call", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const ctx = buildBaseCtx({ getVoiceMenuState: () => ({ enabled: true, active: false }), toggleVoice: () => {}, toggleVoicePause: () => {} });
    initMenu(ctx).buildContextMenu();
    assert.ok(!labelsOf(ctx.contextMenu.template).some((l) => /Listening/.test(l)));
  });

  it("works without the voice hook wired (older ctx)", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    const ctx = buildBaseCtx();
    assert.doesNotThrow(() => initMenu(ctx).buildContextMenu());
  });

  it("tray menu carries the same entry", () => {
    const initMenu = loadMenuWithElectron(fakeElectron());
    let trayMenu = null;
    const ctx = buildBaseCtx({
      getVoiceMenuState: () => ({ enabled: true, active: true }),
      toggleVoice: () => {},
      tray: { setContextMenu: (m) => { trayMenu = m; } },
    });
    initMenu(ctx).buildTrayMenu();
    assert.ok(trayMenu.template.some((i) => i.label === "End Voice Chat"));
  });
});

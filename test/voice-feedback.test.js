"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createVoiceFeedback, MAC_MIC_SETTINGS_URL } = require("../src/voice-feedback");

function harness(over = {}) {
  const shown = [];
  const opened = [];
  let now = 1000;
  class FakeNotification {
    constructor(opts) { this.opts = opts; this.handlers = {}; }
    on(ev, fn) { this.handlers[ev] = fn; }
    show() { shown.push(this); }
  }
  const dialogCalls = [];
  const fb = createVoiceFeedback({
    Notification: over.Notification || FakeNotification,
    dialog: { showMessageBox: async (opts) => { dialogCalls.push(opts); return { response: over.response ?? 0 }; } },
    shell: { openExternal: (u) => opened.push(u) },
    t: (k) => `<${k}>`,
    platform: over.platform || "darwin",
    now: () => now,
    getDialogParent: () => null,
  });
  return { fb, shown, opened, dialogCalls, tick: (ms) => { now += ms; } };
}

test("notify shows a localized notification with the voice title", () => {
  const h = harness();
  h.fb.notify("voice-disabled");
  assert.equal(h.shown.length, 1);
  assert.deepEqual(h.shown[0].opts, { title: "<voiceNoticeTitle>", body: "<voiceErrDisabled>" });
});

test("identical notices within 5s are coalesced, later ones show again", () => {
  const h = harness();
  h.fb.notify("aec-unavailable");
  h.fb.notify("aec-unavailable");
  assert.equal(h.shown.length, 1);
  h.tick(6000);
  h.fb.notify("aec-unavailable");
  assert.equal(h.shown.length, 2);
});

test("mic denial opens the macOS privacy pane only on click, once per notification", () => {
  const h = harness();
  h.fb.notify("mic-denied");
  assert.deepEqual(h.opened, []);
  h.shown[0].handlers.click();
  assert.deepEqual(h.opened, [MAC_MIC_SETTINGS_URL]);
  const win = harness({ platform: "win32" });
  win.fb.notify("mic-denied");
  assert.equal(win.shown[0].handlers.click, undefined);
});

test("a notification failure never throws into the call path", () => {
  const h = harness({ Notification: class { constructor() { throw new Error("no display"); } } });
  assert.doesNotThrow(() => h.fb.notify("reply-too-long"));
});

test("cloud consent dialog states the upload and returns the user's choice", async () => {
  const yes = harness({ response: 0 });
  assert.equal(await yes.fb.confirmCloudConsent(), true);
  const d = yes.dialogCalls[0];
  assert.equal(d.title, "<voiceConsentTitle>");
  assert.equal(d.message, "<voiceConsentTitle>");
  assert.equal(d.detail, "<voiceConsentBody>");
  assert.deepEqual(d.buttons, ["<voiceConsentAllow>", "<voiceConsentCancel>"]);
  assert.equal(d.defaultId, 1);
  assert.equal(d.cancelId, 1);
  const no = harness({ response: 1 });
  assert.equal(await no.fb.confirmCloudConsent(), false);
});

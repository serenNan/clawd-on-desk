"use strict";

const { describeVoiceNotice } = require("./voice-notice-text");

const MAC_MIC_SETTINGS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
const COALESCE_MS = 5000;

// User-facing surface for voice: OS notifications for errors/notices and the
// first-use cloud upload consent dialog. Secrets and transcripts never pass here.
function createVoiceFeedback({ Notification, dialog, shell, t, platform = process.platform, now = Date.now, getDialogParent = () => null }) {
  const lastShown = new Map();

  function notify(code) {
    const stamp = now();
    if (lastShown.has(code) && stamp - lastShown.get(code) < COALESCE_MS) return;
    lastShown.set(code, stamp);
    const { body, openMicSettings } = describeVoiceNotice(code, t);
    try {
      const n = new Notification({ title: t("voiceNoticeTitle"), body });
      if (openMicSettings && platform === "darwin") n.on("click", () => shell.openExternal(MAC_MIC_SETTINGS_URL));
      n.show();
    } catch { /* notifications are best effort */ }
  }

  async function confirmCloudConsent() {
    const options = {
      type: "question",
      title: t("voiceConsentTitle"),
      message: t("voiceConsentTitle"),
      detail: t("voiceConsentBody"),
      buttons: [t("voiceConsentAllow"), t("voiceConsentCancel")],
      defaultId: 1,
      cancelId: 1,
    };
    const parent = getDialogParent();
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return result.response === 0;
  }

  return { notify, confirmCloudConsent };
}

module.exports = { createVoiceFeedback, MAC_MIC_SETTINGS_URL };

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (root) root.ClawdVoiceCaptions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Latest-sentence bubble next to the pet. Text lives only in this element:
  // nothing is stored or logged, and it fades out a few seconds after the last update.
  const MAX_CHARS = 160; // CSS clamps the visible part to two lines
  const MIN_HOLD_MS = 2500;
  const MAX_HOLD_MS = 7000;
  const PER_CHAR_MS = 100;
  const HINT_HOLD_MS = 3000; // "start from a Claude Code session" hint

  const holdMs = (role, text) => (role === "hint" ? HINT_HOLD_MS : Math.min(MAX_HOLD_MS, MIN_HOLD_MS + String(text).length * PER_CHAR_MS));

  function createCaptions({ el, setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout }) {
    let timer = null;
    const hide = () => { timer = null; el.classList.remove("show"); };
    return {
      show({ role, text } = {}) {
        const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
        if (!clean || (role !== "user" && role !== "assistant" && role !== "hint")) return;
        el.textContent = clean;
        el.setAttribute("data-role", role);
        el.classList.add("show");
        clearT(timer);
        timer = setT(hide, holdMs(role, clean));
      },
      clear() { clearT(timer); hide(); el.textContent = ""; },
    };
  }

  return { createCaptions, holdMs, MAX_CHARS };
});

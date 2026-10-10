"use strict";

const { createMicWatch } = require("./voice-mic-watch");

// Who records the microphone for a call: the bundled helper ("helper") or the
// renderer's getUserMedia ("renderer"). The helper needs the main-process VAD
// (it only produces raw PCM) and the user setting. A helper failure pins the
// call to the renderer. The zero-PCM watch lives here because its remedy depends
// on the source: ask the host to restart the helper, or the renderer to rebuild.
const RENDERER_RETRIES = 3;
const HELPER_RETRIES = RENDERER_RETRIES + 1; // the 4th request lets the host give up and fall back

function createCaptureSource({ canHelper, onSource, onHelperSilent, send, log, now }) {
  let source = null;
  let hasVad = false;
  let forced = false;
  let watch = null;

  const pick = () => (!forced && hasVad && canHelper() ? "helper" : "renderer");

  function apply(next) {
    source = next;
    log("capture_source", { source, forced });
    watch = createMicWatch({
      now, log, maxRetries: next === "helper" ? HELPER_RETRIES : RENDERER_RETRIES,
      onSilent: (info) => (next === "helper" ? onHelperSilent(info) : send("voice:mic-restart", info)),
    });
    onSource(next);
  }

  return {
    source: () => source,
    begin({ hasMainVad }) { hasVad = !!hasMainVad; forced = false; apply(pick()); return source; },
    refresh() {
      if (!source) return;
      const next = pick();
      if (next === source) return;
      apply(next);
      send("voice:capture", { source: next });
    },
    fail(reason) { log("capture_failed", { reason }); forced = true; this.refresh(); },
    feedWatch(buf) { if (watch) watch.feed(buf); },
    end() { if (!source) return; source = null; watch = null; onSource(null); },
  };
}

module.exports = { createCaptureSource };

"use strict";

// Brain for `session` mode: the reply text is authored by an external Claude
// Code session (via /voice/converse), so "generation" just replays that text
// through the normal sentence -> TTS -> playback pipeline.
function createSessionBrain() {
  return {
    id: "session",
    async probe() { return { ok: true }; },
    send(req, handlers) {
      handlers.onTextDelta(req.text);
      handlers.onCompleted(req.text);
    },
    cancel() {},
    reset() {},
    dispose() {},
  };
}

module.exports = { createSessionBrain };

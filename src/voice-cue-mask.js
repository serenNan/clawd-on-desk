"use strict";

// Plays a start/end cue through `onCue` and, for the start cue, masks the mic for
// `maskMs` so the cue itself is never heard as speech.
const { errorFields } = require("./voice-debug-log");

function createCueMask({ onCue, log, maskMs, setTimeout: setT, clearTimeout: clearT }) {
  let masked = false;
  let timer = null;
  return {
    cue(name, mask = false) {
      try { onCue(name); } catch (e) { log("exception", { where: "onCue", ...errorFields(e) }); }
      clearT(timer);
      masked = mask;
      if (masked) timer = setT(() => { masked = false; timer = null; }, maskMs);
    },
    isMasked: () => masked,
  };
}

module.exports = { createCueMask };

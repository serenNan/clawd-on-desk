"use strict";

// Provider lifecycle for the call controller: readiness + brain probe on start, tolerant disposal on stop.
const { resolveVoiceReadiness } = require("./voice-settings");
const { errorFields } = require("./voice-debug-log");

function safely(log, where, fn) {
  try { fn(); } catch (e) { log("exception", { where, ...errorFields(e) }); }
}

// -> { providers, probe } or { rejected: { status:"error", reasons } }
async function openProviders({ voice, env, createProviders, log }) {
  const readiness = resolveVoiceReadiness({ voice, env, requireEnabled: true });
  if (!readiness.ready) { log("start_rejected", { reasons: readiness.reasons.join(",") }); return { rejected: { status: "error", reasons: readiness.reasons } }; }
  const providers = createProviders(voice);
  const probe = providers.brain && providers.brain.probe ? await providers.brain.probe() : { ok: true };
  if (!probe.ok) {
    safely(log, "brain.dispose", () => providers.brain.dispose());
    log("start_rejected", { reasons: probe.reason || "brain-unavailable" });
    return { rejected: { status: "error", reasons: [probe.reason || "brain-unavailable"] } };
  }
  return { providers, probe };
}

function disposeProviders(p, log) {
  if (!p) return;
  safely(log, "tts.dispose", () => { if (p.tts && p.tts.dispose) p.tts.dispose(); });
  safely(log, "brain.dispose", () => { if (p.brain) p.brain.dispose(); });
  safely(log, "vad.reset", () => { if (p.vad) p.vad.reset(); });
}

module.exports = { openProviders, disposeProviders };

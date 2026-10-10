"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cloneDefaultVoice,
  normalizeVoice,
  validateVoice,
  resolveVoiceReadiness,
  DASHSCOPE_KEY_ENV,
} = require("../src/voice-settings");

test("defaults: disabled, session brain, sherpa-onnx STT, Edge TTS, no cloud consent", () => {
  const d = cloneDefaultVoice();
  assert.equal(d.enabled, false);
  assert.equal(d.brain, "session");
  assert.equal(d.stt, "sherpa-onnx");
  assert.equal(d.tts, "edge");
  assert.equal(d.edgeVoice, "zh-CN-XiaoxiaoNeural");
  assert.equal(d.endSilenceMs, 800);
  assert.equal(d.cloudConsent, false);
  assert.equal(d.ttsVoice, "longanyang");
  assert.notEqual(cloneDefaultVoice(), d, "each call returns a fresh object");
});

test("normalizeVoice coerces bad input back to defaults and drops unknown keys", () => {
  assert.deepEqual(normalizeVoice(undefined), cloneDefaultVoice());
  const n = normalizeVoice({ enabled: "yes", stt: "nope", tts: 3, apiKey: "sk-secret", cloudConsent: true });
  assert.equal(n.enabled, false);
  assert.equal(n.stt, "sherpa-onnx");
  assert.equal(n.tts, "edge", "unknown provider falls back to the default");
  assert.equal(n.cloudConsent, true);
  assert.equal("apiKey" in n, false, "credentials are never persisted in prefs");
});

test("validateVoice rejects secrets, unknown providers and bad types", () => {
  assert.equal(validateVoice(cloneDefaultVoice()).status, "ok");
  assert.equal(validateVoice({ ...cloneDefaultVoice(), apiKey: "x" }).status, "error");
  assert.equal(validateVoice({ ...cloneDefaultVoice(), stt: "mystery" }).status, "error");
  assert.equal(validateVoice({ ...cloneDefaultVoice(), enabled: 1 }).status, "error");
  assert.equal(validateVoice(null).status, "error");
  assert.equal(validateVoice({ ...cloneDefaultVoice(), claudePath: "a\nb" }).status, "error");
});

test("readiness: local providers need no key or consent", () => {
  const r = resolveVoiceReadiness({ voice: { ...cloneDefaultVoice(), tts: "local-kokoro" }, env: {} });
  assert.equal(r.ready, true);
  assert.equal(r.cloud, false);
});

test("readiness: cloud STT without key or consent is not ready (no capture)", () => {
  const voice = { ...cloneDefaultVoice(), stt: "aliyun-paraformer" };
  const r = resolveVoiceReadiness({ voice, env: {} });
  assert.equal(r.ready, false);
  assert.deepEqual(r.reasons.sort(), ["cloud-consent-missing", "dashscope-key-missing"]);
  const withKey = resolveVoiceReadiness({ voice, env: { [DASHSCOPE_KEY_ENV]: "k" } });
  assert.deepEqual(withKey.reasons, ["cloud-consent-missing"]);
  const ok = resolveVoiceReadiness({ voice: { ...voice, cloudConsent: true }, env: { [DASHSCOPE_KEY_ENV]: "k" } });
  assert.equal(ok.ready, true);
  assert.equal(ok.cloud, true);
});

test("readiness: cosyvoice v3.5 needs a voice id", () => {
  const voice = { ...cloneDefaultVoice(), tts: "aliyun-cosyvoice-v3.5-flash", cloudConsent: true };
  const env = { [DASHSCOPE_KEY_ENV]: "k" };
  assert.deepEqual(resolveVoiceReadiness({ voice, env }).reasons, ["voice-id-missing"]);
  assert.equal(resolveVoiceReadiness({ voice: { ...voice, ttsVoiceId: "cosyvoice-v3.5-flash-abc" }, env }).ready, true);
});

test("readiness: disabled voice is never ready", () => {
  const r = resolveVoiceReadiness({ voice: { ...cloneDefaultVoice(), tts: "local-kokoro", enabled: false }, env: {}, requireEnabled: true });
  assert.equal(r.ready, false);
  assert.deepEqual(r.reasons, ["voice-disabled"]);
});

test("prefs schema carries voice defaults and normalizes a stored blob", () => {
  const prefs = require("../src/prefs");
  const d = prefs.getDefaults();
  assert.deepEqual(d.voice, cloneDefaultVoice());
  const v = prefs.validate({ ...d, voice: { enabled: true, apiKey: "leak", stt: "bogus" } });
  assert.equal(v.voice.enabled, true);
  assert.equal(v.voice.stt, "sherpa-onnx");
  assert.equal("apiKey" in v.voice, false);
});

test("settings-actions registers a voice validator", () => {
  const { updateRegistry } = require("../src/settings-actions");
  assert.equal(typeof updateRegistry.voice, "function");
  assert.equal(updateRegistry.voice(cloneDefaultVoice()).status, "ok");
  assert.equal(updateRegistry.voice({ ...cloneDefaultVoice(), tts: "x" }).status, "error");
});

test("sherpa-onnx and local-whisper are valid local providers and need no key or consent", () => {
  for (const stt of ["sherpa-onnx", "local-whisper"]) {
    assert.equal(validateVoice({ ...cloneDefaultVoice(), stt }).status, "ok");
    const r = resolveVoiceReadiness({ voice: { ...cloneDefaultVoice(), tts: "local-kokoro", enabled: true, stt }, env: {} });
    assert.equal(r.ready, true);
    assert.equal(r.cloud, false);
  }
  assert.equal(normalizeVoice({ stt: "local-whisper" }).stt, "local-whisper");
});

test("brain accepts session and still rejects unknown brains", () => {
  assert.equal(normalizeVoice({ brain: "session" }).brain, "session");
  assert.equal(validateVoice({ brain: "session" }).status, "ok");
  assert.equal(validateVoice({ brain: "gpt" }).status, "error");
  assert.equal(normalizeVoice({ brain: "gpt" }).brain, "session");
});

test("local Kokoro voice and speed are configurable and bounded", () => {
  const d = normalizeVoice({});
  assert.equal(d.localTtsVoice, "zf_xiaoxiao");
  assert.equal(d.ttsSpeed, 1.2);
  assert.equal(normalizeVoice({ ttsSpeed: 1.5 }).ttsSpeed, 1.5);
  assert.equal(normalizeVoice({ ttsSpeed: 9 }).ttsSpeed, 1.2);
  assert.equal(normalizeVoice({ ttsSpeed: "fast" }).ttsSpeed, 1.2);
  assert.equal(normalizeVoice({ localTtsVoice: "zm_yunxi" }).localTtsVoice, "zm_yunxi");
});

test("edge TTS is a cloud provider: needs consent but no DashScope key", () => {
  const voice = { ...cloneDefaultVoice(), tts: "edge" };
  const r = resolveVoiceReadiness({ voice, env: {} });
  assert.equal(r.cloud, true);
  assert.deepEqual(r.reasons, ["cloud-consent-missing"]);
  assert.equal(resolveVoiceReadiness({ voice: { ...voice, cloudConsent: true }, env: {} }).ready, true);
  assert.equal(validateVoice({ tts: "edge" }).status, "ok");
});

test("edgeVoice must look like a neural voice name; bad values fall back", () => {
  assert.equal(normalizeVoice({ edgeVoice: "zh-CN-YunjianNeural" }).edgeVoice, "zh-CN-YunjianNeural");
  assert.equal(normalizeVoice({ edgeVoice: "<script>" }).edgeVoice, "zh-CN-XiaoxiaoNeural");
  assert.equal(validateVoice({ edgeVoice: "a b" }).status, "error");
  assert.equal(validateVoice({ edgeVoice: "zh-CN-XiaoyiNeural" }).status, "ok");
});

test("endSilenceMs is bounded to 400-1500 ms", () => {
  assert.equal(normalizeVoice({ endSilenceMs: 1000 }).endSilenceMs, 1000);
  assert.equal(normalizeVoice({ endSilenceMs: 300 }).endSilenceMs, 800);
  assert.equal(normalizeVoice({ endSilenceMs: 2000 }).endSilenceMs, 800);
  assert.equal(validateVoice({ endSilenceMs: 300 }).status, "error");
  assert.equal(validateVoice({ endSilenceMs: 400 }).status, "ok");
});

test("voice cue switch defaults on and accepts booleans only", () => {
  assert.equal(normalizeVoice({}).cueEnabled, true);
  assert.equal(normalizeVoice({ cueEnabled: false }).cueEnabled, false);
  assert.equal(normalizeVoice({ cueEnabled: "no" }).cueEnabled, true);
});

test("captions defaults to on, must be a boolean", () => {
  const { cloneDefaultVoice, normalizeVoice, validateVoice } = require("../src/voice-settings");
  assert.equal(cloneDefaultVoice().captions, true);
  assert.equal(normalizeVoice({ captions: false }).captions, false);
  assert.equal(normalizeVoice({ captions: "no" }).captions, true);
  assert.equal(validateVoice({ captions: "x" }).status, "error");
  assert.equal(validateVoice({ captions: false }).status, "ok");
});

test("default brain is the Claude Code session; the background CLI brain stays selectable", () => {
  const { cloneDefaultVoice, normalizeVoice, validateVoice } = require("../src/voice-settings");
  assert.equal(cloneDefaultVoice().brain, "session");
  assert.equal(normalizeVoice({ brain: "claude-code" }).brain, "claude-code");
  assert.equal(validateVoice({ brain: "claude-code" }).status, "ok");
});

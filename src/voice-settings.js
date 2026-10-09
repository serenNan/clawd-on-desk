"use strict";

// Realtime voice preferences (pure data layer). Credentials never live here:
// the DashScope key is read from the main-process environment only.
const DASHSCOPE_KEY_ENV = "DASHSCOPE_API_KEY";

const BRAINS = Object.freeze(["claude-code", "session"]);
const STT_PROVIDERS = Object.freeze(["sherpa-onnx", "local-whisper", "aliyun-paraformer"]);
const TTS_PROVIDERS = Object.freeze([
  "edge",
  "local-kokoro",
  "aliyun-cosyvoice-v3-flash",
  "aliyun-cosyvoice-v3.5-flash",
]);

// Default: sherpa-onnx streaming ASR in-process + Microsoft Edge online neural
// TTS (free, no key, but the reply text goes to Microsoft, so cloudConsent is
// required; failures fall back to loopback Kokoro). Aliyun providers also need a key.
const DEFAULT_VOICE = Object.freeze({
  enabled: false,
  brain: "claude-code",
  stt: "sherpa-onnx",
  tts: "edge",
  cloudConsent: false,
  ttsVoice: "longanyang",
  ttsVoiceId: "",
  localTtsVoice: "zf_xiaoxiao",
  edgeVoice: "zh-CN-XiaoxiaoNeural",
  endSilenceMs: 800,
  ttsSpeed: 1.2,
  localFallback: false,
  cueEnabled: true,
  claudePath: "",
});

const ENUMS = { brain: BRAINS, stt: STT_PROVIDERS, tts: TTS_PROVIDERS };
const BOOLEANS = ["enabled", "cloudConsent", "localFallback", "cueEnabled"];
const STRINGS = { edgeVoice: 64, ttsVoice: 64, ttsVoiceId: 128, localTtsVoice: 64, claudePath: 512 };
const NUMBERS = { ttsSpeed: [0.5, 2], endSilenceMs: [400, 1500] };
const EDGE_VOICE_RE = /^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9]+Neural$/;

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const hasControlChars = (v) => typeof v === "string" && /[\u0000-\u001f\u007f]/.test(v);

function cloneDefaultVoice() {
  return { ...DEFAULT_VOICE };
}

function normalizeVoice(value) {
  const out = cloneDefaultVoice();
  if (!isPlainObject(value)) return out;
  for (const key of BOOLEANS) if (typeof value[key] === "boolean") out[key] = value[key];
  for (const [key, list] of Object.entries(ENUMS)) {
    if (list.includes(value[key])) out[key] = value[key];
  }
  for (const [key, max] of Object.entries(STRINGS)) {
    if (typeof value[key] === "string" && !hasControlChars(value[key])) out[key] = value[key].trim().slice(0, max);
  }
  if (!EDGE_VOICE_RE.test(out.edgeVoice)) out.edgeVoice = DEFAULT_VOICE.edgeVoice;
  for (const [key, [min, max]] of Object.entries(NUMBERS)) {
    if (Number.isFinite(value[key]) && value[key] >= min && value[key] <= max) out[key] = value[key];
  }
  return out;
}

function validateVoice(value) {
  if (!isPlainObject(value)) return { status: "error", message: "voice must be a plain object" };
  for (const key of Object.keys(value)) {
    if (!(key in DEFAULT_VOICE)) return { status: "error", message: `voice.${key} is not a known setting` };
  }
  for (const key of BOOLEANS) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      return { status: "error", message: `voice.${key} must be a boolean` };
    }
  }
  for (const [key, list] of Object.entries(ENUMS)) {
    if (value[key] !== undefined && !list.includes(value[key])) {
      return { status: "error", message: `voice.${key} must be one of ${list.join(", ")}` };
    }
  }
  for (const [key, max] of Object.entries(STRINGS)) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > max || hasControlChars(v)) {
      return { status: "error", message: `voice.${key} must be a short plain string` };
    }
  }
  if (value.edgeVoice !== undefined && !EDGE_VOICE_RE.test(value.edgeVoice)) {
    return { status: "error", message: "voice.edgeVoice must be a neural voice name like zh-CN-XiaoxiaoNeural" };
  }
  for (const [key, [min, max]] of Object.entries(NUMBERS)) {
    const v = value[key];
    if (v !== undefined && !(Number.isFinite(v) && v >= min && v <= max)) {
      return { status: "error", message: `voice.${key} must be a number between ${min} and ${max}` };
    }
  }
  return { status: "ok" };
}

// Reasons are stable codes (UI maps them to i18n). Nothing is captured or
// uploaded until `ready` is true.
function resolveVoiceReadiness({ voice, env = process.env, requireEnabled = false } = {}) {
  const v = normalizeVoice(voice);
  const reasons = [];
  if (requireEnabled && !v.enabled) reasons.push("voice-disabled");
  const aliyun = v.stt.startsWith("aliyun-") || v.tts.startsWith("aliyun-");
  const cloud = aliyun || v.tts === "edge";
  if (aliyun && !(env && env[DASHSCOPE_KEY_ENV])) reasons.push("dashscope-key-missing");
  if (cloud && !v.cloudConsent) reasons.push("cloud-consent-missing");
  if (v.tts === "aliyun-cosyvoice-v3.5-flash" && !v.ttsVoiceId) reasons.push("voice-id-missing");
  return { ready: reasons.length === 0, cloud, reasons };
}

module.exports = {
  DASHSCOPE_KEY_ENV,
  BRAINS,
  STT_PROVIDERS,
  TTS_PROVIDERS,
  cloneDefaultVoice,
  normalizeVoice,
  validateVoice,
  resolveVoiceReadiness,
};

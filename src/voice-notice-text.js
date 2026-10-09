"use strict";

// Maps stable voice codes (readiness reasons, provider/brain error codes,
// runtime notices) to localized user text. Only the code is ever appended to a
// message; transcripts, prompts and secrets never reach this layer.

const DIRECT = {
  "voice-disabled": "voiceErrDisabled",
  "dashscope-key-missing": "voiceErrDashscopeKey",
  "cloud-consent-missing": "voiceErrCloudConsent",
  "voice-id-missing": "voiceErrVoiceId",
  mic_failed: "voiceErrMicFailed",
  "aec-unavailable": "voiceNoticeAec",
  "sherpa-model-missing": "voiceNoticeSherpaMissing",
  "sherpa-load-failed": "voiceNoticeSherpaLoadFailed",
  stt_sherpa_failed: "voiceNoticeSherpaFailed",
  "fallback-local-stt": "voiceNoticeFallbackStt",
  "fallback-local-tts": "voiceNoticeFallbackTts",
  "reply-too-long": "voiceNoticeReplyLong",
  segment_truncated: "voiceNoticeSegmentTruncated",
};
const BRAIN_CODES = /^(brain[_-]|auth-|not-logged-in|managed-hooks|missing-flag:|claude-|brain-unavailable)/;
const SERVICE_CODES = /^(stt|tts)_/;
const SAFE_CODE = /^[\w:.-]{1,60}$/;

function describeVoiceNotice(code, t) {
  const safe = typeof code === "string" && SAFE_CODE.test(code) ? code : "unknown";
  if (safe === "mic-denied" || safe === "mic_denied") return { body: t("voiceErrMicDenied"), openMicSettings: true };
  if (DIRECT[safe]) return { body: t(DIRECT[safe]) };
  if (BRAIN_CODES.test(safe)) return { body: `${t("voiceErrBrain")} (${safe})` };
  if (SERVICE_CODES.test(safe)) return { body: `${t("voiceErrService")} (${safe})` };
  return { body: `${t("voiceErrGeneric")} (${safe})` };
}

module.exports = { describeVoiceNotice };

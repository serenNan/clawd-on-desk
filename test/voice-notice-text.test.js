"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { describeVoiceNotice } = require("../src/voice-notice-text");
const { i18n, SUPPORTED_LANGS } = require("../src/i18n");

const t = (key) => `<${key}>`;

test("maps start-time readiness reasons to specific messages", () => {
  assert.equal(describeVoiceNotice("voice-disabled", t).body, "<voiceErrDisabled>");
  assert.equal(describeVoiceNotice("dashscope-key-missing", t).body, "<voiceErrDashscopeKey>");
  assert.equal(describeVoiceNotice("cloud-consent-missing", t).body, "<voiceErrCloudConsent>");
  assert.equal(describeVoiceNotice("voice-id-missing", t).body, "<voiceErrVoiceId>");
});

test("mic denial offers the system settings shortcut, other errors do not", () => {
  for (const code of ["mic-denied", "mic_denied"]) {
    const n = describeVoiceNotice(code, t);
    assert.equal(n.body, "<voiceErrMicDenied>");
    assert.equal(n.openMicSettings, true);
  }
  assert.equal(describeVoiceNotice("mic_failed", t).openMicSettings, undefined);
});

test("brain / service / unknown codes keep the specific code visible without content", () => {
  assert.equal(describeVoiceNotice("auth-conflict-env", t).body, "<voiceErrBrain> (auth-conflict-env)");
  assert.equal(describeVoiceNotice("missing-flag:--tools", t).body, "<voiceErrBrain> (missing-flag:--tools)");
  assert.equal(describeVoiceNotice("brain_quota", t).body, "<voiceErrBrain> (brain_quota)");
  assert.equal(describeVoiceNotice("stt_local_unreachable", t).body, "<voiceErrService> (stt_local_unreachable)");
  assert.equal(describeVoiceNotice("tts_network", t).body, "<voiceErrService> (tts_network)");
  assert.equal(describeVoiceNotice("weird thing!", t).body, "<voiceErrGeneric> (unknown)");
});

test("informational notices", () => {
  assert.equal(describeVoiceNotice("aec-unavailable", t).body, "<voiceNoticeAec>");
  assert.equal(describeVoiceNotice("fallback-local-stt", t).body, "<voiceNoticeFallbackStt>");
  assert.equal(describeVoiceNotice("fallback-local-tts", t).body, "<voiceNoticeFallbackTts>");
  assert.equal(describeVoiceNotice("reply-too-long", t).body, "<voiceNoticeReplyLong>");
  assert.equal(describeVoiceNotice("segment_truncated", t).body, "<voiceNoticeSegmentTruncated>");
  assert.equal(describeVoiceNotice("sherpa-model-missing", t).body, "<voiceNoticeSherpaMissing>");
  assert.equal(describeVoiceNotice("sherpa-load-failed", t).body, "<voiceNoticeSherpaLoadFailed>");
  assert.equal(describeVoiceNotice("stt_sherpa_failed", t).body, "<voiceNoticeSherpaFailed>");
});

test("every message key exists in all 7 languages", () => {
  const codes = ["voice-disabled", "dashscope-key-missing", "cloud-consent-missing", "voice-id-missing", "mic-denied", "mic_failed",
    "sherpa-model-missing", "sherpa-load-failed", "stt_sherpa_failed", "aec-unavailable", "fallback-local-stt", "fallback-local-tts", "reply-too-long", "segment_truncated", "brain_auth", "stt_network", "x"];
  for (const lang of SUPPORTED_LANGS) {
    const lookup = (key) => i18n[lang][key];
    for (const code of codes) {
      const body = describeVoiceNotice(code, lookup).body;
      assert.ok(!body.includes("undefined"), `${lang}/${code}`);
    }
    for (const key of ["voiceMenuStart", "voiceMenuStop", "voiceNoticeTitle", "voiceConsentTitle", "voiceConsentBody", "voiceConsentAllow", "voiceConsentCancel"]) {
      assert.equal(typeof i18n[lang][key], "string", `${lang}.${key}`);
    }
  }
});

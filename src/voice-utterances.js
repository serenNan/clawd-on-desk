"use strict";

// Per-utterance STT sessions for the runtime: opens a session on speech-start,
// streams audio, finishes on speech-end, commits the final text once, and
// retries on the fallback STT when the primary one fails. Token checks drop
// results from cancelled sessions.
const MAX_RETAINED_AUDIO_BYTES = 15 * 16000 * 2;

function createUtterances(h) {
  const { log, send, notice } = h;
  let utts = [];

  function tryCommit(utt) {
    if (!h.isActive() || !utt.speechEnded || utt.final === null || utt.submitted) return;
    utt.submitted = true;
    utts = utts.filter((u) => u !== utt);
    const text = utt.final.trim();
    if (text) h.onText(text); else h.onDiscard();
  }

  function bindStt(utt, provider) {
    const token = {};
    utt.token = token;
    const ok = () => h.isActive() && utt.token === token;
    utt.session = provider.begin({
      onPartial: (text) => {
        if (!ok()) return;
        if (!utt.partialSeen) { utt.partialSeen = true; log("stt_partial_first", { provider: provider.id, ms: Date.now() - utt.startAt }); }
        send("voice:partial", { text });
      },
      onFinal: (text) => {
        if (ok() && utt.final === null) {
          utt.final = String(text || "");
          log("stt_done", { provider: provider.id, textLen: utt.final.length, ms: Date.now() - (utt.finishAt || Date.now()) });
          tryCommit(utt);
        }
      },
      onError: (err) => { if (ok()) onSttError(utt, err); },
      onWarning: (w) => { if (ok() && w && w.code) notice(w.code); },
    });
  }

  function onSttError(utt, err) {
    const providers = h.getProviders();
    log("stt_error", { code: err && err.code, message: err && err.message, provider: providers.stt.id, ms: Date.now() - (utt.finishAt || Date.now()) });
    const fb = providers.fallbackStt;
    if (!fb || !h.getVoice().localFallback || providers.stt.id === fb.id) { h.fail((err && err.code) || "stt_failed"); return; }
    h.interrupt("stt-fallback");
    bindStt(utt, fb);
    for (const chunk of utt.chunks) utt.session.writeAudio(chunk);
    if (utt.speechEnded) utt.session.finish();
    notice("fallback-local-stt");
  }

  const current = () => utts.find((u) => !u.speechEnded);

  return {
    count: () => utts.length,
    canListen: () => !!h.sttFor(),
    begin() {
      const stt = h.isActive() && !current() && h.sttFor();
      if (!stt) return;
      h.onSpeechStart();
      const utt = { session: null, token: null, speechEnded: false, final: null, submitted: false, chunks: [], bytes: 0, startAt: Date.now(), partialSeen: false };
      utts.push(utt);
      log("stt_begin", { provider: stt.id });
      bindStt(utt, stt);
    },
    push(buf) {
      const utt = h.isActive() && current();
      if (!utt) return;
      if (utt.bytes < MAX_RETAINED_AUDIO_BYTES) { utt.chunks.push(buf); utt.bytes += buf.length; }
      utt.session.writeAudio(buf);
    },
    end({ reason } = {}) {
      const utt = h.isActive() && current();
      if (!utt) return;
      if (reason === "noise") {
        log("stt_cancel_noise");
        h.onDiscard();
        utt.token = null;
        utt.session.cancel();
        utts = utts.filter((u) => u !== utt);
        return;
      }
      utt.speechEnded = true;
      utt.finishAt = Date.now();
      log("stt_request", { provider: h.getProviders().stt.id, bytes: utt.bytes });
      utt.session.finish();
      tryCommit(utt);
    },
    cancelAll() {
      for (const u of utts) { u.token = null; try { u.session.cancel(); } catch (e) { h.onCancelError(e); } }
      utts = [];
    },
  };
}

module.exports = { createUtterances };

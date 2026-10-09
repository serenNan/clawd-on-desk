"use strict";

// Local streaming STT adapter (sherpa-onnx online recognizer). Same provider
// contract as the other STT adapters: begin() -> { writeAudio, finish, cancel },
// callbacks onPartial / onFinal / onError / onWarning. The native recognizer is
// injected as `engine` (see voice-sherpa-native.js) so tests never load it.
const SAMPLE_RATE = 16000;
const CJK = "\\u3000-\\u9fff\\uff00-\\uffef";
const CJK_GAP = new RegExp(`(?<=[${CJK}])\\s+|\\s+(?=[${CJK}])`, "g");

// The zh-en model emits BPE pieces separated by spaces ("你好， 今天"); drop the
// spaces around CJK text but keep the gaps between latin words.
function normalizeSherpaText(text) {
  return String(text == null ? "" : text).replace(CJK_GAP, "").replace(/\s+/g, " ").trim();
}

function toFloat32(pcm) {
  const view = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
  return Float32Array.from(view, (v) => v / 32768);
}

function createSherpaStt({
  engine, maxSegmentMs = 30000, tailPaddingMs = 300, log = () => {},
} = {}) {
  const maxSamples = Math.floor((SAMPLE_RATE * maxSegmentMs) / 1000);

  function begin({ onPartial, onFinal, onError, onWarning } = {}) {
    const stream = engine.createStream();
    const startedAt = Date.now();
    let done = false;
    let finishing = false;
    let lastText = "";
    let samples = 0;
    let truncated = false;
    let firstPartialLogged = false;

    const release = () => { try { engine.release(stream); } catch { /* best effort */ } };
    const close = () => { done = true; release(); };
    const fail = (e) => {
      if (done) return;
      close();
      if (typeof onError === "function") onError({ code: "stt_sherpa_failed", message: String((e && e.message) || e).slice(0, 200) });
    };
    const decodeAll = () => { while (engine.ready(stream)) engine.decode(stream); };

    return {
      writeAudio(pcm) {
        if (done || finishing || !pcm || pcm.byteLength < 2) return;
        const n = pcm.byteLength >> 1;
        if (samples + n > maxSamples) {
          if (!truncated && typeof onWarning === "function") onWarning({ code: "segment_truncated" });
          truncated = true;
          return;
        }
        try {
          samples += n;
          engine.accept(stream, toFloat32(pcm));
          decodeAll();
          const text = normalizeSherpaText(engine.text(stream));
          if (text && text !== lastText) {
            lastText = text;
            if (!firstPartialLogged) { firstPartialLogged = true; log("sherpa_first_partial", { ms: Date.now() - startedAt }); }
            if (typeof onPartial === "function") onPartial(text);
          }
        } catch (e) { fail(e); }
      },
      finish() {
        if (done || finishing) return;
        finishing = true;
        const t0 = Date.now();
        try {
          if (tailPaddingMs > 0) engine.accept(stream, new Float32Array(Math.round((SAMPLE_RATE * tailPaddingMs) / 1000)));
          engine.finish(stream);
          decodeAll();
          const text = normalizeSherpaText(engine.text(stream));
          close();
          log("sherpa_final", { ms: Date.now() - t0, textLen: text.length, utteranceMs: Date.now() - startedAt });
          if (typeof onFinal === "function") onFinal(text);
        } catch (e) { fail(e); }
      },
      cancel() { if (!done) close(); },
    };
  }

  return {
    id: "sherpa-onnx",
    capabilities: { streaming: true, endpointing: false, sampleRate: SAMPLE_RATE, maxSegmentMs },
    begin,
  };
}

module.exports = { createSherpaStt, normalizeSherpaText };

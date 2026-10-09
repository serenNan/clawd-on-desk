"use strict";

// Main-process VAD state machine on top of a neural detector (Silero via
// sherpa-onnx). The detector only answers "is this chunk inside speech?";
// start/end hysteresis, pre-roll, noise rejection and the segment cap live here.
// Chunks are int16 PCM (any size), events carry int16 Buffers ready for STT.
const END_SILENCE_MIN = 400;
const END_SILENCE_MAX = 1500;
const END_SILENCE_DEFAULT = 800;
const clampEnd = (ms) => Math.min(END_SILENCE_MAX, Math.max(END_SILENCE_MIN, Number(ms) || END_SILENCE_DEFAULT));

const toBuffer = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength);

function createSileroVad({
  detector, sampleRate = 16000, startMs = 60, preRollMs = 300,
  endSilenceMs = END_SILENCE_DEFAULT, minSpeechMs = 150, maxSegmentMs = 15000,
}) {
  let endMs = clampEnd(endSilenceMs);
  let ring = []; // [{pcm, ms}] pre-roll while idle
  let ringMs = 0;
  let voicedRunMs = 0;
  let speaking = false;
  let seg = null; // { ms, voicedMs, silentMs }

  function beginSegment(preRoll, voicedMs) {
    speaking = true;
    seg = { ms: voicedMs, voicedMs, silentMs: 0 };
    return { type: "speech-start", preRoll: Buffer.concat(preRoll.map((c) => toBuffer(c.pcm))) };
  }

  function endSegment(reason) {
    const noise = reason === "silence" && seg.voicedMs < minSpeechMs;
    const ev = { type: "speech-end", reason: noise ? "noise" : reason, durationMs: seg.ms };
    speaking = false;
    seg = null;
    voicedRunMs = 0;
    ring = [];
    ringMs = 0;
    return ev;
  }

  function stepSpeaking(pcm, ms, voiced, events) {
    seg.ms += ms;
    if (voiced) { seg.voicedMs += ms; seg.silentMs = 0; } else seg.silentMs += ms;
    events.push({ type: "audio", pcm: toBuffer(pcm) });
    if (seg.silentMs >= endMs) events.push(endSegment("silence"));
    else if (seg.ms >= maxSegmentMs) {
      events.push(endSegment("limit"));
      events.push(beginSegment([], 0));
    }
  }

  function stepIdle(pcm, ms, voiced, events) {
    ring.push({ pcm, ms });
    ringMs += ms;
    while (ring.length > 1 && ringMs - ring[0].ms >= preRollMs + startMs) ringMs -= ring.shift().ms;
    voicedRunMs = voiced ? voicedRunMs + ms : 0;
    if (voicedRunMs >= startMs) events.push(beginSegment(ring, voicedRunMs));
  }

  return {
    processChunk(pcm) {
      const ms = (pcm.length / sampleRate) * 1000;
      const voiced = !!detector.accept(Float32Array.from(pcm, (v) => v / 32768));
      const strong = detector.isStrong ? !!detector.isStrong() : voiced;
      const events = [{ type: "frame", voiced, strong }];
      if (speaking) stepSpeaking(pcm, ms, voiced, events);
      else stepIdle(pcm, ms, voiced, events);
      return events;
    },
    setEndSilenceMs(ms) { endMs = clampEnd(ms); },
    getEndSilenceMs: () => endMs,
    isSpeaking: () => speaking,
    reset() {
      speaking = false; seg = null; ring = []; ringMs = 0; voicedRunMs = 0;
      if (detector.reset) detector.reset();
    },
  };
}

module.exports = { createSileroVad };

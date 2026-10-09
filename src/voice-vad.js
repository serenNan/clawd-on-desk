(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (root) root.ClawdVoiceVad = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Energy VAD: noise-floor calibration + RMS thresholds with hysteresis.
  // Pure frame-in/events-out logic; the capture worklet owns the clock.
  // Short voiced bursts (< minSpeechMs) still emit speech-start (barge-in
  // needs the early signal) and later end with reason "noise" so the upper
  // layer discards the segment instead of sending it to STT.
  const ENTER_FLOOR = 0.03;
  const EXIT_FLOOR = 0.015;
  const END_SILENCE_MIN = 400;
  const END_SILENCE_MAX = 1500;
  const END_SILENCE_DEFAULT = 800;

  function rmsOf(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    return frame.length ? Math.sqrt(sum / frame.length) : 0;
  }

  function concat(frames) {
    let total = 0;
    for (const f of frames) total += f.length;
    const out = new Float32Array(total);
    let off = 0;
    for (const f of frames) { out.set(f, off); off += f.length; }
    return out;
  }

  function floatToInt16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    }
    return out;
  }

  function createResampler(srcRate, dstRate) {
    const ratio = srcRate / dstRate;
    let carry = new Float32Array(0);
    let pos = 0;
    return {
      process(input) {
        const arr = new Float32Array(carry.length + input.length);
        arr.set(carry, 0);
        arr.set(input, carry.length);
        const out = [];
        while (pos + 1 < arr.length) {
          const i = Math.floor(pos);
          const f = pos - i;
          out.push(arr[i] * (1 - f) + arr[i + 1] * f);
          pos += ratio;
        }
        const drop = Math.min(Math.floor(pos), arr.length);
        carry = arr.slice(drop);
        pos -= drop;
        return floatToInt16(Float32Array.from(out));
      },
      reset() { carry = new Float32Array(0); pos = 0; },
    };
  }

  function createVad(options = {}) {
    const sampleRate = options.sampleRate || 16000;
    const frameMs = options.frameMs || 20;
    const startMs = options.startMs ?? 100;
    const preRollMs = options.preRollMs ?? 150;
    const minSpeechMs = options.minSpeechMs ?? 150;
    const maxSegmentMs = options.maxSegmentMs ?? 15000;
    const calibrationFrames = Math.ceil((options.noiseCalibrationMs ?? 300) / frameMs);
    const startFrames = Math.max(1, Math.round(startMs / frameMs));
    const ringMax = Math.ceil(preRollMs / frameMs) + startFrames;
    let endSilenceMs = Math.min(END_SILENCE_MAX, Math.max(END_SILENCE_MIN, options.endSilenceMs ?? END_SILENCE_DEFAULT));

    let calibrated = 0;
    let noiseSum = 0;
    let enter = ENTER_FLOOR;
    let exit = EXIT_FLOOR;
    let ring = [];
    let speaking = false;
    let voicedRun = 0;
    let seg = null; // { frames, voiced, silent }

    function startSegment(preRoll, voicedFrames) {
      speaking = true;
      seg = { frames: voicedFrames, voiced: voicedFrames, silent: 0 };
      return { type: "speech-start", preRoll };
    }

    function endSegment(reason) {
      const noise = reason === "silence" && seg.voiced * frameMs < minSpeechMs;
      const ev = { type: "speech-end", reason: noise ? "noise" : reason, durationMs: seg.frames * frameMs };
      speaking = false;
      seg = null;
      voicedRun = 0;
      ring = [];
      return ev;
    }

    function calibrate(rms) {
      noiseSum += rms;
      calibrated++;
      if (calibrated >= calibrationFrames) {
        const noise = noiseSum / calibrated;
        enter = Math.max(noise * 3, ENTER_FLOOR);
        exit = Math.max(noise * 1.8, EXIT_FLOOR);
      }
    }

    function stepSpeaking(rms, events) {
      seg.frames++;
      if (rms > exit) { seg.voiced++; seg.silent = 0; } else seg.silent++;
      if (seg.silent * frameMs >= endSilenceMs) {
        events.push(endSegment("silence"));
      } else if (seg.frames * frameMs >= maxSegmentMs) {
        events.push(endSegment("limit"));
        events.push(startSegment(new Float32Array(0), 0));
      }
    }

    function stepIdle(frame, rms, events) {
      ring.push(frame);
      if (ring.length > ringMax) ring.shift();
      voicedRun = rms > enter ? voicedRun + 1 : 0;
      if (voicedRun >= startFrames) events.push(startSegment(concat(ring), voicedRun));
    }

    return {
      processFrame(frame) {
        const rms = rmsOf(frame);
        const events = [{ type: "level", rms, voiced: rms > (speaking ? exit : enter) }];
        if (calibrated < calibrationFrames) { calibrate(rms); return events; }
        if (speaking) stepSpeaking(rms, events);
        else stepIdle(frame, rms, events);
        return events;
      },
      setEndSilenceMs(ms) {
        endSilenceMs = Math.min(END_SILENCE_MAX, Math.max(END_SILENCE_MIN, Number(ms) || END_SILENCE_DEFAULT));
      },
      getEndSilenceMs() { return endSilenceMs; },
      isSpeaking() { return speaking; },
      sampleRate,
    };
  }

  return Object.freeze({ createVad, createResampler, floatToInt16 });
});

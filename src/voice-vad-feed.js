"use strict";

// Feeds renderer PCM into the main-process VAD and turns its events into
// runtime callbacks. The renderer only gets speech-start/frame/end for ducking.
function createVadFeed({ vad, send, log, onSpeechStart, onAudio, onSpeechEnd }) {
  let perf = { chunks: 0, totalUs: 0, maxUs: 0, peak: 0 };
  let speaking = false;

  return {
    feed(buf) {
      const t0 = process.hrtime.bigint();
      const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
      for (let i = 0; i < pcm.length; i += 16) { const a = Math.abs(pcm[i]); if (a > perf.peak) perf.peak = a; }
      const events = vad.processChunk(pcm);
      const us = Number(process.hrtime.bigint() - t0) / 1000;
      perf.chunks += 1; perf.totalUs += us; perf.maxUs = Math.max(perf.maxUs, us);
      if (perf.chunks >= 250) {
        log("vad_perf", { chunks: perf.chunks, meanUs: Math.round(perf.totalUs / perf.chunks), maxUs: Math.round(perf.maxUs), peak: perf.peak });
        perf = { chunks: 0, totalUs: 0, maxUs: 0, peak: 0 };
      }
      for (const ev of events) {
        if (ev.type === "frame") { if (speaking) send("voice:vad", { type: "frame", voiced: ev.voiced, strong: ev.strong }); }
        else if (ev.type === "speech-start") { speaking = true; log("vad_start"); send("voice:vad", { type: "speech-start" }); onSpeechStart(ev.preRoll); }
        else if (ev.type === "audio") onAudio(ev.pcm);
        else if (ev.type === "speech-end") {
          speaking = false;
          log("vad_end", { reason: ev.reason, ms: ev.durationMs });
          send("voice:vad", { type: "speech-end", reason: ev.reason });
          onSpeechEnd({ reason: ev.reason });
        }
      }
    },
    reset() { speaking = false; },
  };
}

module.exports = { createVadFeed };

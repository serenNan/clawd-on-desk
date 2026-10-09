"use strict";

// Renderer-side PCM sink for realtime voice. Pure Web Audio scheduling with an
// injected AudioContext so it is unit-testable; loaded by <script> in the pet
// renderer (window.ClawdVoiceAudio) and by require() in tests.
(function exposeVoiceAudio(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (root) root.ClawdVoiceAudio = api;
})(typeof window !== "undefined" ? window : this, function factory() {
  const MAX_BUFFERED_MS = 2000;
  const START_LEAD_S = 0.02;
  const DUCK_SETTLE_S = 0.045; // 3 * tau(15ms) <= 50ms

  function toBytes(pcm) {
    if (pcm instanceof Uint8Array) return pcm;
    if (pcm instanceof ArrayBuffer) return new Uint8Array(pcm);
    return new Uint8Array(0);
  }

  function concat(a, b) {
    if (!a || !a.length) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  // Decode s16le interleaved bytes into per-channel float arrays; returns RMS.
  function decodeInto(buffer, bytes, channels) {
    const frames = buffer.length;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < frames; i++) {
        const v = dv.getInt16((i * channels + c) * 2, true) / 32768;
        ch[i] = v;
        sum += v * v;
      }
    }
    return Math.sqrt(sum / Math.max(1, frames * channels));
  }

  function createAudioSink(options) {
    const ctx = options.context;
    const onAck = options.onAck || (() => {});
    const onBuffered = options.onBuffered || (() => {});
    const onLevel = options.onLevel || (() => {});
    let epoch = 0;
    let muted = false;
    let duckGain = 1;
    let disposed = false;
    let nextStart = 0;
    let master = null;
    const sentences = new Map(); // id -> { epoch, sources:Set, ended, remainder, heardMuted }

    const targetGain = () => (muted ? 0 : duckGain);

    function ensureMaster() {
      if (master) return master;
      master = ctx.createGain();
      master.gain.value = targetGain();
      master.connect(ctx.destination);
      return master;
    }

    const bufferedMs = () => Math.max(0, (nextStart - ctx.currentTime) * 1000);
    const reportBuffered = () => onBuffered(bufferedMs());

    function smoothGain() {
      if (!master) return;
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(targetGain(), now, DUCK_SETTLE_S / 3);
    }

    function maybeAck(id, s) {
      if (!s.ended || s.sources.size > 0) return;
      sentences.delete(id);
      if (!muted && !s.heardMuted) onAck({ epoch: s.epoch, sentenceId: id });
    }

    function getSentence(id, ep) {
      let s = sentences.get(id);
      if (!s) {
        s = { epoch: ep, sources: new Set(), ended: false, remainder: null, heardMuted: muted, played: false };
        sentences.set(id, s);
      }
      return s;
    }

    function schedule(id, s, bytes, channels, sampleRate) {
      const frames = Math.floor(bytes.length / (2 * channels));
      if (frames === 0) return;
      const buffer = ctx.createBuffer(channels, frames, sampleRate);
      onLevel(decodeInto(buffer, bytes, channels));
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ensureMaster());
      const start = Math.max(nextStart, ctx.currentTime + START_LEAD_S);
      nextStart = start + buffer.duration;
      const rec = { start, duration: buffer.duration };
      s.sources.add(src);
      s.recs = s.recs || new Map();
      s.recs.set(src, rec);
      src.onended = () => {
        s.sources.delete(src);
        s.recs.delete(src);
        if (!s.sources.size && !sentences.has(id)) return;
        maybeAck(id, s);
        reportBuffered();
      };
      src.start(start);
    }

    function enqueue(chunk) {
      if (disposed || !chunk || chunk.epoch < epoch) return;
      const channels = chunk.channels || 1;
      const s = getSentence(chunk.sentenceId, chunk.epoch);
      const all = concat(s.remainder, toBytes(chunk.pcm));
      const usable = all.length - (all.length % (2 * channels));
      s.remainder = usable < all.length ? all.slice(usable) : null;
      schedule(chunk.sentenceId, s, all.subarray(0, usable), channels, chunk.sampleRate);
      reportBuffered();
    }

    function endSentence({ epoch: ep, sentenceId }) {
      const s = sentences.get(sentenceId);
      if (disposed || !s || ep !== s.epoch) return;
      s.ended = true;
      maybeAck(sentenceId, s);
    }

    function stop(opts) {
      const fadeS = ((opts && opts.fadeMs) === undefined ? 20 : opts.fadeMs) / 1000;
      const now = ctx.currentTime;
      let playingSentenceId = null;
      const droppedSentenceIds = [];
      for (const [id, s] of sentences) {
        let playing = false;
        for (const [src, rec] of s.recs || []) {
          if (rec.start <= now && now < rec.start + rec.duration) playing = true;
          src.onended = null;
          try { src.stop(now + fadeS); } catch (_) { /* already stopped */ }
        }
        if (playing && playingSentenceId === null) playingSentenceId = id;
        else droppedSentenceIds.push(id);
      }
      sentences.clear();
      if (master) {
        master.gain.cancelScheduledValues(now);
        master.gain.linearRampToValueAtTime(0, now + fadeS);
        const old = master;
        master = null;
        try { old.disconnect && old.disconnect(); } catch (_) { /* ignore */ }
      }
      nextStart = 0;
      duckGain = 1;
      onLevel(0);
      reportBuffered();
      return { playingSentenceId, droppedSentenceIds };
    }

    return {
      enqueue,
      endSentence,
      stop,
      setEpoch(n) { epoch = n; },
      duck(db) {
        duckGain = Math.pow(10, (db === undefined ? -18 : db) / 20);
        smoothGain();
      },
      restore() {
        duckGain = 1;
        smoothGain();
      },
      setMuted(m) {
        muted = !!m;
        if (muted) for (const s of sentences.values()) s.heardMuted = true;
        smoothGain();
      },
      getBufferedMs: bufferedMs,
      canAccept: () => bufferedMs() <= MAX_BUFFERED_MS,
      isActive: () => sentences.size > 0,
      dispose() {
        if (disposed) return;
        stop({ fadeMs: 0 });
        disposed = true;
      },
    };
  }

  return { createAudioSink, MAX_BUFFERED_MS };
});

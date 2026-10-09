"use strict";

// brain text -> short sentences -> TTS sessions -> renderer PCM, for ONE reply
// at a time. Everything is epoch-guarded: results from a cancelled epoch (or a
// replaced request/session) are dropped before they can touch state or audio.

const MAX_AHEAD_SENTENCES = 2;
const MAX_BUFFERED_MS = 2000;
const RECENT_SENTENCES = 6;

function createReplyPipeline(host) {
  const log = host.log || (() => {});
  let req = null;
  let pending = [];
  let inflight = [];
  const sessions = new Map();
  let chunker = null;
  let seq = 0;
  let buffered = 0;
  let dropped = false;
  let recent = []; // texts of the latest sentences, kept for echo matching
  let tts = host.tts();

  const live = (mine) => req === mine && mine.epoch === host.epoch();

  function closeSessions() {
    for (const s of sessions.values()) { try { s.cancel(); } catch { /* best effort */ } }
    sessions.clear();
  }

  function startSession(item) {
    const epoch = host.epoch();
    const t0 = Date.now();
    let firstPcm = false;
    const handlers = {
      onAudio: (chunk) => {
        if (sessions.get(item.sid) !== session || epoch !== host.epoch()) return;
        if (!firstPcm) { firstPcm = true; log("tts_first_pcm", { sentenceId: item.sid, provider: tts.id, ms: Date.now() - t0, epoch }); }
        host.send("voice:tts-pcm", { epoch, sentenceId: item.sid, pcm: chunk.pcm, sampleRate: chunk.sampleRate, channels: chunk.channels });
        host.setPhase("speaking");
      },
      onEnd: () => {
        if (sessions.get(item.sid) !== session || epoch !== host.epoch()) return;
        log("tts_end", { sentenceId: item.sid, ms: Date.now() - t0, gotAudio: firstPcm });
        host.send("voice:tts-end", { epoch, sentenceId: item.sid });
      },
      onError: (err) => {
        if (sessions.get(item.sid) !== session || epoch !== host.epoch()) return;
        log("tts_error", { sentenceId: item.sid, provider: tts.id, code: err && err.code, message: err && err.message, ms: Date.now() - t0 });
        onTtsError(err);
      },
    };
    log("tts_request", { sentenceId: item.sid, provider: tts.id, textLen: item.text.length, epoch });
    const session = tts.begin(handlers);
    sessions.set(item.sid, session);
    inflight.push(item);
    session.writeText(item.text);
    session.finish();
  }

  function pump() {
    if (host.isMuted() && pending.length) { pending = []; dropped = true; }
    while (pending.length && inflight.length < MAX_AHEAD_SENTENCES && buffered <= MAX_BUFFERED_MS) {
      startSession(pending.shift());
    }
    maybeComplete();
  }

  function maybeComplete() {
    if (!req || !req.brainDone || pending.length || inflight.length) return;
    if (dropped) host.history.discardUnheard();
    req = null;
    host.setPhase("listening");
  }

  function onSentence(mine, text) {
    if (!live(mine)) return;
    const sid = `${mine.turnId}-${++seq}`;
    if (!host.history.addSentence(mine.turnId, sid, text)) {
      host.notice("reply-too-long");
      mine.brainDone = true;
      chunker.reset();
      host.brain().cancel();
      pump();
      return;
    }
    pending.push({ sid, text });
    recent = [...recent, text].slice(-RECENT_SENTENCES);
    pump();
  }

  function onTtsError(err) {
    const fb = host.fallbackTts();
    if (!fb || fb === tts || !host.localFallbackEnabled()) { host.fail(err.code || "tts_failed"); return; }
    const unplayed = [...inflight, ...pending];
    log("tts_fallback", { from: tts.id, to: fb.id, code: err.code, unplayed: unplayed.length });
    closeSessions();
    host.restartEpoch();
    tts = fb;
    inflight = [];
    pending = unplayed;
    host.notice("fallback-local-tts");
    pump();
  }

  return {
    begin({ text, turnId }) {
      const mine = { epoch: host.epoch(), turnId, brainDone: false };
      const t0 = Date.now();
      let firstDelta = false;
      log("brain_request", { turnId, textLen: text.length, epoch: mine.epoch });
      req = mine;
      dropped = false;
      pending = [];
      inflight = [];
      chunker = host.createChunker({ onSentence: (s) => onSentence(mine, s) });
      host.brain().send({ requestId: `${turnId}`, text }, {
        onTextDelta: (d) => {
          if (!firstDelta) { firstDelta = true; log("brain_first_token", { turnId, ms: Date.now() - t0 }); }
          if (live(mine) && !mine.brainDone) chunker.push(d);
        },
        onCompleted: (full) => {
          log("brain_done", { turnId, ms: Date.now() - t0, replyLen: String(full || "").length, live: live(mine) });
          if (!live(mine) || mine.brainDone) return;
          chunker.flush();
          mine.brainDone = true;
          host.history.markGenerationDone(turnId);
          pump();
        },
        onError: (err) => {
          log("brain_error", { turnId, code: err && err.code, ms: Date.now() - t0, live: live(mine) });
          if (live(mine)) host.fail((err && err.code) || "brain_failed");
        },
      });
    },
    ack(sentenceId) {
      const i = inflight.findIndex((s) => s.sid === sentenceId);
      if (i < 0) return;
      inflight.splice(i, 1);
      sessions.delete(sentenceId);
      host.history.markHeard(sentenceId);
      pump();
    },
    setBuffered(ms) { buffered = ms; if (req) pump(); },
    cancel() {
      const brainBusy = req && !req.brainDone;
      closeSessions();
      req = null;
      pending = [];
      inflight = [];
      buffered = 0;
      if (chunker) chunker.reset();
      return brainBusy;
    },
    retag() { if (req) req.epoch = host.epoch(); },
    isActive: () => !!req,
    recentSpoken: () => recent,
    inflightIds: () => inflight.map((s) => s.sid),
  };
}

module.exports = { createReplyPipeline };

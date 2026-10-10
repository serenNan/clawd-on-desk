"use strict";

// `session` brain mode: an external Claude Code session drives the call through
// converse(). One converse may wait at a time; user finals that arrive while
// Claude is thinking are queued. Text is never logged, only outcomes/timings.

const DEFAULT_TIMEOUT_S = 120;
const MIN_TIMEOUT_S = 1;
const MAX_TIMEOUT_S = 600;
const GUARD_GRACE_MS = 60000; // upper bound for "speech never finishes"
const MAX_QUEUE = 5;
const END_WORDS = ["结束语音", "退出语音", "关闭语音", "停止语音", "语音结束", "结束通话", "退出通话", "结束对话", "挂断"];

function isEndPhrase(text) {
  const s = String(text || "").replace(/[\s\p{P}\p{S}]+/gu, "");
  return s.length > 0 && s.length <= 12 && END_WORDS.some((w) => s.includes(w));
}

function clampTimeoutS(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_S;
  return Math.min(MAX_TIMEOUT_S, Math.max(MIN_TIMEOUT_S, n));
}

function countSentences(createChunker, text) {
  let n = 0;
  const c = createChunker({ onSentence: () => { n += 1; } });
  c.push(text);
  c.flush();
  return n;
}

function createSessionBridge(host) {
  const log = host.log || (() => {});
  const setT = host.setTimeout || setTimeout;
  const clearT = host.clearTimeout || clearTimeout;
  const now = host.now || Date.now;
  let waiter = null;
  let queue = [];

  function played(w) {
    const heard = w.turn ? host.heard(w.turn.turnId) : [];
    return { played: heard.join(""), unplayed_count: Math.max(0, (w.turn ? w.turn.total : 0) - heard.length) };
  }

  function finish(w, result, outcome, { phase = "thinking" } = {}) {
    if (!w || w.done) return;
    w.done = true;
    clearT(w.timer);
    clearT(w.guard);
    if (waiter === w) waiter = null;
    log("converse_done", {
      outcome, ms: now() - w.t0, interrupted: !!w.interrupted,
      unplayed: result.unplayed_count === undefined ? null : result.unplayed_count,
    });
    if (phase) host.setPhase(phase);
    // The user only heard the shortened version: say so, and report what was actually read.
    if (w.summarized && !result.ended && !result.superseded && !result.aborted) {
      result = { ...result, ...(result.played === undefined ? { played: w.summary } : {}), summarized: true };
    }
    w.resolve(result);
  }

  function armTimer(w) {
    clearT(w.timer);
    w.timer = setT(() => {
      const paused = host.isPaused && host.isPaused() ? { paused: true } : {};
      finish(w, w.interrupted ? { timeout: true, interrupted: true, ...played(w), ...paused } : { timeout: true, ...paused }, "timeout");
    }, w.timeoutMs);
  }

  function deliver(w, user) {
    if (isEndPhrase(user)) return finish(w, { ended: true }, "ended");
    if (w.interrupted) return finish(w, { interrupted: true, ...played(w), user }, "interrupted");
    return finish(w, { interrupted: false, user }, "user");
  }

  function speakNow(w, text) {
    w.speaking = true; // before speak(): an empty reply may go idle synchronously
    w.turn = host.speak(text);
  }

  return {
    converse({ text = "", timeoutS, signal } = {}) {
      if (waiter) finish(waiter, { superseded: true }, "superseded", { phase: null });
      const clean = String(text || "").trim();
      const timeoutMs = clampTimeoutS(timeoutS) * 1000;
      log("converse_start", { textLen: clean.length, timeoutS: timeoutMs / 1000, queued: queue.length });
      return new Promise((resolve) => {
        const w = { resolve, t0: now(), timeoutMs, turn: null, speaking: false, interrupted: false, timer: null, guard: null, done: false };
        waiter = w;
        if (signal) {
          const onAbort = () => finish(w, { aborted: true }, "aborted");
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener("abort", onAbort, { once: true });
        }
        if (queue.length) {
          const items = queue;
          queue = [];
          if (items.some(isEndPhrase)) { finish(w, { ended: true }, "ended"); return; }
          const user = items.join("，");
          if (!clean) { finish(w, { interrupted: false, user }, "user"); return; }
          w.turn = { turnId: null, total: host.countSentences(clean) };
          w.interrupted = true;
          finish(w, { interrupted: true, ...played(w), user }, "interrupted");
          return;
        }
        w.guard = setT(() => finish(w, { timeout: true }, "timeout"), timeoutMs + GUARD_GRACE_MS);
        if (clean) {
          const over = host.summarizeOver ? host.summarizeOver() : 0;
          if (host.summarize && over > 0 && clean.replace(/\s+/g, "").length > over) {
            host.setPhase("thinking");
            host.summarize(clean).then((r) => {
              if (w.done) return; // taken over / stopped while summarizing
              w.summarized = true;
              w.summary = r.text;
              speakNow(w, r.text);
            });
          } else speakNow(w, clean);
        } else {
          host.setPhase("listening");
          armTimer(w);
        }
      });
    },
    onUserFinal(text) {
      const w = waiter;
      if (!w) {
        queue.push(text);
        if (queue.length > MAX_QUEUE) queue.shift();
        log("session_user_queued", { textLen: text.length, queued: queue.length });
        return;
      }
      deliver(w, text);
    },
    onInterrupt() { if (waiter && waiter.turn) waiter.interrupted = true; },
    onIdle() {
      const w = waiter;
      if (w && w.speaking) { w.speaking = false; armTimer(w); }
    },
    // A newer session claimed the call: the old converse ends, queued finals are not its business.
    takeOver() {
      queue = [];
      finish(waiter, { ended: true, reason: "taken_over" }, "taken_over", { phase: null });
    },
    dispose() {
      queue = [];
      finish(waiter, { ended: true, reason: "stopped" }, "stopped", { phase: null });
    },
    hasWaiter: () => !!waiter,
  };
}

module.exports = { createSessionBridge, countSentences, isEndPhrase, DEFAULT_TIMEOUT_S };

"use strict";

// Accumulates streamed brain text into short speakable sentences for TTS.
// Skips markdown code blocks, never splits numbers or English words, and lets
// the first segment end on a comma so the first sound arrives sooner.

const STRONG = new Set(["。", "！", "？", "!", "?", "；", ";", "\n"]);
const SOFT = new Set(["，", ",", "、", "：", ":"]);
const CLOSERS = new Set(["”", "’", "」", "』", "）", ")", "\"", "'"]);
const ALNUM = /[A-Za-z0-9]/;
const FENCE = "```";

function sanitizeSpeech(text) {
  return String(text)
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+])[ \t]+/gm, "")
    .replace(/[*`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isBoundaryAt(buf, i, firstSegment, minFirst, softMin) {
  const ch = buf[i];
  const prev = buf[i - 1] || "";
  const next = buf[i + 1];
  if (ch === "." || ch === ",") {
    if (next === undefined) return null; // cannot tell "3." from "3.14" yet
    if (ALNUM.test(prev) && ALNUM.test(next) && /\d/.test(prev) && /\d/.test(next)) return null;
    if (ch === "." && ALNUM.test(next)) return null;
    return ch === "." ? "strong" : (soft(i, firstSegment, minFirst, softMin));
  }
  if (STRONG.has(ch)) return "strong";
  if (SOFT.has(ch)) return soft(i, firstSegment, minFirst, softMin);
  return null;
}

function soft(i, firstSegment, minFirst, softMin) {
  const len = i + 1;
  if (firstSegment) return len >= minFirst ? "soft" : null;
  return len >= softMin ? "soft" : null;
}

function safeCut(buf, maxChars) {
  for (let i = Math.min(maxChars, buf.length - 1); i > 0; i--) {
    if (!(ALNUM.test(buf[i - 1]) && ALNUM.test(buf[i]))) return i;
  }
  return -1;
}

function createSentenceChunker({ onSentence, minFirstChars = 8, softMinChars = 24, maxChars = 60 } = {}) {
  let raw = "";
  let inCode = false;
  let buf = "";
  let emitted = 0;

  function emit(text) {
    const clean = sanitizeSpeech(text);
    if (!clean) return;
    emitted++;
    onSentence(clean);
  }

  function drain(final) {
    for (;;) {
      let cut = -1;
      for (let i = 0; i < buf.length; i++) {
        if (isBoundaryAt(buf, i, emitted === 0, minFirstChars, softMinChars)) { cut = i + 1; break; }
      }
      if (cut > 0) {
        while (cut < buf.length && CLOSERS.has(buf[cut])) cut++;
        emit(buf.slice(0, cut));
        buf = buf.slice(cut);
        continue;
      }
      if (buf.length > maxChars) {
        const at = safeCut(buf, maxChars);
        if (at > 0) { emit(buf.slice(0, at)); buf = buf.slice(at); continue; }
      }
      break;
    }
    if (final && buf) { emit(buf); buf = ""; }
  }

  function stripCode(final) {
    for (;;) {
      const at = raw.indexOf(FENCE);
      if (at < 0) {
        const hold = final ? 0 : (raw.endsWith("``") ? 2 : raw.endsWith("`") ? 1 : 0);
        if (!inCode) buf += raw.slice(0, raw.length - hold);
        raw = raw.slice(raw.length - hold);
        return;
      }
      if (!inCode) buf += raw.slice(0, at);
      raw = raw.slice(at + FENCE.length);
      inCode = !inCode;
    }
  }

  return {
    push(delta) {
      if (!delta) return;
      raw += delta;
      stripCode(false);
      drain(false);
    },
    flush() {
      stripCode(true);
      drain(true);
    },
    reset() { raw = ""; buf = ""; inCode = false; emitted = 0; },
  };
}

module.exports = { createSentenceChunker, sanitizeSpeech };

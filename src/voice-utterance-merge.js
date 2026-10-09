"use strict";

// Session mode only: a user pause that is longer than the VAD end-silence but
// shorter than gapMs still belongs to one sentence. A final is held for gapMs;
// a speech-start inside that window defers delivery until the next final (or a
// noise discard / safety timeout) and the segments are merged into one string.
const CJK_EDGE_BEFORE = /[　-鿿＀-￯]$/;
const CJK_EDGE_AFTER = /^[　-鿿＀-￯]/;

const joinSegments = (a, b) => (CJK_EDGE_BEFORE.test(a) || CJK_EDGE_AFTER.test(b) ? `${a}${b}` : `${a} ${b}`);

function createUtteranceMerger({
  deliver, gapMs = 600, holdMaxMs = 20000, log = () => {},
  setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout,
}) {
  let text = null;
  let parts = 0;
  let awaiting = false;
  let timer = null;

  const clear = () => { clearT(timer); timer = null; };
  function flush() {
    clear();
    const out = text;
    const n = parts;
    text = null;
    parts = 0;
    awaiting = false;
    if (n > 1) log("utterance_merged", { parts: n });
    if (out !== null) deliver(out);
  }
  const armGap = () => { clear(); timer = setT(flush, gapMs); };

  return {
    onFinal(t, { awaitingNext = false } = {}) {
      text = text === null ? t : joinSegments(text, t);
      parts += 1;
      awaiting = false;
      if (awaitingNext) { awaiting = true; clear(); timer = setT(flush, holdMaxMs); return; }
      if (gapMs <= 0) { flush(); return; }
      armGap();
    },
    onSpeechStart() {
      if (text === null || awaiting) return;
      awaiting = true;
      clear();
      timer = setT(flush, holdMaxMs);
    },
    onDiscard() {
      if (text !== null && awaiting) { awaiting = false; armGap(); }
    },
    dispose() { clear(); text = null; parts = 0; awaiting = false; },
  };
}

module.exports = { createUtteranceMerger };

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createReplyPipeline } = require("../src/voice-reply-pipeline");

// Two sentences synthesize in parallel; their PCM must still reach the renderer
// one whole sentence after another, never interleaved chunk by chunk.
function harness() {
  const sent = [];
  const sessions = [];
  let brainHandlers = null;
  const host = {
    log: () => {},
    epoch: () => 0,
    send: (channel, p) => sent.push(`${channel === "voice:tts-pcm" ? "pcm" : "end"}:${p.sentenceId}${p.pcm ? `:${p.pcm}` : ""}`),
    setPhase: () => {},
    isMuted: () => false,
    notice: () => {},
    fail: () => {},
    history: { addSentence: () => true, markHeard: () => {}, discardUnheard: () => {}, markGenerationDone: () => {} },
    tts: () => ({ id: "fake", begin: (h) => { const s = { h, writeText() {}, finish() {}, cancel() {} }; sessions.push(s); return s; } }),
    fallbackTts: () => null,
    localFallbackEnabled: () => false,
    brain: () => ({ send: (_req, h) => { brainHandlers = h; }, cancel() {} }),
    createChunker: ({ onSentence }) => ({ push: () => {}, flush: () => { onSentence("第一句。"); onSentence("第二句。"); }, reset() {} }),
  };
  const pipeline = createReplyPipeline(host);
  return { sent, sessions, pipeline, finishBrain: () => brainHandlers.onCompleted("x") };
}

test("later sentence audio waits until the earlier sentence has fully streamed", () => {
  const { sent, sessions, pipeline, finishBrain } = harness();
  pipeline.begin({ text: "x", turnId: 1 });
  finishBrain();
  assert.equal(sessions.length, 2);
  const [a, b] = sessions;
  b.h.onAudio({ pcm: "b1" });
  a.h.onAudio({ pcm: "a1" });
  b.h.onAudio({ pcm: "b2" });
  b.h.onEnd();
  a.h.onAudio({ pcm: "a2" });
  assert.deepEqual(sent, ["pcm:1-1:a1", "pcm:1-1:a2"]);
  a.h.onEnd();
  assert.deepEqual(sent, ["pcm:1-1:a1", "pcm:1-1:a2", "end:1-1", "pcm:1-2:b1", "pcm:1-2:b2", "end:1-2"]);
});

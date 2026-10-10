"use strict";

// Start/end cue sounds, the VAD mask while a cue plays, pause -> renderer, TTS warm-up.
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeHarness } = require("./fixtures/voice-runtime-harness");

const sent = (h, ch) => h.rec.sent.filter((e) => e.channel === ch).map((e) => e.payload);

test("call start plays start; stop plays end", async () => {
  const h = makeHarness();
  await h.runtime.start();
  assert.deepEqual(h.rec.cues, ["start"]);
  h.runtime.stop("user");
  assert.deepEqual(h.rec.cues, ["start", "end"]);
});

test("pause plays end, resume plays start; idempotent calls play nothing extra", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setPaused(true); h.runtime.setPaused(true);
  h.runtime.setPaused(false);
  assert.deepEqual(h.rec.cues, ["start", "end", "start"]);
});

test("mic audio is ignored for 650ms after a start cue (resume), then accepted", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.clock.advance(1000);
  h.runtime.setPaused(true);
  h.runtime.setPaused(false);
  h.runtime.handleSpeechStart();
  assert.equal(h.rec.stt.length, 0, "masked");
  h.clock.advance(649);
  h.runtime.handleSpeechStart();
  assert.equal(h.rec.stt.length, 0, "still masked at 649ms");
  h.clock.advance(2);
  h.runtime.handleSpeechStart();
  assert.equal(h.rec.stt.length, 1, "unmasked after 650ms");
});

test("call start does not mask the mic (only a resume cue does)", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.handleSpeechStart();
  assert.equal(h.rec.stt.length, 1);
});

test("the end cue does not mask the mic", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.clock.advance(1000);
  h.runtime.setPaused(true);
  h.runtime.setPaused(false);
  h.clock.advance(700);
  h.runtime.setPaused(true);
  h.runtime.setPaused(false); // resume again masks; but pause itself must not leave a stale mask
  h.clock.advance(700);
  h.runtime.handleSpeechStart();
  assert.equal(h.rec.stt.length, 1);
});

test("pause state is pushed to the renderer so it can release/reacquire the mic", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setPaused(true);
  h.runtime.setPaused(false);
  assert.deepEqual(sent(h, "voice:paused"), [{ paused: true }, { paused: false }]);
});

test("the TTS provider is warmed on start and disposed on stop", async () => {
  const h = makeHarness();
  await h.runtime.start();
  assert.equal(h.rec.warmed, 1);
  h.runtime.stop("user");
  assert.equal(h.rec.disposed, 1);
});

test("a stem press (system already chimes) toggles pause without our cue", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setPaused(true, { cue: false });
  h.runtime.setPaused(false, { cue: false });
  assert.deepEqual(h.rec.cues, ["start"]);
  assert.equal(h.runtime.snapshot ? h.runtime.snapshot().paused : false, false);
});

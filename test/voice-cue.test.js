"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createVoiceCue, CUE_FILES } = require("../src/voice-cue");

const SOUNDS = path.join(__dirname, "..", "assets", "sounds");
function rig(over = {}) {
  const sent = [];
  const playCue = createVoiceCue({ send: (c, p) => sent.push([c, p]), getCueEnabled: () => true, getSoundVolume: () => 0.4, soundsDir: SOUNDS, ...over });
  return { playCue, sent };
}

test("start plays voice-start.wav, end plays voice-end.wav, via play-sound with the user's volume", () => {
  const r = rig();
  assert.equal(r.playCue("start"), true);
  assert.equal(r.playCue("end"), true);
  assert.equal(r.sent[0][0], "play-sound");
  assert.match(r.sent[0][1].url, /^file:\/\/.*\/assets\/sounds\/voice-start\.wav$/);
  assert.match(r.sent[1][1].url, /\/voice-end\.wav$/);
  assert.equal(r.sent[0][1].volume, 0.4);
});

test("only the voice cue switch silences the cues (pet mute / DND do not); unknown names do nothing", () => {
  const off = rig({ getCueEnabled: () => false });
  assert.equal(off.playCue("start"), false);
  const u = rig();
  assert.equal(u.playCue("bogus"), false);
  assert.deepEqual([off.sent, u.sent], [[], []]);
});

test("the bundled cues are Cora's mono 44.1kHz 16-bit wavs (0.62s)", () => {
  for (const f of Object.values(CUE_FILES)) {
    const b = fs.readFileSync(path.join(SOUNDS, f));
    assert.equal(b.toString("ascii", 0, 4), "RIFF");
    assert.equal(b.readUInt16LE(22), 1, "mono");
    assert.equal(b.readUInt32LE(24), 44100);
    assert.equal(b.readUInt16LE(34), 16);
    assert.ok(Math.abs((b.length - 44) / 2 / 44100 - 0.62) < 0.02, f);
  }
});

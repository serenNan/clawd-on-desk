"use strict";

// Real-model smoke test: runs only when the models were downloaded
// (npm run download:voice-models) and say/afconvert fixtures are not needed -
// it uses the wav shipped inside the model archive's test_wavs when present.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const models = require("../src/voice-models");
const { createSherpaStack } = require("../src/voice-sherpa-native");

const dir = models.getModelsDir(models.defaultUserDataDir());
const ready = models.checkModelsReady(dir).ready;
const wav = path.join(dir, models.ASR_MODEL.dir, "test_wavs", "0.wav");
const skip = !ready || !fs.existsSync(wav) ? "voice models not downloaded" : false;

function readWav16k(file) {
  const b = fs.readFileSync(file);
  const dataAt = b.indexOf("data") + 8;
  return Buffer.from(b.subarray(dataAt));
}

test("real sherpa: streaming STT produces text and Silero detects speech", { skip }, () => {
  const { stt, vad } = createSherpaStack({ modelsDir: dir });
  const pcm = readWav16k(wav);
  const out = { partials: 0, final: null };
  const s = stt.begin({ onPartial: () => { out.partials += 1; }, onFinal: (t) => { out.final = t; } });
  let started = false;
  for (let i = 0; i + 640 <= pcm.length; i += 640) {
    const chunk = pcm.subarray(i, i + 640);
    s.writeAudio(chunk);
    const i16 = new Int16Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length));
    if (vad.processChunk(i16).some((e) => e.type === "speech-start")) started = true;
  }
  s.finish();
  assert.ok(started, "silero flagged speech");
  assert.ok(out.partials > 0, "got partials");
  assert.ok(out.final && out.final.length > 0, "got a final");
});

test("createSherpaStack throws on a missing model dir so callers can fall back", () => {
  assert.throws(() => createSherpaStack({ modelsDir: path.join(require("os").tmpdir(), "no-such-models") }));
});

test("real sherpa stack applies the configured end-of-speech silence", { skip }, () => {
  assert.equal(createSherpaStack({ modelsDir: dir }).vad.getEndSilenceMs(), 800);
  assert.equal(createSherpaStack({ modelsDir: dir, endSilenceMs: 1100 }).vad.getEndSilenceMs(), 1100);
});

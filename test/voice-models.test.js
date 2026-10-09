"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const models = require("../src/voice-models");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "voice-models-"));

test("default models dir is under userData/voice-models", () => {
  assert.equal(models.getModelsDir("/data/clawd-on-desk"), path.join("/data/clawd-on-desk", "voice-models"));
});

test("userData fallback follows the platform convention", () => {
  assert.equal(models.defaultUserDataDir({ platform: "darwin", home: "/Users/a", env: {} }),
    path.join("/Users/a", "Library", "Application Support", "clawd-on-desk"));
  assert.equal(models.defaultUserDataDir({ platform: "linux", home: "/home/a", env: {} }),
    path.join("/home/a", ".config", "clawd-on-desk"));
  assert.equal(models.defaultUserDataDir({ platform: "win32", home: "C:\\u", env: { APPDATA: "C:\\u\\AppData\\Roaming" } }),
    path.join("C:\\u\\AppData\\Roaming", "clawd-on-desk"));
});

test("resolveModelPaths points at silero and the asr files", () => {
  const p = models.resolveModelPaths("/m");
  assert.equal(p.vad, path.join("/m", "silero_vad.onnx"));
  assert.equal(p.encoder, path.join("/m", models.ASR_MODEL.dir, "encoder.int8.onnx"));
  assert.equal(p.tokens, path.join("/m", models.ASR_MODEL.dir, "tokens.txt"));
});

test("checkModelsReady lists every missing file, then passes when all exist", () => {
  const dir = tmp();
  const first = models.checkModelsReady(dir);
  assert.equal(first.ready, false);
  assert.ok(first.missing.includes("silero_vad.onnx"));
  assert.equal(first.missing.length, 1 + models.ASR_MODEL.files.length);
  const p = models.resolveModelPaths(dir);
  fs.mkdirSync(path.dirname(p.encoder), { recursive: true });
  for (const f of [p.vad, p.encoder, p.decoder, p.joiner, p.tokens]) fs.writeFileSync(f, "x");
  assert.deepEqual(models.checkModelsReady(dir), { ready: true, missing: [] });
});

test("an empty file does not count as present", () => {
  const dir = tmp();
  fs.writeFileSync(models.resolveModelPaths(dir).vad, "");
  assert.ok(models.checkModelsReady(dir).missing.includes("silero_vad.onnx"));
});

test("model manifest pins https GitHub URLs and sha256", () => {
  for (const m of [models.VAD_MODEL, models.ASR_MODEL]) {
    assert.match(m.url, /^https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\//);
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.ok(m.size > 0);
  }
});

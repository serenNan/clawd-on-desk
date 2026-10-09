"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const models = require("../src/voice-models");
const { ensureModels, parseArgs, sha256File } = require("../scripts/download-voice-models");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dl-voice-"));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// Fake manifest + fake curl/tar so no network or bzip2 is needed.
function fakeSetup() {
  const vadBytes = Buffer.from("silero-bytes");
  const archiveBytes = Buffer.from("archive-bytes");
  const manifest = {
    vad: { ...models.VAD_MODEL, sha256: sha(vadBytes) },
    asr: { ...models.ASR_MODEL, sha256: sha(archiveBytes) },
  };
  const calls = [];
  const download = async (url, dest) => {
    calls.push(["download", url]);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, url === manifest.vad.url ? vadBytes : archiveBytes);
  };
  const extract = async (archive, outDir) => {
    calls.push(["extract", path.basename(archive)]);
    const d = path.join(outDir, manifest.asr.dir);
    fs.mkdirSync(d, { recursive: true });
    for (const f of manifest.asr.files) fs.writeFileSync(path.join(d, f), "model");
  };
  return { manifest, calls, download, extract, log: () => {} };
}

test("downloads, verifies and installs both models", async () => {
  const dir = tmp();
  const deps = fakeSetup();
  const res = await ensureModels({ dir, ...deps });
  assert.deepEqual(res, { ready: true, downloaded: ["vad", "asr"] });
  assert.equal(models.checkModelsReady(dir).ready, true);
  assert.equal(fs.existsSync(path.join(dir, ".download")), false);
});

test("is idempotent: a second run downloads nothing", async () => {
  const dir = tmp();
  const deps = fakeSetup();
  await ensureModels({ dir, ...deps });
  deps.calls.length = 0;
  const res = await ensureModels({ dir, ...deps });
  assert.deepEqual(res, { ready: true, downloaded: [] });
  assert.deepEqual(deps.calls, []);
});

test("a sha256 mismatch aborts, deletes the file and installs nothing", async () => {
  const dir = tmp();
  const deps = fakeSetup();
  deps.manifest.asr = { ...deps.manifest.asr, sha256: "0".repeat(64) };
  await assert.rejects(ensureModels({ dir, ...deps }), /sha256/);
  assert.equal(fs.existsSync(path.join(dir, ".download", deps.manifest.asr.archive)), false);
  assert.equal(models.checkModelsReady(dir).ready, false);
});

test("a corrupt existing silero file is re-downloaded", async () => {
  const dir = tmp();
  const deps = fakeSetup();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "silero_vad.onnx"), "corrupt");
  const res = await ensureModels({ dir, ...deps });
  assert.ok(res.downloaded.includes("vad"));
  assert.equal(await sha256File(path.join(dir, "silero_vad.onnx")), deps.manifest.vad.sha256);
});

test("parseArgs reads --dir and --force", () => {
  assert.deepEqual(parseArgs(["--dir", "/x", "--force"]), { dir: "/x", force: true });
  assert.deepEqual(parseArgs([]), { dir: null, force: false });
});

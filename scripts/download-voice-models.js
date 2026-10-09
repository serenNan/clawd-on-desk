#!/usr/bin/env node
"use strict";

// Downloads the local sherpa-onnx voice models (Silero VAD + streaming zh-en
// zipformer) into <userData>/voice-models. Idempotent; sha256-verified before
// anything is installed. Network goes through curl, so http(s)_proxy is honoured.
//   node scripts/download-voice-models.js [--dir <path>] [--force]
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const models = require("../src/voice-models");

function parseArgs(argv) {
  const out = { dir: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") out.dir = argv[++i] || null;
    else if (argv[i] === "--force") out.force = true;
  }
  return out;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (c) => h.update(c)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

const curlDownload = (url, dest) => run("curl", ["-fL", "--retry", "3", "-C", "-", "-o", dest, url]);
const tarExtract = (archive, outDir) => run("tar", ["-xjf", archive, "-C", outDir]);

async function fetchVerified({ item, dest, download, log }) {
  await download(item.url, dest);
  const actual = await sha256File(dest);
  if (actual !== item.sha256) {
    fs.rmSync(dest, { force: true });
    throw new Error(`sha256 mismatch for ${path.basename(dest)}: expected ${item.sha256}, got ${actual}`);
  }
  log(`verified ${path.basename(dest)}`);
}

async function ensureModels({ dir, force = false, manifest = { vad: models.VAD_MODEL, asr: models.ASR_MODEL }, download = curlDownload, extract = tarExtract, log = console.log } = {}) {
  const downloaded = [];
  const staging = path.join(dir, ".download");
  fs.mkdirSync(staging, { recursive: true });
  try {
    const vadFile = path.join(dir, manifest.vad.file);
    const vadOk = !force && fs.existsSync(vadFile) && (await sha256File(vadFile)) === manifest.vad.sha256;
    if (!vadOk) {
      const part = path.join(staging, manifest.vad.file);
      await fetchVerified({ item: manifest.vad, dest: part, download, log });
      fs.renameSync(part, vadFile);
      downloaded.push("vad");
    }
    const asrDir = path.join(dir, manifest.asr.dir);
    const asrOk = !force && manifest.asr.files.every((f) => { try { return fs.statSync(path.join(asrDir, f)).size > 0; } catch { return false; } });
    if (!asrOk) {
      const archive = path.join(staging, manifest.asr.archive);
      await fetchVerified({ item: manifest.asr, dest: archive, download, log });
      const out = path.join(staging, "extract");
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await extract(archive, out);
      fs.rmSync(asrDir, { recursive: true, force: true });
      fs.renameSync(path.join(out, manifest.asr.dir), asrDir);
      downloaded.push("asr");
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { ready: models.checkModelsReady(dir).ready, downloaded };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const dir = args.dir || models.getModelsDir(models.defaultUserDataDir());
  console.log(`Voice models dir: ${dir}`);
  const res = await ensureModels({ dir, force: args.force });
  console.log(res.downloaded.length ? `Installed: ${res.downloaded.join(", ")}` : "Already up to date.");
  return res.ready ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(err.message); process.exit(1); });
}

module.exports = { ensureModels, parseArgs, sha256File, main };

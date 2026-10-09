"use strict";

// Local sherpa-onnx voice models (Silero VAD + streaming zh-en zipformer).
// Pure path/manifest helpers shared by the runtime, Settings status and
// scripts/download-voice-models.js. Models live in userData, never the repo.
const fs = require("fs");
const os = require("os");
const path = require("path");

const APP_DIR = "clawd-on-desk";
const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";

const VAD_MODEL = Object.freeze({
  file: "silero_vad.onnx",
  url: `${RELEASE}/silero_vad.onnx`,
  sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
  size: 643854,
});

const ASR_DIR = "sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05";
const ASR_MODEL = Object.freeze({
  dir: ASR_DIR,
  archive: `${ASR_DIR}.tar.bz2`,
  url: `${RELEASE}/${ASR_DIR}.tar.bz2`,
  sha256: "8a6fca056e1a342546edd78be4d50274e2c01898e7b8ae8fc336f6410319c399",
  size: 133898007,
  files: Object.freeze(["encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt"]),
});

function defaultUserDataDir({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", APP_DIR);
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), APP_DIR);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), APP_DIR);
}

const getModelsDir = (userDataDir) => path.join(userDataDir, "voice-models");

function resolveModelPaths(modelsDir) {
  const asr = path.join(modelsDir, ASR_MODEL.dir);
  return {
    vad: path.join(modelsDir, VAD_MODEL.file),
    encoder: path.join(asr, "encoder.int8.onnx"),
    decoder: path.join(asr, "decoder.onnx"),
    joiner: path.join(asr, "joiner.int8.onnx"),
    tokens: path.join(asr, "tokens.txt"),
  };
}

function checkModelsReady(modelsDir, fsImpl = fs) {
  const missing = [];
  const present = (file) => {
    try { return fsImpl.statSync(file).size > 0; } catch { return false; }
  };
  if (!present(path.join(modelsDir, VAD_MODEL.file))) missing.push(VAD_MODEL.file);
  for (const f of ASR_MODEL.files) {
    if (!present(path.join(modelsDir, ASR_MODEL.dir, f))) missing.push(`${ASR_MODEL.dir}/${f}`);
  }
  return { ready: missing.length === 0, missing };
}

module.exports = { VAD_MODEL, ASR_MODEL, defaultUserDataDir, getModelsDir, resolveModelPaths, checkModelsReady };

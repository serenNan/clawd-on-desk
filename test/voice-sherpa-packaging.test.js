"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("sherpa-onnx-node is a runtime dependency (prebuilt N-API addon, no electron-rebuild)", () => {
  assert.match(pkg.dependencies["sherpa-onnx-node"], /^\^?1\./);
});

test("native addon and dylibs of every sherpa platform package are unpacked from the asar", () => {
  assert.ok(pkg.build.asarUnpack.includes("node_modules/sherpa-onnx-node/**/*"));
  assert.ok(pkg.build.asarUnpack.includes("node_modules/sherpa-onnx-*/**/*"));
});

test("models are downloaded at runtime, never bundled into the package", () => {
  const files = JSON.stringify(pkg.build.files) + JSON.stringify(pkg.build.extraResources || []);
  assert.equal(/\.onnx|voice-models/.test(files), false);
});

test("npm run download:voice-models points at the download script", () => {
  assert.equal(pkg.scripts["download:voice-models"], "node scripts/download-voice-models.js");
  assert.ok(fs.existsSync(path.join(ROOT, "scripts", "download-voice-models.js")));
});

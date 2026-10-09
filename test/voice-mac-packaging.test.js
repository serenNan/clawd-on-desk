"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("macOS Info.plist declares a microphone purpose string and no camera one", () => {
  const info = pkg.build.mac.extendInfo;
  assert.equal(typeof info.NSMicrophoneUsageDescription, "string");
  assert.ok(info.NSMicrophoneUsageDescription.length > 20);
  assert.equal(info.LSUIElement, true, "existing extendInfo key is preserved");
  assert.equal("NSCameraUsageDescription" in info, false);
});

test("hardened-runtime entitlements grant audio-input (and only keep the builder defaults otherwise)", () => {
  assert.equal(pkg.build.mac.entitlements, "build/entitlements.mac.plist");
  assert.equal(pkg.build.mac.entitlementsInherit, "build/entitlements.mac.plist");
  const plist = fs.readFileSync(path.join(ROOT, pkg.build.mac.entitlements), "utf8");
  const granted = [...plist.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]).sort();
  assert.deepEqual(granted, [
    "com.apple.security.cs.allow-dyld-environment-variables",
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    // ad-hoc signed builds fail dyld Team ID checks on Electron Framework without this
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.device.audio-input",
  ]);
  assert.equal(plist.includes("device.camera"), false);
});

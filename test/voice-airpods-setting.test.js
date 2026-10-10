"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { cloneDefaultVoice, normalizeVoice, validateVoice } = require("../src/voice-settings");
const { SUPPORTED_LANGS } = require("../src/i18n");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

test("voice.airpodsMuteCapture defaults to true and is a validated boolean", () => {
  assert.equal(cloneDefaultVoice().airpodsMuteCapture, true);
  assert.equal(normalizeVoice({}).airpodsMuteCapture, true);
  assert.equal(normalizeVoice({ airpodsMuteCapture: false }).airpodsMuteCapture, false);
  assert.equal(normalizeVoice({ airpodsMuteCapture: "no" }).airpodsMuteCapture, true);
  assert.equal(validateVoice({ airpodsMuteCapture: false }).status, "ok");
  assert.equal(validateVoice({ airpodsMuteCapture: 1 }).status, "error");
});

test("voice tab has the AirPods switch and the exact zh copy in every language", () => {
  const code = read("settings-tab-voice.js");
  assert.match(code, /switchRow\("voiceAirpodsLabel",\s*"voiceAirpodsDesc",\s*"airpodsMuteCapture"\)/);
  assert.match(code, /airpodsMuteCapture:\s*true/);
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(read("settings-i18n.js"), context, { filename: "settings-i18n.js" });
  const strings = context.ClawdSettingsI18n.STRINGS;
  assert.equal(strings["zh"].voiceAirpodsLabel, "用 AirPods 按柄控制静音");
  assert.equal(strings["zh"].voiceAirpodsDesc, "由桌宠自带的录音程序收音，可用 AirPods 按柄静音；关闭后改回浏览器内录音");
  for (const lang of SUPPORTED_LANGS) {
    for (const key of ["voiceAirpodsLabel", "voiceAirpodsDesc"]) assert.ok(strings[lang][key] && strings[lang][key].trim(), `${lang} ${key}`);
  }
});

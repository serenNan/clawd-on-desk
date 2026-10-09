"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC_DIR = path.join(__dirname, "..", "src");
const { SUPPORTED_LANGS } = require("../src/i18n");
const read = (name) => fs.readFileSync(path.join(SRC_DIR, name), "utf8");

test("settings-tab-voice.js registers via the sibling IIFE pattern", () => {
  const code = read("settings-tab-voice.js");
  assert.match(code, /root\.ClawdSettingsTabVoice\s*=\s*\{\s*init\s*\}/);
  assert.match(code, /core\.tabs\.voice\s*=\s*\{\s*render\s*\}/);
});

test("settings.html loads settings-tab-voice.js before settings-renderer.js", () => {
  const html = read("settings.html");
  const tabIdx = html.indexOf("settings-tab-voice.js");
  assert.ok(tabIdx > 0);
  assert.ok(html.indexOf("settings-renderer.js") > tabIdx);
});

test("settings-renderer.js has voice sidebar entry and init call", () => {
  const code = read("settings-renderer.js");
  assert.match(code, /id:\s*"voice"/);
  assert.match(code, /labelKey:\s*"sidebarVoice"/);
  assert.match(code, /ClawdSettingsTabVoice\.init\(core\)/);
});

test("settings-icons.js defines a voice icon", () => {
  assert.match(read("settings-icons.js"), /^\s*voice:\s*$/m);
});

test("every i18n key used by the voice tab exists in all languages", () => {
  const code = read("settings-tab-voice.js");
  const keys = new Set([...code.matchAll(/"(voice[A-Za-z0-9]+|sidebarVoice)"/g)].map((m) => m[1]));
  keys.add("sidebarVoice");
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(read("settings-i18n.js"), context, { filename: "settings-i18n.js" });
  const strings = context.ClawdSettingsI18n.STRINGS;
  for (const lang of SUPPORTED_LANGS) {
    for (const key of keys) {
      assert.ok(typeof strings[lang][key] === "string" && strings[lang][key].trim(), `${lang} missing ${key}`);
    }
  }
});

test("voice tab offers sherpa-onnx as default STT and shows model readiness", () => {
  const code = read("settings-tab-voice.js");
  assert.match(code, /\["sherpa-onnx",\s*"voiceSttSherpa"\]/);
  assert.match(code, /stt:\s*"sherpa-onnx"/);
  assert.match(code, /getVoiceModelsStatus/);
  assert.match(code, /voiceSherpaReady/);
  assert.match(code, /voiceSherpaMissing/);
});

test("settings preload exposes the read-only model status query", () => {
  assert.match(read("preload-settings.js"), /getVoiceModelsStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("voice:models-status"\)/);
});

test("voice tab offers the session brain driven by /clawd-voice", () => {
  const code = read("settings-tab-voice.js");
  assert.match(code, /\["session",\s*"voiceBrainSession"\]/);
  assert.match(code, /selectRow\("voiceBrainLabel",\s*"brain"/);
  assert.match(read("settings-i18n.js"), /voiceBrainSession: "由 Claude Code 会话 \/clawd-voice 驱动"/);
});

test("voice tab: Edge TTS is the first/default option with a voice picker and a cloud privacy note", () => {
  const code = read("settings-tab-voice.js");
  assert.match(code, /TTS_OPTIONS = \[\s*\["edge",\s*"voiceTtsEdge"\]/);
  assert.match(code, /tts: "edge"/);
  for (const voice of ["zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural", "zh-CN-YunxiNeural", "zh-CN-YunjianNeural"]) {
    assert.ok(code.includes(`"${voice}"`), `${voice} offered`);
  }
  assert.match(code, /"voiceEdgeVoiceLabel"/);
  assert.match(code, /"voiceEdgeCloudNote"/);
  assert.match(code, /isCloud = \(v\) => .*v\.tts === "edge"/);
});

test("voice tab: end-of-speech pause is adjustable within 400-1500 ms", () => {
  const code = read("settings-tab-voice.js");
  assert.match(code, /"voiceEndSilenceLabel"/);
  assert.match(code, /endSilenceMs/);
  const nums = [...code.matchAll(/END_SILENCE_CHOICES = \[([^\]]+)\]/g)][0][1].split(",").map(Number);
  assert.ok(Math.min(...nums) >= 400 && Math.max(...nums) <= 1500 && nums.includes(800));
});

test("settings text states the shortcut pauses the mic during a call, and the Microsoft upload", () => {
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(read("settings-i18n.js"), context, { filename: "settings-i18n.js" });
  const strings = context.ClawdSettingsI18n.STRINGS;
  assert.match(strings.en.voiceEnabledDesc, /pauses \/ resumes the microphone/);
  assert.match(strings["zh"].voiceEnabledDesc, /暂停 \/ 恢复收音/);
  assert.match(strings.en.voiceCloudConsentDesc, /Microsoft/);
  assert.match(strings.zh.voiceCloudConsentDesc, /微软/);
  assert.match(strings.zh.shortcutLabelToggleVoice, /暂停或恢复收音/);
});

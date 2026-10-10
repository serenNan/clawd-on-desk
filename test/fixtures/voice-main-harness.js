"use strict";

const { createVoiceMain } = require("../../src/voice-main");
const { cloneDefaultVoice, DASHSCOPE_KEY_ENV } = require("../../src/voice-settings");

function fakeProvider(id, extra = {}) {
  return {
    id,
    capabilities: { sampleRate: 16000, channels: 1, format: "s16le" },
    begin: () => ({ writeAudio() {}, writeText() {}, finish() {}, cancel() {} }),
    ...extra,
  };
}

function makeHarness(opts = {}) {
  const log = { notices: [], overlays: [], sent: [], created: [], updates: [], listeners: new Map(), mediaAsks: 0, captions: [], dbg: [], cues: [] };
  let voice = { ...cloneDefaultVoice(), brain: "claude-code", tts: "local-kokoro", enabled: true, ...(opts.voice || {}) };
  const wc = { id: 7, isDestroyed: () => false, send: (c, p) => log.sent.push([c, p]) };
  const factories = {
    createLocalStt: () => { log.created.push("local-stt"); return fakeProvider("local-whisper"); },
    createLocalTts: () => { log.created.push("local-tts"); return fakeProvider("local-kokoro"); },
    createEdgeTts: (o) => { log.created.push(["edge-tts", o.voice, o.speed]); return fakeProvider("edge-" + o.voice); },
    createAliyunStt: (o) => { log.created.push(["aliyun-stt", !!o.apiKey]); return fakeProvider("aliyun-paraformer"); },
    createAliyunTts: (o) => { log.created.push(["aliyun-tts", o.model, o.voice, o.voiceId]); return fakeProvider("aliyun-" + o.model); },
    sherpaStatus: () => (opts.sherpa === "ready" ? { ready: true, missing: [] } : { ready: false, missing: ["silero_vad.onnx"] }),
    createSherpa: (o) => {
      if (opts.sherpaThrows) throw new Error("dlopen failed");
      log.created.push("sherpa");
      log.sherpaOpts = o;
      return { stt: fakeProvider("sherpa-onnx"), vad: { processChunk: () => { log.vadChunks = (log.vadChunks || 0) + 1; return []; }, reset() {}, isSpeaking: () => false } };
    },
    createClaudeBrain: (o) => { log.created.push(["brain", o.claudePath]); return { id: "claude-code", probe: async () => opts.probe || { ok: true }, send() {}, cancel() {}, reset() {}, dispose() { log.created.push("brain-dispose"); } }; },
  };
  const handlers = new Map();
  const ipcMain = {
    on: (c, f) => log.listeners.set(c, f), removeListener: (c) => log.listeners.delete(c),
    handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c),
  };
  log.handlers = handlers;
  let mini = false;
  const vm = createVoiceMain({
    ipcMain,
    getPetWebContents: () => wc,
    getVoice: () => voice,
    applyVoiceUpdate: async (next) => { log.updates.push(next); voice = next; return { status: "ok" }; },
    env: opts.env || {},
    platform: opts.platform || "darwin",
    systemPreferences: opts.noSysPrefs ? null : {
      getMediaAccessStatus: () => opts.mic || "granted",
      askForMediaAccess: async () => { log.mediaAsks++; return opts.askResult !== false; },
    },
    isMiniTransitioning: () => mini,
    setVoiceOverlay: (n) => log.overlays.push(n),
    playCue: (name) => log.cues.push(name),
    notify: (code, detail) => log.notices.push([code, detail]),
    t: (key) => `T:${key}`,
    captionWindow: { show: (p) => log.captions.push(p), clear: () => log.captions.push("clear"), dispose() {} },
    getThemeId: () => "clawd",
    confirmCloudConsent: async () => opts.consent === true,
    debugLog: { log: (event, f) => log.dbg.push([event, f]), logRenderer() {} },
    factories,
    ...(opts.extraDeps || {}),
  });
  return { vm, log, wc, setMini: (v) => { mini = v; }, getVoice: () => voice, setVoice: (v) => { voice = { ...voice, ...v }; }, emit: (c, p) => log.listeners.get(c)({ sender: wc }, p) };
}

module.exports = { makeHarness, fakeProvider };

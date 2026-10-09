"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createVoiceDebugLog, errorFields, RENDERER_EVENTS } = require("../src/voice-debug-log");
const { registerVoiceIpc } = require("../src/voice-ipc");
const { createVoiceRuntime } = require("../src/voice-runtime");

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vdl-")), "voice-debug.log");
const lines = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("writes one JSON line with ISO time, event and fields", () => {
  const f = tmp();
  const l = createVoiceDebugLog({ filePath: f, now: () => new Date("2026-01-02T03:04:05.000Z") });
  l.log("session_start", { stt: "local-whisper", ms: 12 });
  assert.deepEqual(lines(f), [{ t: "2026-01-02T03:04:05.000Z", event: "session_start", stt: "local-whisper", ms: 12 }]);
});

test("drops privacy-sensitive keys and non-primitive values, truncates long strings", () => {
  const f = tmp();
  const l = createVoiceDebugLog({ filePath: f });
  l.log("x", { text: "secret", apiKey: "sk-1", pcm: Buffer.alloc(4), reply: "r", obj: { a: 1 }, ok: true, note: "a".repeat(900), textLen: 5 });
  const [row] = lines(f);
  assert.equal(row.text, undefined);
  assert.equal(row.apiKey, undefined);
  assert.equal(row.pcm, undefined);
  assert.equal(row.obj, undefined);
  assert.equal(row.ok, true);
  assert.equal(row.textLen, 5);
  assert.ok(row.note.length <= 320);
});

test("rotates when file exceeds maxBytes", () => {
  const f = tmp();
  const l = createVoiceDebugLog({ filePath: f, maxBytes: 300 });
  for (let i = 0; i < 20; i++) l.log("tick", { i });
  assert.ok(fs.existsSync(`${f}.1`));
  assert.ok(fs.statSync(f).size <= 300 + 100);
});

test("never throws when the file cannot be written", () => {
  const l = createVoiceDebugLog({ filePath: "/nonexistent-dir-xyz/a/b.log", fs: { appendFileSync() { throw new Error("x"); }, statSync() { throw new Error("x"); }, mkdirSync() {} } });
  assert.doesNotThrow(() => l.log("a"));
});

test("errorFields keeps message and first stack lines only", () => {
  const e = new Error("boom");
  e.stack = ["Error: boom", "a", "b", "c", "d", "e"].join("\n");
  const f = errorFields(e);
  assert.equal(f.message, "boom");
  assert.equal(f.stack.split("\n").length, 4);
});

test("logRenderer accepts only whitelisted events and limits fields", () => {
  const f = tmp();
  const l = createVoiceDebugLog({ filePath: f });
  l.logRenderer({ event: "vad_speech_end", ms: 400, text: "hi" });
  l.logRenderer({ event: "evil_event", ms: 1 });
  l.logRenderer("junk");
  const rows = lines(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "r:vad_speech_end");
  assert.equal(rows[0].text, undefined);
  assert.ok(RENDERER_EVENTS.has("mic_error"));
});

test("voice-ipc routes voice:debug-log only from the trusted sender", () => {
  const handlers = new Map();
  const ipcMain = { on: (ch, fn) => handlers.set(ch, fn), removeListener() {} };
  const trusted = { id: 1, isDestroyed: () => false };
  const got = [];
  registerVoiceIpc({ ipcMain, runtime: {}, getTrustedWebContents: () => trusted, log: { logRenderer: (p) => got.push(p) } });
  handlers.get("voice:debug-log")({ sender: { id: 9, isDestroyed: () => false } }, { event: "mic_ok" });
  handlers.get("voice:debug-log")({ sender: trusted }, { event: "mic_ok" });
  assert.equal(got.length, 1);
});

test("runtime logs session start/stop and epoch changes without text", async () => {
  const events = [];
  const log = (event, fields) => events.push([event, fields || {}]);
  const stt = { id: "s", capabilities: { sampleRate: 16000 }, begin: () => ({ writeAudio() {}, finish() {}, cancel() {} }) };
  const tts = { id: "t", begin: () => ({ writeText() {}, finish() {}, cancel() {} }) };
  const brain = { probe: async () => ({ ok: true }), send() {}, cancel() {}, reset() {}, dispose() {} };
  const rt = createVoiceRuntime({
    getVoice: () => ({ enabled: true, cloudConsent: true, stt: "local-whisper", tts: "local-kokoro" }),
    createProviders: () => ({ stt, tts, brain }),
    sendToRenderer() {},
    log,
  });
  await rt.start();
  rt.stop("user");
  const names = events.map((e) => e[0]);
  assert.ok(names.includes("session_start"));
  assert.ok(names.includes("session_stop"));
  assert.equal(events.find((e) => e[0] === "session_stop")[1].reason, "user");
});

test("sherpa/silero events land in the debug log as timings only, never text", () => {
  const f = tmp();
  const dl = createVoiceDebugLog({ filePath: f });
  const { createSherpaStt } = require("../src/voice-stt-sherpa");
  const engine = {
    createStream: () => ({ n: 0 }), accept(s) { s.n += 1; }, ready: () => false,
    decode() {}, text: () => "绝密识别结果", finish() {}, release() {},
  };
  const s = createSherpaStt({ engine, log: dl.log }).begin({ onPartial() {}, onFinal() {} });
  s.writeAudio(Buffer.alloc(640));
  s.finish();
  dl.log("vad_start");
  dl.log("vad_end", { reason: "silence", ms: 800 });
  dl.log("vad_perf", { chunks: 250, meanUs: 40, maxUs: 300 });
  dl.log("sherpa_fallback", { reason: "model-missing" });
  const rows = lines(f);
  for (const name of ["sherpa_first_partial", "sherpa_final", "vad_start", "vad_end", "vad_perf", "sherpa_fallback"]) {
    assert.ok(rows.some((r) => r.event === name), name);
  }
  assert.ok(!fs.readFileSync(f, "utf8").includes("绝密"));
});

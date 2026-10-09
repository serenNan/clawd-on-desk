"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { registerVoiceIpc, createVoicePermissionPolicy, MAX_AUDIO_BYTES } = require("../src/voice-ipc");

function setup({ trusted = { id: 1, isDestroyed: () => false, sent: [], send(ch, p) { this.sent.push([ch, p]); } } } = {}) {
  const handlers = new Map();
  const ipcMain = { on: (ch, fn) => handlers.set(ch, fn), removeListener: (ch) => handlers.delete(ch) };
  const calls = [];
  const runtime = new Proxy({}, { get: (_, name) => (...args) => calls.push([name, ...args]) });
  const ipc = registerVoiceIpc({ ipcMain, runtime, getTrustedWebContents: () => trusted });
  const fire = (ch, payload, sender = trusted) => handlers.get(ch)({ sender }, payload);
  return { handlers, calls, ipc, trusted, fire };
}

test("registers only voice:* channels and routes trusted sender events to the runtime", () => {
  const s = setup();
  for (const ch of s.handlers.keys()) assert.ok(ch.startsWith("voice:"), ch);
  s.fire("voice:speech-start");
  s.fire("voice:audio", new Uint8Array(640));
  s.fire("voice:speech-end", { reason: "silence" });
  s.fire("voice:barge-commit", { playingSentenceId: "1-2" });
  s.fire("voice:ack", { epoch: 3, sentenceId: "1-2" });
  s.fire("voice:buffered", 1234);
  assert.deepEqual(s.calls.map((c) => c[0]), [
    "handleSpeechStart", "handleAudio", "handleSpeechEnd", "handleBargeCommit", "handleAck", "handleBuffered",
  ]);
  assert.ok(Buffer.isBuffer(s.calls[1][1]));
  assert.equal(s.calls[4][1].sentenceId, "1-2");
});

test("untrusted senders are ignored", () => {
  const s = setup();
  s.fire("voice:speech-start", undefined, { id: 99, isDestroyed: () => false });
  s.fire("voice:audio", new Uint8Array(4), null);
  assert.deepEqual(s.calls, []);
});

test("rejects oversized, wrongly typed or malformed payloads", () => {
  const s = setup();
  s.fire("voice:audio", new Uint8Array(MAX_AUDIO_BYTES + 1));
  s.fire("voice:audio", "not audio");
  s.fire("voice:audio", new Uint8Array(3));
  s.fire("voice:speech-end", { reason: "<script>" });
  s.fire("voice:ack", { epoch: "x", sentenceId: 5 });
  s.fire("voice:buffered", -5);
  s.fire("voice:barge-commit", { playingSentenceId: { evil: true } });
  assert.deepEqual(s.calls.map((c) => c[0]), ["handleBargeCommit"]);
  assert.equal(s.calls[0][1].playingSentenceId, null);
});

test("sendToRenderer only reaches the trusted live window and never accepts other channels", () => {
  const s = setup();
  s.ipc.sendToRenderer("voice:start", { a: 1 });
  s.ipc.sendToRenderer("evil:channel", {});
  s.ipc.sendToRenderer("voice:vad", { type: "speech-start" });
  assert.deepEqual(s.trusted.sent, [["voice:start", { a: 1 }], ["voice:vad", { type: "speech-start" }]]);
  s.trusted.isDestroyed = () => true;
  s.ipc.sendToRenderer("voice:stop", {});
  assert.equal(s.trusted.sent.length, 2);
});

test("dispose removes every listener", () => {
  const s = setup();
  s.ipc.dispose();
  assert.equal(s.handlers.size, 0);
});

test("permission policy: audio only for the trusted window while a call is active; camera never", () => {
  const trusted = { id: 1 };
  let active = false;
  const policy = createVoicePermissionPolicy({ getTrustedWebContents: () => trusted, isCallActive: () => active });
  const other = { id: 2 };
  assert.equal(policy.check(trusted, "media", { mediaType: "audio" }), false, "no call, no mic");
  active = true;
  assert.equal(policy.check(trusted, "media", { mediaType: "audio" }), true);
  assert.equal(policy.check(trusted, "media", { mediaType: "video" }), false);
  assert.equal(policy.check(trusted, "media", { mediaType: "unknown" }), false);
  assert.equal(policy.check(other, "media", { mediaType: "audio" }), false);
  const results = [];
  policy.request(trusted, "media", (g) => results.push(g), { mediaTypes: ["audio"] });
  policy.request(trusted, "media", (g) => results.push(g), { mediaTypes: ["audio", "video"] });
  policy.request(other, "media", (g) => results.push(g), { mediaTypes: ["audio"] });
  assert.deepEqual(results, [true, false, false]);
});

test("permission policy keeps pre-existing behaviour for non-media permissions", () => {
  const policy = createVoicePermissionPolicy({ getTrustedWebContents: () => null, isCallActive: () => false });
  assert.equal(policy.check({ id: 5 }, "clipboard-sanitized-write", {}), true);
  const out = [];
  policy.request({ id: 5 }, "notifications", (g) => out.push(g), {});
  assert.deepEqual(out, [true]);
});

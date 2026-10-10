"use strict";

// Runtime in `session` brain mode: no CLI brain, finals go to converse(),
// converse text plays through sentence -> TTS -> ack with barge-in semantics.
const assert = require("node:assert/strict");
const test = require("node:test");

const { createVoiceRuntime } = require("../src/voice-runtime");
const { createSessionBrain } = require("../src/voice-brain-session");
const { cloneDefaultVoice } = require("../src/voice-settings");

function makeHarness() {
  const rec = { sent: [], stt: [], tts: [], logs: [], states: [] };
  const stt = {
    id: "local-whisper", capabilities: { sampleRate: 16000 },
    begin(handlers) {
      const s = { handlers, writeAudio() {}, finish() {}, cancel() {} };
      rec.stt.push(s);
      return s;
    },
  };
  const tts = {
    id: "local-kokoro", capabilities: { sampleRate: 24000, channels: 1, format: "s16le" },
    begin(handlers) {
      const s = { handlers, texts: [], writeText(t) { this.texts.push(t); }, finish() {}, cancel() {} };
      rec.tts.push(s);
      return s;
    },
  };
  const runtime = createVoiceRuntime({
    getVoice: () => ({ ...cloneDefaultVoice(), tts: "local-kokoro", enabled: true, brain: "session", stt: "local-whisper" }),
    mergeGapMs: 0,
    env: {},
    createProviders: () => ({ stt, tts, brain: createSessionBrain() }),
    sendToRenderer: (channel, payload) => rec.sent.push({ channel, payload }),
    onStateChange: (s) => rec.states.push(s.phase),
    log: (event, fields) => rec.logs.push([event, fields]),
  });
  return { runtime, rec };
}

// One user utterance: speech-start, audio, speech-end, STT final.
function say(h, text) {
  const before = h.rec.stt.length;
  h.runtime.handleSpeechStart();
  h.runtime.handleAudio(Buffer.alloc(4));
  h.runtime.handleSpeechEnd({ reason: "silence" });
  h.rec.stt[before].handlers.onFinal(text);
}
const ack = (h) => { for (const id of h.runtime.getState().inflight.slice()) h.runtime.handleAck({ epoch: h.runtime.getState().epoch, sentenceId: id }); };

test("session mode never talks to a CLI brain; state flags sessionMode", async () => {
  const h = makeHarness();
  assert.equal((await h.runtime.start()).status, "ok");
  assert.equal(h.runtime.getState().sessionMode, true);
});

test("converse round: plays reply, then returns the user's next final", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const p = h.runtime.converse({ text: "你好呀。有什么事吗。" });
  assert.deepEqual(h.rec.tts.map((s) => s.texts[0]), ["你好呀。", "有什么事吗。"]);
  h.rec.tts[0].handlers.onAudio({ pcm: Buffer.alloc(4), sampleRate: 24000, channels: 1 });
  assert.equal(h.runtime.getState().phase, "speaking");
  ack(h);
  assert.equal(h.runtime.getState().phase, "listening");
  say(h, "帮我查个东西");
  assert.deepEqual(await p, { interrupted: false, user: "帮我查个东西" });
  assert.equal(h.runtime.getState().phase, "thinking");
});

test("user speech during playback interrupts: played / unplayed_count / user", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const p = h.runtime.converse({ text: "第一句话。第二句话。第三句话。" });
  const first = h.runtime.getState().inflight[0];
  h.runtime.handleAck({ epoch: 0, sentenceId: first });
  h.runtime.handleBargeCommit({ playingSentenceId: h.runtime.getState().inflight[0] });
  assert.ok(h.rec.sent.some((e) => e.channel === "voice:stop-playback"));
  say(h, "等一下，我想问别的");
  assert.deepEqual(await p, { interrupted: true, played: "第一句话。", unplayed_count: 2, user: "等一下，我想问别的" });
});

test("a backchannel during playback does not interrupt or return", async () => {
  const h = makeHarness();
  await h.runtime.start();
  let settled = false;
  const p = h.runtime.converse({ text: "我来讲一下。这个很长。" }).then((r) => { settled = true; return r; });
  const epoch = h.runtime.getState().epoch;
  say(h, "嗯");
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(h.runtime.getState().epoch, epoch);
  ack(h);
  say(h, "继续");
  assert.deepEqual(await p, { interrupted: false, user: "继续" });
});

test("timeout starts after playback and returns {timeout:true}", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const p = h.runtime.converse({ text: "测试一下", timeoutS: 0.05 });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(h.runtime.getState().inflight.length, 1); // still "playing": no timeout yet
  ack(h);
  assert.deepEqual(await p, { timeout: true });
});

test("stop ends a pending converse with ended; converse outside session mode errors", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const p = h.runtime.converse({});
  h.runtime.stop("user");
  assert.deepEqual(await p, { ended: true, reason: "stopped" });
  assert.deepEqual(await h.runtime.converse({}), { error: "not-in-session" });
});

test("session events are logged without text", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const p = h.runtime.converse({ text: "绝密文本" });
  ack(h);
  say(h, "用户绝密");
  await p;
  const events = h.rec.logs.map(([e]) => e);
  assert.ok(events.includes("converse_start") && events.includes("converse_done"));
  assert.equal(JSON.stringify(h.rec.logs).includes("绝密"), false);
});

test("long converse text is summarized through the injected summarizer, voice.summarizeOver gates it", async () => {
  const { makeHarness } = require("./fixtures/voice-runtime-harness");
  const sums = [];
  const h = makeHarness({ voice: { summarizeOver: 10 }, runtimeOptions: { summarize: async (t) => { sums.push(t.length); return { text: "摘要一句。", summarized: true }; } } });
  await h.runtime.start();
  const p = h.runtime.converse({ text: "这是一段超过十个字的长回复内容，需要先压缩。", timeoutS: 30 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.rec.tts[0].texts, ["摘要一句。"]);
  assert.equal(sums.length, 1);
  h.runtime.stop("test");
  const r = await p;
  assert.equal(r.ended, true);
  assert.equal(JSON.stringify(h.rec.logs).includes("超过十个字"), false);
});

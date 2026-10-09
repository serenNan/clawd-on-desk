"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createVoiceRuntime } = require("../src/voice-runtime");
const { cloneDefaultVoice } = require("../src/voice-settings");

function makeHarness(overrides = {}) {
  const log = { sent: [], states: [], sttSessions: [], ttsSessions: [], brainSends: [], brain: { cancels: 0, resets: 0, disposes: 0 } };
  const stt = {
    id: overrides.sttId || "local-whisper",
    capabilities: { streaming: false, endpointing: false, sampleRate: 16000, maxSegmentMs: 15000 },
    begin(handlers) {
      const s = { handlers, writes: [], finished: false, cancelled: false,
        writeAudio(b) { this.writes.push(b); }, finish() { this.finished = true; }, cancel() { this.cancelled = true; } };
      log.sttSessions.push(s);
      return s;
    },
  };
  const tts = {
    id: "local-kokoro",
    capabilities: { sampleRate: 24000, channels: 1, format: "s16le" },
    begin(handlers) {
      const s = { handlers, texts: [], finished: false, cancelled: false,
        writeText(t) { this.texts.push(t); }, finish() { this.finished = true; }, cancel() { this.cancelled = true; } };
      log.ttsSessions.push(s);
      return s;
    },
  };
  const brain = {
    id: "claude-code",
    async probe() { return { ok: true, version: "x" }; },
    send(req, handlers) { log.brainSends.push({ req, handlers }); },
    cancel() { log.brain.cancels++; },
    reset() { log.brain.resets++; },
    dispose() { log.brain.disposes++; },
  };
  let voice = { ...cloneDefaultVoice(), tts: "local-kokoro", enabled: true, ...(overrides.voice || {}) };
  const runtime = createVoiceRuntime({
    getVoice: () => voice,
    env: overrides.env || {},
    createProviders: () => ({ stt, tts, brain, fallbackStt: overrides.fallbackStt, fallbackTts: overrides.fallbackTts }),
    sendToRenderer: (channel, payload) => log.sent.push({ channel, payload }),
    onStateChange: (s) => log.states.push(s),
    now: () => 0,
  });
  return { runtime, log, setVoice: (v) => { voice = { ...voice, ...v }; } };
}

const pcm = (n = 4) => Buffer.alloc(n);
const sentTo = (h, ch) => h.log.sent.filter((e) => e.channel === ch);

async function speak(h, text, { endBeforeFinal = true } = {}) {
  const r = h.runtime;
  const before = h.log.sttSessions.length;
  r.handleSpeechStart();
  r.handleAudio(pcm());
  if (endBeforeFinal) r.handleSpeechEnd({ reason: "silence" });
  const s = h.log.sttSessions[before];
  s.handlers.onFinal(text);
  if (!endBeforeFinal) r.handleSpeechEnd({ reason: "silence" });
  return s;
}

test("start refuses when cloud provider lacks key/consent and creates nothing", async () => {
  const h = makeHarness({ voice: { stt: "aliyun-paraformer" } });
  const res = await h.runtime.start();
  assert.equal(res.status, "error");
  assert.ok(res.reasons.includes("dashscope-key-missing"));
  assert.equal(sentTo(h, "voice:start").length, 0);
  assert.equal(h.runtime.getState().phase, "idle");
});

test("start refuses when voice is disabled", async () => {
  const h = makeHarness({ voice: { enabled: false } });
  const res = await h.runtime.start();
  assert.deepEqual(res.reasons, ["voice-disabled"]);
});

test("start/stop are idempotent and stop releases providers", async () => {
  const h = makeHarness();
  assert.equal((await h.runtime.start()).status, "ok");
  assert.equal((await h.runtime.start()).status, "ok");
  assert.equal(sentTo(h, "voice:start").length, 1);
  assert.equal(h.runtime.getState().phase, "listening");
  h.runtime.stop("user");
  h.runtime.stop("user");
  assert.equal(sentTo(h, "voice:stop").length, 1);
  assert.equal(h.log.brain.disposes, 1);
  assert.equal(h.runtime.getState().phase, "idle");
});

test("brain probe failure keeps the call from starting (fail closed)", async () => {
  const sent = [];
  const r = createVoiceRuntime({
    getVoice: () => ({ ...cloneDefaultVoice(), tts: "local-kokoro", enabled: true }),
    env: {},
    createProviders: () => ({
      stt: {}, tts: {}, brain: { probe: async () => ({ ok: false, reason: "missing-flag:--tools" }), dispose() {} },
    }),
    sendToRenderer: (channel) => sent.push(channel),
  });
  const res = await r.start();
  assert.equal(res.status, "error");
  assert.deepEqual(res.reasons, ["missing-flag:--tools"]);
  assert.deepEqual(sent, []);
});

test("full turn: final submits once, sentences stream to TTS, ack completes", async () => {
  const h = makeHarness();
  await h.runtime.start();
  await speak(h, "你好");
  assert.equal(h.log.brainSends.length, 1);
  assert.equal(h.log.brainSends[0].req.text, "你好");
  const { handlers } = h.log.brainSends[0];
  handlers.onTextDelta("你好呀。今天");
  assert.equal(h.log.ttsSessions.length, 1);
  assert.deepEqual(h.log.ttsSessions[0].texts, ["你好呀。"]);
  assert.equal(h.log.ttsSessions[0].finished, true);
  h.log.ttsSessions[0].handlers.onAudio({ pcm: pcm(6), sampleRate: 24000, channels: 1 });
  const out = sentTo(h, "voice:tts-pcm");
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.epoch, 0);
  assert.equal(h.runtime.getState().phase, "speaking");
  handlers.onTextDelta("好开心。");
  handlers.onCompleted("你好呀。今天好开心。");
  h.log.ttsSessions[0].handlers.onEnd();
  assert.equal(h.log.ttsSessions.length, 2);
  const ids = h.runtime.getState().inflight.slice();
  assert.equal(ids.length, 2);
  h.runtime.handleAck({ epoch: 0, sentenceId: ids[0] });
  assert.equal(h.runtime.getState().phase, "speaking");
  h.runtime.handleAck({ epoch: 0, sentenceId: ids[1] });
  assert.equal(h.runtime.getState().phase, "listening");
  assert.equal(h.runtime.needsRebuild(), false);
});

test("empty final is ignored; duplicate final does not start a second turn", async () => {
  const h = makeHarness();
  await h.runtime.start();
  await speak(h, "   ");
  assert.equal(h.log.brainSends.length, 0);
  assert.equal(h.runtime.getState().phase, "listening");
  const s = await speak(h, "你好");
  s.handlers.onFinal("你好");
  assert.equal(h.log.brainSends.length, 1);
});

test("final that arrives before the local speech-end waits for the gate", async () => {
  const h = makeHarness();
  await h.runtime.start();
  const s = await speak(h, "继续说", { endBeforeFinal: false });
  assert.ok(s);
  assert.equal(h.log.brainSends.length, 1);
});

test("noise segments are dropped without calling any provider final", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.handleSpeechStart();
  h.runtime.handleAudio(pcm());
  h.runtime.handleSpeechEnd({ reason: "noise" });
  assert.equal(h.log.sttSessions[0].cancelled, true);
  assert.equal(h.log.brainSends.length, 0);
});

test("at most 2 sentences are synthesised ahead; third waits for an ack", async () => {
  const h = makeHarness();
  await h.runtime.start();
  await speak(h, "讲故事");
  h.log.brainSends[0].handlers.onTextDelta("第一句话。第二句话。第三句话。");
  assert.equal(h.log.ttsSessions.length, 2);
  const first = h.runtime.getState().inflight[0];
  h.runtime.handleAck({ epoch: 0, sentenceId: first });
  assert.equal(h.log.ttsSessions.length, 3);
});

test("renderer buffer above 2s pauses new TTS sessions", async () => {
  const h = makeHarness();
  await h.runtime.start();
  await speak(h, "讲故事");
  h.runtime.handleBuffered(2500);
  h.log.brainSends[0].handlers.onTextDelta("第一句话。");
  assert.equal(h.log.ttsSessions.length, 0);
  h.runtime.handleBuffered(500);
  assert.equal(h.log.ttsSessions.length, 1);
});

test("interrupt bumps epoch, cancels everything and drops late results", async () => {
  const h = makeHarness();
  await h.runtime.start();
  await speak(h, "讲故事");
  const { handlers } = h.log.brainSends[0];
  handlers.onTextDelta("从前有座山。山里有座庙。");
  const tts0 = h.log.ttsSessions[0];
  h.runtime.handleBargeCommit({ playingSentenceId: h.runtime.getState().inflight[0] });
  assert.equal(h.runtime.getState().epoch, 1);
  assert.equal(h.log.brain.cancels, 1);
  assert.equal(tts0.cancelled, true);
  assert.equal(sentTo(h, "voice:stop-playback").length, 1);
  const sentBefore = h.log.sent.length;
  handlers.onTextDelta("迟到的文本。");
  handlers.onCompleted("x");
  handlers.onError({ code: "late" });
  tts0.handlers.onAudio({ pcm: pcm(), sampleRate: 24000, channels: 1 });
  tts0.handlers.onError({ code: "late" });
  assert.equal(h.log.sent.length, sentBefore);
  assert.equal(h.log.ttsSessions.length, 2, "no new tts session for late text");
  assert.equal(h.runtime.getState().phase, "listening");
});

test("after an interrupt the next brain input is rebuilt from heard history only", async () => {
  const h = makeHarness();
  await h.runtime.start();
  await speak(h, "讲故事");
  h.log.brainSends[0].handlers.onTextDelta("从前有座山。山里有座庙。");
  const ids = h.runtime.getState().inflight.slice();
  h.runtime.handleAck({ epoch: 0, sentenceId: ids[0] });
  h.runtime.handleBargeCommit({ playingSentenceId: ids[1] });
  await speak(h, "等一下");
  assert.equal(h.log.brain.resets, 1);
  const text = h.log.brainSends[1].req.text;
  assert.ok(text.includes("从前有座山。"));
  assert.equal(text.includes("山里有座庙"), false);
  assert.ok(text.includes("等一下"));
  assert.ok(text.includes("partiallyPlayed"));
});

test("a reply over 2000 chars is cancelled and visible as truncated", async () => {
  const h = makeHarness();
  await h.runtime.start();
  await speak(h, "长篇大论");
  const { handlers } = h.log.brainSends[0];
  for (let i = 0; i < 60; i++) handlers.onTextDelta("这是一句比较长的话用来凑够字数".repeat(3) + "。");
  assert.ok(h.log.brain.cancels >= 1);
  assert.equal(sentTo(h, "voice:notice").some((e) => e.payload.code === "reply-too-long"), true);
  const spoken = h.log.ttsSessions.reduce((n, s) => n + s.texts.join("").length, 0);
  assert.ok(spoken <= 2000);
});

test("backchannel final during an active reply is dropped, substantive one interrupts", async () => {
  const h = makeHarness();
  await h.runtime.start();
  await speak(h, "讲故事");
  h.log.brainSends[0].handlers.onTextDelta("从前有座山。");
  await speak(h, "嗯");
  assert.equal(h.log.brainSends.length, 1);
  assert.equal(h.runtime.getState().epoch, 0);
  await speak(h, "不对，换一个");
  assert.equal(h.runtime.getState().epoch, 1);
  assert.equal(h.log.brainSends.length, 2);
});

test("barge commit keeps the live utterance STT session for the new turn", async () => {
  const h = makeHarness();
  await h.runtime.start();
  await speak(h, "讲故事");
  h.log.brainSends[0].handlers.onTextDelta("从前有座山。");
  h.runtime.handleSpeechStart();
  h.runtime.handleAudio(pcm());
  const live = h.log.sttSessions[1];
  h.runtime.handleBargeCommit({});
  assert.equal(live.cancelled, false);
  h.runtime.handleSpeechEnd({ reason: "silence" });
  live.handlers.onFinal("换个话题");
  assert.equal(h.log.brainSends.length, 2);
});

test("muted output never starts TTS and the unheard reply forces a rebuild", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.setMuted(true);
  await speak(h, "在吗");
  h.log.brainSends[0].handlers.onTextDelta("在的。");
  h.log.brainSends[0].handlers.onCompleted("在的。");
  assert.equal(h.log.ttsSessions.length, 0);
  await speak(h, "喂");
  assert.equal(h.log.brain.resets, 1);
  assert.equal(h.runtime.getState().muted, true);
});

test("STT failure without fallback stops the call with a visible error", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.handleSpeechStart();
  h.log.sttSessions[0].handlers.onError({ code: "stt_local_unreachable", message: "x" });
  const st = h.runtime.getState();
  assert.equal(st.phase, "error");
  assert.equal(st.error, "stt_local_unreachable");
  assert.equal(sentTo(h, "voice:stop").length, 1);
});

test("cloud STT failure falls back to local only when the user enabled it", async () => {
  const fb = { used: [] };
  const fallbackStt = {
    id: "local-whisper",
    begin(handlers) {
      const s = { handlers, writes: [], finished: false, writeAudio(b) { this.writes.push(b); }, finish() { this.finished = true; }, cancel() {} };
      fb.used.push(s);
      return s;
    },
  };
  const h = makeHarness({ fallbackStt, sttId: "aliyun-paraformer", voice: { localFallback: true } });
  await h.runtime.start();
  h.runtime.handleSpeechStart();
  h.runtime.handleAudio(pcm(8));
  h.runtime.handleSpeechEnd({ reason: "silence" });
  h.log.sttSessions[0].handlers.onError({ code: "stt_network" });
  assert.equal(h.runtime.getState().epoch, 1);
  assert.equal(fb.used.length, 1);
  assert.equal(fb.used[0].writes.length, 1);
  assert.equal(fb.used[0].finished, true);
  assert.equal(sentTo(h, "voice:notice").some((e) => e.payload.code === "fallback-local-stt"), true);
  fb.used[0].handlers.onFinal("你好");
  assert.equal(h.log.brainSends.length, 1);
});

test("renderer destruction ends the call exactly once", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.handleRendererGone();
  h.runtime.handleRendererGone();
  assert.equal(sentTo(h, "voice:stop").length, 1);
  assert.equal(h.runtime.getState().phase, "idle");
});

test("events after stop are ignored", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.stop("user");
  h.runtime.handleSpeechStart();
  h.runtime.handleAudio(pcm());
  assert.equal(h.log.sttSessions.length, 0);
});

test("renderer capture errors (e.g. mic denied) end the call visibly without retry loops", async () => {
  const h = makeHarness();
  await h.runtime.start();
  h.runtime.handleRendererError({ code: "mic_denied" });
  assert.equal(h.runtime.getState().phase, "error");
  assert.equal(h.runtime.getState().error, "mic_denied");
  h.runtime.handleRendererError({ code: "mic_denied" });
  assert.equal(sentTo(h, "voice:stop").length, 1);
});

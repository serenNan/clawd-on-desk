"use strict";

// CosyVoice streaming TTS adapter (DashScope WebSocket). Not verified against
// the live service. One begin() = one synthesis task (the runtime opens one per
// short sentence). Binary frames are raw s16le PCM; odd trailing bytes are
// carried so a half sample is never emitted. No text or key is logged.
const { requireKey, newTaskId, buildFrame, isAuthFailure, openSocket } = require("./voice-aliyun-ws");

function mapFailure(errorCode) {
  if (isAuthFailure(errorCode)) return "tts_auth";
  if (/voice/i.test(errorCode || "")) return "tts_voice";
  return "tts_failed";
}

function createAliyunTts(options = {}) {
  const apiKey = requireKey(options.apiKey);
  const model = options.model || "cosyvoice-v3-flash";
  const isV35 = model === "cosyvoice-v3.5-flash";
  const region = options.region || "beijing";
  if (region !== "beijing") throw new Error("only the beijing region is supported");
  const sampleRate = options.sampleRate || 22050;
  const voice = isV35 ? options.voiceId || "" : options.voice || "longanyang";

  function begin(handlers = {}) {
    if (isV35 && !voice) {
      if (handlers.onError) handlers.onError({ code: "tts_voice", message: "voice id required for cosyvoice-v3.5-flash" });
      return { writeText() {}, finish() {}, cancel() {} };
    }
    const taskId = newTaskId();
    const pendingText = [];
    let ready = false;
    let finishRequested = false;
    let done = false;
    let carry = null;
    let ws = null;

    const close = () => { done = true; try { ws && ws.close(); } catch {} };
    const fail = (code, message) => {
      if (done) return;
      close();
      if (handlers.onError) handlers.onError({ code, message });
    };
    const sendText = (text) => ws.send(buildFrame("continue-task", taskId, { input: { text } }));
    const sendFinish = () => ws.send(buildFrame("finish-task", taskId));
    const onBinary = (buf) => {
      if (done) return;
      const data = carry ? Buffer.concat([carry, buf]) : buf;
      const even = data.length - (data.length % 2);
      carry = even < data.length ? data.subarray(even) : null;
      if (even > 0 && handlers.onAudio) handlers.onAudio({ pcm: data.subarray(0, even), sampleRate, channels: 1 });
    };
    const onJson = (obj) => {
      if (done) return;
      const ev = obj.header.event;
      if (ev === "task-started") {
        ready = true;
        for (const t of pendingText.splice(0)) sendText(t);
        if (finishRequested) sendFinish();
      } else if (ev === "task-finished") {
        close();
        if (handlers.onEnd) handlers.onEnd();
      } else if (ev === "task-failed") {
        fail(mapFailure(obj.header.error_code), String(obj.header.error_message || "task failed").slice(0, 200));
      }
    };

    ws = openSocket(options.WebSocketImpl, apiKey, {
      onOpen: () => {
        if (done) return;
        ws.send(buildFrame("run-task", taskId, {
          taskGroup: "audio", task: "tts", fn: "SpeechSynthesizer", model,
          parameters: { text_type: "PlainText", voice, format: "pcm", sample_rate: sampleRate },
        }));
      },
      onJson,
      onBinary,
      onClose: () => fail("tts_network", "connection closed"),
      onFail: (kind) => fail(kind === "auth" ? "tts_auth" : "tts_network", "connection failed"),
    });

    return {
      writeText(text) {
        if (done || finishRequested || typeof text !== "string" || !text) return;
        if (ready) sendText(text); else pendingText.push(text);
      },
      finish() {
        if (done || finishRequested) return;
        finishRequested = true;
        if (ready) sendFinish();
      },
      cancel() { close(); },
    };
  }

  return {
    id: `aliyun-${model}`,
    capabilities: { streaming: true, sampleRate, channels: 1, format: "s16le" },
    begin,
  };
}

module.exports = { createAliyunTts };

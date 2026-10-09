"use strict";

// Paraformer realtime STT adapter (DashScope WebSocket). Not verified against
// the live service. A task exists only between begin() and final/error/cancel,
// so silence never keeps a billed task open. No content or key is logged.
const { requireKey, newTaskId, buildFrame, isAuthFailure, openSocket } = require("./voice-aliyun-ws");

const SAMPLE_RATE = 16000;
const MAX_BUFFER_BYTES = 15 * SAMPLE_RATE * 2;

function createAliyunStt(options = {}) {
  const apiKey = requireKey(options.apiKey);
  const model = options.model || "paraformer-realtime-v2";
  const finalTimeoutMs = options.finalTimeoutMs || 3000;
  const setT = options.setTimeout || setTimeout;
  const clearT = options.clearTimeout || clearTimeout;

  function begin(handlers = {}) {
    const taskId = newTaskId();
    const pending = [];
    let pendingBytes = 0;
    let ready = false;
    let finishRequested = false;
    let finishSent = false;
    let done = false;
    let timer = null;
    const sentences = [];
    let ws = null;

    const close = () => { done = true; clearT(timer); try { ws && ws.close(); } catch {} };
    const fail = (code, message) => {
      if (done) return;
      close();
      if (handlers.onError) handlers.onError({ code, message });
    };
    const complete = () => {
      if (done) return;
      const text = sentences.join("").trim();
      close();
      if (handlers.onFinal) handlers.onFinal(text);
    };
    const sendFinish = () => {
      if (finishSent || !ready) return;
      finishSent = true;
      ws.send(buildFrame("finish-task", taskId));
      timer = setT(() => fail("stt_timeout", "final result timed out"), finalTimeoutMs);
    };
    const onJson = (obj) => {
      if (done) return;
      const ev = obj.header.event;
      if (ev === "task-started") {
        ready = true;
        for (const chunk of pending.splice(0)) ws.send(chunk);
        pendingBytes = 0;
        if (finishRequested) sendFinish();
      } else if (ev === "result-generated") {
        const s = obj.payload && obj.payload.output && obj.payload.output.sentence;
        if (!s || typeof s.text !== "string") return;
        if (s.sentence_end) sentences.push(s.text);
        if (handlers.onPartial) handlers.onPartial(sentences.join("") + (s.sentence_end ? "" : s.text));
      } else if (ev === "task-finished") {
        complete();
      } else if (ev === "task-failed") {
        const auth = isAuthFailure(obj.header.error_code);
        fail(auth ? "stt_auth" : "stt_failed", String(obj.header.error_message || "task failed").slice(0, 200));
      }
    };

    ws = openSocket(options.WebSocketImpl, apiKey, {
      onOpen: () => {
        if (done) return;
        ws.send(buildFrame("run-task", taskId, {
          taskGroup: "audio", task: "asr", fn: "recognition", model,
          parameters: { format: "pcm", sample_rate: SAMPLE_RATE },
        }));
      },
      onJson,
      onBinary: () => {},
      onClose: () => fail("stt_network", "connection closed"),
      onFail: (kind) => fail(kind === "auth" ? "stt_auth" : "stt_network", "connection failed"),
    });

    return {
      writeAudio(pcm) {
        if (done || finishRequested || !pcm || !pcm.length) return;
        if (ready) return void ws.send(pcm);
        pending.push(pcm);
        pendingBytes += pcm.length;
        while (pendingBytes > MAX_BUFFER_BYTES && pending.length > 1) pendingBytes -= pending.shift().length;
      },
      finish() {
        if (done || finishRequested) return;
        finishRequested = true;
        sendFinish();
      },
      cancel() { close(); },
    };
  }

  return {
    id: "aliyun-paraformer",
    capabilities: { streaming: true, endpointing: true, sampleRate: SAMPLE_RATE, maxSegmentMs: 15000 },
    begin,
  };
}

module.exports = { createAliyunStt };

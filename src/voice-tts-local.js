"use strict";

// 本地 Kokoro（OpenAI 兼容）流式 TTS adapter：每个 begin() 是一个短句 session。
const { loopbackRequest } = require("./voice-loopback-http");

const DEFAULT_BASE_URL = "http://127.0.0.1:8880";

function createLocalTts({ baseUrl = DEFAULT_BASE_URL, voice = "zf_xiaoxiao", speed = 1.2, sampleRate = 24000 } = {}) {
  const port = Number(new URL(baseUrl).port || 80);

  function begin({ onAudio, onError, onEnd } = {}) {
    let text = "";
    let done = false;
    let started = false;
    const ac = new AbortController();
    const call = (fn, arg) => { if (typeof fn === "function") fn(arg); };
    const fail = (code, message) => {
      if (done) return;
      done = true;
      ac.abort();
      call(onError, { code, message });
    };
    const end = () => { if (!done) { done = true; call(onEnd); } };

    async function run() {
      let res;
      try {
        res = await loopbackRequest({
          url: `${baseUrl}/v1/audio/speech`, ports: [port], method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "kokoro", input: text, voice, response_format: "pcm", stream: true, speed }),
          signal: ac.signal,
        });
      } catch (e) {
        if (e.code !== "aborted") fail("tts_local_unreachable", e.code);
        return;
      }
      if (res.statusCode !== 200) { res.stream.resume(); fail("tts_local_http", `HTTP ${res.statusCode}`); return; }
      let carry = null;
      res.stream.on("data", (chunk) => {
        if (done) return;
        let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
        carry = null;
        if (buf.length % 2) { carry = Buffer.from(buf.subarray(buf.length - 1)); buf = buf.subarray(0, buf.length - 1); }
        if (buf.length) call(onAudio, { pcm: Buffer.from(buf), sampleRate, channels: 1 });
      });
      res.stream.on("end", end);
      res.stream.on("error", () => fail("tts_local_unreachable", "stream error"));
      res.stream.on("aborted", () => fail("tts_local_unreachable", "stream aborted"));
    }

    return {
      writeText(t) { if (!done && !started && typeof t === "string") text += t; },
      finish() {
        if (done || started) return;
        started = true;
        if (!text.trim()) { end(); return; }
        run();
      },
      cancel() { done = true; ac.abort(); },
    };
  }

  return {
    id: "local-kokoro",
    capabilities: { streaming: true, sampleRate, channels: 1, format: "s16le" },
    begin,
  };
}

module.exports = { createLocalTts };

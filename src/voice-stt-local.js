"use strict";

// 本地 whisper.cpp（OpenAI 兼容）分段识别 adapter：非流式，finish() 时一次性上传 WAV。
const crypto = require("crypto");
const { loopbackRequest } = require("./voice-loopback-http");

const SAMPLE_RATE = 16000;
const DEFAULT_BASE_URL = "http://127.0.0.1:2022";

function wavHeader(dataLen) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + dataLen, 4);
  h.write("WAVEfmt ", 8, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(dataLen, 40);
  return h;
}

function buildMultipart(pcm, language) {
  const boundary = `----clawd${crypto.randomBytes(8).toString("hex")}`;
  const field = (name, value) => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const fileHead = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
    "Content-Type: audio/wav\r\n\r\n");
  const body = Buffer.concat([
    field("model", "whisper-1"), field("language", language), field("response_format", "json"),
    fileHead, wavHeader(pcm.length), pcm, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function readJsonText(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return typeof parsed.text === "string" ? parsed.text.trim() : "";
}

function createLocalStt({
  baseUrl = DEFAULT_BASE_URL, language = "zh", timeoutMs = 15000, maxSegmentMs = 15000,
} = {}) {
  const maxBytes = Math.floor((SAMPLE_RATE * maxSegmentMs) / 1000) * 2;
  const port = Number(new URL(baseUrl).port || 80);

  function begin({ onFinal, onError, onWarning } = {}) {
    let chunks = [];
    let bytes = 0;
    let truncated = false;
    let done = false;
    let finishing = false;
    const ac = new AbortController();
    const emit = (fn, arg) => { if (!done && typeof fn === "function") { done = true; fn(arg); } };
    const fail = (code, message) => emit(onError, { code, message });

    async function run() {
      const pcm = Buffer.concat(chunks);
      chunks = [];
      const { body, contentType } = buildMultipart(pcm, language);
      try {
        const res = await loopbackRequest({
          url: `${baseUrl}/v1/audio/transcriptions`, ports: [port], method: "POST",
          headers: { "content-type": contentType, "content-length": body.length },
          body, signal: ac.signal, timeoutMs,
        });
        if (res.statusCode !== 200) { res.stream.resume(); fail("stt_local_http", `HTTP ${res.statusCode}`); return; }
        emit(onFinal, await readJsonText(res.stream));
      } catch (e) {
        if (done || e.code === "aborted") return;
        if (e.code === "timeout") fail("stt_timeout", "timeout");
        else if (e.code === "unreachable") fail("stt_local_unreachable", "unreachable");
        else fail("stt_local_http", e.code || "bad response");
      }
    }

    return {
      writeAudio(pcm) {
        if (done || finishing || !pcm || !pcm.length) return;
        const buf = Buffer.from(pcm.buffer ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) : pcm);
        const room = maxBytes - bytes;
        if (buf.length > room) {
          if (!truncated && typeof onWarning === "function") onWarning({ code: "segment_truncated" });
          truncated = true;
        }
        const keep = Math.max(0, Math.min(room, buf.length)) & ~1;
        if (keep > 0) { chunks.push(buf.subarray(0, keep)); bytes += keep; }
      },
      finish() {
        if (done || finishing) return;
        finishing = true;
        // 整体超时：响应头之后 body 卡住也要能收口。
        const t = setTimeout(() => { ac.abort(); fail("stt_timeout", "timeout"); }, timeoutMs + 50);
        t.unref && t.unref();
        run().finally(() => clearTimeout(t));
      },
      cancel() { done = true; chunks = []; ac.abort(); },
    };
  }

  return {
    id: "local-whisper",
    capabilities: { streaming: false, endpointing: false, sampleRate: SAMPLE_RATE, maxSegmentMs },
    begin,
  };
}

module.exports = { createLocalStt };

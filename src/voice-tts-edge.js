"use strict";

// Microsoft Edge online neural TTS (the "read aloud" WebSocket service, free,
// no key). One begin() = one synthesis request = one short sentence, multiplexed over a
// shared pre-warmed socket (voice-edge-conn.js).
// The service only answers audio-24khz-48kbitrate-mono-mp3 (raw/riff PCM is
// closed without audio, measured), so MP3 frames are decoded to s16le PCM in the
// main process with mpg123-decoder (WASM) before reaching the PCM sink.
// Since 2024 the endpoint requires a Sec-MS-GEC token (see buildSecMsGec).
// The reply text is sent to Microsoft; never log text.
const crypto = require("node:crypto");
const { createEdgeConnection } = require("./voice-edge-conn");

const TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_VERSION = "143.0.3650.96";
const URL_BASE = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const WIN_EPOCH_SECONDS = 11644473600;
const VOICE_RE = /^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9]+Neural$/;

const newId = () => crypto.randomUUID().replace(/-/g, "");

function buildSecMsGec(nowMs = Date.now()) {
  let secs = Math.floor(nowMs / 1000) + WIN_EPOCH_SECONDS;
  secs -= secs % 300;
  return crypto.createHash("sha256").update(`${secs * 1e7}${TRUSTED_TOKEN}`).digest("hex").toUpperCase();
}

function speedToRate(speed) {
  const pct = Math.round((Number(speed) - 1) * 100);
  return `${pct < 0 ? "-" : "+"}${Math.abs(pct)}%`;
}

const xmlEscape = (s) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

function defaultCreateDecoder() {
  const { MPEGDecoder } = require("mpg123-decoder");
  const d = new MPEGDecoder();
  return { ready: d.ready, decode: (chunk) => d.decode(chunk), free: () => d.free() };
}

function toPcm16(float32) {
  const out = Buffer.allocUnsafe(float32.length * 2);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2);
  }
  return out;
}

function createEdgeTts(options = {}) {
  const voice = options.voice || "zh-CN-XiaoxiaoNeural";
  if (!VOICE_RE.test(voice)) throw new Error("invalid edge voice name");
  const speed = options.speed || 1.2;
  const sampleRate = 24000;
  const now = options.now || Date.now;
  const setT = options.setTimeout || setTimeout;
  const clearT = options.clearTimeout || clearTimeout;
  const createDecoder = options.createDecoder || defaultCreateDecoder;
  const lang = voice.split("-").slice(0, 2).join("-");

  const conn = createEdgeConnection({
    openSocket: () => {
      const WS = options.WebSocketImpl || require("ws");
      return new WS(`${URL_BASE}?TrustedClientToken=${TRUSTED_TOKEN}&Sec-MS-GEC=${buildSecMsGec(now())}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}&ConnectionId=${newId()}`, {
        headers: {
          Pragma: "no-cache",
          "Cache-Control": "no-cache",
          Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
          "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_VERSION.split(".")[0]}.0.0.0 Safari/537.36 Edg/${CHROMIUM_VERSION.split(".")[0]}.0.0.0`,
        },
        ...(options.agent ? { agent: options.agent } : {}),
      });
    },
    configFrame: () => `X-Timestamp:${new Date(now()).toUTCString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
      + `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`,
    now, setTimeout: setT, clearTimeout: clearT, log: options.log, idleMs: options.idleMs,
  });

  function ssmlFrame(id, text) {
    return `X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${new Date(now()).toUTCString()}Z\r\nPath:ssml\r\n\r\n`
      + `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>`
      + `<voice name='${voice}'><prosody pitch='+0Hz' rate='${speedToRate(speed)}' volume='+0%'>${xmlEscape(text)}</prosody></voice></speak>`;
  }

  function begin(handlers = {}) {
    let text = "";
    let done = false;
    let finished = false;
    let decoder = null;
    let req = null;
    let chain = Promise.resolve();
    const call = (fn, arg) => { if (typeof fn === "function") fn(arg); };
    const release = () => {
      done = true;
      if (req) req.cancel();
      const d = decoder;
      decoder = null;
      if (d) chain = chain.then(() => { try { d.free(); } catch { /* best effort */ } });
    };
    const fail = (code, message) => {
      if (done) return;
      release();
      call(handlers.onError, { code, message });
    };
    const queue = (task) => {
      chain = chain.then(() => { if (!done) return task(); }).catch((e) => fail("tts_edge_decode", String((e && e.message) || e).slice(0, 200)));
    };

    function onAudioBody(body) {
      const d = decoder;
      queue(async () => {
        await d.ready;
        const r = d.decode(new Uint8Array(body));
        if (done || !r.samplesDecoded) return;
        handlers.onAudio && handlers.onAudio({ pcm: toPcm16(r.channelData[0].subarray(0, r.samplesDecoded)), sampleRate: r.sampleRate || sampleRate, channels: 1 });
      });
    }

    return {
      writeText(t) { if (!done && !finished && typeof t === "string") text += t; },
      finish() {
        if (done || finished) return;
        finished = true;
        if (!text.trim()) { done = true; call(handlers.onEnd); return; }
        decoder = createDecoder();
        const id = newId();
        req = conn.submit(id, ssmlFrame(id, text), {
          onAudio: (b) => { if (!done) onAudioBody(b); },
          onEnd: () => { if (!done) queue(() => { release(); call(handlers.onEnd); }); },
          onError: fail,
        });
      },
      cancel() { if (!done) release(); },
    };
  }

  return {
    id: `edge-${voice}`,
    capabilities: { streaming: true, sampleRate, channels: 1, format: "s16le" },
    begin,
    warm: () => conn.warm(),
    dispose: () => conn.dispose(),
  };
}

module.exports = { createEdgeTts, buildSecMsGec, speedToRate };

#!/usr/bin/env node
"use strict";

// Manual benchmark for the local streaming voice stack (real models, real-time
// pacing). Feeds a 16 kHz mono wav in 20 ms chunks through Silero VAD and the
// sherpa-onnx streaming recognizer, exactly like the voice runtime does.
//   node scripts/manual/voice-sherpa-bench.js <file.wav> [--expect "你好，今天天气怎么样"]
// Works under plain Node and `ELECTRON_RUN_AS_NODE=1 <Electron binary>`.
const fs = require("fs");
const models = require("../../src/voice-models");
const { createSherpaStack } = require("../../src/voice-sherpa-native");

const CHUNK = 320; // 20 ms @ 16 kHz
const pct = (arr, p) => [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [file] = process.argv.slice(2);
  const expect = process.argv.includes("--expect") ? process.argv[process.argv.indexOf("--expect") + 1] : null;
  const wav = fs.readFileSync(file);
  const speech = new Int16Array(wav.buffer.slice(wav.byteOffset + wav.indexOf("data") + 8, wav.byteOffset + wav.length));
  const pcm = new Int16Array(speech.length + 16000 * 1.1); // 300 ms lead-in below + 800 ms tail of silence
  pcm.set(speech, 4800);
  const { stt, vad } = createSherpaStack({ modelsDir: models.getModelsDir(models.defaultUserDataDir()) });

  const vadMs = []; const writeMs = [];
  let t0 = 0; let session = null; let startAt = 0; let firstPartial = null; let lastVoicedAt = 0; let finalAt = null;
  const out = { partials: [], final: null };
  const nowMs = () => Number(process.hrtime.bigint() - t0) / 1e6;
  t0 = process.hrtime.bigint();
  for (let i = 0; i + CHUNK <= pcm.length; i += CHUNK) {
    const chunk = pcm.subarray(i, i + CHUNK);
    const a = process.hrtime.bigint();
    const events = vad.processChunk(chunk);
    vadMs.push(Number(process.hrtime.bigint() - a) / 1e6);
    if (events.some((e) => e.type === "frame" && e.voiced)) lastVoicedAt = nowMs();
    for (const ev of events) {
      const w = (buf) => { const b = process.hrtime.bigint(); session.writeAudio(buf); writeMs.push(Number(process.hrtime.bigint() - b) / 1e6); };
      if (ev.type === "speech-start") {
        startAt = nowMs();
        session = stt.begin({
          onPartial: (t) => { if (firstPartial === null) firstPartial = nowMs(); out.partials.push([Math.round(nowMs()), t]); },
          onFinal: (t) => { finalAt = nowMs(); out.final = t; },
        });
        w(ev.preRoll);
      } else if (ev.type === "audio" && session) w(ev.pcm);
      else if (ev.type === "speech-end" && session) session.finish();
    }
    await sleep(20 - ((nowMs() % 20))); // real-time pacing
  }
  const rate = (arr) => `mean ${(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3)} p95 ${pct(arr, 0.95).toFixed(3)} max ${Math.max(...arr).toFixed(3)} ms (n=${arr.length})`;
  console.log(`vad speech-start at ${startAt.toFixed(0)} ms (audio onset 300 ms)`);
  console.log(`first partial ${(firstPartial - startAt).toFixed(0)} ms after speech-start`);
  console.log(`last partial text: ${out.partials.length ? out.partials[out.partials.length - 1][1] : "(none)"}`);
  console.log(`final: ${out.final}`);
  console.log(`final ${(finalAt - lastVoicedAt).toFixed(0)} ms after last voiced frame (incl. VAD end-silence)`);
  console.log(`vad per 20 ms chunk: ${rate(vadMs)}`);
  console.log(`stt writeAudio (decode) per chunk: ${rate(writeMs)}`);
  if (expect) console.log(`match expected: ${out.final === expect} (${JSON.stringify(expect)})`);
}

main().catch((e) => { console.error(e); process.exit(1); });

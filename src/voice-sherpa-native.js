"use strict";

// Thin wrappers around sherpa-onnx-node (N-API prebuilt, loads in Electron's
// main process and in ELECTRON_RUN_AS_NODE). Kept free of logic so the tested
// layers (voice-stt-sherpa, voice-vad-silero) can be driven by fakes.
const { resolveModelPaths } = require("./voice-models");
const { createSherpaStt } = require("./voice-stt-sherpa");
const { createSileroVad } = require("./voice-vad-silero");

const SAMPLE_RATE = 16000;
const STRONG_THRESHOLD = 0.8; // ducking while we speak: leaked echo rarely scores this high

function loadSherpa(requireFn = require) {
  return requireFn("sherpa-onnx-node");
}

function createSherpaEngine({ sherpa, paths, numThreads = 2 }) {
  const recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: paths.encoder, decoder: paths.decoder, joiner: paths.joiner },
      tokens: paths.tokens,
      numThreads,
      provider: "cpu",
      debug: 0,
    },
    decodingMethod: "greedy_search",
    enableEndpoint: 0, // end of utterance comes from Silero VAD, not the recognizer
  });
  return {
    createStream: () => recognizer.createStream(),
    accept: (s, f32) => s.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: f32 }),
    ready: (s) => recognizer.isReady(s),
    decode: (s) => recognizer.decode(s),
    text: (s) => recognizer.getResult(s).text,
    finish: (s) => s.inputFinished(),
    release: () => {}, // stream handles are freed by the addon's GC finalizer
  };
}

// Silero via sherpa's Vad. isDetected() is true from the first window above
// `threshold` until `minSilenceDuration` of silence, which is the per-frame
// "voiced" signal the state machine in voice-vad-silero builds on.
function createSileroDetector({ sherpa, paths, threshold = 0.5, strongThreshold = STRONG_THRESHOLD, minSilenceDuration = 0.1 }) {
  const make = (th) => new sherpa.Vad({
    sileroVad: { model: paths.vad, threshold: th, minSilenceDuration, minSpeechDuration: 0.05, windowSize: 512, maxSpeechDuration: 30 },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: "cpu",
    debug: 0,
  }, 30);
  const vad = make(threshold);
  const strict = make(strongThreshold);
  const feed = (v, f32) => {
    v.acceptWaveform(f32);
    while (!v.isEmpty()) v.pop(); // we only need the live flag; drop finished segments
    return v.isDetected();
  };
  let strong = false;
  return {
    accept(f32) {
      strong = !!feed(strict, f32);
      return feed(vad, f32);
    },
    isStrong: () => strong,
    reset() { vad.reset(); strict.reset(); strong = false; },
  };
}

// STT adapter + Silero VAD wired to the real native module. Throws if the
// addon or a model file cannot be loaded (callers fall back to whisper).
function createSherpaStack({ modelsDir, log = () => {}, sherpa = loadSherpa(), endSilenceMs }) {
  const paths = resolveModelPaths(modelsDir);
  return {
    stt: createSherpaStt({ engine: createSherpaEngine({ sherpa, paths }), log }),
    vad: createSileroVad({ detector: createSileroDetector({ sherpa, paths }), endSilenceMs }),
  };
}

module.exports = { createSherpaStack, loadSherpa, createSherpaEngine, createSileroDetector, STRONG_THRESHOLD, SAMPLE_RATE };

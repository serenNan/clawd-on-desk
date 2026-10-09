(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (root) root.ClawdVoiceRenderer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  // Renderer-side call controller: keeps the mic track + capture AudioContext
  // alive for the whole call (also while the assistant speaks), runs VAD and
  // the two-stage barge-in locally, and plays PCM from main. Network, keys and
  // providers never reach this file; everything goes through `api`.
  const TARGET_RATE = 16000;
  const FRAME_MS = 20;
  const VOICE_GAP_MS = 60;
  const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };
  const dep = (name, path) => (typeof module !== "undefined" && module.exports ? require(path) : root[name]);

  function createVoiceRenderer(options) {
    const { api, getUserMedia, createContext, createWorkletNode, workletUrl } = options;
    const vadMod = options.vad || dep("ClawdVoiceVad", "./voice-vad");
    const bargeMod = options.barge || dep("ClawdVoiceBargeIn", "./voice-barge-in");
    const audioMod = options.audio || dep("ClawdVoiceAudio", "./voice-audio-renderer");
    const now = options.now || Date.now;
    const setT = options.setTimeout || setTimeout;
    const clearT = options.clearTimeout || clearTimeout;
    const onNotice = options.onNotice || (() => {});
    const onLevel = options.onLevel || (() => {});

    let running = false;
    let stream = null;
    let ctx = null;
    let node = null;
    let source = null;
    let paused = false;
    let micOp = Promise.resolve();
    let sink = null;
    let vad = null;
    let resampler = null;
    let barge = null;
    let lastStop = null;
    let epoch = 0;
    let muted = false;
    let bargeVoicing = false;
    let gapMs = 0;
    let speechStartAt = 0;
    let remoteVad = false; // main-process Silero VAD owns segmentation
    let remoteSpeaking = false;
    let lastSentenceId = null;
    // Debug events go to main (voice-debug.log); only names/durations, never content.
    const dlog = (event, f) => { try { if (api.debugLog) api.debugLog({ event, ...f }); } catch { /* ignore */ } };
    const errInfo = (e) => ({ name: e && e.name, message: String((e && e.message) || e || "").slice(0, 200), stack: e && e.stack ? String(e.stack).split("\n").slice(0, 4).join("\n") : "" });

    const sinkProxy = {
      duck: (db) => { dlog("barge_duck", { db }); return sink && sink.duck(db); },
      restore: () => { dlog("barge_restore"); return sink && sink.restore(); },
      stop: () => { if (sink) lastStop = sink.stop(); return lastStop; },
    };

    function sendPcm(float32) {
      const pcm = resampler.process(float32);
      if (pcm.length) api.audio(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    }

    // The VAD keeps a segment open through its end-silence tail, but barge-in
    // must see *continuous voiced* time, so track short voiced gaps here.
    function trackVoicing(voiced) {
      if (voiced) {
        gapMs = 0;
        if (!bargeVoicing) { bargeVoicing = true; barge.onSpeechStart(); }
      } else if (bargeVoicing) {
        gapMs += FRAME_MS;
        if (gapMs >= VOICE_GAP_MS) { bargeVoicing = false; barge.onSpeechEnd(); }
      }
    }

    function onVadEvent(ev) {
      if (ev.type === "level") {
        onLevel("mic", ev.rms);
        if (vad.isSpeaking()) trackVoicing(ev.voiced);
      } else if (ev.type === "speech-start") {
        resampler.reset();
        speechStartAt = now();
        dlog("vad_speech_start");
        api.speechStart();
        sendPcm(ev.preRoll);
        trackVoicing(true);
      } else if (ev.type === "speech-end") {
        dlog("vad_speech_end", { reason: ev.reason, ms: now() - speechStartAt });
        api.speechEnd({ reason: ev.reason });
        bargeVoicing = false;
        barge.onSpeechEnd();
      }
    }

    function rmsOf(frame) {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      return frame.length ? Math.sqrt(sum / frame.length) : 0;
    }

    function onFrame(frame) {
      if (!running) return;
      barge.setAssistantActive(!!sink && sink.isActive());
      if (remoteVad) { onLevel("mic", rmsOf(frame)); sendPcm(frame); return; }
      const wasSpeaking = vad.isSpeaking();
      const events = vad.processFrame(frame);
      const started = events.some((e) => e.type === "speech-start");
      for (const ev of events) {
        if (ev.type === "speech-end" && wasSpeaking && !started) sendPcm(frame);
        onVadEvent(ev);
      }
      if (wasSpeaking && !events.some((e) => e.type === "speech-end") && !started) sendPcm(frame);
    }

    function release() {
      running = false;
      if (barge) barge.dispose();
      if (node) { try { node.port.onmessage = null; node.disconnect(); } catch { /* ignore */ } }
      if (source) { try { source.disconnect(); } catch { /* ignore */ } }
      if (stream) for (const t of stream.getTracks()) t.stop();
      if (sink) sink.dispose();
      const c = ctx;
      stream = ctx = node = sink = source = null;
      paused = false;
      return c && c.close ? c.close().catch(() => {}) : Promise.resolve();
    }

    async function start(info) {
      if (running) return;
      running = true;
      epoch = 0;
      remoteVad = !!(info && info.vad === "main");
      remoteSpeaking = false;
      dlog("renderer_start");
      try {
        stream = await getUserMedia(MIC_CONSTRAINTS);
        ctx = createContext();
        const track = stream.getAudioTracks()[0];
        const settings = (track && track.getSettings && track.getSettings()) || {};
        dlog("mic_ok", { aec: settings.echoCancellation, ns: settings.noiseSuppression, ctxRate: ctx.sampleRate });
        if (settings.echoCancellation === false) onNotice("aec-unavailable");
        await ctx.audioWorklet.addModule(workletUrl);
        vad = remoteVad ? null : vadMod.createVad({ sampleRate: ctx.sampleRate, frameMs: 20 });
        resampler = vadMod.createResampler(ctx.sampleRate, TARGET_RATE);
        sink = options.createSink
          ? options.createSink(ctx, sinkHandlers())
          : audioMod.createAudioSink({ context: ctx, ...sinkHandlers() });
        barge = bargeMod.createBargeIn({
          sink: sinkProxy, now, setTimeout: setT, clearTimeout: clearT,
          partialOnly: !!remoteVad, // sherpa streams partials: only real words interrupt
          onCommit: (reason) => { dlog("barge_commit", { reason }); api.bargeCommit({ playingSentenceId: lastStop ? lastStop.playingSentenceId : null }); },
        });
        node = createWorkletNode(ctx);
        node.port.onmessage = (e) => {
          try { onFrame(e.data); } catch (err) { dlog("renderer_exception", { where: "onFrame", ...errInfo(err) }); }
        };
        source = ctx.createMediaStreamSource(stream);
        source.connect(node);
      } catch (err) {
        const code = err && (err.name === "NotAllowedError" || err.name === "SecurityError") ? "mic_denied" : "mic_failed";
        dlog("mic_error", { code, ...errInfo(err) });
        await release();
        api.rendererError({ code });
      }
    }

    function releaseMic() {
      if (source) { try { source.disconnect(); } catch { /* ignore */ } source = null; }
      if (stream) for (const t of stream.getTracks()) t.stop();
      stream = null;
      remoteSpeaking = false; bargeVoicing = false; gapMs = 0;
      if (barge) barge.reset();
      if (resampler) resampler.reset();
    }

    async function setMicPaused(next) {
      if (!running || next === paused) return;
      paused = next;
      if (next) { releaseMic(); dlog("mic_released"); return; }
      try {
        const s = await getUserMedia(MIC_CONSTRAINTS);
        if (!running || paused) { for (const t of s.getTracks()) t.stop(); return; }
        stream = s;
        source = ctx.createMediaStreamSource(s);
        source.connect(node);
        dlog("mic_reacquired");
      } catch (err) {
        const code = err && (err.name === "NotAllowedError" || err.name === "SecurityError") ? "mic_denied" : "mic_failed";
        dlog("mic_error", { code, ...errInfo(err) });
        api.rendererError({ code });
      }
    }

    function sinkHandlers() {
      return {
        onAck: (a) => { dlog("playback_ack", { epoch: a && a.epoch, sentenceId: a && a.sentenceId }); api.ack(a); },
        onBuffered: (ms) => api.buffered(ms),
        onLevel: (v) => onLevel("speaker", v),
      };
    }

    return {
      start,
      async stop() { if (running || stream || ctx) await release(); },
      handleTtsPcm(chunk) {
        if (!running || !sink) return;
        if (chunk.sentenceId !== lastSentenceId) { lastSentenceId = chunk.sentenceId; dlog("playback_start", { epoch: chunk.epoch, sentenceId: chunk.sentenceId }); }
        if (chunk.epoch > epoch) { epoch = chunk.epoch; sink.setEpoch(epoch); }
        sink.enqueue(chunk);
      },
      handleTtsEnd(info) { if (running && sink) sink.endSentence(info); },
      handleStopPlayback({ epoch: e } = {}) {
        if (!running || !sink) return;
        lastStop = sink.stop();
        dlog("playback_stop", { epoch: e });
        epoch = Math.max(epoch, Number.isSafeInteger(e) ? e : epoch);
        sink.setEpoch(epoch);
        if (barge) barge.reset();
      },
      // Events from the main-process VAD: speech-start ducks (via barge-in), frames
      // keep the continuous-voice clock, speech-end lets barge-in restore/decide.
      handleVad(ev) {
        if (!running || !remoteVad || !barge || !ev) return;
        if (ev.type === "speech-start") {
          remoteSpeaking = true; speechStartAt = now(); gapMs = 0;
          barge.setAssistantActive(!!sink && sink.isActive());
          dlog("vad_speech_start", { remote: true });
          // While we speak only strict-threshold frames count (leaked echo scores low).
          if (!(sink && sink.isActive())) trackVoicing(true);
        } else if (ev.type === "frame" && remoteSpeaking) {
          trackVoicing(sink && sink.isActive() ? !!(ev.strong ?? ev.voiced) : !!ev.voiced);
        } else if (ev.type === "speech-end") {
          remoteSpeaking = false;
          dlog("vad_speech_end", { reason: ev.reason, ms: now() - speechStartAt, remote: true });
          bargeVoicing = false;
          barge.onSpeechEnd();
        }
      },
      handlePartial({ text } = {}) { if (running && barge) barge.onPartial(text); },
      handleMuted({ muted: m } = {}) { muted = !!m; if (sink) sink.setMuted(muted); },
      // Pause really closes the mic (macOS orange dot off); the call, context and sink stay up.
      handlePaused({ paused: p } = {}) {
        micOp = micOp.then(() => setMicPaused(!!p)).catch(() => {});
        return micOp;
      },
      isRunning: () => running,
    };
  }

  return { createVoiceRenderer };
});

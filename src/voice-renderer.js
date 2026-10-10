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
  const MAX_HEAL = 3;
  const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };
  const dep = (name, path) => (typeof module !== "undefined" && module.exports ? require(path) : root[name]);

  function createVoiceRenderer(options) {
    const { api, getUserMedia, createContext, createWorkletNode, workletUrl } = options;
    const vadMod = options.vad || dep("ClawdVoiceVad", "./voice-vad");
    const bargeMod = options.barge || dep("ClawdVoiceBargeIn", "./voice-barge-in");
    const audioMod = options.audio || dep("ClawdVoiceAudio", "./voice-audio-renderer");
    const deviceMod = options.micDevice || dep("ClawdVoiceMicDevice", "./voice-mic-device");
    const now = options.now || Date.now;
    const setT = options.setTimeout || setTimeout;
    const clearT = options.clearTimeout || clearTimeout;
    const onNotice = options.onNotice || (() => {});
    const onLevel = options.onLevel || (() => {});

    let running = false; let stream = null; let ctx = null; let node = null; let source = null;
    let paused = false; let micOp = Promise.resolve(); let sink = null;
    let vad = null; let resampler = null; let barge = null;
    let lastStop = null; let epoch = 0;
    let muted = false; let bargeVoicing = false;
    let gapMs = 0; let speechStartAt = 0; let healCount = 0; let lastHealAt = -Infinity; // heal restarts this call (track_ended capped at MAX_HEAL)
    let remoteVad = false; let remoteSpeaking = false; // main-process Silero VAD owns segmentation
    let helperCap = false; // the bundled helper records the mic: no getUserMedia here
    const deadMics = new Set(); let micLabel = ""; // labels of inputs that went silent this call
    const seenSentences = new Set(); // playback_start is logged once per sentence (chunks of 2 sentences interleave)
    // Debug events go to main (voice-debug.log); only names/durations, never content.
    const dlog = (event, f) => { try { if (api.debugLog) api.debugLog({ event, ...f }); } catch { /* ignore */ } };
    const { errInfo, micErrorCode } = deviceMod;
    const opener = deviceMod.createMicOpener({ getUserMedia, enumerateDevices: options.enumerateDevices, dlog, base: MIC_CONSTRAINTS });
    const setPref = (i) => opener.setPreferred({ id: i && i.micDeviceId, label: i && i.micLabel });
    // Following the system default: a new default input (AirPods connected mid-call) rebuilds capture.
    const follow = deviceMod.createMicFollow({
      enumerateDevices: options.enumerateDevices, getLabel: () => micLabel, dlog, setTimeout: setT, clearTimeout: clearT,
      isActive: () => running && !paused && !helperCap && !opener.isPinned(), isDead: (l) => deadMics.has(l),
      onSwitch: () => queueRestart({ reason: "follow" }), publish: () => { if (running) opener.publish(api.micDevices); },
    });

    const micError = (err) => { const code = micErrorCode(err); dlog("mic_error", { code, ...errInfo(err) }); return code; };
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
      if (paused) return; // muted: the mic is open only for the wake phrase, never for barge-in
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

    const rmsOf = (f) => (f.length ? Math.sqrt(f.reduce((a, x) => a + x * x, 0) / f.length) : 0);

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

    const watchTrack = (t) => { micLabel = deviceMod.watchTrack(t, dlog, onTrackEnded) || micLabel; };
    const queueRestart = (info) => { micOp = micOp.then(() => restartMic(info)).catch(() => {}); return micOp; };
    // OS killed the track: rebuild now, don't wait for main's 3s zero-PCM check.
    function onTrackEnded(t) {
      if (!running || !stream || stream.getAudioTracks()[0] !== t || healCount >= MAX_HEAL) return;
      queueRestart({ reason: "track_ended" });
    }

    function makeNode() {
      node = createWorkletNode(ctx);
      node.port.onmessage = (e) => {
        try { onFrame(e.data); } catch (err) { dlog("renderer_exception", { where: "onFrame", ...errInfo(err) }); }
      };
    }

    function attachMic(s) {
      stream = s;
      watchTrack(s.getAudioTracks()[0]);
      source = ctx.createMediaStreamSource(s);
      source.connect(node);
    }

    function release() {
      running = false;
      if (barge) barge.dispose();
      dropNode();
      if (source) { try { source.disconnect(); } catch { /* ignore */ } }
      if (stream) for (const t of stream.getTracks()) t.stop();
      if (sink) sink.dispose();
      const c = ctx;
      stream = ctx = node = sink = source = null;
      paused = false;
      return c && c.close ? c.close().catch(() => {}) : Promise.resolve();
    }

    // getUserMedia + worklet: only when this renderer (not the helper) records.
    async function openCapture() {
      stream = await opener.open(1);
      const track = stream.getAudioTracks()[0];
      watchTrack(track);
      const settings = (track && track.getSettings && track.getSettings()) || {};
      dlog("mic_ok", { aec: settings.echoCancellation, ns: settings.noiseSuppression, ctxRate: ctx.sampleRate, label: micLabel });
      if (settings.echoCancellation === false) onNotice("aec-unavailable");
      opener.publish(api.micDevices); // names for the settings picker
      makeNode();
      source = ctx.createMediaStreamSource(stream);
      source.connect(node);
    }

    async function start(info) {
      if (running) return;
      running = true;
      epoch = 0;
      seenSentences.clear(); deadMics.clear(); healCount = 0; setPref(info);
      remoteVad = !!(info && info.vad === "main");
      helperCap = remoteVad && !!info && info.capture === "helper";
      remoteSpeaking = false;
      dlog("renderer_start", { capture: helperCap ? "helper" : "renderer" });
      try {
        ctx = createContext();
        ctx.onstatechange = () => {
          dlog("ctx_state", { state: ctx && ctx.state });
          if (running && ctx && (ctx.state === "suspended" || ctx.state === "interrupted") && ctx.resume) ctx.resume().catch(() => {});
        };
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
        if (!helperCap) await openCapture();
      } catch (err) {
        const code = micError(err);
        await release();
        api.rendererError({ code });
      }
    }

    // Main flips the recording source mid-call (setting toggled, or the helper gave up).
    function handleCapture({ source: next } = {}) {
      const toHelper = next === "helper" && remoteVad;
      if (!running || toHelper === helperCap) return micOp;
      helperCap = toHelper; dlog("capture_switch", { capture: next });
      micOp = micOp.then(async () => {
        if (toHelper) { releaseMic(); dropNode(); return; }
        try { await openCapture(); } catch (err) { api.rendererError({ code: micError(err) }); }
      }).catch(() => {});
      return micOp;
    }

    const dropNode = () => { if (node) { try { node.port.onmessage = null; node.disconnect(); } catch { /* ignore */ } } };

    function releaseMic() {
      if (source) { try { source.disconnect(); } catch { /* ignore */ } source = null; }
      if (stream) for (const t of stream.getTracks()) t.stop();
      stream = null;
      remoteSpeaking = false; bargeVoicing = false; gapMs = 0;
      if (barge) barge.reset();
      if (resampler) resampler.reset();
    }

    // Rebuild the capture chain from a fresh getUserMedia: main saw zero PCM, the
    // track ended, or the user picked another mic (reason "select": no dead-mic mark).
    async function restartMic(info = {}) {
      if (!running || helperCap) return;
      const select = info.reason === "select" || info.reason === "follow";
      if (!select && !info.reason && now() - lastHealAt < 1500) return; // main's zero check chasing a restart we just did
      if (!select) { healCount += 1; lastHealAt = now(); deadMics.add(deviceMod.normLabel(micLabel)); }
      dlog(select ? "mic_select" : "mic_restart", { attempt: select ? 1 : healCount, reason: info.reason, ctxState: ctx && ctx.state });
      releaseMic();
      dropNode();
      try {
        if (ctx.state !== "running" && ctx.resume) await ctx.resume();
        const s = await opener.open(select ? 1 : healCount, deadMics);
        if (!running) { for (const t of s.getTracks()) t.stop(); return; }
        makeNode();
        attachMic(s);
        dlog("mic_restarted", { ctxState: ctx.state, label: micLabel });
      } catch (err) {
        api.rendererError({ code: micError(err) });
      }
    }

    const sinkHandlers = () => ({
      onAck: (a) => { dlog("playback_ack", { epoch: a && a.epoch, sentenceId: a && a.sentenceId }); api.ack(a); },
      onBuffered: (ms) => api.buffered(ms), onLevel: (v) => onLevel("speaker", v),
    });

    return {
      start,
      async stop() { if (running || stream || ctx) await release(); },
      handleTtsPcm(chunk) {
        if (!running || !sink) return;
        if (!seenSentences.has(chunk.sentenceId)) { seenSentences.add(chunk.sentenceId); dlog("playback_start", { epoch: chunk.epoch, sentenceId: chunk.sentenceId }); }
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
        if (!running || paused || !remoteVad || !barge || !ev) return;
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
      handlePartial({ text } = {}) { if (running && !paused && barge) barge.onPartial(text); },
      handleMuted({ muted: m } = {}) { muted = !!m; if (sink) sink.setMuted(muted); },
      // Mute keeps the mic and capture chain running (main listens locally for the wake phrase); only barge-in is disarmed.
      handlePaused({ paused: p } = {}) {
        paused = !!p;
        if (paused) { remoteSpeaking = false; bargeVoicing = false; gapMs = 0; if (barge) barge.reset(); dlog("mute_on"); }
        else micOp = micOp.then(() => follow.recheck()).catch(() => {}); // the default input may have changed while muted
        return micOp;
      },
      handleCapture,
      handleDeviceChange: () => { if (running) follow.onDeviceChange(); },
      handleMicRestart: (info) => queueRestart(info || {}),
      handleMicSelect(info) { setPref(info); return queueRestart({ reason: "select" }); },
      isRunning: () => running,
    };
  }

  return { createVoiceRenderer };
});

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { makeHarness } = require("./fixtures/voice-main-harness");
const { cloneDefaultVoice, DASHSCOPE_KEY_ENV } = require("../src/voice-settings");

test("pause shows the paused pet state and plays end; resume goes back to listening with start", async () => {
  const h = makeHarness();
  await h.vm.shortcutToggle();
  assert.deepEqual(h.log.cues, ["start"]);
  h.vm.togglePause();
  assert.deepEqual(h.log.overlays.slice(-1), ["paused"]);
  assert.deepEqual(h.log.cues, ["start", "end"]);
  assert.ok(h.log.sent.some(([c, p]) => c === "voice:paused" && p.paused === true));
  h.vm.togglePause();
  assert.deepEqual(h.log.overlays.slice(-1), ["listening"]);
  assert.deepEqual(h.log.cues, ["start", "end", "start"]);
  h.vm.stop("user");
  assert.deepEqual(h.log.cues.slice(-1), ["end"]);
});

test("default (local) call builds only local providers plus the Claude brain", async () => {
  const h = makeHarness();
  const res = await h.vm.toggle();
  assert.equal(res.status, "ok");
  assert.deepEqual(h.log.created.filter((c) => typeof c === "string" && c !== "brain-dispose"), ["local-stt", "local-tts"]);
  assert.ok(h.log.sent.some(([c]) => c === "voice:start"));
  assert.equal(h.vm.getState().active, true);
  assert.deepEqual(h.log.overlays.slice(-1), ["listening"]);
});

test("second toggle ends the call, clears the overlay and releases the brain", async () => {
  const h = makeHarness();
  await h.vm.toggle();
  await h.vm.toggle();
  assert.equal(h.vm.getState().active, false);
  assert.equal(h.log.overlays.slice(-1)[0], null);
  assert.ok(h.log.created.includes("brain-dispose"));
  assert.ok(h.log.sent.some(([c]) => c === "voice:stop"));
});

test("disabled voice only shows a notice; nothing is created or captured", async () => {
  const h = makeHarness({ voice: { enabled: false } });
  const res = await h.vm.toggle();
  assert.equal(res.status, "error");
  assert.deepEqual(h.log.notices[0][0], "voice-disabled");
  assert.deepEqual(h.log.created, []);
  assert.equal(h.log.mediaAsks, 0);
});

test("macOS: not-determined asks once, denied never starts or loops", async () => {
  const ask = makeHarness({ mic: "not-determined" });
  await ask.vm.toggle();
  assert.equal(ask.log.mediaAsks, 1);
  assert.equal(ask.vm.getState().active, true);

  const denied = makeHarness({ mic: "denied" });
  await denied.vm.toggle();
  await denied.vm.toggle();
  assert.equal(denied.log.mediaAsks, 0);
  assert.equal(denied.vm.getState().active, false);
  assert.equal(denied.log.notices.filter(([c]) => c === "mic-denied").length, 2);

  const refused = makeHarness({ mic: "not-determined", askResult: false });
  await refused.vm.toggle();
  assert.equal(refused.vm.getState().active, false);
  assert.equal(refused.log.notices[0][0], "mic-denied");
});

test("cloud provider without key stops with a notice and never reaches the mic", async () => {
  const h = makeHarness({ voice: { stt: "aliyun-paraformer", cloudConsent: true } });
  const res = await h.vm.toggle();
  assert.equal(res.status, "error");
  assert.ok(res.reasons.includes("dashscope-key-missing"));
  assert.equal(h.log.mediaAsks, 0);
  assert.equal(h.vm.getState().active, false);
});

test("cloud provider without consent asks first; decline keeps capture off", async () => {
  const env = { [DASHSCOPE_KEY_ENV]: "k" };
  const no = makeHarness({ voice: { stt: "aliyun-paraformer" }, env, consent: false });
  await no.vm.toggle();
  assert.equal(no.vm.getState().active, false);
  assert.deepEqual(no.log.updates, []);
  assert.equal(no.log.notices[0][0], "cloud-consent-missing");

  const yes = makeHarness({ voice: { stt: "aliyun-paraformer" }, env, consent: true });
  const res = await yes.vm.toggle();
  assert.equal(res.status, "ok");
  assert.equal(yes.log.updates[0].cloudConsent, true);
  assert.ok(yes.log.created.some((c) => Array.isArray(c) && c[0] === "aliyun-stt" && c[1] === true));
});

test("local fallback providers exist only when the user enabled them for a cloud pair", async () => {
  const env = { [DASHSCOPE_KEY_ENV]: "k" };
  const on = makeHarness({ voice: { stt: "aliyun-paraformer", tts: "aliyun-cosyvoice-v3-flash", cloudConsent: true, localFallback: true }, env });
  await on.vm.toggle();
  assert.deepEqual(on.log.created.filter((c) => typeof c === "string" && c.startsWith("local")), ["local-stt", "local-tts"]);
  const off = makeHarness({ voice: { stt: "aliyun-paraformer", tts: "aliyun-cosyvoice-v3-flash", cloudConsent: true }, env });
  await off.vm.toggle();
  assert.deepEqual(off.log.created.filter((c) => typeof c === "string" && c.startsWith("local")), []);
});

test("v3.5 passes the configured voice id and model", async () => {
  const env = { [DASHSCOPE_KEY_ENV]: "k" };
  const h = makeHarness({ voice: { tts: "aliyun-cosyvoice-v3.5-flash", ttsVoiceId: "vid-1", cloudConsent: true }, env });
  await h.vm.toggle();
  const tts = h.log.created.find((c) => Array.isArray(c) && c[0] === "aliyun-tts");
  assert.deepEqual(tts, ["aliyun-tts", "cosyvoice-v3.5-flash", "longanyang", "vid-1"]);
});

test("miniTransitioning rejects start but never blocks ending", async () => {
  const h = makeHarness();
  h.setMini(true);
  const res = await h.vm.toggle();
  assert.equal(res.status, "rejected");
  assert.equal(h.log.mediaAsks, 0);
  assert.equal(h.vm.getState().active, false);
  h.setMini(false);
  await h.vm.toggle();
  h.setMini(true);
  await h.vm.toggle();
  assert.equal(h.vm.getState().active, false);
});

test("brain probe failure surfaces as a notice and leaves nothing running", async () => {
  const h = makeHarness({ probe: { ok: false, reason: "auth-conflict-env" } });
  const res = await h.vm.toggle();
  assert.equal(res.status, "error");
  assert.deepEqual(h.log.notices[0], ["auth-conflict-env", undefined]);
  assert.equal(h.vm.getState().active, false);
});

test("settings: disabling voice or switching provider while active ends the call", async () => {
  const h = makeHarness();
  await h.vm.toggle();
  h.vm.onSettingsChanged({ ...cloneDefaultVoice(), brain: "claude-code", tts: "local-kokoro", enabled: true });
  assert.equal(h.vm.getState().active, true);
  h.vm.onSettingsChanged({ ...cloneDefaultVoice(), brain: "claude-code", enabled: true, tts: "aliyun-cosyvoice-v3-flash" });
  assert.equal(h.vm.getState().active, false);
  await h.vm.toggle();
  h.vm.onSettingsChanged({ ...cloneDefaultVoice(), brain: "claude-code", enabled: false });
  assert.equal(h.vm.getState().active, false);
});

test("lifecycle events end the call idempotently", async () => {
  for (const event of ["dnd", "sleep", "hide", "quit", "pet-closed"]) {
    const h = makeHarness();
    await h.vm.toggle();
    h.vm.onLifecycle(event);
    h.vm.onLifecycle(event);
    assert.equal(h.vm.getState().active, false, event);
    assert.equal(h.log.sent.filter(([c]) => c === "voice:stop").length, 1, event);
  }
});

test("renderer notices and call errors become user-visible notices", async () => {
  const h = makeHarness();
  await h.vm.toggle();
  h.emit("voice:renderer-error", { code: "mic_denied" });
  assert.ok(h.log.notices.some(([c]) => c === "mic_denied"));
  assert.equal(h.vm.getState().active, false);
});

test("permission policy only allows the trusted window's audio during an active call", async () => {
  const h = makeHarness();
  assert.equal(h.vm.permissionPolicy.check(h.wc, "media", { mediaType: "audio" }), false);
  await h.vm.toggle();
  assert.equal(h.vm.permissionPolicy.check(h.wc, "media", { mediaType: "audio" }), true);
  assert.equal(h.vm.permissionPolicy.check(h.wc, "media", { mediaType: "video" }), false);
});

test("dispose removes IPC listeners and ends the call", async () => {
  const h = makeHarness();
  await h.vm.toggle();
  h.vm.dispose();
  assert.equal(h.log.listeners.size, 0);
  assert.equal(h.vm.getState().active, false);
});

// ---- sherpa-onnx default provider and whisper fallback ----
const startMsg = (h) => h.log.sent.find(([c]) => c === "voice:start")[1];

test("models missing: falls back to whisper with a visible notice, renderer VAD", async () => {
  const h = makeHarness({ voice: { stt: "sherpa-onnx" } });
  assert.equal((await h.vm.toggle()).status, "ok");
  assert.ok(h.log.created.includes("local-stt"));
  assert.ok(!h.log.created.includes("sherpa"));
  assert.equal(h.log.notices.filter(([c]) => c === "sherpa-model-missing").length, 1);
  assert.equal(startMsg(h).vad, "renderer");
  assert.equal(startMsg(h).stt, "local-whisper");
  assert.ok(h.log.dbg.some(([e, f]) => e === "sherpa_fallback" && f.reason === "model-missing"));
});

test("models ready: sherpa STT + main-process VAD, no whisper, no notice", async () => {
  const h = makeHarness({ voice: { stt: "sherpa-onnx" }, sherpa: "ready" });
  await h.vm.toggle();
  assert.ok(h.log.created.includes("sherpa"));
  assert.ok(!h.log.created.includes("local-stt"));
  assert.equal(startMsg(h).vad, "main");
  assert.equal(startMsg(h).stt, "sherpa-onnx");
  assert.deepEqual(h.log.notices, []);
});

test("native module fails to load: whisper fallback plus a distinct notice", async () => {
  const h = makeHarness({ voice: { stt: "sherpa-onnx" }, sherpa: "ready", sherpaThrows: true });
  assert.equal((await h.vm.toggle()).status, "ok");
  assert.ok(h.log.created.includes("local-stt"));
  assert.equal(h.log.notices.filter(([c]) => c === "sherpa-load-failed").length, 1);
  assert.ok(h.log.dbg.some(([e, f]) => e === "sherpa_fallback" && f.reason === "load-failed"));
});

test("choosing whisper explicitly never probes sherpa or warns", async () => {
  const h = makeHarness({ voice: { stt: "local-whisper" } });
  await h.vm.toggle();
  assert.deepEqual(h.log.notices, []);
  assert.equal(h.log.dbg.some(([e]) => e === "sherpa_fallback"), false);
});

test("sherpa + localFallback keeps whisper ready as the mid-call fallback STT", async () => {
  const h = makeHarness({ voice: { stt: "sherpa-onnx", localFallback: true }, sherpa: "ready" });
  await h.vm.toggle();
  assert.ok(h.log.created.includes("local-stt"));
});

test("Settings can query model readiness over a read-only invoke channel", async () => {
  const missing = makeHarness();
  assert.deepEqual(await missing.log.handlers.get("voice:models-status")(), { ready: false, missing: ["silero_vad.onnx"] });
  const ready = makeHarness({ sherpa: "ready" });
  assert.equal((await ready.log.handlers.get("voice:models-status")()).ready, true);
  ready.vm.dispose();
  assert.equal(ready.log.handlers.has("voice:models-status"), false);
});

test("sessionStart forces session brain without persisting it and builds no CLI brain", async () => {
  const h = makeHarness();
  const res = await h.vm.sessionStart();
  assert.equal(res.status, "ok");
  assert.equal(h.vm.getState().sessionMode, true);
  assert.equal(h.log.created.some((c) => Array.isArray(c) && c[0] === "brain"), false);
  assert.deepEqual(h.log.updates, [], "settings are not rewritten");
  assert.ok(h.log.dbg.some(([e, f]) => e === "session_api_start" && f.status === "ok" && typeof f.ms === "number"));
});

test("sessionStart on a running claude-code call switches to session mode; stop clears the override", async () => {
  const h = makeHarness();
  await h.vm.toggle();
  assert.equal(h.vm.getState().sessionMode, false);
  const started = await h.vm.sessionStart();
  assert.equal(started.status, "ok");
  assert.equal(h.vm.getState().sessionMode, true);
  assert.deepEqual(await h.vm.sessionStop({ owner: started.owner }), { status: "ok" });
  assert.equal(h.vm.getState().active, false);
  assert.equal((await h.vm.toggle()).status, "ok");
  assert.equal(h.vm.getState().sessionMode, false, "override gone; real setting (claude-code) applies");
});

test("sessionStart reports voice-disabled and does not leave an override behind", async () => {
  const h = makeHarness({ voice: { enabled: false } });
  const res = await h.vm.sessionStart();
  assert.deepEqual(res.reasons, ["voice-disabled"]);
  h.setVoice({ enabled: true });
  await h.vm.toggle();
  assert.equal(h.vm.getState().sessionMode, false);
});

test("converse requires an active session-mode call", async () => {
  const h = makeHarness();
  assert.deepEqual(await h.vm.converse({ text: "x" }), { error: "not-in-session" });
  await h.vm.toggle();
  assert.deepEqual(await h.vm.converse({ text: "x" }), { error: "not-in-session" });
  const { owner } = await h.vm.sessionStart();
  const p = h.vm.converse({ owner });
  await h.vm.sessionStop({ owner });
  assert.equal((await p).ended, true);
});

test("user-configured session brain does not let toggle open a call by itself", async () => {
  const h = makeHarness({ voice: { brain: "session" } });
  assert.equal((await h.vm.toggle()).status, "needs-session");
  assert.equal(h.vm.getState().active, false);
});
// ---- Edge TTS (default), fallback, end-silence, pause ----

test("edge TTS passes voice and speed, needs consent but no DashScope key", async () => {
  const h = makeHarness({ voice: { tts: "edge", edgeVoice: "zh-CN-YunjianNeural", ttsSpeed: 1.3, cloudConsent: true } });
  assert.equal((await h.vm.toggle()).status, "ok");
  assert.deepEqual(h.log.created.find((c) => Array.isArray(c) && c[0] === "edge-tts"), ["edge-tts", "zh-CN-YunjianNeural", 1.3]);
  const no = makeHarness({ voice: { tts: "edge" }, consent: false });
  await no.vm.toggle();
  assert.equal(no.vm.getState().active, false);
  assert.equal(no.log.notices[0][0], "cloud-consent-missing");
});

test("edge TTS always has local Kokoro as fallback, even with localFallback off", async () => {
  const h = makeHarness({ voice: { tts: "edge", cloudConsent: true, localFallback: false } });
  await h.vm.toggle();
  assert.ok(h.log.created.includes("local-tts"), "fallback Kokoro adapter built");
});

test("voice.endSilenceMs is handed to the sherpa VAD", async () => {
  const h = makeHarness({ voice: { endSilenceMs: 1100 }, sherpa: "ready" });
  await h.vm.toggle();
  assert.equal(h.log.sherpaOpts.endSilenceMs, 1100);
});

test("changing the edge voice or end silence while active restarts the call", async () => {
  const h = makeHarness({ voice: { tts: "edge", cloudConsent: true } });
  await h.vm.toggle();
  h.vm.onSettingsChanged({ ...cloneDefaultVoice(), enabled: true, tts: "edge", cloudConsent: true, edgeVoice: "zh-CN-XiaoyiNeural" });
  assert.equal(h.vm.getState().active, false);
});

test("shortcut: no call -> starts one; active call -> pauses/resumes the mic instead of ending it", async () => {
  const h = makeHarness();
  assert.equal((await h.vm.shortcutToggle()).status, "ok");
  assert.equal(h.vm.getState().active, true);
  assert.deepEqual(h.log.overlays.slice(-1), ["listening"]);
  await h.vm.shortcutToggle();
  assert.equal(h.vm.getState().active, true, "call stays alive");
  assert.equal(h.vm.getState().paused, true);
  assert.deepEqual(h.log.overlays.slice(-1), ["paused"], "pet shows the paused (sleeping) state, not idle");
  await h.vm.shortcutToggle();
  assert.equal(h.vm.getState().paused, false);
  assert.deepEqual(h.log.overlays.slice(-1), ["listening"]);
});

test("session mode: shortcut pauses without ending a pending converse", async () => {
  const h = makeHarness();
  const { owner } = await h.vm.sessionStart();
  let settled = null;
  const p = h.vm.converse({ owner, timeoutS: 5 }).then((r) => { settled = r; });
  await h.vm.shortcutToggle();
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, null, "converse still pending while paused");
  assert.equal(h.vm.getState().paused, true);
  await h.vm.sessionStop({ owner });
  await p;
  assert.equal(settled.ended, true);
});

test("menu state exposes paused, and a call end clears it", async () => {
  const h = makeHarness();
  await h.vm.toggle();
  h.vm.togglePause();
  assert.equal(h.vm.getState().paused, true);
  await h.vm.toggle();
  assert.equal(h.vm.getState().active, false);
  assert.equal(h.vm.getState().paused, false);
});

// ---- single owner: the newest /voice/session/start wins ----

test("a new sessionStart takes over: new owner token, old pending converse ends taken_over, old text is not spoken", async () => {
  const h = makeHarness();
  const a = await h.vm.sessionStart();
  assert.equal(a.status, "ok");
  assert.match(a.owner, /^[0-9a-f-]{16,}$/);
  const pending = h.vm.converse({ owner: a.owner, text: "" });
  const b = await h.vm.sessionStart();
  assert.equal(b.status, "ok");
  assert.notEqual(b.owner, a.owner);
  assert.deepEqual(await pending, { ended: true, reason: "taken_over" });
  assert.equal(h.vm.getState().active, true, "call stays up for the new owner");
  const before = h.log.sent.length;
  assert.deepEqual(await h.vm.converse({ owner: a.owner, text: "旧会话的话" }), { ended: true, reason: "taken_over" });
  assert.equal(h.log.sent.length, before, "nothing sent to the renderer for the old owner");
  const live = h.vm.converse({ owner: b.owner, text: "" });
  await h.vm.sessionStop({ owner: b.owner });
  assert.equal((await live).ended, true);
});

test("sessionStop with a stale owner is ignored; missing owner counts as stale", async () => {
  const h = makeHarness();
  const a = await h.vm.sessionStart();
  const b = await h.vm.sessionStart();
  assert.deepEqual(await h.vm.sessionStop({ owner: a.owner }), { status: "ok", ignored: true, reason: "taken_over" });
  assert.deepEqual(await h.vm.sessionStop({}), { status: "ok", ignored: true, reason: "taken_over" });
  assert.equal(h.vm.getState().active, true);
  assert.deepEqual(await h.vm.converse({ text: "x" }), { ended: true, reason: "taken_over" });
  await h.vm.sessionStop({ owner: b.owner });
  assert.equal(h.vm.getState().active, false);
});

test("owner is cleared when the call ends; converse then reports not-in-session", async () => {
  const h = makeHarness();
  const a = await h.vm.sessionStart();
  await h.vm.sessionStop({ owner: a.owner });
  assert.deepEqual(await h.vm.converse({ owner: a.owner, text: "x" }), { error: "not-in-session" });
});

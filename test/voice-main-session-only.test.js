"use strict";

// Voice is started only by a Claude Code session (/clawd-voice). The shortcut,
// menu and Alt+click never open the mic on their own; they pause/resume or hint.
const assert = require("node:assert/strict");
const test = require("node:test");
const { makeHarness } = require("./fixtures/voice-main-harness");

const hints = (h) => h.log.captions.filter((p) => p.role === "hint").map((p) => p.text);

test("no session owner: shortcut and menu/Alt+click do not start a call, they play end and show the hint", async () => {
  const h = makeHarness({ voice: { brain: "session" } });
  assert.deepEqual(await h.vm.shortcutToggle(), { status: "needs-session" });
  assert.deepEqual(await h.vm.toggle(), { status: "needs-session" });
  assert.equal(h.vm.getState().active, false);
  assert.deepEqual(h.log.created.filter((c) => c === "local-stt"), [], "no providers built, mic never asked");
  assert.equal(h.log.mediaAsks, 0);
  assert.deepEqual(h.log.cues, ["end", "end"]);
  assert.deepEqual(hints(h), ["T:voiceNeedSession", "T:voiceNeedSession"]);
});

test("with a session owner the shortcut only pauses and resumes; the menu can still end the call", async () => {
  const h = makeHarness({ voice: { brain: "session" } });
  await h.vm.sessionStart({ label: "proj·abc123" });
  assert.equal((await h.vm.shortcutToggle()).paused, true);
  assert.equal(h.vm.getState().paused, true);
  assert.equal((await h.vm.shortcutToggle()).paused, false);
  assert.equal(h.vm.getState().active, true, "never ended by the shortcut");
  assert.deepEqual(hints(h), []);
  assert.deepEqual(await h.vm.toggle(), { status: "ok", ended: true });
  assert.equal(h.vm.getState().active, false);
});

test("advanced setting brain=claude-code keeps the background CLI call startable by hand", async () => {
  const h = makeHarness({ voice: { brain: "claude-code" } });
  assert.equal((await h.vm.shortcutToggle()).status, "ok");
  assert.equal(h.vm.getState().active, true);
  assert.deepEqual(hints(h), []);
});

test("the driving session is exposed while a call is live and cleared when it ends or is taken over", async () => {
  const h = makeHarness({ voice: { brain: "session" } });
  assert.equal(h.vm.getState().ownerLabel, null);
  const a = await h.vm.sessionStart({ label: "proj-a·111111" });
  assert.equal(h.vm.getState().ownerLabel, "proj-a·111111");
  await h.vm.sessionStart({ label: "proj-b·222222" });
  assert.equal(h.vm.getState().ownerLabel, "proj-b·222222");
  await h.vm.sessionStop({ owner: a.owner });
  assert.equal(h.vm.getState().ownerLabel, "proj-b·222222", "stale stop ignored");
  h.vm.stop("user");
  assert.equal(h.vm.getState().ownerLabel, null);
});

test("captions go to the caption window only (never to the pet renderer) and are wiped when the call stops", async () => {
  const h = makeHarness({ voice: { brain: "session" } });
  const { owner } = await h.vm.sessionStart({ label: "p" });
  h.emit("voice:speech-start");
  h.vm.converse({ owner, text: "" });
  h.vm.stop("user");
  assert.equal(h.log.sent.some(([c]) => c === "voice:caption"), false);
  assert.equal(h.log.captions.at(-1), "clear");
});

test("waiting on the session maps to the voiceThinking overlay, not the coding thinking state", async () => {
  const h = makeHarness({ voice: { brain: "session" } });
  const { owner } = await h.vm.sessionStart({ label: "p" });
  assert.deepEqual(await h.vm.converse({ owner, text: "", timeoutS: 1 }), { timeout: true });
  assert.equal(h.log.overlays.slice(-1)[0], "voiceThinking");
});

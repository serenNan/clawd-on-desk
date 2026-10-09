"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createSessionBrain } = require("../src/voice-brain-session");

test("session brain echoes the supplied reply text as one delta then completes", async () => {
  const brain = createSessionBrain();
  assert.deepEqual(await brain.probe(), { ok: true });
  const got = [];
  brain.send({ requestId: "1", text: "你好。再见。" }, {
    onTextDelta: (d) => got.push(["d", d]),
    onCompleted: (f) => got.push(["c", f]),
    onError: () => got.push(["e"]),
  });
  assert.deepEqual(got, [["d", "你好。再见。"], ["c", "你好。再见。"]]);
  brain.cancel(); brain.reset(); brain.dispose();
});

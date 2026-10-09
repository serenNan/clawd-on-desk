"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");
const { createFakeWebSocket } = require("./fixtures/fake-ws");
const { createEdgeTts, buildSecMsGec, speedToRate } = require("../src/voice-tts-edge");

// Fake mpg123-style decoder: each chunk of N bytes decodes to N float samples of 0.5 / -0.5.
function fakeDecoderFactory(calls = {}) {
  return () => ({
    ready: Promise.resolve(),
    decode(chunk) {
      calls.decoded = (calls.decoded || 0) + 1;
      const ch = new Float32Array(chunk.length).fill(0.5);
      ch[0] = -0.5;
      return { channelData: [ch, ch], sampleRate: 24000, samplesDecoded: chunk.length };
    },
    free() { calls.freed = (calls.freed || 0) + 1; },
  });
}

function setup(extra = {}) {
  const { FakeWebSocket, instances } = createFakeWebSocket();
  const calls = {};
  const tts = createEdgeTts({ WebSocketImpl: FakeWebSocket, createDecoder: fakeDecoderFactory(calls), now: () => 1_700_000_000_000, ...extra });
  const events = [];
  const handlers = {
    onAudio: (a) => events.push(["audio", a.pcm.length, a.sampleRate, a.channels, a.pcm.readInt16LE(0)]),
    onError: (e) => events.push(["error", e.code]),
    onEnd: () => events.push(["end"]),
  };
  return { tts, instances, events, handlers, calls };
}
const reqId = (ws, i = 1) => /X-RequestId:(\w+)/.exec(ws.sent[i])[1];
const audioFrame = (body, id = "abc") => {
  const head = Buffer.from(`X-RequestId:${id}\r\nPath:audio\r\n`, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(head.length);
  return Buffer.concat([len, head, Buffer.from(body)]);
};
const turnEnd = (ws, id = reqId(ws)) => ws.emit("message", Buffer.from(`X-RequestId:${id}\r\nPath:turn.end\r\n\r\n{}`), false);
const tick = () => new Promise((r) => setImmediate(r));

test("Sec-MS-GEC follows the documented algorithm (5-minute windows, windows epoch, sha256 upper)", () => {
  const ms = 1_700_000_000_000;
  const secs = Math.floor(ms / 1000) + 11644473600;
  const ticks = (secs - (secs % 300)) * 1e7;
  const expected = crypto.createHash("sha256").update(`${ticks}6A5AA1D4EAFF4E9FB37E23D68491D6F4`).digest("hex").toUpperCase();
  assert.equal(buildSecMsGec(ms), expected);
  assert.equal(buildSecMsGec(ms + 50_000), expected, "same 5-minute bucket");
  assert.notEqual(buildSecMsGec(ms + 101_000), expected);
});

test("speed maps to a prosody rate percentage", () => {
  assert.equal(speedToRate(1.2), "+20%");
  assert.equal(speedToRate(1), "+0%");
  assert.equal(speedToRate(0.8), "-20%");
});

test("capabilities: 24k mono s16le; id carries the voice", () => {
  const { tts } = setup();
  assert.equal(tts.id, "edge-zh-CN-XiaoxiaoNeural");
  assert.deepEqual(tts.capabilities, { streaming: true, sampleRate: 24000, channels: 1, format: "s16le" });
});

test("connects with GEC token + headers, sends config then SSML with rate and escaped text", async () => {
  const { tts, instances, handlers } = setup({ voice: "zh-CN-YunjianNeural", speed: 1.2 });
  const s = tts.begin(handlers);
  s.writeText("你好 <b> & 'x'");
  s.finish();
  const ws = instances[0];
  assert.match(ws.url, /^wss:\/\/speech\.platform\.bing\.com\/consumer\/speech\/synthesize\/readaloud\/edge\/v1\?/);
  assert.match(ws.url, /Sec-MS-GEC=[0-9A-F]{64}/);
  assert.match(ws.url, /Sec-MS-GEC-Version=1-/);
  assert.ok(ws.opts.headers.Origin.startsWith("chrome-extension://"));
  assert.equal(ws.sent.length, 0, "nothing sent before open");
  ws.open();
  assert.equal(ws.sent.length, 2);
  assert.match(ws.sent[0], /Path:speech\.config/);
  assert.match(ws.sent[0], /"outputFormat":"audio-24khz-48kbitrate-mono-mp3"/);
  assert.match(ws.sent[1], /Path:ssml/);
  assert.match(ws.sent[1], /name='zh-CN-YunjianNeural'/);
  assert.match(ws.sent[1], /rate='\+20%'/);
  assert.match(ws.sent[1], /你好 &lt;b&gt; &amp; &apos;x&apos;/);
});

test("mp3 frames are decoded to mono s16le PCM in order; turn.end ends the session", async () => {
  const { tts, instances, events, handlers, calls } = setup();
  const s = tts.begin(handlers);
  s.writeText("好");
  s.finish();
  const ws = instances[0];
  ws.open();
  const id = reqId(ws);
  ws.emit("message", audioFrame([1, 2, 3, 4], id), true);
  ws.emit("message", audioFrame([5, 6], id), true);
  ws.emit("message", audioFrame([], id), true); // empty audio frame
  turnEnd(ws);
  await tick(); await tick();
  assert.deepEqual(events, [
    ["audio", 8, 24000, 1, -16384],
    ["audio", 4, 24000, 1, -16384],
    ["end"],
  ]);
  assert.equal(calls.freed, 1);
  assert.equal(ws.closed, false, "socket stays open for the next sentence");
});

test("cancel silences later frames (epoch-safe)", async () => {
  const { tts, instances, events, handlers } = setup();
  const s = tts.begin(handlers);
  s.writeText("好");
  s.finish();
  const ws = instances[0];
  ws.open();
  const id = reqId(ws);
  s.cancel();
  ws.emit("message", audioFrame([1, 2], id), true);
  turnEnd(ws, id);
  await tick();
  assert.equal(ws.closed, false);
  assert.deepEqual(events, []);
});

test("empty text ends immediately without opening a connection", () => {
  const { tts, instances, events, handlers } = setup();
  const s = tts.begin(handlers);
  s.writeText("   ");
  s.finish();
  assert.deepEqual(events, [["end"]]);
  assert.equal(instances.length, 0);
});

test("upgrade rejection (403) maps to tts_edge_auth; socket error/early close to tts_edge_network", async () => {
  const a = setup();
  const sa = a.tts.begin(a.handlers);
  sa.writeText("好"); sa.finish();
  a.instances[0].emit("unexpected-response", {}, { statusCode: 403 });
  assert.deepEqual(a.events, [["error", "tts_edge_auth"]]);

  const b = setup();
  const sb = b.tts.begin(b.handlers);
  sb.writeText("好"); sb.finish();
  b.instances[0].open();
  b.instances[0].drop(); // stale socket: replayed once on a fresh one
  assert.deepEqual(b.events, []);
  b.instances[1].open();
  b.instances[1].drop();
  assert.deepEqual(b.events, [["error", "tts_edge_network"]]);

  const c = setup();
  const sc = c.tts.begin(c.handlers);
  sc.writeText("好"); sc.finish();
  c.instances[0].emit("error", new Error("ECONNRESET"));
  assert.deepEqual(c.events, [["error", "tts_edge_network"]]);
});

test("connect timeout reports tts_edge_network and closes", async () => {
  const timers = [];
  const { tts, instances, events, handlers } = setup({
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  const s = tts.begin(handlers);
  s.writeText("好"); s.finish();
  assert.ok(timers.length >= 1);
  timers[0].fn();
  assert.deepEqual(events, [["error", "tts_edge_network"]]);
  assert.equal(instances[0].closed, true);
});

test("an invalid voice name is rejected at construction (no SSML injection)", () => {
  assert.throws(() => createEdgeTts({ voice: "x'><evil", WebSocketImpl: createFakeWebSocket().FakeWebSocket }), /voice/i);
});

test("warm pre-opens; sentences of one reply share one socket with distinct request ids", async () => {
  const { tts, instances, events, handlers } = setup();
  tts.warm();
  assert.equal(instances.length, 1);
  instances[0].open();
  const a = tts.begin(handlers); a.writeText("一"); a.finish();
  const b = tts.begin(handlers); b.writeText("二"); b.finish();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].sent.filter((x) => /Path:speech\.config/.test(x)).length, 1);
  const ida = reqId(instances[0], 1), idb = reqId(instances[0], 2);
  assert.notEqual(ida, idb);
  instances[0].emit("message", audioFrame([1, 2], idb), true);
  turnEnd(instances[0], idb);
  await tick(); await tick();
  assert.deepEqual(events, [["audio", 4, 24000, 1, -16384], ["end"]]);
});

test("dispose closes the shared socket", () => {
  const { tts, instances } = setup();
  tts.warm(); instances[0].open();
  tts.dispose();
  assert.equal(instances[0].closed, true);
});

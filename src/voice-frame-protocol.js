"use strict";

// Binary frames on the capture helper's stdout: [0xCA 0xFE][uint16 LE length][payload].
// Control JSON never shares this pipe (it goes over stderr, line by line), so a
// stray byte can only show up as a bad magic, which the caller treats as a crash.
const MAGIC = [0xca, 0xfe];
const HEADER_BYTES = 4;

function encodeFrame(payload) {
  const head = Buffer.from([MAGIC[0], MAGIC[1], 0, 0]);
  head.writeUInt16LE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

function createFrameParser({ onFrame, onError = () => {} }) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= HEADER_BYTES) {
        if (buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1]) { buf = Buffer.alloc(0); onError("bad-magic"); return; }
        const len = buf.readUInt16LE(2);
        if (buf.length < HEADER_BYTES + len) return;
        const payload = buf.subarray(HEADER_BYTES, HEADER_BYTES + len);
        buf = buf.subarray(HEADER_BYTES + len);
        if (len) onFrame(payload);
      }
    },
  };
}

module.exports = { encodeFrame, createFrameParser, HEADER_BYTES };

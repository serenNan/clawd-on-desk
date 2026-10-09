"use strict";

// Minimal fake of the `ws` WebSocket client surface used by voice adapters.
const { EventEmitter } = require("node:events");

function createFakeWebSocket() {
  const instances = [];
  class FakeWebSocket extends EventEmitter {
    constructor(url, opts) {
      super();
      this.url = url;
      this.opts = opts || {};
      this.sent = [];
      this.closed = false;
      instances.push(this);
    }
    send(data) { this.sent.push(data); }
    close() { if (!this.closed) { this.closed = true; this.emit("close", 1000); } }
    open() { this.emit("open"); }
    serverJson(obj) { this.emit("message", Buffer.from(JSON.stringify(obj)), false); }
    serverBinary(buf) { this.emit("message", Buffer.from(buf), true); }
    drop() { this.closed = true; this.emit("close", 1006); }
    jsonSent() { return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d)); }
    binarySent() { return this.sent.filter((d) => typeof d !== "string"); }
  }
  return { FakeWebSocket, instances };
}

module.exports = { createFakeWebSocket };

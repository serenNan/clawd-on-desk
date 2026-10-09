"use strict";

// AudioWorklet processor: regroups 128-sample render quanta into ~20ms mono
// Float32 frames and transfers them to the main thread (zero-copy transfer of
// a fresh buffer). Loaded via audioWorklet.addModule; not a UMD module.
registerProcessor("clawd-voice-capture", class ClawdVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frameSize = Math.max(1, Math.round(globalThis.sampleRate * 0.02));
    this.frame = new Float32Array(this.frameSize);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs && inputs[0] && inputs[0][0];
    if (!input) return true;
    let offset = 0;
    while (offset < input.length) {
      const n = Math.min(this.frameSize - this.filled, input.length - offset);
      this.frame.set(input.subarray(offset, offset + n), this.filled);
      this.filled += n;
      offset += n;
      if (this.filled === this.frameSize) {
        const out = this.frame;
        this.frame = new Float32Array(this.frameSize);
        this.filled = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
});

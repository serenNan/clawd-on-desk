"use strict";

// Start/end cue sounds for the voice call (Cora's start.wav / end.wav), played
// through the pet's existing "play-sound" channel at the pet's sound volume.
// Gated only by voice.cueEnabled: the user muted pet sounds but still wants
// to hear when the mic pauses/resumes.
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const CUE_FILES = Object.freeze({ start: "voice-start.wav", end: "voice-end.wav" });

function createVoiceCue({ send, getCueEnabled, getSoundVolume, soundsDir }) {
  return function playCue(name) {
    const file = CUE_FILES[name];
    if (!file || !getCueEnabled()) return false;
    send("play-sound", { url: pathToFileURL(path.join(soundsDir, file)).href, volume: getSoundVolume() });
    return true;
  };
}

module.exports = { createVoiceCue, CUE_FILES };

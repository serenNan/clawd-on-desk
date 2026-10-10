"use strict";

// Spoken mute / resume commands, matched on the final transcript and handled by
// the runtime itself (never forwarded to the Claude session).
const strip = (text) => String(text == null ? "" : text).replace(/[\s\p{P}\p{S}]+/gu, "");
const LEAD = /^(?:请|先|麻烦|帮我|给我|把)+/;
const TAIL = /(?:一下|下|吧|啊|呀|哦|嘛|呢|啦|了|好吗|可以吗)+$/;

// Only a short sentence that is essentially the word itself ("静音", "先静音", "静音吧", "静音一下").
const isMuteCommand = (text) => strip(text).replace(LEAD, "").replace(TAIL, "") === "静音";
// The wake phrase may sit inside a sentence ("好了恢复语音吧").
const isResumeCommand = (text) => strip(text).includes("恢复语音");

module.exports = { isMuteCommand, isResumeCommand };

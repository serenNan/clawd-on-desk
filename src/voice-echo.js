"use strict";

// Speaker echo that slips past AEC and gets transcribed looks like the text we
// are currently speaking. Compared on adjacent-character pairs (a bare char
// set would flag real speech that merely reuses common characters).
const ECHO_OVERLAP = 0.6;
const ECHO_MIN_CHARS = 2;

const norm = (s) => String(s == null ? "" : s).replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();

function pairs(s) {
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

function isEchoText(text, spoken, { overlap = ECHO_OVERLAP } = {}) {
  const t = norm(text);
  if (t.length < ECHO_MIN_CHARS) return false;
  const have = pairs(norm((spoken || []).join("")));
  if (!have.size) return false;
  const want = [...pairs(t)];
  return want.filter((p) => have.has(p)).length / want.length > overlap;
}

// The user speaks Chinese; background music with English lyrics transcribes
// as pure Latin text and must not count as the user talking.
const hasChinese = (text) => (String(text == null ? "" : text).match(/\p{Script=Han}/gu) || []).length >= 1;

module.exports = { isEchoText, hasChinese, ECHO_OVERLAP };

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isEchoText } = require("../src/voice-echo");

const spoken = ["今天北京天气不错，气温二十度。", "下午可能有小雨，记得带伞。"];

test("transcribed echo of the current/recent sentence is echo", () => {
  assert.equal(isEchoText("今天北京天气不错", spoken), true);
  assert.equal(isEchoText("下午可能有小雨 记得带伞", spoken), true);
  assert.equal(isEchoText("今天北京天汽不错气温二十度", spoken), true, "one garbled char still echo");
});

test("real user speech is not echo even if it reuses common characters", () => {
  assert.equal(isEchoText("等一下我有问题", spoken), false);
  assert.equal(isEchoText("你能不能把天气再说一遍", spoken), false);
  assert.equal(isEchoText("stop", spoken), false);
});

test("empty / single-char text and empty spoken list are never echo", () => {
  assert.equal(isEchoText("", spoken), false);
  assert.equal(isEchoText("天", spoken), false);
  assert.equal(isEchoText("今天北京", []), false);
});

test("hasChinese needs a Han character (a bare 好 still counts as an answer)", () => {
  const { hasChinese } = require("../src/voice-echo");
  assert.equal(hasChinese("No just in time to see"), false);
  assert.equal(hasChinese("ok"), false);
  assert.equal(hasChinese("好"), true);
  assert.equal(hasChinese("帮我打开 GitHub"), true);
});

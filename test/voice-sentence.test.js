"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createSentenceChunker, sanitizeSpeech } = require("../src/voice-sentence");

function run(deltas, opts) {
  const out = [];
  const c = createSentenceChunker({ onSentence: (s) => out.push(s), ...opts });
  for (const d of deltas) c.push(d);
  c.flush();
  return out;
}

test("splits on strong punctuation across delta boundaries", () => {
  assert.deepEqual(run(["你好呀，今天", "天气不错。我们", "聊点什么？"]), ["你好呀，今天天气不错。", "我们聊点什么？"]);
});

test("first segment may end at a comma once it has 8+ chars; later ones wait for strong punctuation", () => {
  const out = run(["好的我明白你的意思了，", "那我们先看看第一个问题，再看第二个问题。"]);
  assert.equal(out[0], "好的我明白你的意思了，");
  assert.equal(out[1], "那我们先看看第一个问题，再看第二个问题。");
});

test("short first clause is not emitted on a comma", () => {
  assert.deepEqual(run(["嗯，我觉得可以。"]), ["嗯，我觉得可以。"]);
});

test("never splits inside numbers or English words", () => {
  assert.deepEqual(run(["圆周率是3.14", "159，大约等于一千零二十四，也就是1,024。"]).join(""), "圆周率是3.14159，大约等于一千零二十四，也就是1,024。");
  const out = run(["我喜欢用 Type", "Script 写代码。"]);
  assert.deepEqual(out, ["我喜欢用 TypeScript 写代码。"]);
});

test("does not speak markdown code blocks or formatting symbols", () => {
  const out = run(["先看这段：\n```js\nconsole.log(1)\n```\n", "结果是 **一** 。"]);
  assert.equal(out.join("").includes("console"), false);
  assert.equal(out.join("").includes("`"), false);
  assert.equal(out.join("").includes("*"), false);
  assert.ok(out.join("").includes("结果是"));
});

test("force-splits very long text without punctuation only at a safe boundary", () => {
  const long = "这是一段没有任何标点的很长很长的文字".repeat(6);
  const out = run([long], { maxChars: 40 });
  assert.ok(out.length >= 2);
  assert.equal(out.join(""), long);
});

test("flush emits trailing text once and is idempotent", () => {
  const out = [];
  const c = createSentenceChunker({ onSentence: (s) => out.push(s) });
  c.push("没有结尾标点");
  c.flush();
  c.flush();
  assert.deepEqual(out, ["没有结尾标点"]);
});

test("sanitizeSpeech strips markdown, bullets and emoji-free whitespace", () => {
  assert.equal(sanitizeSpeech("# 标题\n- 第一\n- 第二"), "标题 第一 第二");
  assert.equal(sanitizeSpeech("   "), "");
});

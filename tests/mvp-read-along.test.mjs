import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(await mkdtemp(join(tmpdir(), "shelf-read-along-")), "read-along-core.mjs");
await build({
  entryPoints: [join(root, "app/web/lib/read-along-core.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});
const R = await import(pathToFileURL(out).href);

test("split: CJK punctuation, closing quotes and ellipsis", () => {
  assert.deepEqual(R.splitSentences("他说：“走吧。”她没动！真的？……好吧；再见…"), ["他说：“走吧。”", "她没动！", "真的？……", "好吧；", "再见…"]);
  assert.deepEqual(R.splitSentences("（注：见上文。）然后呢"), ["（注：见上文。）", "然后呢"]);
});

test("split: English and mixed text", () => {
  assert.deepEqual(R.splitSentences('He left. "Why?" she asked. Pi is 3.14 today.'), ["He left.", '"Why?"', "she asked.", "Pi is 3.14 today."]);
  assert.deepEqual(R.splitSentences("第一章 开端。Hello world! 你好。"), ["第一章 开端。", "Hello world!", "你好。"]);
});

test("split: no punctuation, newlines, empties", () => {
  assert.deepEqual(R.splitSentences("没有标点的一段话"), ["没有标点的一段话"]);
  assert.deepEqual(R.splitSentences("标题\n\n正文第一句。"), ["标题", "正文第一句。"]);
  assert.deepEqual(R.splitSentences("  \n。。\n "), []);
  assert.deepEqual(R.splitSentences("好。\n……"), ["好。……"]); // punctuation-only fragment joins the previous one
  assert.deepEqual(R.splitSentences(""), []);
});

test("weights: Latin words count 2, punctuation ignored", () => {
  assert.equal(R.sentenceWeight("你好。"), 2);
  assert.equal(R.sentenceWeight("Hello world!"), 4);
  assert.equal(R.sentenceWeight("用 AI 读书"), 5);
});

test("starts are monotonic, start at 0 and the last is < duration", () => {
  const ss = R.splitSentences("短。这一句稍微长一些。Hello there, friend. 最后一句话在这里。");
  const st = R.sentenceStarts(ss, 10000);
  assert.equal(st.length, ss.length);
  assert.equal(st[0], 0);
  for (let i = 1; i < st.length; i++) assert.ok(st[i] > st[i - 1]);
  assert.ok(st.at(-1) < 10000);
  assert.deepEqual(R.sentenceStarts(["a。"], 0), [0]);
});

test("sentenceAt picks the sentence by time", () => {
  const text = "甲乙丙丁。戊己庚辛。";
  assert.deepEqual(R.sentenceAt(text, 8000, 0), { index: 0, sentence: "甲乙丙丁。", first: "甲乙丙丁。" });
  assert.equal(R.sentenceAt(text, 8000, 3999).index, 0);
  assert.equal(R.sentenceAt(text, 8000, 4000).index, 1);
  assert.equal(R.sentenceAt(text, 8000, 99999).index, 1);
  assert.equal(R.sentenceAt("", 8000, 0), null);
});

test("normalize strips punctuation, folds width and case, maps back", () => {
  const src = "Ａ b，“Ｃ”！ 中";
  const n = R.normalize(src);
  assert.equal(n.text, "abc中");
  assert.deepEqual(n.map.map((i) => src[i]), ["Ａ", "b", "Ｃ", "中"]);
});

test("findSentence: matches after footnotes/annotations were deleted", () => {
  const orig = "前文略。他走进房间[1]，看见桌上放着一封信②（原注：此信后来遗失）。他没有拆开。";
  const hay = R.normalize(orig).text;
  const cleaned = "他走进房间，看见桌上放着一封信。"; // subsequence of the original
  const hit = R.findSentence(hay, cleaned, 0);
  assert.ok(hit);
  assert.equal(hay.slice(hit.start, hit.start + 5), "他走进房间");
  assert.ok(hay.slice(hit.start, hit.end).endsWith("信"));
  assert.ok(hit.end - hit.start <= Math.ceil(R.normalize(cleaned).text.length * 1.6));
});

test("findSentence: repeated phrase is found in order with the cursor", () => {
  const hay = R.normalize("他说好的。中间一段别的话。他说好的。结尾。").text;
  const a = R.findSentence(hay, "他说好的。", 0);
  const b = R.findSentence(hay, "他说好的。", a.end);
  assert.equal(a.start, 0);
  assert.ok(b.start > a.start);
  assert.equal(hay.slice(b.start, b.end), "他说好的");
  // Cursor past the last occurrence: falls back to the whole haystack.
  assert.equal(R.findSentence(hay, "他说好的。", hay.length).start, 0);
});

test("findSentence: shorter prefix fallback and null when absent", () => {
  const hay = R.normalize("从前有座山山里有座庙[注]庙里有个老和尚在讲故事").text;
  // The 12-char prefix spans the "注" the LLM deleted, so only the 6-char prefix finds it.
  const hit = R.findSentence(hay, "从前有座山，山里有座庙，庙里有个老和尚。", 0);
  assert.ok(hit);
  assert.equal(hit.start, 0);
  assert.equal(R.findSentence(hay, "完全不相干的句子。", 0), null);
  assert.equal(R.findSentence(hay, "。。", 0), null);
});

test("findNear: backward seek picks the earlier copy, not a far later duplicate", () => {
  const filler = "无关的叙述文字".repeat(300); // > NEAR_CHARS
  const hay = R.normalize(`他终于开口说话了。${filler}中间。${filler}他终于开口说话了。`).text;
  const later = hay.lastIndexOf("他终于开口说话了");
  const cursor = hay.indexOf("中间"); // past the first copy, far before the second
  assert.ok(later - cursor > R.NEAR_CHARS);
  assert.equal(R.findNear(hay, "他终于开口说话了。", "", cursor).start, 0);
});

test("findNear: a short sentence is found near the cursor, not a far later copy", () => {
  const filler = "别的内容".repeat(500);
  const hay = R.normalize(`是的。开头。问他。是的。${filler}是的。`).text;
  const cursor = hay.indexOf("问他");
  const hit = R.findNear(hay, "是的。", "", cursor);
  assert.equal(hit.start, hay.indexOf("是的", cursor));
  assert.ok(hit.start - cursor < 10);
  // Sentence missing: falls back to the piece's first sentence, again near first.
  assert.equal(R.findNear(hay, "不存在。", "问他。", 0).start, cursor);
  assert.equal(R.findNear(hay, "不存在。", "也不存在。", 0), null);
});

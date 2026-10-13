export function buildJobInput({ operation, question, chapter, model }) {
  const input = { operation, model };
  if (operation === "question") {
    const value = question.trim();
    if (!value || value.length > 4000)
      throw new Error("请输入不超过 4,000 字的书内问题。");
    input.question = value;
  }
  if (operation === "chapter_summary") {
    const value = Number(chapter);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error("请输入有效的章节编号或 PDF 页码。");
    input.chapter = value;
  }
  return input;
}

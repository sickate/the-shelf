# 相邻笔记自动合并（2026-10-31）

## 目标
翻页时一句话被拆成两条摘录（上一页末尾一条、下一页开头一条）。新建摘录时，若与本书已有的一条同色摘录首尾相接，自动并成一条，不再产生第二条。

## 范围
- 新建摘录（「摘录」/颜色/「写笔记」保存）时检查相邻；合并 = PATCH 已有那条（quote、locator、label、note），不新建。
- 判定"相邻"（两条同色，任一先后顺序）：
  - TXT/MD：两段之间只有空白。
  - EPUB / MOBI：同一章节文档内，两段 Range 之间只有空白（分页翻页即此情形）；合并后重新生成 CFI。跨章节不合并。
  - PDF 同页：两段之间只有空白。
  - PDF 跨页（第 N 页末 + 第 N+1 页首）：A 之后到第 N 页末、B 之前从第 N+1 页首的剩余文字各 ≤ 40 字（容忍页眉、页脚、页码）。第 N 页文字取自本次会话已渲染页的缓存，没有就不合并。
- PDF locator 新增可选 `endPage`（> page）：从 (page,start) 到 (endPage,end)；中间页整页高亮。服务端校验、前端 parseLocator、绘制、标签「第 12–13 页」都要跟上。双页并排时一次选择跨到右页也直接生成 `endPage`。
- 合并后文字 ≤ 4,000 字，否则不合并。笔记文字用空行拼接。
- 合并后 toast 显示「已与相邻摘录合并」，带「撤销」按钮：把原那条 PATCH 回原值，再把新选区单独 POST 一条。
- 服务端 PATCH `/api/notes/:id` 新增可改 `quote`、`locator`、`label`（与 POST 同样校验）。无 schema 变更。

## 不做
- 不批量合并历史上已经拆开的笔记。
- 不合并不同颜色的笔记，不合并重叠的摘录。

## 实施
单个 Opus 5.5 子 Agent，在 worktree 中实现（前后端改动耦合）：`app/worker.mjs`、`app/web/lib/reader-notes-core.ts`、`app/web/lib/reader-notes.ts`、`app/web/notes.ts`（标签/locator 显示，如需要）、测试 `tests/mvp-notes.test.mjs`、`tests/mvp-reader-notes.test.mjs`。
- 纯函数（相邻判定、PDF 跨页切片、引文拼接、标签）放 core 并加测试。
- Adapter 增加可选 `join(existing, located): Located | null`，由控制器在 create 时调用。

## 验收
- `npm test` 通过；`app` 构建通过。
- 主 Agent review 后合并到 main、推送、部署，线上冒烟（登录后 PATCH quote/locator 正常、读取页无报错）。

## 回退
`wrangler rollback` 到上一版本；数据无 schema 变更，含 `endPage` 的笔记在旧前端中不画高亮，但仍在列表中可见、可导出。

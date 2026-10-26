# 漫画 CBZ 与模糊书目重新识别（2026-10-26）

用户需求：漫画图片文件夹打包为 CBZ 并增加漫画阅读器；zip/rar 解压后上传；文件名含义模糊、无法识别的书读取前几页内容后重新识别。

## A. 压缩包（主 Agent 已完成）

- `中国历代通俗演义全集.zip`（11 部）、`几个不同版本的中国通史.zip`（45 部）：GBK 文件名解码后解压到 `books/05-历史与社会/`，56 部 TXT 全部上传。
- `军地两用.rar`：2 本 PDF（93 MB、78 MB）超过 20 MB，只登记书目。
- 不处理：`rplidar-*.igs.zip`（CAD 模型，不是书）、xmind/mht/json/gsheet。

## B. 漫画 CBZ（M1）

- 来源：`books/09-漫画/` 下的图片文件夹。《炎拳》84 话（每话一个文件夹，约 4.4 MB/话），《再見繪梨》201 页（341 MB），《蓦然回首》138 页（70 MB）。《Chainsaw Man》已是逐话 PDF，不改。
- 打包脚本 `scripts/pack-cbz.mjs`：每个最内层图片文件夹 → 一个 `.cbz`（ZIP，图片按自然序，不压缩存储），输出到 `books/09-漫画/<作品>/<话>.cbz`，原图片保留。超过 19,500,000 bytes 时先用 `sips` 重新编码（JPEG 质量 80，长边 ≤ 2000 px），仍超限再按页拆分为“（1/3）”等多卷；记录报告。
- 阅读器：`read.ts` 新增 CBZ 分支（`lib/cbz.ts` 解析 ZIP 中央目录，存储/deflate 两种条目，deflate 用 `DecompressionStream('deflate-raw')`，不加新依赖）；单页/双页（右→左可选，漫画默认右开）、适合宽度/适合高度、键盘与点击左右翻页、预加载前后两页、记住页码。
- 缩略图：`thumb.ts` 支持 cbz（首图）。在线阅读格式 `READABLE` 加入 cbz。
- 上传：打包后用 `npm run app:upload`，归类按目录。

## C. 模糊书目重新识别（C1）

- 对象：自动归类或 AI 简介 `confidence = low` 且非手动的条目（当前约 455 条，几乎都是只凭文件名生成）。
- 本地提取正文（新脚本 `scripts/mvp-reidentify.mjs`，读 `books/` 源文件，云端未上传的 >20 MB 书也适用）：PDF 用 `pdfjs-dist` legacy 前 8 页文本；EPUB 解包读前若干章节；DOC/DOCX/RTF/HTML 用 macOS `textutil`；TXT/MD 直读（GB18030 回退）。≤ 12,000 字。MOBI/AZW3、扫描版 PDF、XLSX/PPTX 无可用文本则跳过并列出。
- 流程（每本，串行，沿用 batch.mjs 的忙碌等待/续跑/状态文件）：
  1. `POST /api/books/:id/info?force=1 {excerpt}` → AI 依据正文给出规范书名与作者。
  2. `POST /api/books/:id/class?force=1 {excerpt, query}`：Worker 新增可选 `excerpt`（写入 AI 输入）与 `query`（检索候选号所用书名，默认仍为文件名清洗结果；脚本传 1 中识别出的“书名 作者”）。
  3. 若识别出的书名与文件名明显不同且 1 的 `confidence` 仍为 low，再以 `query` 重跑一次 info（Worker 的 info 同样接受可选 `query` 用于 DeepSeek 检索）。
- 手动分类不覆盖。
- 输出报告：识别前后书名、分类、类型、可信度变化。

## 分工

| # | 任务 | 模型 |
| --- | --- | --- |
| M1 | 打包脚本 + CBZ 阅读器 + 缩略图 + 测试 | Opus 5.5 |
| C1 | Worker `excerpt`/`query` 参数 + 重新识别脚本 + 测试 | Opus 5.5（AI 调用、Worker 接口） |

## 验收

- 生产：CBZ 若干话可读（单/双页、翻页、刷新恢复）、缩略图生成；重新识别后抽查 20 本。
- `npm run app:test` 通过。

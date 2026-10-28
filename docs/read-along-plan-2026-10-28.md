# 朗读跟读高亮（2026-10-28）

状态（2026-10-28）：R1–R4 已合并上线（Worker 版本 `f76f0a85`，回退目标 `3815c225`）。本机 227 项测试、类型检查、构建通过；线上 HTTP：已有任务 23/23 片返回 `text`，访客 401，`read.js` 含跟读代码。**浏览器交互（高亮、翻页、暂停跟随）未验收。** 已知限制：光标后 1,500 字内有重复句时回拖可能命中后者；EPUB 改字号/窗口大小可能误触“暂停跟随”。

## 目标

播放朗读时，在阅读页高亮正在读的那一句；至少能翻到/滚到当前音频片开始的位置。

## 范围

- 做：TXT/MD、EPUB（epub.js）、MOBI/AZW3（foliate）句级高亮 + 自动翻页/滚动；PDF 只自动翻到所在页（无文字层，不高亮）。
- 做：播放器“跟随朗读”开关（默认开，本机记住）；用户手动翻页/滚动后暂停跟随，播放器出现“回到朗读位置”。
- 不做：TTS 逐字时间戳（`qwen3-tts-flash-realtime` 未提供）；改数据表；改合成流程；CBZ。

## 方案

1. **后端**：`jobView` 每片多返回 `text`（已存于 `audio_pieces.text`，为 LLM 整理后的文字）。无迁移，旧任务直接可用。mock API 同步给示例文字。
2. **句内时间估算**（纯函数，`lib/read-along-core.ts`）：片文字按句末标点（`。！？!?；;…` 及英文 `. `，含后随引号括号）切句；每句权重 = 去空白和标点后的字符数（英文单词按 2 计，接近 S0 实测语速比）；句起点 = 片时长 × 前面权重占比。片里标题后自动补的“。”不影响结果。
3. **原文匹配**（纯函数 + DOM 索引）：把目标文档的文本节点拼成“规范化串”（去空白和标点、全角转半角、小写），记录每个字符对应的（节点, 偏移）。对一句话取规范化后的前 12 个字，从上次命中位置向后查找；查不到时依次试前 6 个字、在整章内查找；仍失败就用本片第一句的命中位置，再失败则不移动。句尾用贪心子序列匹配（窗口 ≤ 句长 × 1.6）得到结束位置，因为 LLM 只删不改，整理后的文字是原文的子序列。返回 DOM `Range`。
4. **高亮**：优先 CSS Custom Highlight API（`CSS.highlights.set("shelf-read-along", new Highlight(range))`，在对应 iframe 的 document 上注册并注入 `::highlight(shelf-read-along)` 样式），不改 DOM，不影响 CFI 和笔记高亮。不支持该 API 的浏览器只滚动/翻页、不高亮。
5. **适配器**（`ReadAlongTarget`，由 `read.ts` 按格式注册，与 `setChapterSource` 同一套路）：
   ```ts
   interface ReadAlongTarget {
     /** 在本章内找到这句话并显示出来（必要时翻页/跨节加载），返回是否成功。 */
     show(sentence: string, pieceFirstSentence: string, opts: { highlight: boolean }): Promise<boolean>;
     clear(): void;
     /** 用户自己翻页/滚动时回调（适配器自己区分程序翻页）。 */
     onUserNavigate(cb: () => void): void;
   }
   ```
   - TXT：在 `article` 内查找，句子不在视口中部 1/3 时 `scrollIntoView({block:"center"})`。
   - EPUB：先在 `rendition.getContents()` 里找；找不到时按章节范围加载各 spine 节（`section.load`）查找，`section.cfiFromRange` 得到 CFI 后 `rendition.display(cfi)`，再在渲染后的文档里高亮。命中所在页不是当前页时翻页。
   - MOBI：同 EPUB，用 `fv.renderer.getContents()`、`book.sections[i].createDocument()`、`fv.getCFI(index, range)`、`fv.goTo(cfi)`。
   - PDF：按章节页范围逐页取文字（缓存），找到句子所在页后翻到该页。
6. **播放器接入**：`createAudioPlayer` 增加 `onPosition({ pieceText, offsetMs, durationMs })`（`timeupdate`/换片/拖动时触发，节流到 ≥ 250 ms 或句子变化时）。`lib/read-along.ts` 的控制器计算当前句，句子变化时调用适配器 `show`；关闭播放器时 `clear()`。

## 分工

| # | 任务 | 模型 | 依赖 |
| --- | --- | --- | --- |
| R1 | 后端返回片文字、类型、mock、测试 | Sonnet 5.5 | 无 |
| R2 | 核心：切句与时间估算、规范化匹配与 DOM 索引、高亮、跟随控制器、播放器 `onPosition`/跟随开关/回到位置、TXT 适配器、单测 | Opus 5.5 | 契约（`AudioPiece.text`） |
| R3 | EPUB + MOBI 适配器（跨节加载、CFI 翻页、iframe 高亮样式） | Opus 5.5 | R2 |
| R4 | PDF 翻页适配器 | Sonnet 5.5 | R2 |

主 Agent review 每个交付，跑测试/构建，线上 HTTP 验收片文字返回。

## 验收

- 单测：切句（中英混排、引号、省略号、无标点）；时间估算单调且末句起点 < 时长；匹配（删了脚注/批注后仍命中、重复短语按顺序命中、找不到时回退）；后端 `pieces[].text` 存在且访客 401 不变。
- `npm test`、`npm run build:cloudflare` 通过。
- 线上：已有任务的 `GET /api/audio/:id` 每片带 `text`。浏览器中 TXT/EPUB/MOBI 播放时高亮跟随、跨页自动翻页、手动翻页后暂停跟随、“回到朗读位置”可用；PDF 翻页正确。浏览器交互需用户实测，未实测前不宣称验收通过。

## 部署与回退

`commit → push → 本机受控发布（`npm run app:deploy`）→ 线上验证`。回退：重新部署上一 Worker 版本；后端多返回一个字段，旧前端忽略，无数据变更。

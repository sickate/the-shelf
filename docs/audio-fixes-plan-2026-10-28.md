# 朗读修复与连续播放（2026-10-28 晚）

状态：计划，开发中。未上线。

## 用户反馈

1. 自动语气和不加语气听感几乎一样 → 按方案 1：让 LLM 给出明确、可听出差别的语气。
2. 播放时经常报错；播放中途页面提示错误但仍在播放。
3. 读的时候切换了章节，朗读没有跟着切换。
4. 新功能：上一章快结束时自动开始生成下一章，连续播放。
5. 新功能：页面左右两侧加翻页按钮（移动端和桌面端都要）。
6. 同一章节、同一音色和语气，生成完后又重新生成一遍。

## 线上数据查到的根因

- **长章节失败**：`epub:Text/part0006.xhtml`（91 片）在第 50 片附近 R2 写入报 `The request exceeded the maximum Workers subrequest depth (10034)`。原因：长任务由 Workflow 在自己内部 `AUDIO_WORKFLOW.create` 下一个实例接续（`audioContinue`），每接续一次调用深度 +1，到上限后子请求全部失败。
- **误判 CPU 降级**：该错误文本含 “exceeded”，被 `/cpu|exceeded|…/` 当成 CPU 超限 → 拆片并把全局片长降到 120（`cpu_limit`），之前也出现过 `repeated_failure`。已手动恢复为 200。
- **重复生成（反馈 6）**：任务失败的同一时刻（09:45:11）创建了同键新任务并从头生成 137 片（前一任务已就绪 50 片）。重试/重新生成目前是软删除旧任务后全部重做，不复用已就绪的片。
- **握手超时**：第二个任务 128/137 片后某片 3 轮 `tts_handshake_timeout_s101_f0`（升级成功但无任何帧），整个任务随即失败。
- **播放中报错（反馈 2）**：播放器轮询失败时显示“状态刷新失败：…”，片加载失败显示“音频加载失败”。疑似 `jobView` 每 3 秒解析全部片的 `marks`（137 片 × 约 1.5 KB）在 Free 10 ms CPU 下超限，以及瞬时网络错误；需核实。

## 方案

### 后端（B1，Opus 5.5）

- **接续不再嵌套**：Workflow 不再在内部创建下一实例；改为把任务标记为“待接续 part N”后结束本实例，由**顶层请求**启动下一实例（确定性 id，幂等）：新增 Cron Trigger（每分钟）扫描待接续任务，另外任务 GET 也顺带检查。核实 Free 套餐 cron 可用；`wrangler.jsonc` 增加 `triggers.crons`。
- **错误分类**：CPU 降级只认真正的 CPU 超限信号（Workers 的 exceededCpu / “Worker exceeded CPU time limit”），不认 subrequest depth、`put:`、`tts_*`。
- **失败可续跑，不重做**：重试（同音色同语气）在原任务上把 failed 的片重置为 pending 并重启 Workflow，已就绪的片保留；不再软删除重建。单片失败不让整个任务失败：多轮退避（如 30 s、2 min、5 min）后才标记该片 failed，任务状态 `failed` 但保留已就绪部分可播放。
- **创建去重**：同键（书、章节、文本 hash、音色、语气）有任何未删除任务（含 failed）时返回该任务，不新建；核实前端没有自动重建路径。
- **轮询减负**：`marks` 写入时已校验为 JSON，`jobView` 直接拼接原字符串、不再 `JSON.parse`；或只在片就绪后单独接口获取。保证长章节（≥ 150 片）一次轮询 CPU 明显低于 10 ms。
- **语气（反馈 1）**：LLM 整理提示要求 `style` 写出具体情绪、语速、停顿、音高（≥ 2 项具体描述），禁止“平稳/适中/客观/自然”这类等同默认的描述；服务端校验，命中禁用词或过短时用一组按内容类型的预设兜底（如叙事“语速稍慢、略带感情起伏、句间停顿明显”）。已生成任务不变。

B1 实现（分支 `b1-audio-backend-fixes`，未上线）：
- 迁移 `0009_audio_handoff.sql`：`audio_jobs.next_part`（NULL = 无待接续）+ 部分索引；旧代码不读写该列。Workflow 预算用尽时 `handoff-<N>` 步只写 `next_part = N` 后结束；`kickJob` 在 Cron（`* * * * *`，`scheduled` → `audioCron`，每次最多 10 个）、任务 GET/查找、重试中创建 `<jobId>-p<N>`（已存在视为已启动，`next_part` 仅在仍为 N 时清空）。Workers Free：每账号 5 个 Cron Trigger、每次 10 ms CPU。
- CPU 降级只认 `exceededCpu` / `exceeded CPU` / `CPU time limit`，排除 `tts_*`、`put:`、`subrequest`；旧模型的“两轮失败拆片”规则保留但同样排除 `put:`/subrequest。
- 单片 4 轮（每轮 1 + 2 次步骤重试），轮间等待 30 s / 2 min / 5 min，之后该片 `failed`、继续后续片；累计 3 片失败即提前停止。结束时有失败片 → 任务 `failed`（`tts_failed: <首个失败片错误>`），就绪片照常可播。
- 同键重试（`POST /api/audio/:id/regenerate`，同音色同语气）：`failed`/`budget_exceeded` 在原任务续跑（200，`resumed: true`；只重置 failed 片，保留预留与已就绪片），其他状态原样返回（200，`resumed: false`）；不再软删重建。切到另一键且该键已有任务（含 failed）→ 返回并续跑该任务（`reused: true`）。
- 任务视图直接拼接已校验的 `marks` 字符串，输出与旧实现逐字节一致。
- 语气：提示要求 ≥ 2 项具体描述；`validateStyle` 去掉含默认词（平稳/适中/客观/自然/中性…）或否定句的分句后需命中 ≥ 2 类（情绪/语速/停顿/音高），且 ≥ 10 字；否则按内容（对话/文言/说明/叙事）用 `STYLE_PRESETS` 兜底。重新生成到新键时旧的默认式 style 不再复制。预设未做付费实测。
- 发布顺序：`wrangler d1 migrations apply`（0009，--remote）→ commit/push → `npm run app:deploy`（含 cron）→ 线上验证。

### 前端（F1，Opus 5.5）

- **报错（反馈 2）**：轮询失败静默重试（指数退避），连续失败 ≥ 3 次才提示，播放不中断时用轻提示而非错误态；片加载失败自动重试 2 次再提示。
- **跟随章节（反馈 3）**：播放器打开时，若阅读器当前章节（`ChapterSource` 的 chapterKey）变为另一章并停留 ≥ 2 秒，且“跟随”开启，则切到该章的朗读（查找或创建任务，从头播放）；跟随关闭时在播放器显示“朗读本章”按钮。朗读自动翻到下一章引起的章节变化不触发切换。
- **连续播放（反馈 4）**：`ChapterSource` 增加“下一章”提取（EPUB/MOBI 按目录下一项、PDF 下一大纲项、TXT 下一标题）。当前章剩余播放时长 ≤ 5 分钟（或剩余未生成不足时更早）时为下一章创建任务（同音色同语气）；当前章播完自动打开下一章任务并播放，阅读器跟随翻到下一章。设置里可关“连续播放”（默认开）。
- 重试按钮调用续跑（不重建）。

### 翻页按钮（U1，Sonnet 5.5）

- 阅读页左右边缘各一个半透明翻页按钮（EPUB、MOBI、PDF、CBZ；TXT 为上/下翻一屏），移动端和桌面端都显示；不遮挡正文点选和笔记选择，避开底部播放器，键盘可聚焦，`aria-label` 为“上一页/下一页”。复用现有 prev/next/step 逻辑。

## 验收

- 单测：接续不在 Workflow 内创建实例；cron/GET 幂等启动；错误分类；续跑只重置 failed 片、不重复计预算；同键创建返回原任务；`jobView` 不解析 marks 且输出不变；style 校验与兜底；前端轮询退避、章节切换判定、下一章提取、预取时机。
- `npm test`、类型检查、构建、`npm run verify:public` 通过。
- 线上：一章 ≥ 100 片的长章节完整生成且无 subrequest depth 错误、无误降级；失败后重试只补失败片；auto 与 plain 的 style 明显不同；连续播放预取下一章。浏览器交互（报错提示、章节跟随、连续播放、翻页按钮）需用户实测。

## 部署与回退

`commit → push → npm run app:deploy（含 cron 触发器）→ 线上验证`。回退到 `7ba598d7`；新增字段/状态对旧代码无害（如有迁移，需保持向后兼容）。

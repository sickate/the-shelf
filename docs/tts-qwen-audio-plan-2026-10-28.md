# 朗读改用 qwen-audio-3.1-tts-flash（2026-10-28）

状态：计划，开发中。未上线。

## 背景与实测

- `qwen3-tts-instruct-flash-realtime` 已下线（`Model not exist`）。用户已把 Key 权限改为全部模型，选定 `qwen-audio-3.1-tts-flash`。
- 该模型**不走** realtime 接口（realtime 返回 `Model not found`），走 inference 协议：`wss://dashscope.aliyuncs.com/api-ws/v1/inference`，`Authorization: Bearer <key>`。
  - `run-task`（`header: {action, task_id: UUID, streaming:"duplex"}`；`payload: {task_group:"audio", task:"tts", function:"SpeechSynthesizer", model, parameters:{text_type:"PlainText", voice, format:"mp3", sample_rate:24000, bit_rate:64, volume:50, rate:1, pitch:1, word_timestamp_enabled:true, instruction?}, input:{}}`）→ `task-started` → `continue-task {input:{text}}` → `finish-task` → 多个 `result-generated`（音频为**二进制帧**；JSON 帧带 `output.sentence.{index, words:[{text, begin_index, end_index, begin_time, end_time}]}`，同一句会多次推送、words 累积）→ `task-finished`（`usage.characters`）或 `task-failed`（`header.error_code/error_message`）。
  - 实测（31 字中英混排）：`instruction` 被接受；`bit_rate:64` 得 64 kbps CBR MP3（约 0.48 MB/分钟，默认 160 kbps）；计 51 字符；`begin_index` 看起来是**词序号**而非字符偏移（"。T"、"aleb" 各占一个序号），需按词文本顺序对齐回片文字。多句时 `begin_time` 是否跨句累计**未验证**。
- 价格：未找到北京区官方价，以百炼控制台为准；用户已同意按量计费。
- 用户决定：**默认男声 `xunanchuan_v3.1`**；可选 `longanhuan_v3.1`、`longanlingxin_v3.1`、`longanfengyue_v3.1`。朗读语气两档：`auto`（LLM 选的 style 作为 `instruction`，默认）与 `plain`（不发 instruction），用户可在播放器切换（切换 = 重新生成）。

## 范围

- 做：新 TTS 客户端；任务记录模型与语气档；每片保存逐词时间标记并在任务视图返回；播放器音色/语气选择；跟读高亮优先用真实时间标记。
- 不做：改旧任务（旧任务、旧音频、旧 Cherry 等音色继续可播放；旧模型代码保留，仅新任务用新模型）；SSML；方言。

## 契约

- 迁移 `0008_audio_tts.sql`（增量、幂等）：`audio_jobs.tts_model TEXT`（旧行为 NULL = `qwen3-tts-flash-realtime`）、`audio_jobs.tone TEXT NOT NULL DEFAULT 'auto'`（`auto`/`plain`）、`audio_pieces.marks TEXT`（见下）。唯一索引改为 `(book_id, chapter_key, source_sha256, voice, tone) WHERE deleted_at IS NULL`（删旧建新）。
- API：创建 `POST /api/books/:id/audio` 和 `POST /api/audio/:id/regenerate` 接受可选 `tone`；`GET /api/books/:id/audio?chapterKey=&voice=&tone=` 可按音色/语气查找（缺省返回最新）。任务视图增加 `tone`、`ttsModel`。
- 片：`AudioPiece.marks?: number[]`，扁平数组 `[charOffset0, ms0, charOffset1, ms1, …]`，`charOffset` 为片 `text` 的 UTF-16 偏移，`ms` 为该词在本片音频内的起点；按偏移递增；每片 ≤ 约 2 KB（太长时只保留句首标点后的词）。
- 前端：`VOICES` 改为 `[{id, label}]`（许南川（男）/龙安欢/龙安灵心/龙安风悦），`DEFAULT_VOICE = "xunanchuan_v3.1"`；旧任务的旧音色在选择框里显示为“旧音色”。语气选择“自动语气 / 不加语气”。`sentenceAt` 在有 `marks` 时用真实时间，否则沿用按字数估算。

## 分工

| # | 任务 | 模型 | 依赖 |
| --- | --- | --- | --- |
| Q1 | 先用小样（≤ 200 字、≥ 3 句、2 段）验证多句时间戳与 `begin_index` 语义；新 TTS 客户端（超时、非空、MP3 校验、错误码、二进制帧拼接、时间标记对齐）、迁移、任务/片/视图/API、Workflow 按任务模型选择客户端、测试 | Opus 5.5（AI 调用、迁移、持久任务） | 无 |
| Q2 | 前端：音色/语气选择、默认男声、`marks` 用于跟读、mock、测试 | Sonnet 5.5 | 契约 |

## 验收

- 单测：协议事件序列（mock WebSocket）、失败/超时/无音频、时间标记对齐（中英混排、标点合并的词）、迁移后唯一键含 tone、旧任务视图不变、tone 校验、访客 401。
- `npm test`、类型检查、构建通过。
- 线上：同一章分别以 auto、plain 生成一次；每段 ≤ 20:00；片带 `marks`；预算与 R2 字节一致；旧任务仍可播放。浏览器高亮对齐需用户实测。

## 部署与回退

`d1 migrations（0008，--remote）→ commit → push → npm run app:deploy → 线上验证`。回退：重新部署上一 Worker 版本（新列/索引对旧代码无害：旧代码插入时 tone 取默认 auto，不违反新唯一索引）。

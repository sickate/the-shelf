# 朗读改用 qwen-audio-3.1-tts-flash（2026-10-28）

状态（2026-10-28）：已上线（Worker `7ba598d7`；迁移 0008 已在远端执行）。首次发布 `745f9497` 在 Workers 中合成失败（`tts_no_audio`、握手超时、upgrade 520，并误触发 `repeated_failure` 降级到 120 字），已回退到 `f76f0a85`、恢复 200 字；修复（二进制帧兼容、诊断码、qwen-audio 连接错误不触发 CPU 降级）后重发。线上验收：同一约 400 字小样 auto/plain 各 2 片全部 ready，xunanchuan_v3.1，64 kbps，每片约 160 个时间标记，每次计 688 字符；Range 206、访客 401、旧任务可读、预算含 audioBytes。**浏览器播放、语气差异听感与高亮对齐待用户实测。**

## 背景与实测

- `qwen3-tts-instruct-flash-realtime` 已下线（`Model not exist`）。用户已把 Key 权限改为全部模型，选定 `qwen-audio-3.1-tts-flash`。
- 该模型**不走** realtime 接口（realtime 返回 `Model not found`），走 inference 协议：`wss://dashscope.aliyuncs.com/api-ws/v1/inference`，`Authorization: Bearer <key>`。
  - `run-task`（`header: {action, task_id: UUID, streaming:"duplex"}`；`payload: {task_group:"audio", task:"tts", function:"SpeechSynthesizer", model, parameters:{text_type:"PlainText", voice, format:"mp3", sample_rate:24000, bit_rate:64, volume:50, rate:1, pitch:1, word_timestamp_enabled:true, instruction?}, input:{}}`）→ `task-started` → `continue-task {input:{text}}` → `finish-task` → 多个 `result-generated`（音频为**二进制帧**；JSON 帧带 `output.sentence.{index, words:[{text, begin_index, end_index, begin_time, end_time}]}`，同一句会多次推送、words 累积）→ `task-finished`（`usage.characters`）或 `task-failed`（`header.error_code/error_message`）。
  - 实测（31 字中英混排）：`instruction` 被接受；`bit_rate:64` 得 64 kbps CBR MP3（约 0.48 MB/分钟，默认 160 kbps）；计 51 字符；`begin_index` 看起来是**词序号**而非字符偏移（"。T"、"aleb" 各占一个序号），需按词文本顺序对齐回片文字。多句时 `begin_time` 是否跨句累计**未验证**。
- Q1 实测（2026-10-28，`xunanchuan_v3.1`，`bit_rate:64`，`word_timestamp_enabled:true`；4 次小样，82–180 字，中英混排、2 段、≥ 3 句）：
  - **一次 `continue-task` = 一个 sentence**（`index:0`），不按句号拆分；`begin_time`/`end_time` 是相对本任务音频起点的毫秒。拆成多个 `continue-task` 时 `index` 递增，`begin_time` 与 `begin_index` 都**跨句累计**。实现：每片只发一次 `continue-task`（含换行没问题，换行在 `normalized_text` 里被去掉）。
  - `begin_index`/`end_index` 是**词序号**（与字符偏移无关）。词 `text` 取自 `normalized_text`：半角标点转全角（`,`→`，`、`!`→`！`、`'`→`’`、引号有时转 `“”`），标点**粘在下一个词前**（`，Alice`、`！”她`、`。The`），句末标点粘在最后一个词后（`吧。`、`’s go！`），英文词带前导空格（` weather`），数字被读法替换（`2026年10月`→`二零二六年十月`，`第3章`→`第三章`）。对齐：按词的首个字母/数字在游标后 24 个 UTF-16 单位内查找、贪婪吃掉其余字母/数字；找不到的（数字读法）跳过；跳过数字后找到的中文数字也跳过；片首若无标记补 `[0, 首词时间]`。
  - `result-generated` 的 `output.type` 依次为 `sentence-begin`（带 `original_text`/`normalized_text`）→ 多个 `sentence-synthesis`（words 累积，有的为空）→ `sentence-end`（**完整 words** + 累计 `usage`）；之后 `task-finished`（`usage.characters`，CJK 计 2）。二进制音频帧全部在 `sentence-end` 之前到达。实现取每个 sentence 最长的 words 列表。
  - MP3：ID3v2 开头、MPEG-2 Layer III 24 kHz 单声道 **64 kbps CBR**（约 8 KB/s）；`mp3Info` 时长与 `afinfo` 一致（14.352 s / 598 帧、31.32 s、13.272 s、11.88 s）。`AUDIO_BYTES_PER_CHAR = 4000` 仍明显多预留（实测约 1.4–1.7 KB/字）。
  - 用应用内客户端经 `ws` 适配器实测通过：82 字 → 95 KB、11.88 s、30 个标记、3.6 s。
- 价格：未找到北京区官方价，以百炼控制台为准；用户已同意按量计费。
- 用户决定：**默认男声 `xunanchuan_v3.1`**；可选 `longanhuan_v3.1`、`longanlingxin_v3.1`、`longanfengyue_v3.1`。朗读语气两档：`auto`（LLM 选的 style 作为 `instruction`，默认）与 `plain`（不发 instruction），用户可在播放器切换（切换 = 重新生成）。

## 范围

- 做：新 TTS 客户端；任务记录模型与语气档；每片保存逐词时间标记并在任务视图返回；播放器音色/语气选择；跟读高亮优先用真实时间标记。
- 不做：改旧任务（旧任务、旧音频、旧 Cherry 等音色继续可播放；旧模型代码保留，仅新任务用新模型）；SSML；方言。

## 契约

- 迁移 `0008_audio_tts.sql`（增量、幂等）：`audio_jobs.tts_model TEXT`（旧行为 NULL = `qwen3-tts-flash-realtime`）、`audio_jobs.tone TEXT NOT NULL DEFAULT 'auto'`（`auto`/`plain`）、`audio_pieces.marks TEXT`（见下）。唯一索引改为 `(book_id, chapter_key, source_sha256, voice, tone) WHERE deleted_at IS NULL`（删旧建新）。
- API：创建 `POST /api/books/:id/audio` 和 `POST /api/audio/:id/regenerate` 接受可选 `tone`（`auto`/`plain`，否则 400 `bad_tone`）；`GET /api/books/:id/audio?chapterKey=&voice=&tone=` 可按音色/语气查找（缺省返回最新；无匹配 404；非法值 400）。任务视图增加 `tone`、`ttsModel`（旧任务 `qwen3-tts-flash-realtime`）。旧音色（Cherry 等）在创建/重新生成里映射为默认音色，不报 400；查找时按原值精确匹配。
- 重新生成（Q1 实现）：目标（音色, 语气）与原任务相同 = 重试，软删原任务并新建（201）；目标已有可用的活任务（非 failed/budget_exceeded）→ 直接返回该任务（200，`reused: true`，不合成）；否则新建（201，`reused: false`），原任务若已 ready 则保留（切回免费），否则软删并停止其 Workflow。新任务一律用新模型，复用已清洗块与 style。
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

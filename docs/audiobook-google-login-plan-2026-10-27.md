# 有声书朗读 + Google 登录（2026-10-27）

状态（2026-10-28 更新）：
- G1/G2 已上线：只能用 Google 白名单账号登录（用户浏览器验收通过），密码登录与 `OWNER_PASSWORD` 已删除；脚本用 `OWNER_API_TOKEN`。
- 朗读后端 A1 已上线（迁移 0007、`DASHSCOPE_KEY`、Workflow `the-shelf-audio`；Worker 版本 `3815c225`），朗读按钮已开启。
- 线上 HTTP 验收（2026-10-28）：
  - 小样（中英混排+脚注）：LLM 整理生效，脚注/参考文献/URL/图表引用删除，语气“平稳、客观、语速适中的讲解语气，像纪录片旁白”；Range 206、访客 401。首次验收发现校验比例过严（0.58 < 0.6）等问题，已修复（`cb3bb83`）。
  - 长章节《唐史演义》第五十六回（6,366 汉字）：43 片、12 个 Workflow 实例接续、用时约 12.5 分钟；两段 19.29 + 10.39 分钟（均 ≤ 20:00）；无 CPU 降级、无 LLM 回退；计费 13,893 字符（约 ¥1.4）；约 0.71 MB/分钟，预算已计入、无残留预留。
  - 已知问题：半文言时长估算偏低（估 22 分钟，实际 29.7 分钟）；无标记的正文夹批（如“应五十四回”）未删除。
- 未验收：真实浏览器中的章节提取（EPUB/MOBI/PDF/TXT）和播放器交互；instruct 语气模型待 Key 开放 `qwen3-tts-instruct-flash-realtime`。

用户决定：TTS 用用户新建的 the-shelf 专用 DashScope Key，同意阿里云按字符计费；Google 登录只允许白名单所有者，**去掉密码登录**；CPU 不够时先把每片缩到约 200 字。

用户需求：

1. 阅读页点“朗读”，系统在后台生成当前章节的语音。先用 LLM 整理文本（去掉脚注、不需读出的括号内容、符号、批注、引文出处等），再用类似 `../read-ai` 的语音合成转成语音。
2. 播放控件可控制进度和速度。
3. 单段语音不超过 20 分钟；章节过长拆成多段。
4. 支持中英文混读。
5. 登录改为可用 Google 授权。

## 现状与约束

- 线上应用是 `app/`：单 Worker（Workers **Free**，单次调用 10 ms CPU、50 个子请求），D1 `the-shelf-app`，私有 R2 `the-shelf-first-book-20261023`。登录为单一所有者密码 + HMAC cookie（`shelf_session`）。
- 阅读器在浏览器里解析 EPUB/MOBI/AZW（epub.js / foliate）、PDF（pdf.js）、TXT/MD；已有 `lib/excerpt.ts` 提取正文的先例。
- LLM：`oai.parallelstreamllc.com /v1/tasks`（`gpt-luna`，全服务**同时只跑一个**任务，忙时 503 + `Retry-After`，无幂等，超时可能已执行）。该服务**不提供 TTS**。
- read-ai 的朗读：阿里云 DashScope `qwen3-tts-flash`（`MultiModalConversation`，音色 Cherry 等，`language_type: Auto` 支持中英混读）。HTTP 非流式接口每次约 ≤ 600 字、输出 **WAV**（24 kHz 16 bit，约 2.9 MB/分钟），返回限时签名 URL。实时版 `qwen3-tts-flash-realtime`（WebSocket）支持 MP3/Opus 输出。本项目目前**没有 DashScope Key**。
- AGENTS.md：R2 全部登记责任合计 ≤ 8,000,000,000 bytes、单文件 ≤ 20,000,000 bytes，预算在 D1 原子检查；新 R2 写入必须计入。默认私有，写操作校验 Origin。

## 决定（默认值，用户可改）

### 朗读

- **仅所有者可用**（与阅读权限一致）。支持 EPUB、MOBI/AZW3、TXT/MD、带文本层的 PDF；扫描版 PDF、CBZ 不支持（按钮提示“无可朗读文字”）。
- **章节 = 阅读器当前所在的目录项**：EPUB/MOBI 取当前 spine 节（目录项跨多节时合并到下一个目录项为止）；PDF 取当前页所在大纲项到下一个大纲项的页范围，无大纲时从当前页起取 30 页；TXT 按“第X章/Chapter N/#”标题识别章节，识别不到时从当前位置取约 2 万字。章节文本由浏览器提取后提交，单章上限 300,000 字，超出提示“章节过长，从当前位置朗读前 30 万字”。
- **文本整理两步**：
  1. 规则预处理（确定性、可测）：脚注编号 `[1]`、`①`、上标数字、`※`、URL、邮箱、页眉页码行、连续符号行、`（见第 X 页）`、`[注]` 等。
  2. LLM 整理：按 ~6,000 字分块调用 `gpt-luna`（low effort，json_object），指令为“只删除不该读出的内容，可把少数符号改写成可读形式（如 `%` → 百分之），不得改写、概括、增补正文”。服务端校验：输出长度为输入的 60%–105%，且按字符的最长公共子序列覆盖输出 ≥ 95%（即输出几乎全部来自原文）；不通过则该块回退为规则预处理结果并记 `llm_fallback`，不重试。
- **语音合成**：DashScope `qwen3-tts-flash-realtime`（WebSocket，输出 MP3 单声道，目标 ~48 kbps，约 0.36 MB/分钟），音色默认 Cherry（中英混读），可在播放器里改音色（改音色 = 重新生成）。S0 已确认实际输出为 MP3（约 0.73 MB/分钟，见“S0 实测结论”）。
- **分段**：整理后的文本按句子切成 ≤ 500 字的“片”（合成调用单位）；片按顺序装入“段”，每段以**实际合成时长**累计，下一片会使该段超过 20:00 时开新段——保证每段严格 ≤ 20 分钟。生成前按语速估算（中文 ~4.2 字/秒，英文 ~2.6 词/秒）显示“约 N 段、约 M 分钟”。
- **存储**：每片一个 R2 对象 `audio/<jobId>/<seg>-<piece>.mp3`（每片 ~1–3 MB，远小于 20 MB），不再合并成大文件。段 = 片的有序清单（D1 记录时长）。这样第一片生成好就能开始播放，后台继续生成；也避免 Worker 内做大文件拼接。片字节在写 R2 **之前**原子预留预算并计入 `USED_SQL`；超预算则任务停在 `budget_exceeded`。
- **缓存**：同一书 + 章节定位 + 整理后文本 hash + 音色 只生成一次；再次点朗读直接播放已生成的结果。可手动“重新生成”。删除朗读缓存只做软删除（与书一致：不释放对象或预算）。
- **后台执行**：Cloudflare **Workflows**（Free 已做过长任务验证）。一个章节 = 一个 Workflow 实例，步骤：`clean-<i>`（LLM 块）→ `piece-<j>`（合成一片：预留预算 → WebSocket 收 MP3 → 写 R2 → 回填时长）。LLM 步骤遇 503 按 `Retry-After` 退避，最多 6 次；合成步骤最多重试 2 次，同一片 key 固定、覆盖写，预留按片记录不重复计。关闭页面不影响生成。
- **播放器**（阅读页底部浮条，可收起）：播放/暂停、段内进度条（拖动、显示 已播/总长）、±15 秒、速度 0.75/1/1.25/1.5/1.75/2（`playbackRate`，保持音高）、上一段/下一段与段选择、生成进度（“第 2 段生成中 37%”）、音色选择。片之间用第二个 `<audio>` 预加载下一片，近似无缝；进度条把片拼成段的统一时间轴。Media Session 支持锁屏/耳机按键。播放位置按“书+章节”记在本机，下次回来续播。

### Google 登录

- 保持**单一所有者**模型（笔记、阅读记录、上传都按所有者设计，多用户是另一项大改，本轮不做）。Google 账号只用来证明“你是所有者”：`OWNER_EMAILS`（逗号分隔，默认只有用户本人的 Gmail）里的、`email_verified` 为 true 的账号登录后得到与现在相同的所有者会话。
- **去掉密码登录**，分两次发布以免把自己锁在外面：第一次上线 Google 登录（密码仍可用），线上用白名单账号验收通过后，第二次发布移除 `/api/login` 密码分支、登录页密码框和 `OWNER_PASSWORD` secret。
- 本机脚本（`scripts/mvp-upload.mjs`、`scripts/lib/batch.mjs` 的 enrich/classify/reidentify）现在用密码换 cookie。改为**所有者 API 令牌**：secret `OWNER_API_TOKEN`（≥ 32 字节随机），脚本发 `Authorization: Bearer <token>`，服务端常量时间比较；只认 Bearer、不设 cookie，因此不受浏览器 CSRF 影响，Origin 校验对 Bearer 请求豁免。令牌放 `.env`（0600），不进 Git。
- 流程：`GET /api/auth/google` → 生成 `state` + PKCE（签名短期 cookie，10 分钟）→ 302 到 Google；`GET /api/auth/google/callback` 校验 state → 服务端用 client secret 向 `oauth2.googleapis.com/token` 换码 → 校验 id_token 的 `iss`/`aud`/`exp`/`email_verified`/`nonce` → 邮箱在白名单则签发会话 cookie，否则 403 页面“此 Google 账号无权访问”。会话签名内容改为 `owner:<expiry>:<emailHash>`，旧 cookie 在过渡期仍有效。
- 用户需要在 Google Cloud Console 创建 OAuth Web 客户端（同意屏幕保持 Testing、把自己加为测试用户即可，无需 Google 审核），回调地址 `https://the-shelf.iamzhutuo.workers.dev/api/auth/google/callback`（本地开发另加 `http://localhost:8787/...`）。Secrets：`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`OWNER_EMAILS`。

## S0 实测结论（2026-10-27，线上，约 20 次调用；临时资源已删除）

- `qwen3-tts-flash-realtime`（北京区 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime`）真实输出 MP3：24 kHz 单声道 VBR，均值约 100 kbps，约 0.73 MB/分钟；**无 Xing 头**，时长由服务端按帧计算存 D1。MP3 码率不可调；opus 可调码率但 Ogg 时间戳错误，暂不用。
- 流程：`session.created` → `session.update {voice, mode:"commit", language_type:"Auto", response_format:"mp3", sample_rate:24000}` → `input_text_buffer.append` / `commit` / `session.finish` → `response.audio.delta`（base64）… `response.done`（`usage.characters`）→ `session.finished`；服务端不主动关连接。
- Worker 与 Workflow `step.do` 内出站 WebSocket、R2 写入均可用。CPU：~200 字约 15 ms，~500 字约 36 ms（Workflow 内约 68 ms），主要耗在接收 base64；均未被 `exceededCpu` 终止，但 Free 10 ms 不保证一直宽松。
- **用户决定**：先用 Free + 每片约 200 字；出现 CPU 超限终止时自动把该片拆小并把全局片长降到约 120 字，并在状态中提示。默认音色 Cherry。
- 语速约 21 秒/100 中文字，20 分钟段约 5,700 字。每片延迟 8–12 秒（200 字）。约 14 次中 3 次 1006 断开且无音频：每片需超时、重试与非空校验。
- 计费：中文每字按 2 字符计；约 ¥2/万中文字。CosyVoice 仍未开放（不需要）。
- 本机 macOS 12.6 无法运行 workerd（需 13.5+），本地只做 Node 测试，Workers 运行时行为在线上验收。

## 数据（迁移 `app/migrations/0007_audio.sql`，A1 最终设计）

- `audio_jobs`：在草案基础上增加 `style`（LLM 按内容选的朗读语气，或默认中性语气）、`piece_chars`（200，CPU 降级后 120）、`billed_chars`、`cpu_downgraded`、`total_pieces`/`done_pieces` 默认 0。唯一约束改为**部分唯一索引** `(book_id, chapter_key, source_sha256, voice) WHERE deleted_at IS NULL`，以便软删除后同键可以重新生成。
- `audio_blocks`（新增）：LLM 整理块（约 6,000 字，段落边界），`raw` 在整理后清空（不长期保存原文），`cleaned` 保留供重新生成复用；`llm_status` ∈ pending/llm/fallback/short，`llm_attempts`，`split_done`。
- `audio_pieces`：`seq = 块×65536 + k×16`（间隙供拆片），增加 `block`、`est_ms`、`billed_chars`、`attempts`、`error`、`cpu_split`；status 增加 `split`（拆分后的父片，保留其预留/字节）。`segment` 在片就绪时按实际时长确定。R2 key 为 `audio/<jobId>/<seq>.mp3`（不含段号，因为段在合成后才确定）。
- `audio_settings`（单行）：全局 `piece_chars`、`cpu_downgraded_at`、`downgrade_reason`。

`USED_SQL` 增加 `SUM(COALESCE(size_bytes, reserved_bytes)) FROM audio_pieces`（含软删除任务和拆分父片）。

## 接口（全部 `requireOwner`，写操作校验 Origin）

见 `docs/mvp-plan.md` “2026-10-27 朗读（A1）”。与草案的差异：创建返回 201（命中缓存 200 且 `duplicate:true`）；任务视图另含 `style`、`pieceChars`、`cpuDowngraded`、`llmFallbackBlocks`、`billedChars`；片接口支持 HEAD；`/api/budget` 增加 `audioBytes`。语气：LLM 整理时同时返回 `style`，第 0 块的结果写入任务；TTS 模型由 `TTS_MODEL` 配置（默认 `qwen3-tts-flash-realtime`，名称含 `instruct` 时把语气作为 `instructions` 发送）。

## 分工

| # | 任务 | 模型 | 依赖 |
| --- | --- | --- | --- |
| S0 | Spike：在 workerd 本机和线上临时 Workflow 中各跑一次 `qwen3-tts-flash-realtime` WebSocket，量 CPU（需 < 10 ms/步）、确认 MP3 输出、码率参数、中英混读效果、单次字数上限 | Opus 5.5 | DashScope Key |
| G1 | Google OAuth：路由、state/PKCE、id_token 校验、白名单、会话格式过渡、登录页按钮、API 令牌与脚本改造、测试 | Opus 5.5（鉴权） | 无（线上验收需 OAuth 客户端） |
| G2 | 移除密码登录（服务端分支、登录页、secret、测试） | Sonnet 5.5 | G1 线上验收通过 |
| A1 | 迁移 0007、预算计入、音频 API、Workflow（LLM 整理 + 合成 + 分段）、规则预处理与 LLM 输出校验、测试 | Opus 5.5（持久任务、AI、预算） | S0 |
| A2 | 各格式“当前章节文本”提取（`lib/chapter-text.ts`），含 PDF 大纲范围、TXT 章节识别、单测 | Sonnet 5.5 | 无 |
| A3 | 播放器组件（片拼段时间轴、预加载、调速、续播、Media Session）与阅读页接入 | Sonnet 5.5 | A1 接口契约（可先用 mock） |

G1、A2 可立即并行；A1 等 S0 结论；A3 与 A1 按契约并行。主 Agent review 每个交付并做功能验证。

## 验收

- 单测：规则预处理用例（脚注/括号引文/URL/页码）；LLM 输出校验（删多了、改写、增补均被拒）；分段算法（任意时长序列下每段 ≤ 20:00）；预算预留与超额；OAuth state 失配、aud/iss 错、未验证邮箱、非白名单邮箱、过期 id_token 均拒绝；访客 401。
- 本机 workerd：Workflow 全流程（LLM 与 TTS 用 mock），中断后续跑不重复计预算。
- 生产：一章中英混排 EPUB（> 20 分钟以触发分段）、一章 TXT、一章文字 PDF 各生成一次；检查脚注已去除、每段 ≤ 20:00、拖动/调速/切段/续播可用、第一片就绪后即可播放；R2 用量与 D1 预算一致。Google 登录：白名单账号成功、其他账号被拒、登出后失效；脚本用 API 令牌上传/归类成功；G2 后 `/api/login` 返回 404。
- 回退：重新部署上一 Worker 版本；新表与已生成音频保留无害；G1 出问题时密码登录仍在；G2 之后若 Google 不可用，回退到 G1 版本即恢复密码登录。

## 风险

- **Workers Free 10 ms CPU**：只计 JS 实际运算，等待 TTS/LLM/R2 的网络时间不计。主要 CPU 是把收到的 base64 音频解码成字节并拼接（每片 MP3 约 1–3 MB）。Spike 不过时把片缩到约 200 字（每片约 50 秒、0.3 MB）。片不需要合并：播放器本来就把片拼成一段时间轴。代价是片间衔接点多约 2.5 倍（预加载下一片，听感上是句末多一点停顿），合成调用、R2 对象、Workflow 步骤数同比增加（仍在免费额度内）。仍不够再问用户是否升级 Workers Paid（本轮不改套餐）。
- 若只能用 HTTP `qwen3-tts-flash`（只出 WAV）：20 分钟 WAV ≈ 58 MB，超单文件 20 MB 且很快耗尽 8 GB；Worker 内转码不可行。届时需改用其他能直接出 MP3/Opus 的接口（如 DashScope CosyVoice），再请用户确认。
- 费用：DashScope 按字符计费（阿里云账号，非 Cloudflare），一章 2 万字约几元人民币以内，具体以阿里云当期价格为准。生成前显示估算字数。
- LLM 服务同一时间只跑一个任务：长章节整理可能需要数分钟；整理在后台进行，播放器显示进度。
- 存储：48 kbps 下 1 小时约 22 MB；整本 10 小时书约 220 MB。

## 待用户提供

1. the-shelf 专用 DashScope API Key（放 `.env` 的 `SHELF_DASHSCOPE_KEY`，再 `wrangler secret put DASHSCOPE_KEY`）。
2. Google Cloud OAuth Web 客户端的 Client ID / Secret（同意屏幕 Testing，测试用户加自己；回调地址见上），以及白名单邮箱。

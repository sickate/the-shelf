# 有声书朗读 + Google 登录（2026-10-27）

状态：计划已确认（2026-10-27），待 DashScope Key 到位后做 S0。未实现、未部署。

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
- **语音合成**：DashScope `qwen3-tts-flash-realtime`（WebSocket，输出 MP3 单声道，目标 ~48 kbps，约 0.36 MB/分钟），音色默认 Cherry（中英混读），可在播放器里改音色（改音色 = 重新生成）。若 Spike 证明实时接口在 Workers 上不可用，退回 HTTP `qwen3-tts-flash` 必须解决 WAV 体积问题（见风险）。
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

## 数据（迁移 `app/migrations/0007_audio.sql`）

```sql
CREATE TABLE IF NOT EXISTS audio_jobs (
  id TEXT PRIMARY KEY,                -- a_<random>
  book_id TEXT NOT NULL REFERENCES books(id),
  chapter_key TEXT NOT NULL,          -- 定位：cfi/href | pdf 页范围 | text 偏移，≤ 500 字节
  chapter_label TEXT,
  source_sha256 TEXT NOT NULL,        -- 提交原文 hash
  voice TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','cleaning','synthesizing','ready','failed','budget_exceeded')),
  workflow_id TEXT,
  est_seconds INTEGER, total_pieces INTEGER, done_pieces INTEGER NOT NULL DEFAULT 0,
  error TEXT, llm_fallback_blocks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  UNIQUE (book_id, chapter_key, source_sha256, voice)
);
CREATE TABLE IF NOT EXISTS audio_pieces (
  job_id TEXT NOT NULL REFERENCES audio_jobs(id),
  seq INTEGER NOT NULL,               -- 全章顺序
  segment INTEGER,                    -- 合成后按实际时长确定
  text TEXT NOT NULL,                 -- 整理后片文本（≤ 500 字）
  r2_key TEXT, size_bytes INTEGER, reserved_bytes INTEGER, duration_ms INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending','ready','failed')),
  PRIMARY KEY (job_id, seq)
);
```

`USED_SQL` 增加 `SUM(COALESCE(size_bytes, reserved_bytes))`（含软删除的任务）。章节原文不长期保存（整理后的片文本保留，供重生成与以后做“跟读高亮”）。

## 接口（全部 `requireOwner`，写操作校验 Origin）

| 方法 路径 | 说明 |
| --- | --- |
| POST /api/books/:id/audio `{chapterKey, label, text, voice?}` | 文本 ≤ 300,000 字、body ≤ 1.2 MB。命中缓存返回现有任务；否则建任务、启动 Workflow，返回 `{job}`（含估算段数/时长） |
| GET /api/books/:id/audio?chapterKey= | 本章已有任务（或 404） |
| GET /api/audio/:jobId | 任务状态 + 段与片清单 `{segments:[{index, durationMs, pieces:[{seq, durationMs, ready}]}], status, donePieces, totalPieces}` |
| GET /api/audio/:jobId/pieces/:seq | 片 MP3，支持 Range，`Cache-Control: private, max-age=86400` |
| POST /api/audio/:jobId/regenerate `{voice?}` | 新任务（旧任务软删除） |
| DELETE /api/audio/:jobId | 软删除 |
| GET /api/auth/google、GET /api/auth/google/callback | 见上 |
| GET /api/me | 增加 `{owner, email?}` |

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

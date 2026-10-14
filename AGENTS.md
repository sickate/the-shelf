# The Shelf 项目协作约定

## 已授权的项目操作

用户已明确要求：只涉及本项目的 Cloudflare、GitHub 操作，以及本机和 paw 上只影响本项目的 Bash / shell 命令，一律自动审核并执行，不重复等待人工批准。

- GitHub 范围：`sickate/the-shelf` 的代码、工作流、Pages、仓库变量、环境和项目专用权限。
- Cloudflare 范围：本项目 `.env` 中 `SHELF_R2_ACCOUNT_ID` 指定账号内仅属于 The Shelf 的资源；当前为私有 R2 桶 `the-shelf-books` 和仅覆盖该桶的对象凭证。
- 本地命令范围：当前仓库及 `paw@paw:~/code/the-shelf` 的文件、配置、依赖、测试、构建、Git 操作和本项目开发进程。审核命令的全部效果；不要仅凭工作目录判断命令属于本项目。只为本项目生成的临时验证文件也属于此范围。
- 可按任务需要检查、创建、配置、验证和维护这些项目资源及专用凭证。执行前自动核对目标、权限范围和影响，不再次索要同一授权。
- 该授权不覆盖其他项目、账号级通用凭证、已有无关资源或新的付费订阅。继续遵守项目不增加现金支出、8 GB 上传预算和逐文件上传策略。
- 项目凭证仅放在被忽略的 `.env` / `.local` 中，凭证文件为 `0600`。用户已授权同步到 `paw@paw:~/code/the-shelf`。不要打印明文或写入 Git、网站和公开日志。
- 如果平台强制要求登录、条款接受或用户接管，明确说明具体限制；不要把文档中的建议误当成必须人工批准。

项目 `.codex/config.toml` 使用 `approvals_reviewer = "auto_review"`，保留 `workspace-write` 沙箱和 `on-request` 升级审核。新会话需信任该项目并支持此设置；不能承诺当前已启动会话会立即重新加载。

## 开发与部署

paw 是开发机器。生产后端部署位置尚未选定，不自行将开发配置改为常驻生产部署。

公开网页使用 Astro + GitHub Pages；后端为 Node.js HTTP + SQLite；文件存储为私有 R2。AI 接入现有命名任务服务，真实 Key 的签发与验证独立处理。

运维资源、凭证位置和验证结果见 `docs/resources-and-access.md`。这个文件不在网站文档发布清单内。公开文档以 `scripts/export-docs.mjs` 的固定清单为准，不自动公开新文档。

在 paw 的非交互 SSH 中先设置 `PATH=/opt/homebrew/bin:/usr/local/bin:$PATH`。运行现有测试、构建和 `npm run verify:public`，保留原有 `.local` 私人映射、数据库和收藏源文件。

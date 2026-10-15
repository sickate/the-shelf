# The Shelf 资源、权限与开发配置

更新日期：2026 年 10 月 15 日。本文是仓库运维记录，不在网站文档发布清单中，不包含真实凭证。现有资源验证记录来自 10 月 14 日；本次仅追加迁移计划与本地复验状态。

## 部署边界

`paw@paw:~/code/the-shelf` 是开发目录，未配置常驻服务、生产域名或反向代理。当前 Node.js 后端使用本机 HTTP 和 SQLite；已配置的 Cloudflare 资源仍只有私有 R2 文件存储。

10 月 15 日用户确认将 Cloudflare 统一托管加入计划，目标为 Workers Static Assets、Workers、D1 与 Workflows；先验证免费运行条件，再逐步迁移。尚未为这些服务创建项目资源、签发部署凭证或切换现有 GitHub Pages。实际资源名称、地址、绑定、权限与验证结果在实施时补录，任务顺序见 `docs/development-plan.md`。

## GitHub

| 项目 | 已核验配置 |
| --- | --- |
| 仓库 | `sickate/the-shelf`，公开仓库，默认分支 `main` |
| 本机与 paw 的 GitHub 身份 | 均为 `sickate`，对本仓库有管理和推送权限 |
| Pages | 使用 GitHub Actions 发布，强制 HTTPS |
| 网站 | <https://sickate.github.io/the-shelf/> |
| 发布环境 | `github-pages`，仅允许 `main` 部署 |
| Actions 默认权限 | `contents: read`；工作流另声明 `pages: write` 与 `id-token: write` |
| 最近一次发布核验 | [成功的 Pages 工作流](https://github.com/sickate/the-shelf/actions/runs/38430083904) |
| 前端 API 变量 | `PUBLIC_SHELF_API_URL` 尚未设置；确定生产 API 地址后再填写 |

paw 已有可用的 GitHub CLI 登录和 Git SSH 访问。本次复用其既有权限，不复制本机 GitHub 账号令牌。Pages 使用工作流临时令牌和 OIDC，不需要长期部署密钥，也不需要 Cloudflare 密钥。

通过非交互 SSH 运行时，Homebrew 工具可能不在默认 PATH 中，先执行：

```sh
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd ~/code/the-shelf
gh api repos/sickate/the-shelf --jq .permissions
```

## Cloudflare R2

已在项目 `.env` 中 `SHELF_R2_ACCOUNT_ID` 指定的 Cloudflare 账号创建私有 `the-shelf-books` 桶，使用 Standard 存储，位置提示为 APAC。`r2.dev` 公共访问关闭，未绑定匿名自定义域名。核验时整个账号显示存储占用为 0 B，账单使用量为 $0.00；未开通新的付费订阅。账号标识和真实凭证留在私人配置中。

已签发账号持有的长期令牌 `the-shelf-development`，状态为 Active，权限为 `Object Read & Write`，仅限定到 `the-shelf-books`，可读取、上传、列出和删除桶内对象。S3 Access Key ID 和 Secret Access Key 已写入本机与 paw 的被 Git 忽略的 `.env`，分别对应 `SHELF_R2_ACCESS_KEY_ID` 和 `SHELF_R2_SECRET_ACCESS_KEY`；账号和桶分别对应 `SHELF_R2_ACCOUNT_ID`、`SHELF_R2_BUCKET`。没有复制本机 Wrangler OAuth 凭证或其他项目的通用管理令牌。

若需吊销或轮换，在 Cloudflare R2 → Manage API Tokens 中按 `the-shelf-development` 名称管理。先签发相同单桶范围的新令牌，更新两端 `.env` 并验证后，再吊销旧令牌；不要把权限扩大到所有桶。

CORS 配置源在 `config/r2-cors.json`，已应用并从 Cloudflare 回读核验。仅允许 GitHub Pages 和本机 Astro 来源的 `GET`、`HEAD`，允许阅读器的 Range 请求并暴露相关响应头。生产网站来源变化时需同步调整桶规则。[Cloudflare CORS 文档](https://developers.cloudflare.com/r2/buckets/cors/)。

项目上传预算仍为 8,000,000,000 字节，每个文件不超过 20,000,000 字节。R2 免费额度按整个账号共享，必须先核对账号已有占用；配置预算不是 Cloudflare 的账单封顶。[R2 价格与免费额度](https://developers.cloudflare.com/r2/pricing/)。

本次不上传电子书。实际上传继续使用逐文件计划，传入 `--execute` 才执行。

## 私人配置与同步

`.env` 使用 `0600` 权限，`.local` 使用 `0700` 权限。开发环境已生成独立所有者密码，密码留在 `.env` 中，不写入文档、Git、前端 `PUBLIC_` 变量或 GitHub Actions。开发后端仅监听 `127.0.0.1:8787`；本机文件读取默认关闭。

同步只涉及项目配置和本次修改的源文件。paw 已有的私人书籍映射、SQLite、提取正文和源文件保持在原位置。本机私人文件映射不能替代 paw 自己的导入结果。

不要把 `.env` 当成 shell 脚本执行；项目命令通过 Node 的环境文件加载器读取它。

```sh
npm run server
npm run dev
```

在本机浏览器访问 paw 的开发环境，可建立 SSH 转发：

```sh
ssh -N -L 4321:127.0.0.1:4321 -L 8787:127.0.0.1:8787 paw@paw
```

然后打开 <http://127.0.0.1:4321/>。私有状态和凭证均被 Git 忽略；运行 `npm run verify:public` 检查发布产物。

## 自动审核授权

用户已授权本项目 Cloudflare、GitHub 操作及仅影响本项目的 Bash / shell 命令自动审核执行。授权记录在 `AGENTS.md`，实际项目设置在 `.codex/config.toml`，两者均已同步到 paw。

设置为 `approval_policy = "on-request"`、`approvals_reviewer = "auto_review"`、`sandbox_mode = "workspace-write"`。额外审核策略列明仓库、Cloudflare 项目资源、两端项目目录和凭证同步范围。它保留沙箱及自动审核，不关闭审批检查，也不授权无关项目或账号级通用凭证。

通过 Codex `config/read` 回读，确认本机 0.159.0 和 paw 0.162.1 均实际加载自动审核、项目范围及本地 Shell 授权。两端项目均已被各自 Codex 信任。后续新会话从本项目目录启动即可读取；已启动会话不保证热更新设置。[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 已完成的验证

| 验证 | 结果 |
| --- | --- |
| paw 运行环境 | Node.js 26.0.0、Python 3.14.5，具备 pdftotext |
| 现有测试 | 16 项 Node 测试、8 项 Python 测试全部通过 |
| Pages 构建 | 使用正式站点与 `/the-shelf/` 前缀，生成 1,280 个页面，含 1,264 个书籍详情 |
| 公开产物 | 加载实际 `.env` 的 `verify:public` 检查通过；本运维记录不在公开清单内 |
| 真实开发后端 | 临时本机监听，健康检查、所有者密码登录、会话读取通过；验证结束后关闭 |
| 真实 R2 对象访问 | 上传、完整读取、206 Range、Pages 与本机 CORS 均通过 |
| 私有边界 | 无签名请求被拒绝；不允许的 Origin 不获 CORS 访问 |
| 验证对象清理 | 只使用中性文本诊断对象，验证后已删除；没有上传电子书 |
| 项目审核配置 | 两端实际回读均为 `auto_review`，项目和 Shell 策略已加载 |

所有实际密钥与所有者密码仍仅保存在 `.env`。`npm run verify:public` 现会加载该文件，以便核对配置值未进入发布包。S3 匿名请求实际返回 400 `InvalidArgument`，属于拒绝访问；不能只把 403 视为成功的私有隔离检查。

## AI 与生产部署待办

`SHELF_OAI_BASE_URL` 和 `SHELF_OAI_KEY` 暂留空。现有任务入口只接受服务环境配置的 Key，旧管理页签发的数据库 Key 无法用于 `/v1/tasks`。专用任务 Key 需通过该服务的运维配置接入后验证；本次尚未修改现有 AI 生产服务或调用模型。

Cloudflare 为计划中的生产目标；免费 CPU、D1 持久化和 Workflows 长任务验证优先于真实 AI。生产站点与同源 API 地址、项目专用部署权限和 AI 任务 Key 仍待实施时确定。当前 R2 与 GitHub 已可供 paw 开发使用；AI 未配置时仍明确停用，不会发起模型请求。

10 月 15 日本地复跑 16 项 Node 测试、8 项 Python 测试、构建及公开产物隐私检查通过。此前已有的 R2、GitHub 与 paw 远端配置本次未重新核验。

## 公开仓库提交检查

用户确认保持仓库 public；GitHub Pages 在 Cloudflare 新站验收前继续使用。10 月 14 日提交前已检查待提交内容与全部已有 Git 历史，并使用独立离线密钥扫描器复核；实际 R2 Access Key ID、Secret Access Key 和所有者密码未出现在代码或历史中。扫描器提示的文档版本 SHA-256 已重新计算核对，测试用假凭证与类型判断均已逐项确认。

`.env`、`.local`、书籍原文件、SQLite、提取正文和临时扫描报告不进入 Git。公开产物检查使用通用私人路径检测规则，不把实际账号标识和私人挂载目录写进规则。两端 R2 配置和所有者密码逐项比对一致；paw 已有有效 GitHub CLI 登录及 SSH 仓库访问。

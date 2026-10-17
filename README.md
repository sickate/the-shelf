# The Shelf 电子书架

The Shelf 是公开展示个人电子书收藏、按权限提供下载和在线阅读、并支持按需 AI 问答的书库。优先使用免费资源；用户已接受确有必要时承担 The Shelf 合理超额费用。静态网页现由 Cloudflare Workers Static Assets 托管，GitHub Pages 保留回退；AI 接入已有服务。业务后端的生产部署位置尚未选定；paw 用于开发。

CF-02 静态迁移已上线到 https://the-shelf.iamzhutuo.workers.dev/。Cloudflare Workers 上只有公开静态资源，没有 API bindings；静态资源与所有书籍、文档入口已完成线上验收。GitHub Pages 工作流和站点保留为回退。Cloudflare CI 已构建并上传 artifact，但因单 Worker 专用 token 尚未配置，自动部署默认关闭；本机受控发布可用。CF-03 登录、私人阅读及业务 API 仍未上线。优先级与验收见[开发计划](docs/development-plan.md)。

第一版已实现真实收藏目录、分类搜索、文件详情、公开文档、个人登录、授权阅读和按需 AI 后端。R2 与 AI 需要配置凭证后启用；没有配置时不会上传文件或调用模型。

产品与实现文档从 [文档索引](docs/README.md) 开始。未来网站公开的文档区域与这里的文档使用同一份内容源，方便人和其他 AI 阅读。

## 本机运行

需要 Node.js 24 及以上、Python 3.9 及以上。PDF 文本提取需要可选的 pdftotext；MOBI 和 AZW3 需要先准备 EPUB 或正文。

```sh
npm ci
cp .env.example .env
npm run dev
```

网页默认在 http://127.0.0.1:4321/。配置 .env 中的所有者密码后，在另一个终端运行 npm run server；本机文件访问需明确开启 SHELF_LOCAL_FILES_ENABLED，并在自己的机器上导入收藏，生成被忽略的私人映射。

```sh
python3 scripts/import-books.py --root /path/to/books
npm run server
```

复制和导入不会修改源文件。超过 20 MB 的文件仍被登记，零字节文件标为异常。源路径、SQLite、提取正文和密钥均不进入仓库或静态发布包。

为后续检索和 AI 准备正文，可使用 `npm run prepare:text -- --file <fileId>` 预览单个 PDF/EPUB；加 `--execute` 才提取并生成带页码或章节定位、来源指纹的私有版本包。文件 ID 来自导入清单，输出仅保存在 `.local/prepared-text/`，不改原文件或现有清单。PDF 需要 pdftotext，EPUB 使用 Python 标准库；命令说明见 [正文准备工具](scripts/prepare-text.md)。准备后可用 `npm run text:select -- --file <fileId> --version <versionHash>` 验证拟选版本，加 `--execute` 才记录选择；重启本机后端后，问答、章节与全书总结使用该版本。选择命令会读取原书核验来源，运行任务时只需对应的正文包；不改原 manifest。云端同步和真实 AI Key 验证仍待后续验收。

云同步的离线基础现包含原书与正文共用的 SQLite 预算账本、正文版本登记和单对象恢复协议，说明见 [共享预算与同步模块](server/storage-authority.md)。该模块尚未接入旧上传命令、远端 D1 或真实 R2 客户端，不能据此认定正文已同步上线。

## 检查与发布

```sh
npm test
npm run build
npm run verify:public
npm run build:cloudflare
npm run verify:static
```

`build:cloudflare` 显式使用 Cloudflare 根路径，不受本机 Pages 基路径配置影响。可用 `SHELF_CF_SITE_URL` 覆盖目标 HTTPS origin；`verify:static --url https://...` 只读检查远端。GitHub Pages 工作流继续部署回退站；Cloudflare 工作流会构建、检查并上传 artifact，默认不自动部署。部署和后端配置见 [运行与部署](docs/runbook.md)。

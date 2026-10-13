# The Shelf 电子书架

The Shelf 是公开展示个人电子书收藏、按权限提供下载和在线阅读、并支持按需 AI 问答的书库。第一版以不增加现金支出为约束：网页使用 GitHub Pages，电子书使用免费存储额度，业务后端复用已有服务器和 AI 服务。

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

## 检查与发布

```sh
npm test
npm run build
npm run verify:public
```

GitHub Pages 工作流自动构建目录与全部详情，公开产品文档的 HTML、JSON 索引、单篇 Markdown 和合并 Markdown。部署和后端配置见 [运行与部署](docs/runbook.md)。

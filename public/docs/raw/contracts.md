# The Shelf 数据与接口契约

静态网站只消费经过筛选的公开目录和文档数据，后端单独读取私人文件映射。此契约统一导入、网页与后台实现，字段变更要同步消费方和验证。

更新日期：2026 年 10 月 14 日。阶段：开发契约。

## 公开目录

data/catalog.json 为公开输入，结构为 schemaVersion、generatedAt、sourceStatus、thresholdBytes、stats、categories、books。schemaVersion 为 1，thresholdBytes 为 20000000。sourceStatus 是 snapshot 或 scanned。

stats 包含 books、files、totalBytes、candidateBytes、candidateFiles、localOnlyFiles、invalidFiles。categories 是 id、name、count 的数组。

每本书包含 id、title、author（未知为 null）、category、categoryId、tags、description、files。id 为安全的稳定短标识，不能包含源路径。每个文件包含 id、format（PDF、EPUB、MOBI、AZW、AZW3 等大写格式）、sizeBytes、status、reason、visibility、readable。

status 使用 candidate、local_only、unavailable。candidate 仅说明大小合格且非空，仍未上传；local_only 说明因大小等原因只登记；unavailable 用于零字节等异常。reason 为 not_uploaded、size、empty 等明确原因。visibility 默认 private。readable 表示格式具备浏览器阅读能力（PDF 或 EPUB），不代表已授权或已上传。

public/data/catalog.json 可以复制公开输入。公开输出禁止 sourcePath、root、mtimeNs、textPath、storageKey、私人正文及任意密钥。

## 私人清单

.local/manifest.json 包含 schemaVersion、root、generatedAt、files。files 是以公开 file id 为键的对象，每项包含 path（源文件绝对路径）、bookId、format、sizeBytes、mtimeNs（十进制字符串）、eligibility（对应公开 status）、storageKey（缺省 null）、textPath（缺省 null）、visibility（缺省 private）。该文件必须被 Git 忽略。

后端验证真实文件仍在 root 内，非符号链接越界，大小与登记一致，文件非空且不超过门槛后才允许本机读取。大文件即使登录也不通过本地阅读接口绕过门槛。R2 文件使用 storageKey 映射，云端凭证只在服务端。

## 文档导出

scripts/export-docs.mjs 从明确列出的公开文档生成 data/docs.json 与 public/docs 的原文、合并原文和索引。

data/docs.json 包含 generatedAt、version、documents；每项包含 id、title、description、updatedAt、version、markdown、htmlPath、rawPath。README 的文档 ID 使用 overview，其他文件使用不含扩展名的文件名。网页路径为 docs 或 docs/id，rawPath 为 docs/raw/id.md；均是相对于站点基路径的路径。

public/docs/index.json 不含全文，仅输出稳定 ID、标题、简介、版本、更新时间和网页及原文路径。public/docs/all.md 合并全部白名单正文。索引由网页生成可访问的基路径版本，离线导出可保留相对地址。

## 后端配置与会话

后端默认只监听 127.0.0.1:8787。公共 GET /api/config 返回 apiConfigured、aiConfigured、r2Configured、localFilesEnabled、thresholdBytes。GET /api/health 返回 ok。GET /api/session 返回 authenticated 与 csrfToken（未登录为 null）。

POST /api/login 接收 password，成功返回 authenticated 与 csrfToken 并设置 HttpOnly 会话 cookie。POST /api/logout 结束会话。登录密码只从环境配置读取；未配置时不能登录。写请求验证 Origin，已登录写请求还验证 X-CSRF-Token。cookie 的 Secure 与部署域名由配置确定，跨域仅允许配置的网站来源。

## 文件与阅读

GET /api/books/id 返回该书公开目录及可用性，不泄漏源路径。GET /api/files/id/access 需要登录，返回 url、format、expiresAt、mode（local 或 r2）；未配置 R2 且未启用本地文件时返回不可用说明。

POST /api/books/id/metadata 需要登录与 CSRF，接收 title、author、description、tags 和 category；不允许 ID、文件路径或其他字段。成功返回 book，并保存私人覆盖记录及更新公开目录输入。重新导入保留这些修正。

GET /api/files/id/content 需要登录，返回本机文件并支持 Range、HEAD、安全文件名和 Content-Type。客户端通过 credentials include 使用此入口。EPUB 可以先 fetch 授权字节，再向阅读器提供 ArrayBuffer。

## AI 任务

POST /api/books/id/jobs 需要登录及 CSRF，接收 operation（question、chapter_summary、full_summary、author）、question、chapter（可选）、model（gpt-luna 或 gpt-sol），返回 202 和 job。

GET /api/jobs/id 返回私人任务状态；GET /api/books/id/history 返回个人结果；POST /api/jobs/id/publish 接收 published 布尔值，返回更新结果。GET /api/books/id/published 匿名可读主动发布的结果。

job 包含 id、bookId、operation、status（queued、running、completed、failed、uncertain）、createdAt、updatedAt、content、error、sources、published。输入保存在私人数据库，不返回日志。相同在途操作和输入去重。

服务端正文来自私人 textPath 或按需提取。PDF 使用 pdftotext，EPUB 按 spine 顺序读取 XML/HTML，MOBI 和 AZW3 需要先准备可用文本。未上传的大文件不会自动提取。长书全书总结分块逐段保存，按任务调用上限暂停；书内问答附来源。作者资料由独立允许的资料源获取，失败时不以模型猜测代替来源。

AI 调用只通过 /v1/tasks，使用 research_summary 或 topic_analysis，不使用旧聊天接口。请求 key、源文件路径和全文不返回公共网页。GET /api/books/id/published 输出专门筛选的公开字段。

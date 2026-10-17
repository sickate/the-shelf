# CF-04 本机正文准备

此工具是 CF-04 的离线首步。它从现有私人 manifest 中显式选择一个 PDF 或 EPUB，在本项目的 `.local/prepared-text` 生成私有、版本化正文包。包现已接入本机 Node 问答、章节和全书总结任务，须通过下述独立命令明确选择版本。准备与选择命令不上传 R2、不创建 D1 索引、不访问网络、不读取 `.env`；云端同步和线上业务 API 仍待独立实现和验收。

## 使用

需要 Node.js >=24、Python >=3.9；PDF 另需 PATH 中的 `pdftotext`（Poppler）。不安装新依赖。manifest 使用 `scripts/import-books.py` 生成的 schemaVersion 1 格式，默认位置为本项目 `.local/manifest.json`。

```sh
# 必须显式选定一个真实 file ID；默认只读取 manifest 和检查选中文件 stat。
npm run prepare:text -- --file file_0123456789abcdef

# 显式执行才读取源书正文、运行本机提取器并准备私有包。
npm run prepare:text -- --file file_0123456789abcdef --execute

# 可选择其他私人 manifest；输出位置始终是当前工具所属项目的 .local。
npm run prepare:text -- --file file_0123456789abcdef --manifest /absolute/private/manifest.json
```

示例 ID 是占位符；从已有私人 manifest 中选择 ID，不要把私人映射复制到公开 catalog。命令不遍历收藏、不自动选择下一本书。dry-run 不读取书籍内容、不运行正文提取器、不创建输出目录；它会启动本机 Python 文件检查 helper。损坏书籍可以通过 dry-run，真实格式与正文有效性只在 execute 时验证。

成功 stdout 为单行 JSON，包含状态 `dry-run`、`prepared` 或 `reused`，以及选中 ID 和格式；execute 另返回版本、内容 hash、chunk 数、正文/包字节数和项目内相对 artifact 名。stdout 不返回源路径或正文。失败 exit 1，stderr 仅包含 `{"code":"…"}`，不会透传 Python/Poppler 的 stderr、异常、路径或正文。正文包属于私人数据，禁止提交 Git 或放入 public/dist/公开日志。

## 选择供本机 AI 任务使用的版本

`prepare:text --execute` 只生成包，不自动选择。取其 JSON 输出中的 `versionHash`，再显式指定同一个 file ID：

```sh
# 只验证包和原书来源、预览选择；不写选择文件。
npm run text:select -- --file file_0123456789abcdef --version <versionHash>

# 明确执行才记录选择。重启本机后端后，新任务使用这个版本。
npm run text:select -- --file file_0123456789abcdef --version <versionHash> --execute

# 更换已有选择须同时提供原版本，防止误覆盖或并发丢失其他选择。
npm run text:select -- --file file_0123456789abcdef --version <newHash> --replace-version <oldHash> --execute
```

选择命令同样支持 `--manifest /absolute/private/manifest.json`，但不开放任意输出根目录。它会读取原书，核对 stat 与完整 SHA-256，并严格校验包契约、每块内容和版本；dry-run 也执行这些只读核验。源书不可用或与包不一致时拒绝选择。它不写原 manifest，只在 `.local/prepared-text/pins.json` 保存选中来源描述，不保存路径。目录须为 `0700`、文件为 `0600`；执行使用锁、整个选择文件的并发比较及原子替换，保留其他文件的选择。已有不同版本必须提供匹配的 `--replace-version`；并发变动返回冲突，应重新预览。

同一本书有多个格式被选择时，任务按公开目录 `book.files` 顺序使用第一个有选择的文件；最后执行选择不会改变格式顺序。该书任一已声明的选择不合法都会阻断，不能靠另一个有效格式绕过。命令只选择指定文件的版本。

本机后端启动时读取选择文件；修改后须重启，已排队任务的版本快照不会改变。任务运行只读取指定的包，无须再次访问原书，也不依赖启用本机原文件阅读。缺包、篡改或来源校验失败时在调用模型前停止，不扫描“最新包”，不回退其他格式或旧正文。没有版本选择的书仍使用原有正文路径。此功能不使包成为原书阅读器的输入，也不自动调用 AI；任务仍需登录、CSRF 和有效服务配置。

问答引用及总结材料同时保留字符串定位、版本和结构化 PDF 页码或 EPUB spine 位置。章节总结按非空页/章节的顺序选择，引用仍显示真实页码/位置。私人任务 API 及主动发布结果不返回原文件 SHA-256、内部来源快照、源路径或包全文。发布的模型结果仍需所有者检查。

选择失败以安全错误码返回；常见为 `prepared_source_mismatch`、`prepared_package_unavailable`、`prepared_replace_required`、`prepared_selection_conflict`、`prepared_permissions`、`prepared_unsafe_path` 和 `prepared_text_*` 校验错误。不要把私人参数或文件内容追加到日志。

## 包契约（schemaVersion 1）

输出位置：`.local/prepared-text/<fileId>/<versionHash>.json`。无日期字段，同一来源与相同提取结果产生相同字节与版本。现有同名包只有在内容逐字节完全一致、为普通文件且权限为 `0600` 时才复用；任何不同、损坏、符号链接或权限不符均拒绝，绝不覆盖。正常错误会清理临时包，可能留下新创建的空目录；进程被强制终止或主机中断时，可能留下权限为 `0600` 的 `.pending-*` 私有临时文件，须核对后维护，不自动删除旧产物。

| 字段                    | 契约                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `kind` | `1`，`shelf.prepared-text`                                                                                                                               |
| `preparation`           | `algorithm=shelf-text-v1`；换行统一 LF，去 NUL，每节 NFC 后 trim；每块最多 6000 个 Unicode code point；offset 单位为 Unicode code point                  |
| `source`                | manifest 的 `fileId`、`bookId`、`format`、`sizeBytes`、十进制字符串 `mtimeNs`；`fingerprint={algorithm:"sha256",value:…}` 为实际读取的完整源字节 SHA-256 |
| `chunks[]`              | 顺序 `index` 从 0 开始；`text`、UTF-8 文字 `sha256`、`locator`                                                                                           |
| PDF locator             | `{type:"pdf-page",page:1,start:0,end:…}`；页码从 1 开始，空页不生成 chunk，但后续页码保留                                                                |
| EPUB locator            | `{type:"epub-spine",spineIndex:0,start:0,end:…}`；按 OPF spine 顺序，位置从 0 开始；空章节同样保留后续位置，不发布源路径或 ZIP 内文件名                  |
| `textBytes`             | 所有 chunk 文字 UTF-8 字节数之和                                                                                                                         |
| `contentHash`           | `SHA256(UTF8(JSON.stringify(chunks)))`                                                                                                                   |
| `versionHash`           | 移除 `versionHash` 字段后的包对象，以实际字段顺序 `JSON.stringify`，对其 UTF-8 字节计算 SHA-256                                                          |

磁盘包为上述字段顺序的紧凑 JSON，末尾一个 LF。hash 不包含该末尾 LF。单 chunk 的 `start`/`end` 是在**规范化后的节正文**中的半开区间，不能当作源文件字节位置或 EPUB CFI。纯空白窗口省略，其他窗口保留块间空白且不切断 Unicode 代理对。PDF 使用 `pdftotext -enc UTF-8 - -` 的 form feed 页分隔；EPUB 使用现有 `server/extract-epub.py` 的受限 ZIP/OPF 处理，章节经 HTMLParser 读取文本并排除 script/style。普通 XHTML DOCTYPE 不加载 DTD 或网络资源，XML 容器/OPF 的 DTD/ENTITY 拒绝。

这是后续逐文件同步可核验的数据契约，不代表 R2 key、云端 schema 或索引已实现。后续消费者须校验 schema/algorithm、来源指纹、各 chunk hash、contentHash、versionHash 和全部字节上限；不要仅信任 artifact 文件名。文本提取依赖本机 Poppler/Python 版本，升级可能改变文字及版本 hash；来源 hash 仍对同一源字节保持稳定。

## 文件与资源边界

- 仅允许 manifest 中 `candidate`、`visibility=private` 的 PDF/EPUB；要求准确的字节数、mtimeNs 和现有 importer 生成的 file/book ID 格式。
- 默认与执行均拒绝零字节及超过 **20,000,000 bytes** 的源文件。执行另限制提取 stdout、总文字、最终完整 JSON 包各不超过 20,000,000 bytes；JSON 元数据/转义也计入包门槛，因此接近 20 MB 的正文仍可能被拒绝。
- 每个本机子进程最多 60 秒，stderr 最多 65,536 bytes，输出按流计数，超限立即终止。EPUB 最多 10,000 个 ZIP 条目、40,000,000 bytes 声明解压总量，禁止重复条目；最多 20,000 chunks。扫描版 PDF 无可提取正文时明确失败，不进行 OCR。
- Python helper 通过 `dir_fd`、逐层 `O_NOFOLLOW` 和打开后的 fstat 检查源路径及输出层级。manifest、源文件及祖先目录的符号链接均拒绝；来源必须位于 manifest.root 内。macOS `/tmp` 等别名路径须先使用真实路径，不能以 symlink 绕过边界。
- 源 stat 必须与 manifest 一致；执行会在打开/读取前后、提取后、发布前检查 size、mtime、ctime、device、inode。提取器只接收一次受限读取的内存快照 via stdin，不直接打开源路径；源发生漂移则拒绝发布。
- 输出所有私人目录 `.local`、`prepared-text`、`<fileId>` 均为 `0700`，包为 `0600`。现有目录权限不符时返回 `output_permissions`，不修改旧目录或旧数据；先由项目维护者核对再修正权限。已打开目录 fd 用于发布，临时文件独占创建并 fsync，以硬链接原子发布，已有同名文件不会被替换。
- 不修改 manifest、源书、SQLite、catalog、旧正文或服务器状态，不读取 manifest 的 `textPath`/`storageKey`。没有原书时不回退到缓存、网络或模拟正文。

常见错误 code：`file_required`、`invalid_file_id`、`file_not_found`、`unsupported_format`、`file_ineligible`、`manifest_invalid`、`unsafe_path`、`source_outside_root`、`source_changed`、`empty_source`、`source_too_large`、`empty_text`、`pdf_extraction_failed`、`epub_extraction_failed`、`extractor_unavailable`、`extraction_timeout`、`extraction_output_limit`、`package_too_large`、`output_permissions`、`existing_package_invalid`。底层本机 I/O 无可安全细分时返回 `local_io_failed`。

## 模块与验证

```js
import { prepareText } from "./scripts/prepare-text.mjs";
const result = await prepareText({
  fileId: "file_0123456789abcdef",
  execute: false,
});
```

`execute` 必须是 boolean。模块另接受 `manifestPath`、`projectRoot`（用于隔离合成测试）和 `timeoutMs`（仅可缩短到 1–60000 ms）；CLI 不允许改变项目输出根目录。模块抛出带安全 `code` 的 `PreparationError`，不应在日志里追加私人参数。

```sh
node --test tests/prepare-text.test.mjs
```

测试只创建临时合成书籍、manifest 与隔离项目，覆盖真实 PDF/EPUB 提取、PDF 空页/EPUB spine、Unicode 分块与 hash、目录/文件权限、所有输出层级 symlink、来源越界/漂移、失败不落包、流量/超时边界、包超限、篡改拒绝及完整独立 CLI 执行与复用。未安装 Poppler 时真实 PDF 测试明确 skip；交付本机须安装并实际运行通过。

# 朗读体验与书籍缓存（2026-10-30）

## 用户反馈

1. 跟随状态下拖动朗读进度条，高亮句子没有随拖动跳过去。
2. 每次重新打开页面都要重新下载书籍文件（EPUB 等）。
3. 手机上播放时，其他 App 的背景音乐被打断；希望只被调低，且调低幅度可调。
4. 暂停后再播放，偶尔出现两个音频同时朗读、进度不同。
5. “跟随”“连续播放”等开关按钮的按下状态不明显。

## 分析

- (1) `audio-player.ts` 拖动时只更新时间文字，`input` 事件不通知 read-along；松手后 `seekTo` 才 `emitPos`。且若用户此前滚动过页面（`ra.paused`），拖动不会恢复跟随。
- (2) `read.ts` `fetchFile` 每次全量 fetch `/api/books/:id/file`；没有前端持久缓存。PDF 走 Range 加载，不在本次范围。
- (3) Web 无法控制其他 App 的音量。iOS Safari 17+ 提供 `navigator.audioSession.type`：`playback`（默认，打断其他音频）、`transient`（系统压低其他音频）、`ambient`（混音不压低）。压低幅度由系统决定，网页不可调；可提供“打断 / 压低 / 混音”三档，混音档下用户自己调背景音乐 App 的音量即可实现任意比例。浏览器不支持时隐藏该选项。
- (4) 播放器用两个 `<audio>`（cur/nxt）做近无缝衔接；只有 `cur` 被暂停/控制。`nxt` 若被系统（锁屏/耳机/中断恢复）或竞态的 `play()` 启动就不会被停下。

## 方案与分工

| 任务 | 内容 | 模型 |
|---|---|---|
| A 播放器 | 1、3、4、5（均在 `audio-player.ts` / `style.css`） | Opus 5.5 |
| B 书籍缓存 | 2：Cache Storage 缓存非 PDF 书籍文件（键含书 id + 大小 + createdAt），总量上限 + LRU 淘汰，失败回退网络 | Sonnet 5.5 |

A 细节：
- 拖动中（`input`）按滑块位置计算 piece/offset，直接通知 read-along（节流），并在跟随开启时清除 paused；松手后照常 seek。
- `play` 事件里非 `cur` 的元素立即暂停；`pause()` 暂停全部元素；`startPlayback` 前暂停 `nxt`；处理竞态（pause 后 play promise 迟到）。
- 背景音频模式选择（存 localStorage），仅在支持 `navigator.audioSession` 时显示。
- 开关按钮按下态：实心强调色背景 + 白字 + “✓”前缀，未按下为普通描边。

明确不做：PDF 缓存、离线阅读、Service Worker、改后端。

## 验收

- 单测覆盖可纯函数化的部分（滑块位置 → 段内定位、缓存键/淘汰策略）。
- `npm run app:typecheck`、`npm run app:test`、`node app/build.mjs` 通过。
- 发布：commit → push → `npm run app:deploy` → 线上页面可加载。手机端听感（混音/压低）与双音频问题需用户实测。

## 回退

`wrangler rollback` 到上一 Worker 版本；纯前端改动，无迁移。

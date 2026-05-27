# Folder Archive/Drafts — Next Session Handoff

> 2026-05-26 末。分支 `feat/folder-archive-drafts`。core 功能 ship 完成，dogfood 中。

## TL;DR

存档邮件 + 草稿箱双入口已完整实现 + 提交，core 需求 100% 达成（list/详情/草稿增删改发/存档移回删）。8 个干净的 atomic commit。dogfood 阶段：用户在 GUI 真实使用 + 反馈小问题，我据反馈修。

后端 davmail 模式 + `MAILBOX_FOLDER_SYNC_ENABLED=true` 已开，worker 跑着，folder_email 有数据（drafts 同步成功验证）。前端入口常驻，已对接 SSE 自动刷新。

## 完成的 commit 链（按时间序）

| Commit | 内容 |
|---|---|
| `c7f4c75` | **Phase A** — DB v17 三表 + FolderImapReader（IMAP/SMTP 全套）+ FolderEmailRepository + sync_ops + `mailagent folder` CLI（10 命令）|
| `838e747` | **Phase B** — FolderSyncWorker(asyncio loop) + main.py 挂载 + SSE `folder.synced` + config 5 字段 + 修 v6/v10 migration 测试 db_version 硬编码 |
| `21b5d54` | **Phase C** — 前端 UI 第一版（路由 /archive /drafts + Sidebar 入口 + folder/ 组件 + TipTap v3 撰写器 + IPC handler + ElectronApi + i18n + SSE invalidate） |
| `0a1e9c6` | **测试** — tests/folder_sync/test_folder_sync.py 15 个回归测试（parse/repository/sync_ops）|
| `45167d1` | fix 空列表显示裸 "0" |
| `14c4bd1` | fix calendar-sync 启动失败（F29 重构遗漏 caldav_reader import 路径）|
| `2fbfe78` | **UI 重写** — 参照设计 mockup（mockup-{archive,drafts,draft-composer}.html）提升精致度 + PRD/handoff 留档 |
| `e19eda0` | fix 3 个 dogfood UI bug（ICU 插值 / Sidebar 草稿存档计数 / 撰写器收件人折叠）|

## 待办（按优先级）

### 高（用户体验直接相关，dogfood 可能很快碰到）
1. **撰写器加发送按钮** — 现在 DraftEditor 只有保存/丢弃，发送在详情 toolbar。mockup 设计撰写器内有发送。需加 sendDraft 接线 + 二次确认 dialog。
2. **详情上下封导航** — mockup 详情 toolbar 有 prev/next 按钮，当前没接（需要 nav state + 跟列表联动）。

### 中（功能完整性）
3. **附件二进制下载** — 当前详情只列附件名/大小，不可下载。需后端加 `fetch_by_uid` 取二进制 CLI + 前端 `folder:downloadAttachment` IPC + UI。
4. **FolderList 搜索框 UI** — 后端 `folder:search` 已就绪（FTS5 + smartQueryTransform CJK 改写），前端只缺搜索 input。
5. **cid: 内联图渲染** — FolderBodyFrame 现在不解析 cid，需附件二进制下载后做 cid 重写。

### 低（运维 polish）
6. **FRONTEND_MAILBOX_FOLDERS_ENABLED gate** — 入口当前常驻。接 gate 需 settings handler 暴露字段 + Sidebar 条件渲染。
7. **dogfood 持续修小问题**（用户使用中陆续反馈，每个独立小 commit）

## 已知 pre-existing（非本功能引入）

- `test_reverse_sync_outbox` 单测 fail —— 基线分支技术债（reverse_sync 改了 processing_status 参数，测试未更新）。用 `git stash` 已验证非 folder 引入。
- 分支历史穿插后台 OMC 的 kos/island commits（如 `8235483 feat(kos)`、`eebb606 fix(island)`），与本功能无关，但混在 `feat/folder-archive-drafts` 上。

## 当前 `.env` 配置（已启用）

```
MAILAGENT_BACKEND=davmail
MAILBOX_FOLDER_SYNC_ENABLED=true
```
其他默认（archive 窗口 365 天 / 上限 5000 / poll 60s / 前端 gate 未接故不影响）。

## 关键架构（继任者必读）

- **DB v17**：`folder_email` + `folder_email_fts` + `folder_sync_state`（独立表，**不污染 email_metadata 主表**）。schema 见 `src/mail/sync_store.py` 搜 "v17"。
- **后端模块**：`src/folder_sync/`（imap_folder_reader / repository / sync_ops / worker），对标 `src/calendar_sync/` 架构。
- **CLI**：`mailagent folder list/get/search/sync-status/sync-now/delete/move/send-draft/create-draft/edit-draft`（`src/cli/commands/folder.py`），输出标准 `{status, data, meta}` wrapper。
- **前端数据接线**（**不要改，UI 可改**）：`mailApi.folder.*` → IPC `folder:*` → handler 读 better-sqlite3 直读 folder_email / 写 callCli `mailagent folder`。
- **SSE**：worker sync 后 `safe_publish("folder.synced", {folder, inserted, updated, soft_deleted})` → Redis `mailagent:events:v1` → `useEventBridge` 前缀匹配 `['folder']` invalidate 自动刷新。
- **i18n**：`folder.*` zh-CN/en-US 119 key 完全对齐。**项目 .use(ICU)**，插值用单括号 `{count}`（不是 i18next 双括号 `{{count}}`）。
- **主题**：项目支持 `data-theme=light` + `darkMode:'class'`，**用 ink/coral token 自动适配**，不要硬编码 hex/rgb 颜色。

## 死硬约束（不可破）

- **davmail-only**：所有同步/写操作依赖 IMAP/SMTP。AppleScript 模式下 worker 不启动，前端入口仍显但写命令报 `davmail-only` 守卫错误。
- **发送合规红线**：DavMail 当前是 PoC client_id 伪装（CLAUDE.md「不可上生产」）。发送草稿是对外不可逆，UI 已强制二次确认；仅适合本机 dogfood，生产前须走 Graph API 合规。
- **数据契约不变**：FolderEmailMeta/Detail 字段固定，**没有 AI 字段/线程/已读态**（区别收件箱）。UI 重做不要假设有这些字段。

## 设计资产位置

- `docs/folder-ui-prd.md` — 设计 PRD
- `docs/folder-ui-design-handoff.md` — 给设计师的 brief
- `frontend/ref/mockup-archive.html` / `mockup-drafts.html` / `mockup-draft-composer.html` / `mailagent-archive.html` — 设计稿（含真实 ink token CSS）

## 验证命令

```bash
# 后端单测
pytest tests/folder_sync/ -v
# 前端 typecheck + handler 测试
cd frontend && pnpm typecheck && npx vitest run tests/main/handlers/folder.test.ts
# 数据状态
sqlite3 data/sync_store.db "SELECT folder,COUNT(*) FROM folder_email WHERE deleted_at IS NULL GROUP BY folder"
sqlite3 data/sync_store.db "SELECT folder, last_uidnext, last_error FROM folder_sync_state"
# worker 日志
grep "folder-sync" logs/sync.log | tail
# CLI 实测
mailagent folder list drafts -o json
mailagent folder list archive --limit 5 -o json
# 启动 GUI dogfood
cd frontend && pnpm dev
```

## 紧急回滚

```bash
# 关 worker (不再同步, 但本地已有数据保留)
sed -i.bak 's/^MAILBOX_FOLDER_SYNC_ENABLED=true/MAILBOX_FOLDER_SYNC_ENABLED=false/' .env
pm2 restart mail-sync

# 完全回到 ship 前 (git revert 8 个 commit, 不推荐 — schema v17 表保留但前端无入口)
# 或者 git checkout 别的分支
```

## 关键文件清单

```
后端:
  src/mail/sync_store.py            (DB v17 schema)
  src/mail/backend/imap_client.py   (+discover_archive_folder)
  src/folder_sync/__init__.py
  src/folder_sync/imap_folder_reader.py  (IMAP/SMTP 操作)
  src/folder_sync/repository.py     (CRUD + FTS + 软删除 + sync_state)
  src/folder_sync/sync_ops.py       (worker + CLI 共享原语 + SSE publish)
  src/folder_sync/worker.py         (asyncio loop, 对标 CalendarSyncWorker)
  src/cli/commands/folder.py        (mailagent folder CLI)
  src/cli/main.py                   (注册 folder group)
  src/config.py                     (5 个新字段)
  main.py                           (worker 挂载 + cleanup)
  tests/folder_sync/test_folder_sync.py  (15 测试)

前端:
  frontend/src/electron/main/handlers/folder.ts   (读直读 + 写 callCli)
  frontend/src/electron/main/index.ts             (注册)
  frontend/src/shared/api/types.ts                (FolderApi + types)
  frontend/src/shared/api/ElectronApi.ts          (ElectronFolderApi)
  frontend/src/shared/api/HttpApi.ts              (folder stub)
  frontend/src/shared/router-instance.tsx         (/archive /drafts)
  frontend/src/shared/components/layout/Sidebar.tsx           (入口 + count)
  frontend/src/shared/components/layout/FolderLayout.tsx      (两栏壳)
  frontend/src/shared/components/folder/FolderList.tsx
  frontend/src/shared/components/folder/FolderRow.tsx
  frontend/src/shared/components/folder/FolderDetail.tsx
  frontend/src/shared/components/folder/FolderToolbar.tsx
  frontend/src/shared/components/folder/DraftEditor.tsx       (TipTap v3 + chip + 折叠)
  frontend/src/shared/components/folder/FolderBodyFrame.tsx   (DOMPurify iframe)
  frontend/src/shared/components/folder/ConfirmDialog.tsx
  frontend/src/electron/renderer/index.css        (folder-* CSS, token 化)
  frontend/src/shared/hooks/useEventBridge.ts     (folder.synced 路由)
  frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json  (folder.* 119 key)
  frontend/tests/main/handlers/folder.test.ts     (17 测试)
```

## CLAUDE.md 是否要更新？

CLAUDE.md 暂未加 folder_sync 模块段。如果用户希望项目文档完整，可以在 CLAUDE.md 加一段「Folder Sync 模块 (Archive/Drafts)」简介，对标 Calendar 模块段的格式。这不是阻塞项，留作后续。

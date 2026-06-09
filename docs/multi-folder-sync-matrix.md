# 多文件夹同步 — 能力矩阵 & 验收看板

> 配套：[PRD](./multi-folder-sync-prd.md) · [技术设计](./multi-folder-sync-design.md) · [设计 handoff](./multi-folder-sync-design-handoff.md) · [mockup](./mockups/multi-folder-sync/index.html) · [实现 handoff](./multi-folder-sync-handoff.md)
> 本文件是**活的执行/验收看板**，每阶段末更新。把「覆盖完整性」变成可机械核对的表，专治系统改造里「哪个能力漏改 / 漏接 / 漏测 / 漏 i18n / 漏主题」。
> 分支/worktree：`feat/multi-folder-sync`（从 main 切）。
>
> **工程纪律（仿 v2.1 / backend service layer）**：每阶段 **实现（trellis-implement）→ codex GPT-5.5 high review → 修到 APPROVE → trellis-check → 验收（pytest/vitest/build:web/CLI）→ 矩阵标绿 + 进度日志 → atomic commit**。

## 为什么需要这张表

本功能的风险 = ①「某能力只补了一半的层」（后端取数有、前端没接 / serve-api 端点漏 / 没 i18n / 没适配暗色）；②「davmail 能力假设没实测就实现」（写操作 EWS 映射 / 嵌套暴露）；③「碰坏收件箱主路径」。靠人脑记必漏。
**五招防漏**：① 能力矩阵看板（本表）② davmail 能力前置实测 gate ③ 隔离不变量（`SYNC_FOLDERS` 空=零激活，每阶段验）④ 残留检测（P6 删 folder_sync 无引用残留）⑤ 每阶段 codex review + 验收 gate。

图例：✅ 完成 · 🟡 doing · ⬜ 待办 · ➖ 不适用 · 🔴 阻塞/前置未验

## 架构 & 隔离不变量

- **完整 pipeline**：自定义文件夹邮件走 `email_metadata` 主链路，下游 Notion/AI/通知/线程/FTS **按 `mailbox` 字段透传，几乎零改动**（已验证无 INBOX 硬编码）。改造集中在 davmail 取数入口 + per-folder 游标。
- **🔒 隔离不变量（每阶段必验）**：`SYNC_FOLDERS` 为空（默认）时所有新代码不激活，行为与现状逐字节一致。回滚 = 清空 `SYNC_FOLDERS`。
- **davmail-only**：AppleScript 模式全功能门控关闭。
- **接管废弃**：存档/草稿箱并入白名单走主链路；旧 folder_sync 展示链路 P1-P5 停用不删、P6 独立清理；`FolderImapReader` 永久保留（归档/草稿依赖）。

---

## P1 — 后端取数核心（含层级发现）✅　MVP

> 🔴 **前置实测 gate（P1 第一步，未过不继续）**：① davmail `CREATE/RENAME/DELETE` 测试文件夹能映射 EWS（给 P4）② davmail LIST 对 `测试/子` 嵌套返回 `测试/子`（delimiter `/`）+ 中文层级解码。结果写回本节，不支持的子项降级（平铺/隐藏管理）。
>
> **✅ gate 实测结论（2026-06-08，davmail-poc IMAP 127.0.0.1:1143）**：全部支持，**无需任何降级**。
> - **文件夹管理 CRUD（P4）支持**：`CREATE`/`RENAME`/`DELETE`（含中文名 modified-UTF7）全映射 EWS（resp `folder created`/`rename completed`/`folder deleted`）。
> - **嵌套层级（D6）支持**：`CREATE 多文件夹探针ZZ/子文件夹` → LIST 返回 delimiter `/` + 父行 `\HasChildren`；真实邮箱 `对话历史记录` 已带 `\HasChildren`。
> - **系统文件夹保护坐实**：EWS 自身拒删 distinguished folder（`DELETE INBOX` → `ErrorDeleteDistinguishedFolder Distinguished folders cannot be deleted`）；P4 仍做应用层 gate 给干净 UX（不依赖 EWS 报错）。
> - 18 文件夹全列出、中文解码正常（DMS固件发布/存档/对话历史记录/待办/必要文档路径）、delimiter 统一 `/`。探针文件夹已清理。

| 能力 | 后端实现 | 测试 | 验收 | 状态 |
|---|---|---|---|---|
| 文件夹发现 `list_folders()` | `imap.list("","*")` + `decode_imap_utf7` + special-use 标志 + STATUS 邮件数 + **层级树解析**（delimiter→`build_folder_tree`） | `test_imap_utf7`(13) + `test_list_folders`(11，mock LIST 含嵌套行) | CLI `folder discover -o json` 列 18 文件夹含中文+层级 ✓ | ✅ |
| 配置 `SYNC_FOLDERS` + 窗口 | `config.py` 加 `sync_folders`/`folder_sync_past_days`/`folder_sync_max_messages` + `.env.example` | `test_folder_config`(7) | 配置可读、空=默认 ✓ | ✅ |
| per-folder marker | 从 `email_metadata` 派生 `MAX(imap_uid)`（`_max_folder_imap_uid`）+ uidvalidity 存 `sync_state` KV（`folder_uidvalidity:<imap_name>`）；UIDVALIDITY 变→全量重拉 | `test_get_new_emails_multifolder`（marker 推进 / uidvalidity 重拉） | 二次 poll 不重复拉 ✓（真机 e2e 5→5） | ✅ |
| `get_new_emails` 多文件夹遍历 | INBOX 段后追加白名单循环（`_fetch_custom_folder`→`_fetch_new_in_folder` 双模式）+ 每文件夹独立 try + max_messages 截断（取最新 N） | 同上（单文件夹失败隔离 / 截断 / 中文 label / criteria 决策） | `sqlite … GROUP BY mailbox` 出现 `mailbox='Notion'` ✓（真机 e2e） | ✅ |
| DB v22 迁移 | bump `DB_VERSION` 21→22（marker-only，uidvalidity 走 KV 无新表）+ 同步前端 `EXPECTED_DB_VERSION`=22 | `db_version_consistency.test.ts`（前端，✓ 1 passed） | 迁移 idempotent ✓ | ✅ |
| 🔒 隔离不变量 | `SYNC_FOLDERS` 空 → `_custom_folders=[]` → get_new_emails/check_for_changes 循环整段跳过 | `test_get_new_emails_multifolder`（空→只 SELECT INBOX / 零 STATUS 探测）+ 50 现有 davmail 测试回归全绿 | 空配置只 SELECT INBOX ✓ | ✅ |
| CLI `folder discover/enable/disable` | `discover`(只读) + `enable/disable`(写 .env SYNC_FOLDERS, 复用 dotenv set_key) + davmail 门控 | `test_folder_discover`(9, CLI 契约) | `folder discover` 真机列 18 文件夹 ✓ | ✅ |

**验收**：`pytest tests/mail tests/cli tests/api` → **1166 passed / 75 新测试全绿、零新增失败**（7 预存 calendar/reverse_sync 与本功能无关）+ ruff 全过。真机 e2e：`SYNC_FOLDERS=Notion` 跑真实 davmail → `email_metadata` 出现 `mailbox='Notion'`（5 封）、per-folder 增量二次 poll 不重复（5→5）、uidvalidity 持久化。**codex review（GPT-5.5）：REQUEST CHANGES → 修 3 finding → APPROVE WITH NITS（NIT 已修）**。
> **codex 复审修复**（3 finding 全闭环）：① SYNC_FOLDERS 改 **JSON 数组**（modified-UTF7 中文名含逗号，如 对话历史记录=`&W,mL3VOGU,KLsF9V-`，逗号分隔会拆坏；CSV 简单名仍兼容）② IMAP STATUS/SELECT **mailbox 加引号**`quote_mailbox()`（含空格名如 `Unsent Messages` 不 quote → `folder not found`；顺带修 Sent="Sent Items" 潜在 bug）③ `_effective_custom_folders()` 运行时过滤 Sent/Drafts + CLI `enable` 拒绝 `is_system`（防双拉）。

## P2 — 下游 pipeline 验证 + 通知/AI gate（L2/L3）✅　MVP

| 能力 | 实现 | 验收 | 状态 |
|---|---|---|---|
| Notion 同步（L3） | 零改动（Mailbox Select 自动建 option，mailbox 字段透传） | 真机 e2e：邮件落 `mailbox='Notion'`（P1 已验）；`test_custom_folder_email_saved_with_mailbox` | ✅ |
| LLM 分类（L2） | per-folder gate：`should_skip_llm_for_folder` + `FOLDER_LLM_DISABLED`（默认开，黑名单可关） | gate 单测（默认跑/黑名单跳/标准邮箱不受影响） | ✅ |
| FTS 搜索 | 零改动（email_body 触发器自动入 FTS5，mailbox-agnostic） | `test_custom_folder_email_fts_searchable`（真实索引+mailbox 过滤命中/不命中） | ✅ |
| 线程 | 零改动（thread_id 透传） | `test_custom_folder_thread_id_passthrough` + 列表 mailbox 过滤 | ✅ |
| 通知降噪（L3） | `should_skip_feishu_for_folder`（自定义文件夹默认 skip）+ `FOLDER_NOTIFY_ENABLED` 白名单可开；插在 `_maybe_notify_feishu` 发件箱过滤后 | gate 单测（自定义默认不通知/收件箱照常/白名单可开） | ✅ |

DRY 重构：抽 `parse_folder_csv_or_json`(imap_client) 共享 helper（SYNC_FOLDERS/FOLDER_NOTIFY_ENABLED/FOLDER_LLM_DISABLED 共用），`_parse_custom_folders` 改 delegate（行为不变）。

**验收**：27 P2 测试全绿，pytest **1452 passed（含 tests/notify）零新增失败** + ruff 全过。MVP = P1+P2 纯后端独立验收。**两轮独立 review**：codex(GPT-5.5) APPROVE WITH NITS → 修 3 finding（① retry 队列也接 L2 gate ② getattr 兜底修 tests/notify 回归 ③ config JSON 描述）→ codex 用量上限不可用 → **fallback opus 4.8 critic 对抗式复审 APPROVE WITH NITS**（NIT-1 存档有意为自定义[PRD D7]+注释、NIT-2 meta=None 补测试、NIT-3 perf 守卫保留）。
> 🔴 **review 暴露的范围缺口**：L2/L3 gate 改 `new_watcher.py` 会影响 `tests/notify`（之前回归只跑 tests/mail/cli/api 漏了），已纳入回归范围。

## P3 — 前端配置 + Sidebar（树形）✅

| 能力 | 后端 | 前端 | i18n(中/英) | 主题(亮/暗) | 测试 | 状态 |
|---|---|---|---|---|---|---|
| folder 发现 API | serve-api `GET /api/folder/discover`（扁平+tree+count+is_synced，davmail 门控） | — | ➖ | ➖ | `test_folder_discover`(api 6) | ✅ |
| 白名单读写 API | `GET/PUT /api/folder/whitelist`（JSON 写 .env，去重排 INBOX，restart_required） | — | ➖ | ➖ | api 测 | ✅ |
| IPC + useMailApi | daemon 转发（D1，Main handler→serve-api）+ HttpApi 远程直连 | `mailApi.folder.discover/getWhitelist/setWhitelist` | ➖ | ➖ | mock | ✅ |
| `<FolderPicker>` 树组件 | — | 树形（缩进+展开收起）+勾选(imap_name)+窗口(EnvField)+空态+davmail 门控（**照 mockup ①**） | ✅ 44 双语 key 对称 | ✅ token 取色（51 处） | `FolderPicker.test`（拉取/勾选/保存/门控/空态） | ✅ |
| Sidebar 文件夹树 | — | MAILBOXES 段树形（缩进+展开收起）+计数+点击过滤（display_name）（**照 mockup ③**，三段铁律守住） | ✅ | ✅ | `SidebarFolderTree.test`(8，含叶子名/全路径/隔离) | ✅ |
| 列表头部上下文 | — | 层级面包屑（叶子名段，**照 mockup ④**） | ✅ | ✅ | — | ✅ |

**验收**：`pnpm typecheck` 零错 + `pnpm test` **94 文件 1367 passed 零 Electron 回归** + `build:web` ✓ + eslint 新文件干净；`pytest tests/api` 384 passed + ruff 清。i18n 中英对称、token 取色无 raw hex、三段 header 铁律守住、隔离不变量（whitelist 空→Sidebar 不渲染）。**独立 review**：codex 用量上限不可用 → **opus code-reviewer 对抗式 APPROVE WITH NITS**（0 CRIT/HIGH；修 MEDIUM 嵌套文件夹叶子名显示[decode 全路径→split delimiter 取末段，过滤仍用全路径]+ 2 LOW[取消勾选活跃文件夹清 customMailbox / discover-fail fallback 禁点击] + NIT 注释；测试 fixture 改真实全路径覆盖嵌套）。

## P4 — Onboarding + 写操作泛化 + 文件夹管理 ✅

| 能力 | 后端 | 前端 | i18n | 主题 | 验收 | 状态 |
|---|---|---|---|---|---|---|
| onboarding 文件夹步骤 | — | 树形多选步（**照 mockup ②**，可跳过/系统锁定/大文件夹提示） | ⚠️ Chinese-only* | ✅ | 新用户勾选生效 + 可跳过不阻塞 | ✅ |
| 归档/移动泛化 | `archive_inbox_message` 加 `src_imap`（邮件当前文件夹解析，修自定义文件夹归档）+ 新 `move_by_message_id`(任意 src→dst) + `move_to_folder` service（trash 守卫）；`POST /api/email/{id}/move` | — | ➖ | ➖ | 自定义文件夹归档/移动正确（src 解析单测） | ✅ |
| 文件夹管理 CRUD（davmail 实测过） | `create/rename/delete_folder`(IMAP, quote_mailbox) + 系统文件夹保护(`_assert_not_system_folder`+EWS 兜底) + 一致性（rename UPDATE mailbox 含子前缀 / delete `delete_email_full` 级联清 body/attachment/FTS+附件目录 / 白名单 rewrite + restart_required）; `POST/PATCH/DELETE /api/folder/manage` + CLI | 树行 ⋯ 菜单（新建/重命名/删除+二次确认+系统禁用，**照 mockup ⑤**） | ✅ | ✅ | 新建/重命名/删除回写 Exchange + 系统保护 + 删除级联 | ✅ |
| 回复/转发 | 零改动（compose 复用） | 零改动 | ➖ | ➖ | 自定义文件夹内回复/转发 | ✅ |

\* onboarding 步骤硬编码中文 —— 既有 onboarding 全 7 步 Chinese-only 无 i18n 基础设施（HEAD 确认 0 useTranslation），新步保持同一面一致；reviewer 裁定可接受，onboarding 整面 i18n 记独立 backlog。settings 面的管理 UI 已正确 i18n（24 双语 key 对称）。

**验收**：pytest 1492 passed（含 tests/notify/folder_sync）零新增失败 + ruff 清；前端 typecheck + 1379 passed（+12 P4 管理 UI 测试）+ build:web ✓ + eslint。**独立 review**（codex 用量上限 → opus code-reviewer 对抗式）：**REQUEST CHANGES → 修 2 MEDIUM blocking + 4 LOW → APPROVE WITH NITS**。
> **修复**：① delete 不级联（raw connect FK OFF → orphan body/attachment/FTS）→ 改 `delete_email_full` 逐行（FK CASCADE + 附件目录）② rename/delete 不返 `restart_required` → `_rewrite_whitelist` 返 bool 透到 result + serve-api/CLI emit ③ 嵌套 rename 漏子行 → `SET mailbox=new||SUBSTR(...) WHERE LIKE old||'/%'` ④ move dst 无 trash 守卫 → 拒 Trash/Junk ⑤ 前端零测试 → 补 12 管理 UI 测试 ⑥ CLI restart_required NIT 补 emit。

## P5 — 边界打磨 ✅

| 能力 | 实现 | 验收 | 状态 |
|---|---|---|---|
| 取消勾选清理 | `cleanup_local_folder` service（删本地 email_metadata 级联 body/附件/FTS+附件目录 + 移白名单，**不碰 Exchange**）+ serve-api `POST /api/folder/cleanup` + CLI `folder cleanup` + 前端 FolderPicker「同时清理」选项（默认保留） | `test_cleanup_local_folder_deletes_rows_not_exchange`（reader 未调）+ CLI + serve-api 测 | ✅ |
| UIDVALIDITY 重拉 | **P1 已实现**：per-folder uidvalidity 存 KV，变化→全量重拉(SINCE 窗口)，message_id merge 去重兜底 | `test_get_new_emails_multifolder::test_uidvalidity_change_triggers_full_repull` | ✅ |
| 大文件夹分批 | **P1 已实现**：窗口(FOLDER_SYNC_PAST_DAYS)+上限(FOLDER_SYNC_MAX_MESSAGES 取最新 N)+每文件夹独立 try | `test_max_messages_truncation_keeps_newest`；真机 Jira 3458 封受上限约束 | ✅ |
| 层级/管理降级 | davmail 实测全支持（gate 过）→ 无需降级；`build_folder_tree` 孤儿/无嵌套自动退化平铺 | `test_build_tree_flat_all_roots` + `test_build_folder_tree_nesting`（孤儿当顶层不丢） | ✅ |

**验收**：cleanup 5 测 + 边界场景 P1 测试覆盖（uidvalidity 重拉 / max_messages 截断 / tree 降级，reviewer 真实核查属实）。pytest 1495 passed 零新增 + ruff 清；前端 1381 passed + build:web ✓ + cleanup UI/接线/2 测试。**独立 review**（codex 限流 → opus code-reviewer）：**APPROVE WITH NITS**（0 CRIT/HIGH/MEDIUM；cleanup 不碰 Exchange 用 _NoReader 哨兵测试坐实）→ 修 3 LOW：① cleanup 加空名/系统邮箱守卫（防 raw API 误删收件箱本地行）② 删/清父文件夹含子文件夹本地行（`OR mailbox LIKE label||'/%'`，与 rename 对称防孤儿）③ 空 imap_name 拒绝。

## P6 — folder_sync 展示链路清理（独立 cleanup）✅

| 动作 | 处置 | 验收 | 状态 |
|---|---|---|---|
| 删 FolderSyncWorker + folder_email/_fts/folder_sync_state 三表 | 删 worker/repository/sync_ops + DB v23 DROP migration（trigger→FTS→主表→state，全 IF EXISTS idempotent）；DB_VERSION 22→23 同步前端 EXPECTED_DB_VERSION=23 | 残留检测无生产引用（顺带清 4 处 stale 注释/docstring） | ✅ |
| 删老 folder router/CLI 展示端点 + Sidebar 老数据源 | 删 `src/api/schemas/folder.py` + 老 router/CLI 展示端点（保留 P3-P5 discover/whitelist/manage/cleanup）+ 前端老 viewer（folder/ 7 组件 + FolderLayout + Sidebar 老 nav + router archive/drafts route + HttpApi/ElectronApi/types 老方法 + handlers/folder.ts 老 IPC）+ 老 i18n（settings.sync.folder 孤儿，双语）+ 死 config（`frontend_mailbox_folders_enabled`）+ env-keys 4 死 key（**顺带修 P3 遗漏**：`FOLDER_SYNC_PAST_DAYS`/`FOLDER_SYNC_MAX_MESSAGES` 入 MANAGED_ENV_KEYS 白名单，否则新 SyncTab EnvField env:set 抛 E_INVALID_KEY 存不了） | typecheck + 1364 fe + build:web 全过，无 404 残留调用 | ✅ |
| `FolderImapReader` **迁出保留** | `git mv src/folder_sync/imap_folder_reader.py → src/mail/backend/`，删空 folder_sync 包，5 import 站点（mail_write + tests）改路径；无循环 import（davmail_backend 不反向 import） | 归档/草稿/CRUD 回归全过（21 测 + 1467 py 零新增） | ✅ |

**验收**：后端 1467 passed 零新增（7 全 pre-existing：6 expansion_loop + 1 reverse_sync_outbox）+ 前端 typecheck + 1364 passed（1 useEmailChat 流式 flaky，隔离 44/44）+ build:web 全绿 + 残留检测干净。**独立 review（codex GPT-5.5 xhigh）：APPROVE**（0 blocking；2 NIT [stale 注释×4 + EOF 空行] 已修）。

---

## 横切关注点（每阶段核对）

| 关注点 | 要求 | 核对方式 |
|---|---|---|
| **i18n** | 所有新前端文案走 i18n key（中 `zh-CN` + 英 `en-US` 双语），**零硬编码中文**；复用现有 i18n 体系 | 切换语言无 raw key；grep 新组件无硬编码中文串 |
| **多主题** | 所有新 UI 从 token 取色（`rgb(var(--ink-*))`/`--c-accent`），**亮暗都正确**；mockup 已给两套基准 | 亮/暗切换渲染对照 mockup |
| **🔒 隔离不变量** | `SYNC_FOLDERS` 空=零激活=逐字节一致 | 每阶段回归收件箱主路径 |
| **DB 版本** | `DB_VERSION` bump 必同步 `backend_lifecycle.ts` 的 `EXPECTED_DB_VERSION` | `db_version_consistency.test.ts` |
| **davmail 能力前置** | 写操作/嵌套先实测再实现，不支持则降级 | ✅ P1 gate 全过（CRUD+嵌套+系统保护全支持，无降级）→ 见 P1 节 gate 结论 |
| **打包铁律** | 真机 build 前 `build-python-venv.sh` 重 provision + `rebuild:electron` | 见 handoff §3 |

## 最终验收（goal 出口）

1. **软件全绿**：`pytest tests/mail tests/cli tests/api` + `pnpm test` + `typecheck` + `build:web`。
2. **真机 e2e**（build `.app`，先重 provision venv）：配置页拉取文件夹树 → 勾选 → Sidebar 树形呈现 → 点击查看 → AI/Notion/搜索 → 标旗/归档/移动/回复 → 新建/重命名/删除文件夹 → onboarding 勾选 → 大文件夹不阻塞 → i18n 中英 + 亮暗主题全对 → AppleScript 门控 → `SYNC_FOLDERS` 空回归一致。
3. **文档更新**：CLAUDE.md 开关表 + `.env.example` + architecture-internals + 三份文档标「已实现」。
4. **统一提交 + 合 main + bump version + tag**。

## 进度日志

| 日期 | 阶段 | 事件 | commit |
|---|---|---|---|
| 2026-06-08 | — | 需求+设计+mockup+矩阵就绪，goal 待启动 | `f0ceb84` 等 |
| 2026-06-08 | P1 gate | davmail 前置实测全过：CRUD/嵌套/系统保护全支持，无降级 | — |
| 2026-06-08 | P1 | 实现完成（imap_utf7/list_folders/SYNC_FOLDERS/per-folder marker+uidvalidity/get_new_emails 多文件夹/DB v22/CLI discover·enable·disable）；75 新测试绿 + 真机 e2e 过 + 零新增回归（1166 passed）；codex REQUEST CHANGES→修 3 finding（JSON 白名单/mailbox quoting/系统文件夹排除）→ APPROVE WITH NITS（NIT 修） | `22c7f759` |
| 2026-06-08 | P2 | L3 通知降噪 + L2 LLM gate（per-folder）+ 下游零改动验证（Notion/FTS/线程/mailbox 过滤）+ DRY 抽 parse_folder_csv_or_json；27 测试 + 1452 passed（含 notify）零新增；codex APPROVE WITH NITS→修 3→opus critic APPROVE WITH NITS | `f12f173e` |
| 2026-06-08 | P3 | serve-api discover/whitelist 端点（6 api 测）+ 前端 FolderPicker 树/SidebarFolderTree/API wiring(HttpApi+Electron IPC)/i18n 双语 44/主题 token；executor 实现；opus code-reviewer APPROVE WITH NITS→修 MEDIUM 嵌套叶子名+2 LOW+NIT；typecheck+1367 前端测试+build:web+384 api+ruff/eslint 全绿 | `efb73a02` |
| 2026-06-08 | P4 | 写操作泛化（archive src 泛化+move_to_folder+trash 守卫）+ 文件夹管理 CRUD（create/rename/delete+系统保护+级联+一致性+白名单 restart）+ serve-api manage/move + CLI + onboarding 步 + FolderPicker 管理 UI；opus code-reviewer REQUEST CHANGES→修 2 MEDIUM blocking（delete 级联/restart_required）+4 LOW→APPROVE WITH NITS；1492 py + 1379 fe 全绿 | `c01229f0` |
| 2026-06-08 | P5 | 取消勾选清理（cleanup_local_folder 不碰 Exchange + serve-api/CLI + 前端选项默认保留）+ 验证 P1 边界（UIDVALIDITY 重拉/max_messages/tree 降级）；opus review APPROVE WITH NITS→修 3 LOW（cleanup 守卫/含子行/空名）；1495 py + 1381 fe 全绿 | `2a7cb86b` |
| 2026-06-09 | P6 | folder_sync 展示链路清理：删 worker/repository/sync_ops + DB v23 DROP 三表（idempotent）+ 老 router/CLI 展示端点 + 前端老 viewer（folder/ 7 组件/FolderLayout/Sidebar 老 nav/archive·drafts route/老 IPC·API 方法）+ i18n 孤儿（settings.sync.folder 双语）+ 死 config（frontend_mailbox_folders_enabled）；`FolderImapReader` git mv → `src/mail/backend/`（5 import 改）；**顺带修 P3 env 白名单遗漏**（FOLDER_SYNC_PAST_DAYS/MAX_MESSAGES 入 MANAGED_ENV_KEYS）；后端 1467 passed 零新增 + 前端 typecheck+1364+build:web 全绿；codex GPT-5.5 xhigh **APPROVE**→修 2 NIT（stale 注释×4 / EOF 空行） | `9e588a96` |

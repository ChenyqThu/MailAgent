# MailAgent 升级迁移指南（2026-05 大版本）

> **覆盖范围**：从 **~2026-05-14（DB v3，AppleScript 单后端，无前端/无 KOS）** 升级到
> **2026-05-28（DB v17，DavMail 主路径，Electron 前端，KOS 可选）**。
>
> **这份文档是写给 agent 的**。如果你是某位旧版本用户的 Claude Code / Codex agent，
> 请先**完整读一遍**，再按 [§4 决策点](#4-决策点用户必须拍板) 逐项跟用户确认，
> 最后按 [§5 分模块迁移步骤](#5-分模块迁移步骤) 执行。过程中遇到 [§6 隐藏风险](#6-隐藏风险清单agent-必读)
> 列出的任何一项，停下来跟用户说清楚再动手。

---

## 0. 先判断：用户真的在"旧版本"吗？

在动任何东西之前，先跑这几条快速判定，确认基线、避免误操作：

```bash
cd <用户的 MailAgent 目录>

# (a) 当前代码版本 / 落后多少
git log --oneline -1
git fetch && git log --oneline HEAD..origin/main | wc -l   # 落后的提交数

# (b) 当前 SQLite schema 版本（核心判据）
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version';" 2>/dev/null \
  || sqlite3 data/sync_store.db "PRAGMA user_version;"

# (c) 旧版特征：这些目录/文件在旧版里"不存在"
ls src/kos src/folder_sync src/calendar_sync frontend 2>/dev/null   # 旧版会全部 No such file
grep -c MAILAGENT_BACKEND .env 2>/dev/null                          # 旧版 = 0
```

判定结论：

| 观察 | 含义 |
|---|---|
| DB version = **3**（或读不到 `db_version`，只有 `PRAGMA user_version`） | 典型的两周前基线，本指南完全适用 |
| DB version 在 **4–16** 之间 | 中间版本，本指南仍适用，只是部分迁移你已经走过（迁移幂等，重复无害） |
| DB version = **17** | 已是最新 schema，重点看 [§4 决策点](#4-决策点用户必须拍板) 决定要不要启用新功能即可 |
| `src/kos` 等目录已存在 | 代码已较新，按 `git log` 落后量判断 |

> ⚠️ **不要假设**。先读出真实的 DB version 和落后提交数，再决定迁移范围。

---

## 1. TL;DR — 两周内发生了什么

| 大变更 | 一句话 | 默认是否启用 | 用户必须决策？ | 关键风险 |
|---|---|---|---|---|
| **DavMail 双后端** | 邮件后端从「Mail.app + AppleScript」抽象成可切换的 `IMailBackend`，新增 DavMail IMAP/SMTP/CalDAV 主路径 | 代码默认 `applescript`（保持旧行为） | ✅ 是否切 davmail | **合规**：当前 davmail 用伪装 client_id，不可上生产；EWS 2026-10 退役 |
| **数据库 v3 → v17** | 14 次 schema 升级：新增正文/附件 SSoT、outbox、翻译、日历、归档/草稿、AI 字段等 10+ 张表/列 | 启动自动迁移 | ❌（自动） | **单向**，不可降级；附件落盘吃磁盘 |
| **v4 SQLite SSoT** | 邮件正文 + 附件二进制以 SQLite/本地盘为 SSoT，Notion 退化为镜像，FTS5 全文搜索 | 双写 `BODY_DUAL_WRITE_ENABLED=true` 默认开 | ❌（默认开，按需调） | 附件磁盘体积；读路径灰度开关 `NOTION_READ_FROM_SQLITE` |
| **MailAgent Web（前端）** | 全新 Electron 桌面 App（收件箱/详情/AI chat/撰写/翻译/灵动岛/设置） | 不随后端启动，需单独装 | ✅ 是否装前端 | 需 venv 里的 `mailagent` CLI + better-sqlite3 原生编译 |
| **KOS（gbrain）知识库** | mail-sync 把邮件推 KOS `/ingest`；前端 chat 用 `kos_query`/`kos_digest` 调跨域知识 | 全 4 个 flag 默认 `false` | ✅ 是否接 KOS | 需向 KOS 管理员（Lucien）申请 OAuth 凭据 |
| **灵动岛 / Sprint15 outbox / 日历 SSoT / 归档草稿** | 一系列子系统，详见 [§5](#5-分模块迁移步骤) | 多数默认关（灵动岛 flag 默认开但需装 app） | 视需要 | 见各小节 |

**最重要的一句话**：升级代码 + 自动迁移数据库是**安全**且**几乎零决策**的；真正需要用户拍板的是
**要不要启用 4 个可选大功能**（davmail / 前端 / KOS / LLM 本地分类）。这些都是 opt-in，
不启用就维持旧行为。

---

## 2. 升级前必做（不可跳过）

```bash
cd <用户的 MailAgent 目录>

# 1) 备份数据库 —— 迁移单向不可逆，这是唯一的后悔药
cp data/sync_store.db "data/sync_store.db.bak.$(date +%Y%m%d-%H%M%S)"

# 2) 备份 .env（后面要往里加新配置）
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"

# 3) 确认 working tree 干净（有本地改动先 stash/commit，别让 git pull 冲突）
git status

# 4) 如果用 PM2 跑着，先停服务再升级（迁移在下次启动时发生）
pm2 stop mail-sync 2>/dev/null || true
```

> 💡 备份 db 是**硬要求**：v3→v17 迁移会改表结构，没有官方降级脚本。回滚 = 换回旧代码 + 还原这个备份。

---

## 3. 数据库迁移（v3 → v17）—— 自动、幂等、单向

迁移逻辑全在 [`src/mail/sync_store.py`](src/mail/sync_store.py) 的 `_init_database()`，
用 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE`（带 try/except 容错）实现，**幂等**：
你只要用新代码启动一次 `main.py`，数据库就会从当前版本一路升到 v17，重复启动无副作用。

**这两周加了什么（v3 → v17）：**

| 版本 | 内容 | 关联功能 |
|---|---|---|
| v4 | `email_body` + `email_attachment` 表 | v4 SSoT 正文/附件 |
| v4→ | `email_body_fts`（FTS5 全文索引） | 全文搜索 |
| v5 | `cli_checkpoints` | CLI 长任务 resume |
| v6 | `v4_rollout_stats` | v4 灰度统计 |
| v7 | `island_dispatch` | 灵动岛去重/审计 |
| v8 | `email_metadata.is_pinned` / `pinned_at` | 前端置顶 |
| v9 | `email_metadata.is_important` | 前端重要标记 |
| v10 | `email_outbox` | Sprint 15 SSoT inversion |
| v12 | `email_translation` | 沉浸式翻译缓存 |
| v13 | `email_metadata.imap_uidvalidity` / `imap_uid` / `backend_origin` + `sync_sequence` 表 | **DavMail 双后端** |
| v13 | `email_metadata.processing_status` | 反向同步状态机 |
| v14 | `email_metadata.ai_priority` / `ai_action` | AI 字段提升主表列 |
| v15 | `calendar_event` + `calendar_sync_state` | 日历 CalDAV → SQLite SSoT |
| v16 | `email_attachment_text` + `email_attachment_fts` + triggers | 附件文本化 + 搜索 |
| v17 | `folder_email` + `folder_sync_state` | 存档/草稿箱双入口 |

**风险与注意：**

- **单向不可降级**：没有 downgrade 脚本。回滚靠 [§2](#2-升级前必做不可跳过) 的 db 备份。
- **磁盘体积**：`email_body`（正文 HTML+Markdown）和 `data/attachments/{internal_id}/`（附件二进制）
  会随双写增长。大邮箱（6–7 万封）首次回填可能是 GB 级。磁盘紧张的用户先看 [§5.3](#53-v4-sqlite-ssot正文--附件)。
- **迁移在启动时跑**，不是 `git pull` 时跑。所以验证迁移要在启动 `main.py` 之后。

**验证迁移成功：**

```bash
source venv/bin/activate
python3 main.py    # 看启动日志，应有 "Database tables initialized (v17)"，无 migration ERROR
# Ctrl-C 停掉，或直接验证版本：
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version';"   # 期望 17
sqlite3 data/sync_store.db ".tables" | tr ' ' '\n' | grep -E "email_outbox|calendar_event|folder_email|email_body"
```

---

## 4. 决策点（用户必须拍板）

下面 5 个是真正需要用户决定的地方。**agent 应逐项问用户**，不要替他默认选择。
每项都给了「默认/收益/成本/风险」，帮用户判断。

### 决策 A：邮件后端 —— 保持 AppleScript，还是切 DavMail？

| | AppleScript（默认/旧行为） | DavMail（新主路径） |
|---|---|---|
| **配置** | `MAILAGENT_BACKEND=applescript`（或不设） | `MAILAGENT_BACKEND=davmail` |
| **依赖** | macOS Mail.app 已加账户 + 自动化权限 | 额外跑 DavMail JVM（PM2 `davmail-poc`）+ cipher key |
| **收益** | 零额外部署，继续能用 | 单封获取 ~236ms（vs ~1s，4× 快）；富文本草稿不再靠 GUI 注入；跨平台铺路 |
| **风险** | EWS 退役后 Mail.app 本身受影响（与 backend 无关） | ⚠️ **合规**：当前用 Outlook for Windows 伪装 client_id（PoC），**不可上生产**，需公司 IT 审批（建议直接申请 Graph API）；EWS 2026-10-01 关停，DavMail 6.7 仍走 EWS |

> **建议**：个人 dogfood / 想要富文本草稿和速度 → 可以切 davmail。
> 公司生产环境 / 合规敏感 → **先别切**，维持 applescript，等 Graph API 路线（Issue #404）落地。
> 不确定就保持 applescript（默认），随时一行 `.env` 切换。切换/回切见 [§5.2](#52-后端选择applescript--davmail)。

### 决策 B：要不要装 MailAgent Web 桌面前端？

- **它是什么**：Electron App，给后端 mail-sync 当 GUI —— 收件箱三栏、邮件详情、AI 多轮 chat、
  回复/转发撰写（TipTap）、一键翻译、灵动岛通知、设置面板。
- **默认**：不随后端启动，纯 opt-in。后端照常无头跑（Notion 仍是你的主界面）。
- **成本**：需要 Node + pnpm，首次装要编译 better-sqlite3 原生模块；或直接下 Releases 的 `.dmg`。
- **风险**：前端要求 venv 里装好 `mailagent` CLI（它通过 CLI/SSE 跟后端通信）；keytar 把密钥写 macOS 钥匙串。
- **建议**：想要现代邮件客户端体验就装；只要"邮件进 Notion + AI 分类"则**完全不需要**。装法见 [§5.5](#55-mailagent-web-前端)。

### 决策 C：要不要接 KOS（gbrain）知识库？

- **它是什么**：把邮件推到外部知识图谱（Jarvis KOS v2 @ `kos.chenge.ink`），让 AI chat 能跨邮件/跨来源检索。
  Producer（推 `/ingest`）+ Consumer（chat 工具 `kos_query`/`kos_digest`）。
- **默认**：**4 个 flag 全部 `false`**，不接就完全不影响主同步。
- **成本/前置**：需要向 KOS 管理员（Lucien）申请 **OAuth client 凭据**（`gbrain_cl_*` / `gbrain_cs_*`），
  放进 `.env`（建议 `.env.local`，别 commit）。
- **风险**：KOS 不可达时**不阻塞**主流程（fail-soft，自动 fallback 本地 FTS5）；但凭据是机密，别进 git。
- **建议**：除非用户明确有"跨邮件知识检索 / 多来源知识图谱"需求且有 KOS 访问权，否则**保持关闭**。启用见 [§5.6](#56-kos-gbrain-知识库)。

### 决策 D：AI 分类走哪条路 —— Notion Email Agent，还是本地 LLM，还是 Notion Agent CLI？

这块两周内**底层没大改**，但容易和新功能撞车，需要讲清楚：

- **Notion Email Agent（旧默认）**：Notion 端 Automation 填 AI 字段。不动它就继续用。
- **本地 LLM 分类**（`LLM_AGENT_ENABLED=true`）：本地用 Anthropic 兼容网关填 AI 字段。
  ⚠️ **启用前必须先在 Notion 端把 Email Agent 停掉**（或加 "AI Summary is empty" 过滤），
  否则两条 AI 路径双跑撞车。详见 [`docs/LLM_AGENT_SETUP.md`](docs/LLM_AGENT_SETUP.md)。
- **Notion Agent CLI**（`notion-agent`，前端 AI 后端选项之一）：前端 chat 可调；`pipx install notion-agent-cli`。
- **建议**：维持现状最省心。想要本地可控/省 Notion AI 额度 → 切本地 LLM（注意防双跑）。

### 决策 E：灵动岛 / 日历 SSoT / 归档草稿 等子系统

这些都是 opt-in 小功能，按需启用，无强迫：

- **灵动岛**（`PING_ISLAND_ENABLED`，代码默认**已开**）：需另装 `ping-island.app`；没装则 socket fail-open，**不影响主同步**。
- **日历 CalDAV SSoT**（`CALENDAR_CALDAV_SYNC_ENABLED=false`）：davmail CalDAV → SQLite `calendar_event`。davmail 模式下才有意义。
- **归档/草稿箱**（`MAILBOX_FOLDER_SYNC_ENABLED=false`）：**davmail-only**，applescript 模式不启动。
- **Sprint15 outbox**（`MAILAGENT_OUTBOX_ENABLED`，灰度）：反向同步走 outbox+FanoutWorker；关时退回旧 AppleScript 直调。

---

## 5. 分模块迁移步骤

### 5.1 拉代码 + 更新依赖（所有人都要做）

```bash
cd <用户的 MailAgent 目录>
git pull                                  # 若有本地改动先 stash
source venv/bin/activate
pip install -e ".[cli,dev]"               # 装/更新 mailagent CLI（旧版可能还没有 CLI）
mailagent --version                        # 期望 3.0.0
```

> 旧版（两周前）很可能**还没有 `mailagent` CLI**（CLI 是 2026-05-16 才 ship 的）。
> `pip install -e ".[cli]"` 会把它装进 venv。前端、KOS producer 鉴权、批量运维都依赖它。

启动并让数据库自动迁移（见 [§3 验证](#3-数据库迁移v3--v17--自动幂等单向)）。
**到这一步，不启用任何新功能，用户就已经"无缝升级"了**，行为跟旧版一致（只是底层多了 SSoT 双写和一堆空表）。

### 5.2 后端选择（AppleScript ↔ DavMail）

**保持 applescript（默认，无需操作）**：什么都不用改，`.env` 里没有 `MAILAGENT_BACKEND` 等价于 applescript。

**切到 davmail**（决策 A 选了切才做）：
```bash
# 前置：本机已装并跑起 DavMail JVM（PM2 进程 davmail-poc），确认 online
pm2 ls | grep davmail-poc

# .env 追加
cat >> .env <<'EOF'
MAILAGENT_BACKEND=davmail
DAVMAIL_USER=your.email@example.com
DAVMAIL_POC_MODE=1          # PoC 共享 key；生产前必须改成显式 DAVMAIL_CIPHER_KEY
EOF
pm2 restart mail-sync && pm2 logs mail-sync --lines 30 --nostream
```
**回切 applescript（emergency）**——⚠️ 必须 reset radar marker，否则 applescript 看 davmail 的 UIDNEXT 永远检测不到新邮件：
```bash
sed -i.bak 's/^MAILAGENT_BACKEND=davmail/MAILAGENT_BACKEND=applescript/' .env
sqlite3 data/sync_store.db "UPDATE sync_state SET value = (SELECT MAX(internal_id) FROM email_metadata WHERE backend_origin='applescript') WHERE key='last_max_row_id';"
pm2 restart mail-sync
```
DavMail 完整配置项见 [`.env.example`](.env.example) §Dual-Backend，背景见 [`docs/claude/architecture-internals.md`](docs/claude/architecture-internals.md) §Sprint 16。

### 5.3 v4 SQLite SSoT（正文 + 附件）

- **默认行为**：`BODY_DUAL_WRITE_ENABLED=true` —— 新邮件 sync 时自动把正文/附件元数据写 SQLite，
  附件二进制落 `data/attachments/{internal_id}/`。失败仅 warning，不阻断 Notion sync。**无需操作**。
- **磁盘提醒**：附件落盘会吃空间。`ATTACHMENT_STORAGE_DIR` 可改路径。存量邮件不会自动回填正文/附件，
  需要时用 backfill 脚本（见 [`docs/architecture_v4_sqlite_ssot.md`](docs/architecture_v4_sqlite_ssot.md)）。
- **读路径灰度**：`NOTION_READ_FROM_SQLITE=false`（默认）。切 `true` 后 sync/resync 优先走 SQLite SSoT，
  miss 自动 fallback。切前请按 v4 文档至少实测 3 封。**建议先保持 false。**

### 5.4 Sprint 15 outbox（反向同步 SSoT inversion）

- **默认**：`MAILAGENT_OUTBOX_ENABLED` 灰度。关时反向同步（Notion → Mail.app）退回旧 AppleScript 直调，跟旧版一致。
- **启用**：开关打开后，flag/状态变更写 SQLite intent + `email_outbox`，进程内 `FanoutWorker` 异步派发到 Mail.app + Notion。
  切换流程（单封 smoke → 一处 callsite → 全切）见 [`docs/sprint15-backend-complete.md`](docs/sprint15-backend-complete.md)。
- **建议**：旧用户可暂不启用，等其它部分稳定后再灰度。

### 5.5 MailAgent Web 前端

**方式一（推荐普通用户）：下载打包好的 `.dmg`**
到 [GitHub Releases](https://github.com/chenyqthu/MailAgent/releases) 下对应架构（arm64 / x64），
右键 → 打开（ad-hoc 签名）。完整步骤见 [`frontend/INSTALL.md`](frontend/INSTALL.md)。

**方式二（开发者：源码跑）**
```bash
cd frontend
pnpm install            # postinstall 会编译 better-sqlite3 原生模块
pnpm dev                # 开发模式；或 pnpm build:mac 出 .dmg
```
**前置硬条件**：venv 里 `mailagent` CLI 必须在 PATH（前端通过它跟后端通信）。
若前端报 `mailagent CLI not on PATH`，见 INSTALL.md §5.1。
应用内首配（AI 后端 / 密钥 / 存储路径）见 INSTALL.md §3。

### 5.6 KOS（gbrain）知识库

仅在决策 C 选"接"时做。**先拿到 OAuth 凭据**（找 Lucien 申请 `gbrain_cl_*` / `gbrain_cs_*`），然后：
```bash
# 写到 .env（凭据建议放 .env.local，别 commit）
cat >> .env <<'EOF'
KOS_MCP_BASE=https://kos.chenge.ink
KOS_OAUTH_CLIENT_ID=gbrain_cl_xxxx
KOS_OAUTH_CLIENT_SECRET=gbrain_cs_xxxx
EOF
# 连通性自测
bash scripts/dev/kos_smoke_test.sh        # health / token / MCP query / Python client e2e
```
**分层启用（按需逐个打开，全默认 false）：**
- `MAILAGENT_KOS_INGEST_ENABLED=true` —— Producer：邮件 sync 完异步推 `/ingest`（`KOS_INGEST_PRIORITY_FLOOR` 控阈值，默认 normal）
- `MAILAGENT_KOS_CONSUMER_ENABLED=true` —— 前端 chat 的 `kos_query`/`kos_digest` 工具
- `MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED=true` —— chat system prompt 注入 sender digest（前端）
- `MAILAGENT_AGENT_HARNESS=true` —— 前端多轮 tool-calling chat（KOS consumer 的载体之一）

验收清单见 [`docs/eval/m2-dogfood-checklist.md`](docs/eval/m2-dogfood-checklist.md)，设计见 [`docs/kos-integration-design.md`](docs/kos-integration-design.md)。

### 5.7 日历 CalDAV → SQLite SSoT

- davmail 模式下，设 `CALENDAR_CALDAV_SYNC_ENABLED=true` 启动进程内 `CalendarSyncWorker`，
  从 DavMail CalDAV 增量同步到 SQLite `calendar_event`。
- applescript 模式下也能跑旧的"邮件 .ics → 日程"路径（与本 worker 无关）。
- 详见 [`docs/claude/calendar-ops.md`](docs/claude/calendar-ops.md)。

### 5.8 归档 / 草稿箱（folder_sync）

- **davmail-only**：`MAILBOX_FOLDER_SYNC_ENABLED=true` 且 `MAILAGENT_BACKEND=davmail` 才启动 `FolderSyncWorker`。
- applescript 模式下设了也不启动（启动日志会提示）。
- 详见 [`docs/folder-ui-prd.md`](docs/folder-ui-prd.md)。

---

## 6. 隐藏风险清单（agent 必读）

迁移过程中最容易踩、且文档分散的坑，集中列在这里：

1. **DavMail 合规红线**：当前 davmail 用伪装 client_id（PoC），**严禁上公司生产**。切之前跟用户确认这是个人 dogfood 还是生产。EWS 2026-10-01 关停，DavMail 6.7 仍走 EWS —— 长期方案是 Graph API（见 [`docs/roadmap-post-cutover.md`](docs/roadmap-post-cutover.md) §5.1）。
2. **数据库迁移单向**：没有降级脚本。**一定先备份** `data/sync_store.db`（[§2](#2-升级前必做不可跳过)）。
3. **backend 回切要 reset marker**：davmail → applescript 回切时若不重置 `last_max_row_id`，applescript 会因为看着 davmail 的 UIDNEXT 而永远 `has_new=False`，**新邮件静默不同步**。脚本见 [§5.2](#52-后端选择applescript--davmail)。
4. **AI 双跑撞车**：启用本地 LLM 分类前，**必须**先在 Notion 端停掉 Email Agent Automation，否则两条路径同时填 AI 字段。
5. **Notion schema 新字段**：若启用本地 LLM 或新前端，确认 Notion 邮件库有 `AI Action`/`AI Priority`/`AI Review Status` 这些 Select 字段及其选项（`AI Priority`: Critical/Urgent/Important/Normal/Low）。改 schema 要同步 `src/llm_agent/schema.py`（有 `schema-consistency-reviewer` subagent 校验）。
6. **env-only flag 需要 load_dotenv**：部分 flag（灵动岛 deeplink、CLI 写命令鉴权等）直读 `os.environ`，靠 `main.py` 的 `load_dotenv()` 注入。**用 PM2 跑时确认 `.env` 真的被加载**，否则这些功能静默失效。
7. **folder 写未走 outbox SSoT**：归档/草稿的写操作目前**直连 IMAP**，没走 Sprint15 的 outbox 反转（已知待优化项，非 bug，但和主邮件路径的一致性模型不同）。
8. **附件磁盘体积**：v4 双写 + 大邮箱回填可能 GB 级。磁盘紧张先确认 `ATTACHMENT_STORAGE_DIR` 落点。
9. **前端依赖 mailagent CLI on PATH**：前端不是独立的，它靠 venv 里的 CLI 跟后端通信；CLI 不在 PATH → 前端空白/报错。
10. **macOS 权限**：完全磁盘访问（读 Mail.app SQLite）+ 自动化（操作 Mail.app）。PM2 进程继承启动终端的权限，换终端要重新授权。
11. **KOS 凭据是机密**：`gbrain_cs_*` 绝不能进 git，放 `.env.local`。

---

## 7. 验证 & 回滚

**升级后基础验证：**
```bash
pm2 restart mail-sync && sleep 3 && pm2 logs mail-sync --lines 30 --nostream   # 无 ERROR
sqlite3 data/sync_store.db "SELECT value FROM sync_state WHERE key='db_version';"  # 17
sqlite3 data/sync_store.db "SELECT sync_status, COUNT(*) FROM email_metadata GROUP BY sync_status"  # 状态分布正常，dead_letter 没暴涨
mailagent admin health -o json | jq .data.healthy   # true
```
完整部署验证见 `/deploy` skill；系统化排查见 `/debug` skill。

**回滚（升级出问题时）：**
```bash
pm2 stop mail-sync
git checkout <旧版本 commit>                         # 换回旧代码
cp data/sync_store.db.bak.<时间戳> data/sync_store.db  # 还原 db 备份（[§2] 那份）
cp .env.bak.<时间戳> .env
pm2 restart mail-sync
```
> 注意：旧代码 + 新（v17）数据库**不保证兼容**（旧代码不认识新表/列虽然多数情况无害，但别赌）。
> 正确回滚是**代码和 db 一起回到旧版本**。

---

## 8. 参考文档地图

| 主题 | 文档 |
|---|---|
| 架构总览（本次整理） | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| 架构内核 / Sprint15 / Sprint16 深度 | [`docs/claude/architecture-internals.md`](docs/claude/architecture-internals.md) |
| DavMail cutover 全程 | [`docs/sprint16-cutover-complete.md`](docs/sprint16-cutover-complete.md) |
| Post-cutover roadmap（含 EWS 退役应对） | [`docs/roadmap-post-cutover.md`](docs/roadmap-post-cutover.md) |
| v4 SSoT 运维 | [`docs/architecture_v4_sqlite_ssot.md`](docs/architecture_v4_sqlite_ssot.md) · [`docs/claude/v4-ssot-ops.md`](docs/claude/v4-ssot-ops.md) |
| 本地 LLM 分类启用 | [`docs/LLM_AGENT_SETUP.md`](docs/LLM_AGENT_SETUP.md) · [`docs/claude/llm-agent.md`](docs/claude/llm-agent.md) |
| KOS 集成 | [`docs/kos-integration-design.md`](docs/kos-integration-design.md) · [`docs/claude/agent-harness-kos.md`](docs/claude/agent-harness-kos.md) |
| 日历模块 | [`docs/claude/calendar-ops.md`](docs/claude/calendar-ops.md) |
| 前端安装 / 使用 | [`frontend/INSTALL.md`](frontend/INSTALL.md) |
| CLI 命令全表 | [`docs/claude/cli-reference.md`](docs/claude/cli-reference.md) |
| 全部配置项 | [`.env.example`](.env.example) |
| Agent 项目指南 | [`CLAUDE.md`](CLAUDE.md) |

---

> 反馈 / 问题：[GitHub Issues](https://github.com/chenyqthu/MailAgent/issues)

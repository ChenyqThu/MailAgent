# 多文件夹同步 — 实现 Handoff（作战地图）

> 给**新 session**的开箱即用交付包：串起 PRD / 设计 / mockup + 分阶段落地 + 每阶段 codex review gate + 最终验收 + 文档更新 + 统一提交。
>
> **本功能当前状态**：✅ **已实现**（P1-P6 全部落地，2026-06-09，每阶段独立 review + 软件全绿）。实现语义见 [`architecture-internals.md`「多文件夹同步」](./claude/architecture-internals.md)，逐阶段验收见 [matrix](./multi-folder-sync-matrix.md) 进度日志。
> **决策基线**：完整 pipeline · 完整写操作（含回复/转发/移动）· 白名单手动勾选 · davmail-only
> **最后更新**：2026-06-09

---

## 0. TL;DR（30 秒）

让 davmail 把**用户勾选的自定义 Exchange 文件夹**（Jira/Notion/DMS固件发布…）接入 email_metadata 主链路，邮件获得与收件箱完全一致的全套能力。能力已实测坐实（LIST 列得出 18 个文件夹 + SELECT/SEARCH 取得到 + 有增量游标）。核心改造集中在 **davmail 取数主循环 + per-folder 游标 + 写操作泛化**；下游 Notion/AI/通知/搜索/列表**几乎零改动**。隔离极强：`SYNC_FOLDERS` 默认空 = 所有新代码不激活 = 与现状逐字节一致。

---

## 1. 交付物清单

| 文档 | 角色 | 状态 |
|---|---|---|
| [`multi-folder-sync-prd.md`](./multi-folder-sync-prd.md) | **PRD** — 需求背景、功能表现、配置页/Sidebar/onboarding 交互、决策记录、给设计师的出稿清单（§9） | ✅ 完成 |
| [`multi-folder-sync-design.md`](./multi-folder-sync-design.md) | **总设 + 详设（合一）** — §1-3 总体设计（架构/瓶颈/改动总览），§4-10 详细设计（接口/schema/函数/数据流/分阶段/验收/风险/文件清单） | ✅ 完成 |
| [`multi-folder-sync-design-handoff.md`](./multi-folder-sync-design-handoff.md) | **设计 handoff** — 5 界面设计规格 + 全状态 + 气质约束 | ✅ 完成 |
| [`multi-folder-sync-matrix.md`](./multi-folder-sync-matrix.md) | **能力矩阵 & 验收看板** — P1-P6 + i18n/主题/隔离横切 + 出口（执行驱动） | ✅ 完成 |
| `mockups/multi-folder-sync/index.html` | **mockup** — claude design 5 界面高保真稿（亮暗双主题，逐字复用生产 token） | ✅ 完成 |
| 本文档 | **handoff 作战地图** — 工作流编排 | ✅ 完成 |

**阅读顺序（新 session）**：PRD → design → 本 handoff → mockup（到手后）→ 创建 worktree → P1 开工。

---

## 2. 实现工作流总览

```
claude design 出 mockup
        │
        ▼
 创建 worktree (feat/multi-folder-sync, 从 main)
        │
        ▼
 P1 后端取数核心 ──► codex gpt-5.5 high review ──► 修到 APPROVE ──► commit
        │
        ▼
 P2 下游 pipeline 验证 + 通知 gate ──► review ──► commit
        │
        ▼
 P3 前端配置 + Sidebar ──► review ──► commit
        │
        ▼
 P4 onboarding + 写操作泛化 ──► review ──► commit
        │
        ▼
 P5 边界打磨 ──► review ──► commit
        │
        ▼
 最终软件验收（全测试绿）+ 真机 e2e（build .app）
        │
        ▼
 更新 readme/架构/CLAUDE.md/.env.example + 统一提交
        │
        ▼
 合 main + bump version + tag
```

---

## 2.5 流程选型：轻量结合 Trellis（已拍板 2026-06-08）

**docs/ 三份 = 权威需求设计**（不重走 Trellis brainstorm/prd）；**实现期挂 Trellis task 做编排 + 知识沉淀**；**质量门/隔离/验收用 codex review + worktree + 真机 e2e**。三者各管一段，不重复。

实现 session 在 worktree 里：
1. `python3 ./.trellis/scripts/task.py create "多文件夹同步"` 建 task；prd.md **引用 docs/ 三份**（不复制），jsonl 把 P1-P5 拆成 phase。
2. 每阶段循环：`trellis-implement`（按 design.md 实现）→ **codex gpt-5.5 high 独立 review**（强 gate，见 §5，REQUEST CHANGES 必修）→ `trellis-check`（兜底）→ `trellis-update-spec`（把实现中确立的契约——per-folder marker 的 UIDVALIDITY 处理、modified-UTF7 解码、`SYNC_FOLDERS` 空=零激活不变量——沉淀到 `.trellis/spec/`）→ commit。
3. 全部 phase 完 + 真机 e2e 通过 → 文档更新（§7）→ 统一提交 → `/trellis:finish-work` 收口。

> Trellis 提供：task 状态机/进度追溯 + spec 知识沉淀 + finish-work 收口纪律。
> 你的工作流提供：codex 异构强 review + worktree 隔离 + 真机 e2e。
> docs/ 提供：权威需求与设计。

---

## 3. Worktree 创建与 setup

**main 已是最新最全**（v2.1 已合入）。worktree 可由 **Claude Code 自动创建**（新 session 勾选 worktree 功能 → 从当前分支/main 切，都完整），或用下面命令手动建。**无论哪种，provision 必做**（新 worktree 的 `node_modules` / venv 是 gitignored 本地产物）。自动 worktree 时跳过下面 `#0 #1`，直接从 `#2` provision：

```bash
# 0. 确保 main 最新
cd /Users/chenyuanquan/Documents/MailAgent
git fetch && git checkout main && git pull

# 1. 创建 worktree（独立目录，main 全程保持干净可用）
git worktree add -b feat/multi-folder-sync ../MailAgent-multi-folder main
cd ../MailAgent-multi-folder

# 2. provision 后端 venv（主仓 Python 测试用）
python3 -m venv venv && source venv/bin/activate
pip install -e ".[cli,dev]"

# 3. provision frontend（gitignored 本地产物，新 worktree 必装）
cd frontend
pnpm install                              # node_modules（含一次 electron rebuild）
bash scripts/build-python-venv.sh         # resources/python 嵌入式 CPython（~200M，分钟级）
```

> 🔴 **打包铁律（build .app 前必读 CLAUDE.md「打包/发布」节）**：
> - 跑过 `pnpm test`（含 rebuild:node）后、build 前必 `pnpm rebuild:electron`（better-sqlite3 切回 Electron ABI，否则 SQLite IPC 全崩）。
> - **改了 Python 后端后，build .app 前必 `bash frontend/scripts/build-python-venv.sh` 重 provision**（venv 非 editable，旧 provision = 旧后端，验白做）。本功能 P1-P4 都改 src/，真机验收前务必重 provision。
> - 含远程 web 要 `pnpm build:web`；DB_VERSION bump 必同步 `backend_lifecycle.ts` 的 `EXPECTED_DB_VERSION`。

**收尾**：合并 main 后 `git worktree remove ../MailAgent-multi-folder` 清理。

---

## 4. 分阶段实施（细节见 design.md §7）

| 阶段 | 范围 | 验收方式 | 粗估 | MVP |
|---|---|---|---|---|
| **P1 后端取数核心** | `list_folders()` 发现 + modified-UTF7 解码 + `SYNC_FOLDERS` 配置 + per-folder marker（state KV）+ `get_new_emails` 多文件夹遍历 + DB v22 | CLI `folder discover` + 配 `SYNC_FOLDERS` 跑 main.py，sqlite 查 email_metadata 出现自定义文件夹邮件、marker 不重复拉 | 2-3d | ✅ |
| **P2 下游 + 通知 gate** | 验证 Notion/LLM/FTS/线程 对自定义文件夹工作 + 自定义文件夹通知降噪（默认不通知） | Notion 页面 Mailbox 字段对 + 搜索命中 + 不刷飞书 | 1d | ✅ |
| **P3 前端配置 + Sidebar** | `<FolderPicker>` 组件 + serve-api `/api/folder/discover`+whitelist + IPC + Sidebar MAILBOXES 段动态渲染 + 列表 folder 过滤 | 设置页勾选 → Sidebar 出现 → 点击过滤 | 2-3d | |
| **P4 onboarding + 写操作** | onboarding 文件夹勾选步骤 + 归档/移动 src/dst 泛化 + `move_message` 扩展任意 src/dst | 新用户 onboarding 勾选；自定义文件夹内归档/移动/回复/转发 | 2-3d | |
| **P5 边界打磨** | 取消同步数据清理策略 + UIDVALIDITY 变化重拉 + 大文件夹分批 | 取消勾选行为；改 Outlook 文件夹结构后重拉 | 1-2d | |

**总计 8-12 天**。**MVP = P1+P2**（纯后端，CLI/sqlite 独立验收，不动前端、不碰收件箱主路径，风险最低）。建议 MVP 先跑通验证，再推前端各期。

**关键技术锚点**（design.md §10 有完整文件清单）：
- 取数遍历：`davmail_backend.py:1146` `get_new_emails`（在 INBOX 段后**追加**白名单循环，不改 INBOX）
- per-folder marker：复用 Sent 模式（从 email_metadata 派生）+ uidvalidity 存 state KV（`sync_store.py:1348` 同款）
- 写操作泛化：`mail_write.py:659` archive 写死 INBOX→Archive → 泛化；`imap_folder_reader.py:361` move_message 扩展任意 src
- 下游零改动：mailbox 字段透传，无 INBOX 硬编码

---

## 5. 每阶段 Review Gate（codex gpt-5.5 high）

每阶段实现完 + 自验绿后，**独立 review**（不自评）：

- **怎么跑**：用 `collaborating-with-codex` skill（或 `omc ask codex`），model = **gpt-5.5 high reasoning**。（项目惯例，勿用官方 `codex:codex-rescue`。）
- **review 什么**（每阶段）：
  1. **正确性** — 该阶段逻辑是否符合 design.md；边界（空文件夹/大文件夹/UIDVALIDITY 变化/中文名）是否处理。
  2. **隔离性**（最高优先）— 是否破坏收件箱/发件箱主路径；`SYNC_FOLDERS` 空时是否真正零激活；per-folder try 是否隔离失败。
  3. **一致性** — 与现有 Sent 模式、outbox SSoT、service-layer 写面是否对齐；无重复造轮子。
  4. **测试覆盖** — 单测/集成是否覆盖该阶段验收点（design.md §8.2）。
- **结论分级**：`APPROVE` / `APPROVE WITH NITS` / `REQUEST CHANGES`。**REQUEST CHANGES 必须修到通过**才进下一阶段。
- **记录**：每阶段 review 结论 + 修复要点写进 commit message 或阶段小结（便于最终验收回溯）。

---

## 6. 最终验收

### 6.1 软件验收（全绿）
```bash
# 后端
source venv/bin/activate
pytest tests/mail tests/cli tests/api -q          # 含新增 test_imap_utf7 / test_list_folders / test_get_new_emails_multifolder / folder discover 契约
# 前端
cd frontend && pnpm test                           # FolderPicker / Sidebar / onboarding 步骤 + 零 Electron 回归
pnpm typecheck && pnpm build:web                    # 零 TS 错 + web SPA 构建
```

### 6.2 真机 e2e（build .app）
> 🔴 **build 前必**：`bash frontend/scripts/build-python-venv.sh`（本功能改了 Python）+ `pnpm rebuild:electron`。漏跑 = 验白做（memory 血泪教训）。

```bash
cd frontend
pnpm build:web && pnpm rebuild:electron && pnpm run build && npx electron-builder --dir --arm64
# 装机
ditto dist/mac-arm64/MailAgent.app /Applications/   # 退出旧 app + 停 pm2 mail-sync 防双写
```
**e2e 检查清单**（对照 PRD §8 / design.md §8）：
- [ ] 设置页拉取文件夹列表，18 个文件夹含中文名 + 邮件数
- [ ] 勾选 Notion/Jira 保存 → 后端开始同步 → 邮件进 email_metadata（mailbox 正确）
- [ ] 自定义文件夹邮件被 AI 分类 + 同步到 Notion（Mailbox 字段对）+ 进全文搜索 + 正确归线程
- [ ] Sidebar MAILBOXES 段出现勾选的文件夹，计数对，点击列表按 folder 过滤
- [ ] 自定义文件夹内标旗/已读/归档/移动/回复/转发全链路正确
- [ ] 大文件夹（Jira 3458 封）受窗口+上限约束，不阻塞收件箱主同步
- [ ] onboarding 能勾选文件夹，完成后生效
- [ ] AppleScript 后端下功能整体禁用 + 提示
- [ ] **回归**：`SYNC_FOLDERS` 清空后行为与现状一致（收件箱/发件箱不受影响）

---

## 7. 文档更新清单（收尾，统一提交前）

| 文档 | 更新 |
|---|---|
| `CLAUDE.md` | 「关键开关现状」表加 `SYNC_FOLDERS` / `FOLDER_SYNC_PAST_DAYS` / `FOLDER_SYNC_MAX_MESSAGES`；「模块地图」如有新模块补；「文档地图」加多文件夹同步指针 |
| `.env.example` | 加 `SYNC_FOLDERS` + 窗口配置 + 注释 |
| `docs/claude/architecture-internals.md` | 多文件夹取数语义（get_new_emails 多文件夹遍历 + per-folder marker） |
| `frontend/ARCHITECTURE.md` | 如改了 Sidebar/列表过滤，补说明 |
| `frontend/.../backend_lifecycle.ts` | `EXPECTED_DB_VERSION` 同步 bump 到 22 |
| 本三份文档（prd/design/handoff） | 顶部状态标记为「已实现」+ 实际偏差记录 |
| memory（可选） | 新功能落地经验（如 per-folder marker 坑、worktree 经验） |

---

## 8. 统一提交策略

- **阶段内**：每阶段 atomic commit，scoped message（项目惯例中文）：`feat(multi-folder): P1 davmail 多文件夹取数 + per-folder 游标`。便于 review/回滚。
- **文档更新**：收尾时单独一个 commit：`docs(multi-folder): 更新 CLAUDE.md/架构/.env.example + 标记文档已实现`。
- **合 main + 发版**（参考 CLAUDE.md「打包/发布」）：真机验收通过 → 合 main → bump `frontend/package.json` version（patch/minor，本功能建议 minor）→ build → 装机验证 → `git tag -a vX.Y.Z`。
- **worktree 清理**：合并后 `git worktree remove`。

---

## 9. 关键约束 / 坑提醒（继承项目铁律）

| 约束 | 说明 |
|---|---|
| 🔒 **隔离回滚** | `SYNC_FOLDERS` 默认空 = 新代码零激活 = 与现状逐字节一致。这是最强灰度保护，开发全程保持「空配置零影响」不变量。 |
| 🔴 **venv provision** | 改 Python 后 build .app 前必 `build-python-venv.sh` 重 provision（判据=分支 vs 上次 provision 是否改过 Python）。 |
| 🔴 **better-sqlite3 ABI** | build 前必 `pnpm rebuild:electron`（跑过 test 后尤其）。 |
| 🔴 **DB_VERSION 同步** | bump `DB_VERSION`（21→22）必同步前端 `EXPECTED_DB_VERSION`，否则打包 app 启动门控卡 120s。 |
| ⚠️ **davmail-only + PoC 合规** | AppleScript 路径门控关闭；davmail 是 PoC（well-known client_id 伪装）不可上生产，正式落地需 IT 审批/Graph API；EWS 2026-10 退役。 |
| ⚠️ **subagent worktree git 污染** | 派 review/只读 subagent 到共享 worktree 禁跑 `git checkout/reset/stash`（memory [[feedback_subagent_shared_worktree_git]]）。 |
| ⚠️ **LLM 调用规格** | 新增 LLM 调用点统一 1M 上下文 + 64k max output（memory 用户指令）。 |

---

## 10. 给新 session 的启动 prompt（可直接用）

```
读 docs/multi-folder-sync-handoff.md（作战地图）+ docs/multi-folder-sync-prd.md（PRD）+
docs/multi-folder-sync-design.md（总设+详设）+ <mockup 路径>。

任务：按 handoff §4 分阶段在 worktree feat/multi-folder-sync 实现「多文件夹同步」功能。
从 P1（后端取数核心）开始，每阶段实现 + 自验 + collaborating-with-codex gpt-5.5 high
独立 review（handoff §5）+ 修到 APPROVE + atomic commit，再进下一阶段。
MVP = P1+P2（纯后端 CLI/sqlite 验收）。隔离不变量：SYNC_FOLDERS 空时零激活。

先确认 worktree 已按 handoff §3 创建并 provision，再开工。
```

---

## 附：能力实测证据（2026-06-08，davmail-poc IMAP 127.0.0.1:1143）

```
IMAP LIST "" "*"  → 18 个文件夹（含自定义 + 中文名解码）：
  Archive Bugzilla Confluence DMS固件发布 Figma Jira Notification Notion
  Unsent Messages Junk 存档 对话历史记录 Trash Sent 待办 必要文档路径 INBOX Drafts

STATUS + SELECT + SEARCH（自定义文件夹取数验证）：
  Notion        MESSAGES 381   UIDNEXT 1497  UIDVALIDITY 1  → SEARCH 381 封 ✓
  Jira          MESSAGES 3458  UIDNEXT 13644 UIDVALIDITY 1  → SEARCH 3458 封 ✓
  DMS固件发布    MESSAGES 728   UIDNEXT 2418  UIDVALIDITY 1  → SEARCH 728 封 ✓
  待办          MESSAGES 0     UIDNEXT 1     UIDVALIDITY 1  → SEARCH 0 封 ✓（空文件夹也正常）
  必要文档路径   MESSAGES 1     UIDNEXT 4     UIDVALIDITY 1  → SEARCH 1 封 ✓
```
结论：列得出（含中文）、进得去、取得到、有 per-folder 增量游标。能力侧 100% 验证通过。

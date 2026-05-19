# Sprint 15 Handoff — SQLite SSoT inversion: 前端 → SQLite → fanout

> Sprint 14 已 ship round 1-22 — Outlook thread bundle in EmailList, 内联图片
> 终极修, 单滚动条 + sticky 标题, AI Fields hero (Summary + Reply Suggestion)
> 整套, EmailDetail meta 折叠 + Notion URL, 多 mailbox supplement, popover
> z-index Portal fix 等. Sprint 15 = **把 mutating 操作从 Notion-centric
> 反向链路换成 SQLite-first + fanout**, NOTES.md 2026-05-19 战略 TODO 落地.
>
> **启动前最少读完**: §0 TL;DR + §3 工作目标 + §4 涉及文件 + §6 验收清单
> + §7 启动 prompt.

---

## 0. TL;DR

| 项 | 值 |
|---|---|
| Sprint 14 已 ship (前置) | (a) ThreadBundle 落 EmailList — 同 thread_id 邮件折叠到最新邮件下, head 行有 chevron, child 行缩进 + 无头像, 整 bundle 共享 selected 状态; (b) 内联图片终极修 — backend storage_payload_builder 已把 `cid:` 改为 `attachments/{id}/{file}` 相对路径, 前端加路径 rewrite + Electron main `readAttachmentAsDataUrl` 把相对路径 resolve 成绝对路径再读 (round 17+18); (c) 单滚动条 + sticky subject (round 14); (d) AI Fields 双 hero (Summary + Reply Suggestion 含 Copy 按钮) + grid 精简 + Reviewed/Pending chip 加 BadgeCheck/Clock icon; (e) EmailDetail meta 折叠 (Cc/Mailbox/internal_id/message_id/Notion URL 默认收) + grid-rows 平滑动画 + To/Cc 100 字符 more 展开; (f) cross-mailbox supplement listEnriched 让 outbox supplemental 邮件也 carry snippet + AI; (g) popover 用 Portal 跳出 stacking context; (h) thread chevron 全列点击 + 同时 select head; (i) backend `src/llm_agent/store.py:106` 不再 pop `reply_suggestion_md`, labels_json carry 4000 字符 reply markdown; (j) HoverTip 9px sans + ink-fg-2 浅灰; (k) NOTES.md 更新 |
| Sprint 15 目标 | **SQLite SSoT inversion** — 所有 mutating 操作反转方向, 前端 → SQLite (优先写) → fanout job 同步 Mail.app + Notion. 废弃 v3 时代 `notion.updateFlag` → Notion automation webhook → Redis → handler 反向调 AppleScript 的链路 |
| 设计 SSoT | `frontend/NOTES.md` 2026-05-19 strategic entry (主条) + 项目根 `CLAUDE.md` § "双向 Flag 同步" 现状描述 + `~/.claude/projects/.../memory/project_sqlite_ssot_inversion.md` |
| 阀门 | typecheck 0 / lint 0 / vitest 全绿 / pytest llm_agent + new outbox 测试 全绿 / a11y `--strict` clean / 灰度切换实测: 单封 email flag 触发, 1 分钟内 Mail.app + Notion 都同步, 无 webhook 循环 |
| 工作模式 | Claude Opus 4.7 max-effort 单线; 后端先 ship (schema + fanout worker), 前端 follow (新 IPC + callsite 切换); 每段原子 commit |
| 禁动区 | Sprint 14 已 ship 的 UI / DOMPurify / iframe height 解析路径 / Portal popover / ai-strip render rules 不动; backend `src/notion/` facade / pages.create_email_page_v2 灰度路径不动 |

---

## 1. Sprint 14 已 ship deliverables (本会话 round 1-22)

### 1.1 Inbox 视觉收口 (round 1-6)

| 层 | 改动 |
|---|---|
| `frontend/src/shared/components/ui/HoverTip.tsx` | text-meta (12px mono) → text-[9px] sans + leading-none + text-ink-fg-2; 不带 font-mono 因 DESIGN.md §14 #2 禁 CJK at mono 11/12 |
| `frontend/src/electron/renderer/index.css` | 加 `--c-cta-bg` / `--c-cta-bg-hover` / `--c-cta-fg` token + `.btn-cta` class. dark mode CTA bg 用 `--c-accent-dim` (深一档 accent), light mode 直接用 `--c-accent` (本身已深). fg 两个 theme 都白. `--c-accent-fg` 仅做 ghost button 用 |
| `frontend/src/shared/components/email/EmailToolbar.tsx` | PrimaryBtn 用 `.btn-cta` 替代 `bg-coral text-accent-fg` inline, icon 通过 `fill-current` 继承白 |

### 1.2 EmailDetail 重做 (round 6-14)

| 项 | 状态 |
|---|---|
| max-w-[820px] 上限 | 去掉 (全宽), iframe host 自己 mediate reading line length |
| meta grid | 默认显 From / To / Cc / Date; 折叠区: Mailbox + internal_id + message_id + Notion URL; CSS grid-rows 0fr↔1fr + opacity 平滑过渡 |
| To/Cc 100 字符 | 新 `ExpandableValue` helper, > 100 字符截断 + 内嵌小号 "more" 链接切换 |
| 邮件正文底部 footer | 删 — 顶部 toolbar 已有 Notion 按钮重复; "查看原文 .eml" 没 CLI wiring 也删 |
| AIFieldsBlock | 双 hero (Summary coral / Reply Suggestion accent-ringed + Copy button) + grid (Priority / Action / Sender Priority / Category / Project / Urgency Reason 至多 6 cell); Reviewed/Pending chip 加 BadgeCheck/Clock icon, text-[10px] |
| sticky subject | round 14 试探性 — 只 subject + 可选 lang banner sticky top-0, 用 `bg-ink-3/95 backdrop-blur-xl` Liquid Glass. round 8 sticky meta+AIFields 失败 (高度太大), 这次只锁标题 ~60px 不挤压 body |
| 单滚动条 | iframe `overflow:hidden + scrolling="no"`, AIFieldsBlock ReplyDraftHero 去内嵌 max-h/overflow-y-auto, 整封邮件共用一个 scroll container |
| 内联图片显示 | round 17 加 `attachments/{id}/{file}` 相对路径 → data URL rewrite; round 18 fix Electron main `readAttachmentAsDataUrl` 把相对 local_path resolve 成绝对路径再 readFile. NOTES.md 2026-05-20 旧诊断已纠正 ✅ |
| iframe height | parent 主动 `contentDocument.body.scrollHeight` 测量 (sandbox `allow-same-origin` 允许), ResizeObserver + img load 补测, 上限 80_000px. 取代之前依赖 inline `<script>` postMessage 的方案 (sandbox `allow-scripts` 没开, inline script 从不执行) |

### 1.3 ThreadBundle 重构 (round 8-13, 16-22)

| 项 | 状态 |
|---|---|
| 位置 | 撤出 EmailDetail (round 9) → 移到 EmailList (round 10), 不再在邮件正文底部 |
| Layout | wrapper `.thread-row-wrap` (24px chevron col + flex-1 EmailRow), head row chevron 占整 col (round 12) + click 同时 toggle thread + select head (round 16); child row indent + 1px 竖线 tether + `noAvatar=true` 让 avatar 位 visibility:hidden 保留 grid 但形成 32px 缩进 |
| Selected wash + accent bar | 移到 wrapper (`.thread-row-wrap[data-selected]`), bar 落 row 最左缘 (含 chevron col), thread 内任一邮件 active → 整 bundle 高亮 (head + children 共享 `bundleSelected`) |
| Time group count | 只数 thread head 数 (折叠后可见行), 不数 children |
| Pinned | thread-level — 任一邮件 pinned → 整 thread 进 pinned bucket |
| 跨 mailbox 完整 | `listByThread(tid)` useQueries 拿全 thread, supplement merge 时同 id 优先用 `enrichedById` 内的 enriched 版本; enrichedById 含同 mailbox `all` + 对面 mailbox `crossAll` (round 22), inbox 视图自动拉发件箱 enrich, 反之亦然 |
| 去重 | groupByThread 内 `seen: Set<internal_id>` defensive guard |
| 行高 | thread children 不再固定 42px (会裁 subject), 按 EmailRow rowHeight 计算 60-100px; 跨 mailbox supplement 不在 enrichedById 时降级 60px no-snippet 行 |
| orderedIds | round 20 改在 threadGroups 之后 compute, 收集所有 head + children id, cross-mailbox supplement head 不被 active-reset effect 误踢回 inbox 第一封 |

### 1.4 TitleBar popover z-index fix (round 19)

| 项 | 状态 |
|---|---|
| 根因 | TitleBar `<header className="glass">` (backdrop-filter) 创建 stacking context, popover z:60 是该 context 内顶层; EmailDetail sticky 标题 (round 14, 也 backdrop-blur-xl) DOM 在后, 整 context 画在 TitleBar 上 → popover 即使 z:60 也被覆盖 |
| 修 | `AccentPickerPopover` + `ThemePickerPopover` 都用 `createPortal(..., document.body)`, popover DOM 移到 root stacking context, z-index 重新跟 root 比较 |

### 1.5 Backend tiny fix (round 8)

| 项 | 状态 |
|---|---|
| `src/llm_agent/store.py:106` | `labels_dict.pop("reply_suggestion_md", None)` 去掉, labels_json 现在 carry 4000 字符 reply markdown, 前端 AIFieldsBlock Reply Suggestion hero 直接读 |
| pytest llm_agent | 62 passed (round 8 验过) |

---

## 2. 验证用 commits (按 round 顺序)

```
6c62d1a fix(frontend): Sprint 13 round 7 — Inbox UI 收尾 9 项用户反馈
dd271ee feat(frontend): Sprint 13 round 8 + Sprint 14 主菜 — ThreadBundle 上线 + AI hero 回归
fdb54eb fix(frontend): Sprint 13 round 9 — Inbox 折叠 UI 真正实现 + thread bundle 移到列表
31922d8 fix(frontend): Sprint 14 round 10 — thread row 视觉对齐 + 同邮件去重 + child 头像隐藏
9a3e640 fix(frontend): Sprint 14 round 11 — thread bundle 完整 + thread selected + footer 收拢
ade168a fix(frontend): Sprint 14 round 12 — thread chevron 全列点击 + children compact 行
7afd327 fix(frontend): Sprint 14 round 13 — thread child 行高 42 → 60px 避免截断
da04cbb fix(frontend): Sprint 14 round 14 — 单一滚动条 + sticky 邮件标题
c2a5394 fix(frontend): Sprint 14 round 15 — iframe height 真实自适应,长邮件不再被截
b10bf45 fix(frontend): Sprint 14 round 16 — 子邮件显内容预览 + chevron 同时切换+选中头邮件
                       round 17 — 内联图片终极修复, 重写 attachments/{id}/{filename} 相对路径
6c42985 fix(frontend): Sprint 14 round 18 — 内联图片真根因, attachment local_path resolve 错路径
aeefbaa fix(frontend): Sprint 14 round 19 — TitleBar popover Portal 出 stacking context + NOTES 内联图修复记账
4057d3f fix(frontend): Sprint 14 round 20 — outbox thread head 可点 + AI Fields chip / padding 紧凑
05d0b26 fix(frontend): Sprint 14 round 21 — supplement 优先用 visible enriched 数据, head 不丢 snippet/AI
a1193dd fix(frontend): Sprint 14 round 22 — 跨 mailbox supplement 也拿 enriched, 我发出的邮件不再裸行
```

---

## 3. Sprint 15 工作目标 — SQLite SSoT inversion

### 3.1 现状回顾

当前 EmailRow flag 三态切换 / EmailDetail toggle read|flag / BatchActionBar 批量操作链路:

```
前端 → mailApi.notion.updateFlag(id, {isRead/isFlagged/processingStatus})
     → CLI fork: `mailagent notion update-flag <id> ...`
     → Notion REST API: pages.update(props={Is Read, Is Flagged, Processing Status})
     → Notion automation (Email Agent) detect property change
     → POST → webhook-server (FastAPI)
     → Redis LPUSH → MailAgent local Redis consumer
     → handle_flag_changed / handle_ai_reviewed / handle_completed
     → AppleScript: tell Mail.app to set read status / flag color
     → reverse-sync mark SQLite `is_read` / `is_flagged` / `processing_status`
```

**问题**:
- 5-跳路径, 端到端 latency 30s-2min (Notion automation 不快)
- Notion 是 SSoT 假设 = v3 时代设计, v4 SQLite SSoT 落地后语义反转
- webhook-server / Notion automation 都是 single point of failure
- 前端 optimistic UI 与最终一致状态有窗口期, race condition 多

### 3.2 目标架构

```
前端 → mailApi.email.flag(id, {isRead/isFlagged/processingStatus})
     → ipcMain.handle('email:flag') (Electron main 直写 SQLite)
     → UPDATE email_metadata SET is_read/is_flagged/processing_status = ...
     → INSERT INTO email_outbox (op_type='flag_sync', target='mailapp|notion', payload)
     → fanout worker (mail-sync 进程内) 异步消费 outbox
       ├─ Mail.app: AppleScript set read status / flag color
       └─ Notion: pages.update properties

反向链路 (Notion 端用户手改) — 退化为 intent 来源:
     Notion webhook → Redis → handler (新)
     → 写 email_metadata + email_outbox (target='mailapp' only)
     → fanout worker 同步 Mail.app, **不再** 调 Notion 自己的 update (避免回环)
```

### 3.3 实施分块 (4 块, 按依赖排列)

**(A) Backend: outbox 表 + fanout worker** (基础, 必须先 ship)

| 文件 | 改动 |
|---|---|
| `src/mail/sync_store.py` | DB_VERSION 10 migration: 加 `email_outbox` 表 (outbox_id PK, internal_id FK, op_type TEXT, target TEXT in ('mailapp','notion'), payload_json TEXT, status TEXT in ('pending','done','failed'), attempts INT, last_error TEXT, next_retry_at REAL, created_at REAL, updated_at REAL); 索引 `idx_outbox_pending ON email_outbox(status, next_retry_at) WHERE status='pending'` |
| `src/sync/outbox.py` (新) | `OutboxRepository` — enqueue / poll_ready / mark_done / mark_failed / list_dead_letter. 类似 SyncStore 风格 |
| `src/sync/fanout.py` (新) | `FanoutWorker` — 异步 loop 每 5s 拉 pending outbox row, 按 target 派发: `MailAppFanout.execute(payload)` / `NotionFanout.execute(payload)`; 失败重试指数退避; 单 op 幂等 (写前检查 sync_store 当前状态匹配 payload, 已同步就 mark_done 跳过) |
| `src/sync/mailapp_fanout.py` (新) | AppleScript set read / flag (从 `src/events/handlers.py` 抽出来) |
| `src/sync/notion_fanout.py` (新) | Notion pages.update + retry on 429 |
| `main.py` | `asyncio.create_task(FanoutWorker(...).run())` 与 SQLite radar 平行 |

**(B) Backend: 反向 handler 退化为 intent → outbox**

| 文件 | 改动 |
|---|---|
| `src/events/handlers.py` | `handle_flag_changed`: 现在直接调 AppleScript + sync_store.update. 改成 → 写 email_metadata (intent) + 写 outbox (target='mailapp' only, **不写 Notion outbox** 因为 Notion 端是 intent 来源, 回写会产生 webhook 循环). idempotency: 比对当前 sync_store state, 已同步就 skip. 同理 `handle_completed` / `handle_ai_reviewed` |
| pytest `tests/events/` | 新加 outbox-based reverse sync 单测: webhook → handler 写 outbox → fanout pickup → AppleScript exec (mock); 验证回环不发生 |

**(C) Backend: CLI `mailagent email flag`**

| 文件 | 改动 |
|---|---|
| `src/cli/commands/email.py` | 新 subcommand `email flag <id> [--is-read/--is-flagged/--processing-status]`. 直写 email_metadata + outbox (target=mailapp+notion 都写, 因为前端发起的 flag 同时同步两端). 用 `LongTaskContext` (PR-4 长任务契约) 处理 `--allow-concurrent` 等 |
| `docs/cli-schema/email-flag.schema.json` | JSON Schema 契约文件 |
| `docs/agent-cli-rfc.md` | §4.x 补 `email flag` 文档 |

**(D) Frontend: 新 IPC + callsite 切换**

| 文件 | 改动 |
|---|---|
| `frontend/src/electron/main/handlers/email.ts` | 新 ipcMain.handle `'email:flag'`: 收 `{internalId, isRead?, isFlagged?, processingStatus?}` → cli_runner.callCli(`email flag <id> ...`) → 返回 envelope. 与 `email:resync` 同形 |
| `frontend/src/shared/api/types.ts` | `EmailApi.flag(id, opts): Promise<...>` 类型 |
| `frontend/src/shared/api/ElectronApi.ts` + `HttpApi.ts` | 实现 + V2 stub |
| **4 处 callsite 切换**: | |
| `frontend/src/shared/components/email/EmailRow.tsx` L234/237/244/255 (3-state flag cycle) | `mailApi.notion.updateFlag` → `mailApi.email.flag` |
| `frontend/src/shared/components/email/EmailDetail.tsx` L358/380 (handleToggleRead / handleToggleFlag) | 同上 |
| `frontend/src/shared/components/email/BatchActionBar.tsx` L122/134/146/161 (4 处 batch) | 同上 |
| `frontend/src/shared/components/batch/BatchActionBar.tsx` L138 (legacy path 是否仍用 需 verify) | 同上 |
| 旧 `notion.updateFlag` IPC | 保留 (作 fallback / V2 web 端临时回退) 但 callsite 全切; ElectronApi.ts 加 deprecated comment 注释 |
| EmailToolbar.tsx + EmailRow.tsx 文件头 comment | 更新现状, 删 deprecated breadcrumb (已不 deprecated) |
| `frontend/NOTES.md` 2026-05-19 战略条目 | 标 ✅ Sprint 15 ship |

### 3.4 Idempotency / race condition 设计

- fanout worker 每条 op 执行前查当前 SQLite state vs payload, 已同步则 mark_done 跳过 (例: payload is_read=true 但 sync_store.is_read 已是 true → done)
- Notion webhook → handler 写 outbox 时只写 target=mailapp (不回写 Notion). 避免 Notion → outbox → Notion 循环
- 前端 email:flag 写 outbox 时 target 二项都写 (前端 intent 是同步两端)
- outbox 加 `source_event_id` 字段记录"这条 intent 是从哪发起的", debug 用
- 死信策略: 5 次重试后进 dead_letter, 飞书告警

### 3.5 灰度 / 切换计划

1. **后端 ship A + B + C 完整, 默认关闭** — 加 env `MAILAGENT_OUTBOX_ENABLED=false`. fanout worker 启动但不消费. `mailagent email flag` CLI 可单独跑做烟雾测.
2. **后端单封烟雾验证** — `mailagent email flag <id> --is-read` 触发 → 看 outbox 表 + 1 分钟内 sync_store + Mail.app + Notion 三端一致.
3. **前端 ship D 但 callsite 仍用 `notion.updateFlag`** — `email.flag` IPC 就位但 0 使用. 跑回归看没破回环.
4. **灰度 `MAILAGENT_OUTBOX_ENABLED=true`** + 前端 EmailRow 一处 callsite 切到 `email.flag`. 24h 观察.
5. **全切**: EmailDetail / BatchActionBar / EmailRow 全部 callsite 切. 一周后删 `notion.updateFlag` 走 CLI 的旧路径 (保留 IPC 但 stub 成 throw NotImplementedError, V2 web 端走 outbox HTTP API).

### 3.6 涉及文件总览

```
后端 (新增):
  src/sync/outbox.py
  src/sync/fanout.py
  src/sync/mailapp_fanout.py
  src/sync/notion_fanout.py
  tests/sync/test_outbox.py
  tests/sync/test_fanout_worker.py
  docs/cli-schema/email-flag.schema.json

后端 (修):
  src/mail/sync_store.py            DB_VERSION 9 → 10 + email_outbox 表
  src/events/handlers.py            handle_flag_changed / handle_ai_reviewed / handle_completed 退化
  src/cli/commands/email.py         新 flag subcommand
  main.py                           启动 FanoutWorker
  docs/agent-cli-rfc.md             §4.x email flag 文档

前端 (修):
  frontend/src/electron/main/handlers/email.ts      新 'email:flag' IPC
  frontend/src/shared/api/types.ts                  EmailApi.flag 类型
  frontend/src/shared/api/ElectronApi.ts            email.flag 实现
  frontend/src/shared/api/HttpApi.ts                V2 stub
  frontend/src/shared/components/email/EmailRow.tsx 3 处 callsite 切
  frontend/src/shared/components/email/EmailDetail.tsx 2 处切
  frontend/src/shared/components/email/BatchActionBar.tsx 4 处切
  frontend/src/shared/components/batch/BatchActionBar.tsx 1 处切
  frontend/src/shared/components/email/EmailToolbar.tsx 文件头 comment
  frontend/NOTES.md                                 战略条目标 ship
```

---

## 4. 禁动区

- Sprint 14 已 ship 的所有 UI (ThreadBundle / iframe height / sticky subject / AIFieldsBlock hero / meta 折叠) — 不动
- `src/notion/` facade 拆分 (I-07 后) — 内部组件 PageOps / ThreadOps / QueryOps / queries 不直接 import; 走 `from src.notion.sync import NotionSync`
- pages.create_email_page_v2 灰度路径 / `NOTION_READ_FROM_SQLITE` flag — 不动 (这是 v4 Phase 4 完成态, 这次 Sprint 15 只动 reverse sync 链路, 不动正向 sync)
- 项目周报 (`src/project_progress/`) — 完全独立, 不动
- 飞书通知 (`src/notify/feishu.py`) — Card 2.0 form 仍由 handle_ai_reviewed 发送, 但内部链路从 直接 AppleScript 改成 outbox; 卡片发送本身保留

---

## 5. 风险 / 注意

| 风险 | 应对 |
|---|---|
| Notion webhook → handler 写 outbox → fanout 又调 Notion → 触发 Notion automation → 又 webhook → 循环 | handler 写 outbox 时**只**写 target='mailapp', 不写 target='notion' (因 Notion 端的 intent 已经存在). fanout 不再回写 Notion |
| outbox 表锁竞争 (mail-sync + 前端 CLI fork 同时写) | better-sqlite3 + sqlite WAL mode 已开; outbox INSERT 用单行 prepared statement, 锁竞争窗口 < 1ms |
| 灰度期 outbox_enabled=true 但 callsite 仍是 notion.updateFlag → 两套路径并行 | 不发生 — notion.updateFlag 仍走老链路 (notion update → webhook → handler), handler 同时写 outbox (target=mailapp). 即 Notion 改了一次, mail.app 走 outbox 同步. 不冲突. 但要小心: handler 此时不应再直接 AppleScript, 否则 mail.app 被改两次. → handler 改的同时 outbox flag enable, two paths 不重复 |
| Mail.app AppleScript 失败 / Mail not running | outbox 重试 5 次, 失败进 dead_letter 飞书告警. 与现状 (handler 调 AppleScript 失败) 行为一致, 只是失败现在可被 outbox 表观察到 |
| Notion 429 rate limit | NotionFanout 已在 src/notion/client.py 内置 retry, fanout 层不另外加. fanout 重试是顶级保险 (含其他网络错) |

---

## 6. 验收清单

- [ ] backend pytest 全绿 (含 outbox + fanout 新测)
- [ ] frontend typecheck 0 / lint 0 / vitest 全绿 / a11y `--strict` clean
- [ ] `pm2 restart mail-sync` + DB_VERSION 10 migration 成功 (`sqlite3 data/sync_store.db "PRAGMA user_version"` = 10)
- [ ] `mailagent email flag <id> --is-read -o json` 单独跑成功, outbox 表行 +2 (mailapp + notion target), 1 分钟内 status → done
- [ ] 前端点 EmailRow 旗标 → SQLite 立即写 + Mail.app + Notion 同步 (< 10s)
- [ ] 在 Notion 端手改 Is Read → webhook → handler 写 outbox (只 mailapp target) → Mail.app 同步 + Notion 不被回写 (无循环)
- [ ] BatchActionBar 批量 50 封, outbox 1 min 内全 done, 无 race
- [ ] 灰度切换 `MAILAGENT_OUTBOX_ENABLED=false` → 前端回退 `notion.updateFlag`, 服务可降级运行

---

## 7. 启动 prompt (下次 session 用)

> 我们要做 Sprint 15: SQLite SSoT inversion. 请按 `frontend/SPRINT15-HANDOFF.md`
> §3 工作目标实施. 推荐顺序: (A) 后端 outbox 表 + fanout worker → (B) 反向
> handler 改为 intent → (C) CLI `email flag` → (D) 前端 IPC + callsite 切换.
> 每段原子 commit + 验收证据. 灰度切换计划见 §3.5. 风险见 §5. 涉及文件
> 完整清单见 §3.6. 禁动区见 §4.

---

## 8. 参考文档

- `CLAUDE.md` § "双向 Flag 同步" — 现状行为
- `CLAUDE.md` § "Webhook 事件类型" — flag_changed / ai_reviewed / completed 路径
- `frontend/NOTES.md` 2026-05-19 strategic entry — 原始 TODO
- `~/.claude/projects/-Users-chenyuanquan-Documents-MailAgent/memory/project_sqlite_ssot_inversion.md` — 项目记忆
- `docs/architecture_v4_sqlite_ssot.md` — v4 SQLite SSoT 整体架构
- `docs/agent-cli-rfc.md` — CLI 契约 (新 `email flag` 要补 §4.x)
- `frontend/SPRINT13-HANDOFF.md` — Sprint 13 EmailDetail/AIChatPanel 实现历程

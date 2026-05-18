# Sprint 5 Handoff — Mail.app Write Commands + BatchActionBar + 状态机

> Sprint 5 主开发 handoff. Sprint 5 ship 完成 — 主菜 Mail.app 写命令端到端
> (createDraft + resync + llm:run + notion:updateFlag) + BatchActionBar 52px
> (DESIGN.md §5.4) + 状态机 #3/#4 闭环. 已通过独立 opus 4.7 max-effort review
> APPROVE verdict, 0 critical / 0 high / 2 medium (已闭) / 7 low (Sprint 6 关).
>
> **工期实际**: ~5-6 小时 (vs PROJECT-PLAN.md 1.5-2 天估算 — Sprint 4 重估后 5
> 仍偏紧). 单人 opus 4.7 max-effort 一气呵成 + Sprint 4 chat backbone 模块化
> 与 cli_runner 沉淀让写命令落地从 IPC handler 到 Toolbar 接通快得多.
>
> **启动前最少读完**: §0 + §1 + §3 + §4 + §5 + §9 启动 checklist + §10 红线清单.

---

## 0. TL;DR

| 项 | 值 |
|---|---|
| Sprint 范围 | Mail.app write commands (createDraft + resync + llm:run + notion:updateFlag) + Toast + BatchActionBar + 状态机 #3/#4 + Sprint 4 review 8 carry-forwards |
| 已 ship 基线 | commits `2d7a128` (Day 1 carry-forwards) + `0533eba` (Day 2-4 主菜) + `c94d2b0` (ship-review follow-ups) |
| 阀门 | 385 tests passed / 1 skipped (+89 vs Sprint 4), `pnpm lint` 0, `pnpm typecheck` 0, `pnpm a11y:contrast --strict` 12 combos clean, electron-vite build OK, production grep 23 patterns 0 hits |
| 工作模式 | Claude Opus 4.7 max-effort 单线; Sprint 末 opus 4.7 code-reviewer subagent (verdict APPROVE-with-follow-ups) + codex review (parked — bridge script 5min 0 byte timeout, opus 单 reviewer 足) |
| 阻塞 | 无 — 全 gate 绿, 进入 Sprint 6 |
| **Sprint 6 主菜** | `/admin` + `/llm` dashboard + `/calendar` 列表 + `/settings` 完整页 (keytar / Notion Agent binding / accent picker) + Sprint 5 review carry-forwards |

---

## 1. 已 ship deliverables

### Day 1 (commit `2d7a128`) — Sprint 4 review 8 项 carry-forwards

| Carry | What shipped | Tests |
|---|---|---|
| **codex High** | `useEmailChat` stale-send guard — `emailIdRef` mirror + closure capture; `chat.start()` resolve after email switch aborts stranded session | 4 new (incl. test mid-flight email switch) |
| **codex M** | `abortCurrent()` 同步 clear `streamingMessageId` + `refresh()` — UI 不再等下一个 chat:stream 事件 | 1 new |
| **codex L** | `AIChatPanel` `useSyncExternalStore` 订阅 localStorage `mailagent.notionAgent.{pageId,name}` + 自定义 `mailagent:notion-agent-storage` 事件 (Sprint 6 SettingsPage write 时 dispatch) | — |
| **opus M** | `Composer` ⌘↩ 改 `aria-label="ai-chat-panel"` scope 匹配; 不再依赖 `enabled: focused` | — |
| **opus M** | i18n CJK at text-micro/meta — 新 `useCjkMonoSwap()` helper 按 locale (`zh*` / `ja*` / `ko*`) 切 className; 4 个 chat 组件接入 (MessageList truncated/system divider/DraftPreviewCard header + ContextChips title/chips + BackendSelector agentName + Composer footer) | 7 new |
| **opus L** | `chat_db` schema v2 + metadata JSON 列; `notion_agent.extractTurn` v1 backcompat 读 (`model = 'notion-agent:<id>'` legacy + v2 metadata JSON `{thread_id}` 优先); ALTER TABLE 安全 v1→v2 migration | 6 new |
| **opus L** | `MessageList` scrollIntoView 仅在 user 距底部 ≤80px 时触发 — 流式 chunk 不再 hijack 手动向上滚 | — |
| **codex N** | `dispatcher.runStream` sawError defensive break — sticky flag + break loop after error event; metadata 持久化路径 | 2 new |

### Day 2-4 (commit `0533eba`) — Mail.app write commands + BatchActionBar

| 模块 | 行数 | 测试 | 作用 |
|---|---|---|---|
| `handlers/draft.ts` | 240 | 14 | AppleScript reply 草稿创建 (`tell app "Mail" to reply ... with opening window`); 已知/未知 account 双路径; mailbox char allowlist (Sprint 5 ship-review 安全 hardening); E_AUTOMATION_DENIED / E_MAIL_NOT_RUNNING / E_NOT_FOUND / E_INVALID_MAILBOX 分类 |
| `handlers/write_ops.ts` | 200 | 18 | 3 个 CLI 写 IPC: `email:resync` / `llm:run` / `notion:updateFlag`; envelope 模式 `{ ok, data \| code+message+hint }`; write+needsAuth flags 转发 cli_runner; per-command timeout (120s/90s/30s) |
| `shared/state/toast.ts` | 130 | 15 | zustand 队列 (MAX_VISIBLE=4), monotonic id, TTL 自清理 timer, 长任务 progress fraction sticky 模式; `toastSuccess` / `toastError` / `toastInfo` helpers |
| `shared/components/Toast.tsx` | 130 | — | 顶右 slide-in (220ms cubic-bezier), 3 variants (success/error/info); time-based + caller-driven progress bar 双模式; aria-live 区分 polite/assertive |
| `shared/hooks/useBatchOps.ts` | 130 | 6 | 顺序 loop runner: ids[] × unit → outcomes; 两段式 cancel (stage 0→1→2); progress toast 实时更新; 终态自动切 success / partial-error / cancelled toast; i18n via module-level `i18n.t` (Sprint 5 ship-review fix) |
| `shared/components/batch/BatchActionBar.tsx` | 200 | — | DESIGN.md §5.4 — 52px bar (selectedIds>0 触发); 3 个 coral AI ops + 3 个 ghost maintenance ops; cancel 按钮 stage-aware 文案; Esc 退出 |
| `shared/components/email/EmailToolbar.tsx` | +120 | 9 | 4 个写按钮 prop-driven (onCreateDraft/onResync/onLlmRun/onToggleRead/onToggleFlag); Loader2 spinner + disabled; resync 三按钮 confirm dialog (取消/试跑/直接重传); isRead/isFlagged 驱动 label + active 颜色 |
| `EmailDetail.tsx` rewire | +90 | — | 4 个 write handler callbacks 接通 mailApi; query invalidate 刷新 ['email', id] + ['email', id, 'ai'] on success; toastSuccess/Error 分类映射 (code → i18n key); `pending` map per-button |
| `useEmailChat.ts` 状态机 #3/#4 | +60 | 4 | `lastFailedInput` + `retryLast` (仅在 RETRIABLE_ERROR_CODES 时暴露); `quotaCooldownUntil` + 自清理 setTimeout (E_QUOTA → now+5min) |
| `AIChatPanel` retry + cooldown | +50 | — | Error banner 加 retry CTA; `QuotaCooldownTimer` 子组件每 250ms 显示剩余秒数; canSend 包含 cooldown 检查 |
| i18n locales (zh-CN + en-US) | +140 keys | — | toolbar.* / toolbarToast.* / toolbarConfirm.* / batchbar.* / batchToast.* / chat.error.{retry,quotaCooldown} |
| `shared/api/types.ts` | +40 lines | — | CreateDraftOpts/Result, LlmRunOpts, UpdateFlagOpts, LlmApi, NotionWriteApi 类型; MailApi 加 llm + notion 字段 |
| `ElectronApi.ts` | +50 lines | — | WriteEnvelope unwrap helper; ElectronLlmApi + ElectronNotionWriteApi; 5 个新方法注入 IPC |
| `HttpApi.ts` (V2 stub) | +10 lines | — | createDraft / llm.run / notion.updateFlag 占位 (V2-Sprint 3 wire) |

### Sprint 5 ship-review (commit `c94d2b0`) — opus 4.7 max-effort APPROVE-with-follow-ups

opus 4.7 code-reviewer subagent 跑出 **0 Critical / 0 High / 2 Medium / 7 Low**.
本 commit 闭 cheap 部分:

| Severity | Fix | File |
|---|---|---|
| MEDIUM #1 | AppleScript mailbox allowlist — reject C0 controls (0x00-0x1F) + DEL (0x7F) before reaching AppleScript; codepoint iteration (eslint `no-control-regex` 兼容); throws `E_INVALID_MAILBOX` | `handlers/draft.ts:isMailboxNameSafe` |
| LOW | BatchActionBar cancel button — 两个 identical `cancelForce` 分支折叠为 binary state until stage 2 force-stop 真正实现 | `BatchActionBar.tsx:226-227` |
| LOW | useBatchOps terminal toast i18n — 硬编码 "done"/"failed"/"cancelled" 改 `i18n.t('batchToast.{ok,partial,cancelled}')` ICU 模板 | `useBatchOps.ts:120-126` |

剩余 5 个 LOW + 2 Nit + 1 Open Question 记 NOTES.md, Sprint 6 polish 关闭.

---

## 2. Sprint 6 工作清单 (按交付顺序)

### 2.1 Sprint 5 review carry-forwards (Day 1 顺手关 — 必须先于主菜)

| ID | What | File | Source |
|---|---|---|---|
| **opus L** | `RETRIABLE_ERROR_CODES` 补 `E_NOTION_AGENT_FAIL` + Anthropic mid-stream `overloaded_error` / `rate_limit_error` / `api_error` raw 类型 | `src/shared/hooks/useEmailChat.ts:RETRIABLE_ERROR_CODES` | opus 4.7 |
| **opus L** | `quotaCooldownUntil` localStorage 持久化 (key `mailagent.chat.quotaCooldownUntil`) | `src/shared/hooks/useEmailChat.ts:81,263-274` | opus 4.7 |
| **opus L** | `useBatchOps` cancelStage 2 — 真 wire force-stop via Promise.race OR collapse to binary | `src/shared/hooks/useBatchOps.ts:84-89,131-140` | opus 4.7 |
| **opus L** | Toast TTL: track timerId + cancel in dismiss() — 内存洁癖 | `src/shared/state/toast.ts:79-85` | opus 4.7 |
| **opus L** | `lastFailedInput` stranded-session 显式清理 — `send()` 的 stranded-session 分支 + `setLastFailedInput(null)` | `src/shared/hooks/useEmailChat.ts:312-323` | opus 4.7 |
| **opus Nit** | `ResyncConfirmDialog` Tab focus-trap + Portal 化 | `src/shared/components/email/EmailToolbar.tsx:ResyncConfirmDialog` | opus 4.7 |
| **opus Open** | 后端 verify: `mailagent email resync --help` 确认 `--no-parent` 是否真名 (CLAUDE.md 说默认 skip_parent_lookup=True 暗示当前 invert?) | `src/electron/main/handlers/write_ops.ts:95` | opus 4.7 |

### 2.2 Sprint 6 主菜 — 看板 + 设置页 (PROJECT-PLAN.md Sprint 6)

| 任务 | 入口 |
|---|---|
| `/admin` 看板 | health + DB stats + dead-letter list — 调 `mailagent admin {stats,health,dead-letter}` CLI |
| `/llm` dashboard | 处理状态分布 + cost 趋势 (D3 / Recharts) + cache hit rate — 直读 `llm_processing` 表 |
| `/calendar` 列表 | 周期会议 recurring discover/replay |
| `/settings` 完整页 | API key (keytar 写) + test ping / DB 路径 (folder picker) / 附件根目录 / 轮询频率 / 主题色 (6 swatch) / Notion Agent page_id 绑定 (写 localStorage + dispatchEvent) / Custom API endpoint+key / About + GitHub link |
| BatchAction force-stop | 完成 cancelStage 2 真实力终止 (Promise.race against in-flight unit) |
| AI 批量起草回复 | 实现 batch chat.start per id (UI for managing N drafts — drawer 列表?) |

### 2.3 Sprint 7 polish (V1 ship 前)

- 三态主题切换 UI (Settings → Appearance: Light/System/Dark segmented + accent 6 swatch); 跑 `pnpm a11y:contrast --strict` 验 18 组合
- i18n 完整 review: 所有 JSX 字符串走 `t()`; grep `[TODO en]` ≤ 0
- 全局快捷键注册 (DESIGN.md §9.5 全表, 从 `shared/keymap.ts` SSoT 读)
- `?` 弹出快捷键 help 模态
- CommandPalette `⌘K` (shadcn `<Command>`) — 模糊搜邮件 / 切 mailbox / 跳设置
- 错误 toast / loading 骨架屏统一
- Empty state (空收件箱 / 零结果)
- `electron-builder` macOS .dmg ad-hoc 签名
- auto-updater (electron-updater + GitHub Releases)
- README + 安装指南

---

## 3. 工作模式

| 角色 | Agent | 何时用 |
|---|---|---|
| **主线** | Claude Opus 4.7 单线 max-effort | 整 Sprint 6 持续 context |
| **子任务并行** | ultrawork (optional) | Sprint 6 设置页多 form fields 可拆并行,但 review carry-forwards 优先串行 |
| **长 IO** | `Bash run_in_background=true` | `pnpm install` / `pnpm electron-vite build` / `pnpm a11y:contrast` |
| **Sprint 末 review** | `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` (强制); `Skill collaborating-with-codex` (best-effort, Sprint 5 实测 codex bridge 偶发 hang — opus 4.7 review 足够覆盖) | 强制 — 闭环价值高 |
| **禁用** | `codex:codex-rescue` agent / `autopilot` | feedback_codex_collaboration_path 红线 |

参考: `[[reference-mailagent-frontend-dev-collab]]` + `[[feedback-codex-collaboration-path]]`.

---

## 4. 设计约束 (lint / CI 已枪口对准)

DESIGN.md §14 八条非协商 + i18n + 三态主题第 9/10 条 — 同 Sprint 5. Sprint 5 没新增 lint rule.

**Sprint 5 新增 lint pattern**: `react-hooks/purity` 在 Sprint 5 多次 catch `Date.now()` 进 render. 修复 pattern:
- 时间到状态: `useState(() => Date.now())` + setInterval 内 setNow
- 时间到 effect: closure local var `const start = Date.now()` 在 useEffect body 内
- 状态机驱动 UI: 让 hook 自身 clear 该状态 (例 `quotaCooldownUntil` 由 useEmailChat setTimeout 清),render 仅检查 `=== null`

`react-hooks/set-state-in-effect`: 同 effect 内不可同步 setState. Fix: `setTimeout(() => setX(null), Math.max(0, delay))` 总走 timeout 队列.

`no-control-regex`: 控制字符不能直写进 RegExp literal. Fix: 用 `charCodeAt` + 数值比较 (Sprint 5 ship-review `isMailboxNameSafe`).

---

## 5. 架构规范 (关键 + Sprint 5 已落地)

### 5.1 写命令 IPC 模式 (Sprint 5 沉淀)

所有 write IPC 通过 envelope 跨 boundary:
```ts
type WriteEnvelope<T> = { ok: true; data: T } | { ok: false; code: string; message: string; hint?: string }
```
- Main side: `envelopeFromCli(promise)` 把 `CliError` / `Error` / 任何 rejection 折叠成结构化 envelope
- Renderer side: `unwrap(env)` 把 envelope 解开,失败时 throw `Error & { code, hint }` — call sites 可 `err.code === 'E_AUTH'` 分支

**为什么不直接 throw 跨 IPC**: Electron 不可靠保留 `Error.code` 等 custom properties (REVIEW-LOG codex M-3); envelope 模式是 Sprint 3 translate.ts → Sprint 4 chat:start → Sprint 5 所有 write 命令的统一契约.

### 5.2 长任务 progress + cancel pattern (BatchActionBar)

- 顺序 loop runner (`useBatchOps`): 一次 await 一个 unit, 中间不并发 (避免 CLI WAL 写抢锁)
- 进度 toast 是 sticky (progress field 让 Toast.tsx 跳过 TTL); 每 unit 完成后 setProgress
- 两段式 cancel: 第一次 stop queuing (loop 退出, 已 in-flight CLI 继续跑完), 第二次 force (Sprint 6 wire Promise.race)
- 终态: dismiss sticky progress toast → push success / partial / cancelled terminal toast (i18n.t 解析模板)

### 5.3 AppleScript 安全 (Sprint 5 ship-review 加固)

- `escapeAppleScriptString` 转义 `\\` + `\"` (primary defense)
- `isMailboxNameSafe` reject C0 controls + DEL (defense-in-depth against newline injection via mailbox name)
- osascript 调用走 execa argv (不走 shell), NUL 自动被 execa 拦
- 错误分类 `classifyAppleScriptError` 5 类: E_AUTOMATION_DENIED / E_MAIL_NOT_RUNNING / E_NOT_FOUND / E_TIMEOUT / E_APPLESCRIPT (stderr 优先 message)

### 5.4 状态机 #3/#4 (useEmailChat)

- **#3 (retry CTA)**: `lastFailedInput` 在 send() 时 capture, done event 时 clear; `retryLast` 仅在 `RETRIABLE_ERROR_CODES` set 命中时暴露; 非 retriable (E_NO_LLM_KEY / E_MODEL_UNSUPPORTED) 不显示 retry — 防止用户被误导
- **#4 (quota cooldown)**: E_QUOTA → `quotaCooldownUntil = now + 5min`; useEffect setTimeout 自动 clear 该字段; AIChatPanel `canSend = ... && quotaCooldownUntil === null`; `QuotaCooldownTimer` 子组件 250ms tick 显示剩余秒数; 状态机靠 useEmailChat 的 timer 维持,render body 不读 Date.now (react-hooks/purity)

---

## 6. 注意事项 + Edge cases

| 场景 | 处理 |
|---|---|
| Mail.app 自动化权限未授予 | 第一次 createDraft 会 macOS 弹 prompt; 拒绝后 E_AUTOMATION_DENIED + i18n hint 指向 System Settings → Privacy → Automation |
| MAIL_ACCOUNT_NAME env 未设 | `buildDraftScript` 走 unknown-account 分支 (遍历 every account 寻找 internal_id); 慢但能跑 |
| CLI 未在 PATH | `getMailagentBin()` 抛 `E_NO_BIN` + hint "pip install -e .[cli]"; 渲染端 toast 显示 |
| PM2 mail-sync online + 用户点 resync | CLI 自身 exit 9 → CliError code E_PM2_CONFLICT → toast i18n `toolbarToast.resyncFailPm2` |
| dry-run 同时跑 + 真 resync | dry-run write:false 不占 cli_runner 写信号量; 真 resync write:true 走写信号量; 不会死锁 |
| 长任务用户切邮件 / 关 panel | useEmailChat cleanup abort chat session; CLI subprocess 仍跑完 server-side (frontend 不 kill — CLI 自己 checkpoint resume) |
| E_QUOTA 5min cooldown + app 重启 | quotaCooldownUntil 内存only;重启后 reset → 再发请求 → upstream 再次 429 → 再 cooldown. **Sprint 6 持久化** |
| 长线程截断 | MessageList 渲染 ≤ MAX_RENDERED_MESSAGES (40); divider + 39 messages on truncate (Sprint 4 off-by-one fix) |
| Notion Agent thread_id v1 行 | extractTurn 优先读 `metadata.thread_id` (v2); fallback 老 `model = 'notion-agent:<id>'` (v1) — 老用户 ai_chat.db 升级后多轮上下文不断 |

---

## 7. 验收标准

### 7.1 阀门 (ship 前必绿)

- [ ] `pnpm test`: 385 baseline + Sprint 6 新增 all pass (1 happy-dom skip 不算)
- [ ] `pnpm lint`: 0 violation (含 mailagent design rules + react-hooks/purity + react-hooks/set-state-in-effect + no-control-regex 等)
- [ ] `pnpm typecheck`: 0 error (node + web)
- [ ] `pnpm a11y:contrast` (--strict 默认): 12 组合 all clean
- [ ] `pnpm electron-vite build`: ✓
- [ ] **production grep 23 patterns**: renderer + preload 0 hits (除 i18n 提示字符串 `pipx install` + HttpApi comment `osascript`)

### 7.2 功能性 (Sprint 6 主菜)

- [ ] `/admin` 看板 — health + DB stats + dead-letter list 显示并能 retry
- [ ] `/llm` dashboard — 处理状态饼图 + cost 趋势线
- [ ] `/calendar` 列表 — 周期会议可见可 replay
- [ ] `/settings` 完整页 — keytar 写 API key + test ping / Notion Agent 绑定 / 主题色切换 / 配置保存到 localStorage
- [ ] BatchAction force-stop 真终止 in-flight unit
- [ ] AI 批量起草回复 实现 (per-id chat.start + drawer 管理 N 个 draft)

### 7.3 i18n

- [ ] 新增 JSX 字符串全部走 `t()`
- [ ] zh-CN + en-US locales 同步
- [ ] grep `[TODO en]` 0 残留

### 7.4 Sprint 末 review (强制)

- 独立 Opus 4.7 max-effort `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` (Sprint 5 实测 ~4min, 12 个 findings catch, 高价值)
- Codex review via `Skill collaborating-with-codex` (Sprint 5 实测 5min 0-byte hang; best-effort, 别阻塞 ship)

---

## 8. NOTES.md 待办处理

Sprint 6 启动后用 5 分钟整理 `frontend/NOTES.md`. Sprint 5 review carry-forwards
(NOTES.md 2026-05-17 Sprint 5 review entry) 全部应在 Day 1 顺手关 (前 7 项).

---

## 9. 启动 checklist

```bash
# 1. 拉最新 + 切分支
cd ~/Documents/MailAgent && git pull
git checkout main && git merge sprint5   # Sprint 5 主线已 ship
git checkout -b sprint6
cd frontend && pnpm install

# 2. 验 Sprint 5 baseline 全绿
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm test       # 385 passed | 1 skipped
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm lint       # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm typecheck  # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm a11y:contrast  # ✓ 12 组合 clean
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm electron-vite build  # ✓

# 3. mailagent CLI 可用?
which mailagent && mailagent --version
mailagent admin health -o json  # 探一下后端 DB 可读

# 4. Mail.app 自动化权限确认
# 设置 → 隐私与安全 → 自动化 → MailAgent → Mail 勾上 (V1 .app 装上后才弹)
# 没装 .app 时 dev 模式弹 "Electron" — 选 Allow

# 5. 起 dev server 验证 Sprint 5 写命令
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm dev
# → 选邮件 → 点 EmailToolbar 起草回复 → Mail.app 弹 reply 窗口
# → 点 重传 Notion → 三按钮 confirm → 试跑 → toast 显示 dry-run OK
# → 多选邮件 → BatchActionBar 出现 → AI 批量分类 → 进度 toast + 终态 toast

# 6. 必读 (~25 min):
# - frontend/PROJECT-PLAN.md §2 Sprint 6
# - frontend/SPRINT5-HANDOFF.md §2 + §10 (本文档)
# - frontend/NOTES.md (Sprint 5 review carry-forwards)
# - frontend/DESIGN.md §17 三态主题 + §16 i18n (Sprint 6 settings 主战场)
# - 后端 CLAUDE.md "CLI 完整列表" admin/llm/calendar 三 group

# 7. Day 1 顺手关 7 review carry-forwards (§2.1 列表, 必须先于设置页主菜)
```

---

## 10. 不要做的 (红线清单)

- ❌ 不要碰 `data/sync_store.db` schema (C-05 红线; 后端 DB_VERSION 拥有)
- ❌ 不要碰 `~/.mailagent/frontend/ai_chat.db` schema 而不 bump CHAT_DB_VERSION (Sprint 5 已 v2; 加列必须走 ALTER TABLE 而非 DROP+RECREATE)
- ❌ 不要让 LLM API key / token_v2 cookie 进 renderer bundle (C-04 红线; production grep 验证 0 hits across 23 patterns)
- ❌ 不要在 render body 调 `Date.now()` / `Math.random()` 等 impure 函数 (Sprint 5 多次踩 react-hooks/purity; 用 state mirror via effect)
- ❌ 不要在 useEffect body 同步 setState (Sprint 5 踩 react-hooks/set-state-in-effect; 用 setTimeout(0) 推到下一 tick)
- ❌ 不要 RegExp literal 内直写控制字符 (Sprint 5 踩 no-control-regex; 用 `charCodeAt` 数值比较)
- ❌ 不要回退 `useShortcut` 到 per-call-site listener
- ❌ 不要回退 a11y --strict gate
- ❌ 不要用 `codex:codex-rescue` agent ([[feedback-codex-collaboration-path]] 红线; 用 `collaborating-with-codex` skill 或 opus 4.7 reviewer)
- ❌ 不要用 `autopilot`
- ❌ 不要在 `text-micro` / `text-meta` 字面值写中文 — 同 Sprint 4; Sprint 5 已加 `useCjkMonoSwap` helper 解决 i18n key 漏检
- ❌ 不要 commit 让 `lint` / `typecheck` / `test` / `a11y:contrast --strict` 任一 fail
- ❌ 不要直接渲染 `email_metadata.mailbox` 进 AppleScript without `isMailboxNameSafe` 校验 (Sprint 5 ship-review opus MEDIUM #1 加固)
- ❌ 不要发明新颜色 token — 同 Sprint 4

---

## 11. Cross-links (按重要度)

| 文档 | 章节 | 用途 |
|---|---|---|
| `PROJECT-PLAN.md` | §2 Sprint 6 | Sprint 6 任务源头 |
| `DESIGN.md` | §5 toolbar/dialog + §9.5 快捷键 + §14 lint + §16 i18n + §17 主题 | 视觉 / 交互 / 非协商 |
| `ARCHITECTURE.md` | §2.2 + §6 | 数据层抽象边界 + 后端契约 |
| `BACKEND-INTERFACES.md` | §1.6 cli runner + §4 SQLite schema | Sprint 6 admin/llm dashboard 数据来源 |
| `NOTES.md` | 2026-05-17 Sprint 5 review entry | 7 项 review carry-forwards |
| `REVIEW-LOG.md` | C-04 / C-05 / H-15 | 红线 trump 任何新设计 |
| `SPRINT4-HANDOFF.md` | §4 lint 约束 + §5 chat backbone | Sprint 4 chat 模式参考 |
| 后端 `CLAUDE.md` | "CLI 完整列表" admin/llm/calendar group | Sprint 6 settings + admin dashboard 依赖 |
| memory `reference-mailagent-frontend-dev-collab` | 全部 | 工作模式 SoT |

---

> Sprint 6 ship checklist 走完 → 这份 handoff 归档到 `frontend/archive/`, 写
> Sprint 7 handoff 时引用本文 §1.2 (write IPC pattern) + §5 (架构沉淀) + §1.3
> (Sprint 5 review fixes).

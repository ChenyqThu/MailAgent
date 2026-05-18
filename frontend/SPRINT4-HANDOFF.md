# Sprint 4 Handoff — AI Chat Panel + 双 Backend

> Sprint 4 主开发 handoff. Sprint 4 ship 完成 — 主菜 AI Chat panel (Notion Agent · Jarvis + Custom API)
> 双 backend + Day 1 carry-forwards 全部 ship. 已通过独立 opus 4.7 max-effort review + codex review,
> ship-with-follow-ups verdict (8 项 follow-up 记 NOTES.md, Sprint 5 关闭).
>
> **工期实际**: ~4-5 小时 (vs PROJECT-PLAN.md 6-9 天估算). 这是单人 opus 4.7 max-effort 一气呵成 +
> chat backbone 模块化设计的复利. Sprint 4 review 的 Email body 进 prompt 是事后发现的 critical
> functional gap, 已在 Day 4 修复.
>
> **启动前最少读完**: §0 + §1 + §3 + §4 + §5 + §9 启动 checklist + §10 红线清单.

---

## 0. TL;DR

| 项 | 值 |
|---|---|
| Sprint 范围 | AI Chat panel (Notion Agent + Custom API 双 backend) + Day 1 carry-forwards |
| 已 ship 基线 | commits `30e5578` (Day 1) + `343eb05` (Day 2) + `8d00d81` (Day 3) + `745e36a` (Day 4 review fixes) |
| 阀门 | 296 tests passed / 1 skipped, `pnpm lint` 0, `pnpm typecheck` 0, `pnpm a11y:contrast --strict` 12 combos clean, electron-vite build OK |
| 工作模式 | Claude Opus 4.7 max-effort 单线; Sprint 末 codex review (collaborating-with-codex skill) + 独立 opus 4.7 code-reviewer subagent |
| 阻塞 | 无 — 全 gate 绿, 进入 Sprint 5 |
| **Sprint 5 主菜** | Mail.app write commands (reply 草稿 / email resync / AI 重跑 / notion update-flag) + review carry-forwards |

---

## 1. 已 ship deliverables

### Day 1 (commit `30e5578`) — Sprint 3 review 3 项 carry-forwards

| Carry | What shipped | Tests |
|---|---|---|
| **opus H-1** | `useShortcut(spec, handler, opts)` 单 document.keydown bus 替代 per-call-site `useGlobalShortcuts` | 23 |
| **opus M-3** | `EmailDetail.test.tsx` 6 cases 锁 `[internalId, mailApi]` cleanup contract | 6 |
| **C-token + C-gate** | a11y 335 → 0 violations across 12 combinations (chip palette CSS variables dark/light split + ink-fg ramp + per-mode accent + `--c-accent-fg`); `pnpm a11y:contrast --strict` 进 CI gate | 全 axe-core |

### Day 2 (commit `343eb05`) — Chat backbone

| 模块 | 行数 | 测试 | 作用 |
|---|---|---|---|
| `chat_db.ts` | 380 | 21 | 独立 SQLite `~/.mailagent/frontend/ai_chat.db` (C-05 红线 — 不动 sync_store.db). schema_version 自管 + CASCADE FK + NULL-safe UNIQUE lookup |
| `chat/types.ts` | 130 | — | `ChatStreamEvent` (chunk/tool_call/usage/done/error) + `ChatBackend` interface + `EmailContext` |
| `chat/registry.ts` | 30 | — | Pluggable backend lookup |
| `chat/dispatcher.ts` | 280 | 15 | Per-session AbortController + DB writes + IPC sink fanout; rapid-click pre-empt; `loadEmailContext()` from sync_store.db (Day 4 fix) |
| `chat/backends/custom_api.ts` | 320 | 20 | Anthropic Messages SSE stream; SSE parser; system prompt with email context; HTTP error redact (Day 4) |
| `chat/backends/notion_agent.ts` | 270 | 19 | execa notion-agent `chat --json --agent-page-id`; thread_id reuse via assistant.model encoding; stderr-redacted classification (Day 4 critical fix) |
| `handlers/chat.ts` | 110 | — | 4 IPC channels: `chat:start` invoke envelope, `chat:abort` fire-forget, `chat:listMessages`, `chat:listSessions` |
| `shared/api/{types,ElectronApi,HttpApi}.ts` | +200 | — | `ChatApi` interface + `subscribe()` helper + electron impl + V2 stub |
| `shared/hooks/useEmailChat.ts` | 200 | 17 | React adapter; chunk merge + SSoT refresh; switch-email abort via ref-at-cleanup |

### Day 3 (commit `8d00d81`) — AI panel UI

| 组件 | 行数 | 作用 |
|---|---|---|
| `BackendSelector` | 100 | Notion Agent / Custom API 二选一 + 备选 chip 切 (`claude-sonnet-4-6` / `claude-opus-4-7` / `gpt-5.4`) |
| `ContextChips` | 50 | 顶部上下文: 邮件全文 · AI fields ×N · 线程 ×N |
| `QuickActions` | 70 | 5 chips prefill composer (总结/起草回复/翻译/提取动作项/关联 Notion) |
| `Composer` | 130 | textarea 2-8 行 + 圆形 coral send + ⌘↩ via useShortcut allowInEditable + cancel during streaming |
| `MessageList` | 240 | UserBubble / AssistantBubble / ToolCallRow / DraftPreviewCard 内联; chunk streaming cursor; 长线程截断 MAX_RENDERED_MESSAGES=40 |
| `AIChatPanel` | 210 | 360px 右侧固定; useActiveEmail + useEmailChat + useShortcut('alt+b'); error banner + i18n; localStorage seam for agentPageId |
| `index.ts` | 7 | Barrel re-export |
| `i18n` | +140 keys | zh-CN + en-US chat namespace (tabs / backend / context / quickActions / composer / draftReply / status / empty / error / toolCall / truncated) |
| `InboxLayout` | +3 | 加 4th column (240+340+flex+360 = min 940 + chat) |

### Day 4 (commit `745e36a`) — review must-fix

| Fix | Source | What |
|---|---|---|
| **email body 进 prompt** | opus H-1 | `loadEmailContext()` in dispatcher; `buildSystemPrompt(ctx)` (custom_api) + `formatEmailContextHeader()` (notion_agent). Without this, "summarize this email" reached upstream with zero email content |
| **notion-agent stderr redact** | codex Critical | `safeErrorMessage(code, exitCode)` 替 `stderr.slice(0,200)` — `token_v2` cookie 不再跨 IPC boundary |
| **custom_api HTTP error redact** | codex High | 删 `response.text()` 不进 envelope — gateway diag (含 `Authorization: Bearer ...`) 不 forward |
| **sawError skip done** | codex M-2 | Anthropic error event 后 sawError flag, 跳过 trailing usage/done; assistant 不被 mark complete 覆盖 error |
| **sink TOCTOU try/catch** | codex M-3 | `makeWebContentsSink` wrap try/catch — destroyed window 不 abort dispatch loop |
| **mapErrorKey 补 codes** | opus H-2 | `E_NOTION_AGENT_NETWORK` / `E_NETWORK` → `chat.error.network`; 其余 9 codes 明确 fallthrough |
| **MessageList truncation -1** | codex L | sliceSize = `MAX_RENDERED_MESSAGES - 1` when truncated. 总渲染 ≤ 40 |
| **MAX_OUTPUT_TOKENS rename** | opus M | `MAX_INPUT_TOKENS` → `MAX_OUTPUT_TOKENS` (Anthropic max_tokens 是 response 上限) |

---

## 2. Sprint 5 工作清单 (按交付顺序)

### 2.1 Sprint 4 review carry-forwards (Day 1 顺手关 — 必须先于主菜)

| ID | What | File | Source |
|---|---|---|---|
| **codex High** | `useEmailChat` stale-send generation guard | `src/shared/hooks/useEmailChat.ts:226-243` | codex |
| **codex M** | `abortCurrent()` clear local `streamingMessageId` + refresh | `useEmailChat.ts:242` | codex |
| **codex L** | `AIChatPanel` `useSyncExternalStore` for localStorage agentPageId | `AIChatPanel.tsx:43-50` | codex |
| **opus M** | `Composer` enabled=focused gate 改 always (or aria-label scope) | `Composer.tsx:53` | opus |
| **opus M** | i18n CJK at text-micro/meta — bump zh-CN chat strings to text-aux or pick CJK mono font | `MessageList.tsx / ContextChips.tsx / BackendSelector.tsx / Composer.tsx` 多处 | opus |
| **opus L** | `notion-agent` thread_id 离开 model column hack — schema_version=2 加 `metadata JSON` 列 | `notion_agent.ts:91-105` + `chat_db.ts` migration | opus |
| **opus L** | `MessageList` scrollIntoView 仅在 ~80px from bottom 时触发 | `MessageList.tsx:195-197` | opus |
| **codex N** | dispatcher `sawError` defensive break after error event | `dispatcher.ts:218-223` | codex |

### 2.2 Sprint 5 主菜 — Mail.app write commands (PROJECT-PLAN.md Sprint 5)

| 任务 | 入口 |
|---|---|
| Reply 草稿创建 | EmailToolbar 起草回复按钮 → `email:createDraft` IPC → AppleScript `tell app "Mail" to ... make new outgoing message` |
| Email Resync to Notion | EmailToolbar `↻ 重传 Notion` → `email:resync` CLI fork (Sprint 5 第一次真用 `cli_runner.callCli`) |
| AI 重跑 | EmailToolbar `✦ AI 重跑` → `llm:run` CLI fork |
| Notion update-flag (反向) | `notion:update-flag` CLI fork for is_read / is_flagged / processing_status |
| BatchActionBar | DESIGN.md §5.4 — `selectedIds.length > 0` 触发 52px bar 含 AI 批量分类 / AI 批量起草回复 / 批量翻译 EN→中 |
| Long task 进度 | progress bar + SIGINT 二次确认 dialog (CLI long-task contract 已就位) |
| Toast | shadcn `<Toast>` top-right slide-in, 3s auto-dismiss with progress bar |

### 2.3 状态机 #2-4 (Sprint 4 ship 仅 #1; Sprint 5 polish):

- (#2) switch-email abort: ✅ Sprint 4 已 ship in useEmailChat
- (#3) network down → 显式 retry button: error event 已 surface, Sprint 5 加 retry CTA
- (#4) quota exceeded → 5min disable send: E_QUOTA error 已 surface, Sprint 5 加 setTimeout disable

---

## 3. 工作模式

| 角色 | Agent | 何时用 |
|---|---|---|
| **主线** | Claude Opus 4.7 单线 max-effort | 整 Sprint 5 持续 context |
| **子任务并行** | ultrawork (optional) | Sprint 5 写命令多个 IPC handler 可拆并行, 但 review carry-forwards 优先串行 |
| **长 IO** | `Bash run_in_background=true` | `pnpm install` / `pnpm electron-vite build` / `pnpm a11y:contrast` |
| **Sprint 末 review** | `Skill collaborating-with-codex` + `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` | **强制** — Sprint 4 review 实测 catch 1 functional bug + 1 security critical, 闭环价值高 |
| **禁用** | `codex:codex-rescue` agent / `autopilot` | feedback_codex_collaboration_path 红线 |

参考: `[[reference-mailagent-frontend-dev-collab]]` + `[[feedback-codex-collaboration-path]]`.

---

## 4. 设计约束 (lint / CI 已枪口对准)

DESIGN.md §14 八条非协商 + i18n + 三态主题第 9/10 条 — 同 Sprint 3. Sprint 4 没新增 lint rule.

**Sprint 4 新增**: `bg-coral` flood lint catch — 任何 `bg-coral` (无 alpha suffix) → error. 用 `bg-coral/100` for CTA fill, `bg-coral/<N>` for pills. Sprint 4 Day 3 commit `8d00d81` 2 个 bg-coral flood 被 lint catch + 修.

---

## 5. 架构规范 (关键 + Sprint 4 已落地)

### 5.1 数据层抽象 + IPC seam (Sprint 4 持续遵守)

- 组件 only `useMailApi()` → `mailApi.chat.*`
- main process 端: 4 IPC channels (`chat:start` / `chat:abort` / `chat:listMessages` / `chat:listSessions`) + 1 stream event (`chat:stream`)
- `shared/api/types.ts` Chat types 是 frontend SoT; 镜像 main process `chat_db.ts` shape (renderer 不能 import main)
- Production grep verified 23/23 patterns 0 hits in renderer + preload

### 5.2 SQLite 边界 (C-05 严守)

- `data/sync_store.db` 只读 (sync_store.db 是 backend mail-sync 的 SoT, DB_VERSION 它管)
- AI chat 全部走 `~/.mailagent/frontend/ai_chat.db` (独立 SQLite, schema_version 1, FK CASCADE)
- Sprint 4 `dispatcher.loadEmailContext()` 是 唯一 frontend reads sync_store.db for chat 的地方 — readonly + try/catch null fallback

### 5.3 Main process vs renderer 边界 (C-04 严守)

- LLM API key (`getLlmApiKey()` from keytar) 仅在 `chat/backends/custom_api.ts` main process 用
- Notion `token_v2` cookie 仅 `notion-agent` CLI subprocess 持有 (renderer 完全不知道)
- Sprint 4 Day 4 fix: notion_agent stderr.slice 改用 `safeErrorMessage()` — 防 token_v2 印到 stderr 后跨 IPC
- Sprint 4 Day 4 fix: custom_api HTTP error body 不进 envelope — 防 gateway diag (Authorization header echo) 跨 IPC
- AbortController 4 路径全覆盖: (a) email switch via useEmailChat cleanup, (b) panel unmount via same cleanup, (c) 显式 cancel button via abortChatSession, (d) before-quit via abortAllChatSessions

---

## 6. 注意事项 + Edge cases

| 场景 | 处理 |
|---|---|
| Email body 进 prompt | `dispatcher.loadEmailContext()` 在 `startChat` 调一次; 12000 char cap; `EmailContext \| null` passed to backend; missing row → null (chat 仍 work, model 不 see email) |
| Notion Agent 没 bind agentPageId | localStorage `mailagent.notionAgent.pageId` null → Custom API default backend; user 设置后 (Sprint 6 SettingsPage) 切到 Notion Agent |
| notion-agent 未在 PATH | `resolveNotionAgentBin()` fallback `~/.local/bin/notion-agent` (pipx 默认); $NOTION_AGENT_BIN env override |
| Anthropic 协议 model 限制 | Custom API Sprint 4 ship 仅 `claude-*` model; gpt-*/gemini-* yield `E_MODEL_UNSUPPORTED` — Sprint 5 加 OpenAI 协议 SSE parser |
| 长线程截断 | MessageList 渲染 ≤ MAX_RENDERED_MESSAGES (40); divider + 39 messages on truncate (Day 4 off-by-one fix) |
| Empty user message | `chat:start` envelope returns `{ok: false, code: 'E_INVALID_ARG'}` — UI banner shows |
| AbortError | dispatcher / backends 静默吞 (renderer 已知道用户取消, 不需要 toast) |

---

## 7. 验收标准

### 7.1 阀门 (ship 前必绿)

- [ ] `pnpm test`: 296 baseline + Sprint 5 新增 (~30-50 写命令 test) all pass (1 happy-dom skip 不算)
- [ ] `pnpm lint`: 0 violation (含 mailagent design rules + bg-coral flood + 9 个其他)
- [ ] `pnpm typecheck`: 0 error (node + web)
- [ ] `pnpm a11y:contrast` (--strict 默认): 12 组合 all clean
- [ ] `pnpm electron-vite build`: ✓
- [ ] **production grep 23 patterns** (NOTES.md Sprint 4 entry 列): renderer + preload 0 hits

### 7.2 功能性 (Sprint 5 主菜)

- [ ] EmailToolbar 起草回复按钮 → 真的在 Mail.app 创出回复草稿
- [ ] Email Resync to Notion 真的重传 (Notion page 内容更新)
- [ ] AI 重跑 真的覆盖 AI fields (Notion 页 AI Action / Priority 更新)
- [ ] notion update-flag 真的 sync 到 Notion + Mail.app
- [ ] BatchActionBar `selectedIds > 0` 时出现, AI 批量分类 / AI 批量起草 / 批量翻译 可点
- [ ] Long task SIGINT 二次确认 dialog
- [ ] Toast top-right 3s auto-dismiss

### 7.3 i18n

- [ ] 新增 JSX 字符串全部走 `t()`
- [ ] zh-CN + en-US locales 同步
- [ ] grep `[TODO en]` 0 残留
- [ ] Sprint 4 carry-forward: zh-CN chat 字符串在 text-micro/meta 用 text-aux 或 CJK mono (opus M)

### 7.4 Sprint 末 review (必须)

- Codex review via `Skill collaborating-with-codex` (2 prompts)
- 独立 Opus 4.7 max-effort `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` (ship-with-follow-ups 接受, 不许 reject 全打回)

---

## 8. NOTES.md 待办处理

Sprint 5 启动后用 5 分钟整理 `frontend/NOTES.md`. Sprint 4 review carry-forwards (NOTES.md 2026-05-17 Sprint 4 review entry) 全部应在 Day 1 顺手关 (前 8 项).

升级到 gh issue (跨 session / 后端配合):

```bash
gh issue create \
  --label "area:frontend,kind:enhancement,phase:v1.5" \
  --title "OpenAI SSE protocol for Custom API backend" \
  --body "Sprint 4 Custom API backend ships Anthropic-only (claude-* gating). gpt-5.4 / gemini-* return E_MODEL_UNSUPPORTED. Add OpenAI /v1/chat/completions stream parser to chat/backends/custom_api.ts. Source: frontend/SPRINT4-HANDOFF.md §6."
```

---

## 9. 启动 checklist

```bash
# 1. 拉最新 + 切分支
cd ~/Documents/MailAgent && git pull
git checkout main && git merge sprint4   # Sprint 4 主线已 ship
git checkout -b sprint5
cd frontend && pnpm install

# 2. 验 Sprint 4 baseline 全绿
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm test       # 296 passed | 1 skipped
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm lint       # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm typecheck  # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm a11y:contrast  # ✓ 12 combinations clean
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm electron-vite build  # ✓

# 3. notion-agent-cli 仍可用?
~/.local/bin/notion-agent doctor

# 4. 起 dev server 验证 AI panel 渲染
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm dev
# → 看到 4 栏 (Sidebar + List + Detail + AIChatPanel 360px) + 选邮件后 backend selector 出现

# 5. 必读 (~25 min):
# - frontend/PROJECT-PLAN.md §2 Sprint 5
# - frontend/SPRINT4-HANDOFF.md §2 + §10 (本文档)
# - frontend/REVIEW-LOG.md (Sprint 4 review carry-forwards in NOTES.md trumps any LOG)
# - frontend/DESIGN.md §5.4 (BatchActionBar) + §9.5 (快捷键)
# - 后端 CLAUDE.md "CLI 完整列表" + "长任务退出码体系"

# 6. Day 1 顺手关 8 review carry-forwards (§2.1 列表, 必须先于写命令主菜)
```

---

## 10. 不要做的 (红线清单)

- ❌ 不要碰 `data/sync_store.db` schema (C-05 红线; 后端 DB_VERSION 拥有)
- ❌ 不要让 LLM API key / token_v2 cookie 进 renderer bundle (C-04 红线; production grep 验证 0 hits across 23 patterns)
- ❌ 不要回退 `useShortcut` 到 per-call-site listener (Day 1 H-1 重构后 AI Chat ⌘L / ⌘↩ / ⌥B / ⌥A / ⌘N 都依赖 single bus)
- ❌ 不要回退 a11y --strict gate (Day 1 C-gate ship 后 violation 0; 新加组件如果引入 violation, CI fail)
- ❌ 不要用 `codex:codex-rescue` agent ([[feedback-codex-collaboration-path]] 红线; 用 `collaborating-with-codex` skill 或 `omc ask codex`)
- ❌ 不要用 `autopilot`
- ❌ 不要在 `text-micro` / `text-meta` 字面值写中文 — Sprint 4 review opus M 已发现 chat i18n CJK 漏掉 lint, Sprint 5 修
- ❌ 不要 commit 让 `lint` / `typecheck` / `test` / `a11y:contrast --strict` 任一 fail
- ❌ 不要发明新颜色 token — Sprint 4 chip palette 已迁 CSS variables; 新色加 `:root` + `:root[data-theme='light']` 两条; 跑 a11y 验证

---

## 11. Cross-links (按重要度)

| 文档 | 章节 | 用途 |
|---|---|---|
| `PROJECT-PLAN.md` | §2 Sprint 5 | Sprint 5 任务源头 |
| `DESIGN.md` | §5.4 BatchActionBar + §9.5 快捷键 + §14 lint | 视觉 / 交互 / 非协商 |
| `ARCHITECTURE.md` | §2.2 + §6 | 数据层抽象边界 + 后端契约 |
| `BACKEND-INTERFACES.md` | §1.6 cli runner + §3 Redis events + §4.5.1 ai_chat.db schema | 写命令 IPC 契约 |
| `NOTES.md` | Sprint 4 review entry | 8 项 review carry-forwards |
| `REVIEW-LOG.md` | C-04 / C-05 / H-15 | 红线 trump 任何新设计 |
| 后端 `CLAUDE.md` | "CLI 完整列表" + "长任务退出码" | Sprint 5 写命令依赖 |
| memory `reference-mailagent-frontend-dev-collab` | 全部 | 工作模式 SoT |

---

> Sprint 5 ship checklist 走完 → 这份 handoff 归档到 `frontend/archive/`, 写 Sprint 6 handoff 时引用本文 §1.2 (chat backbone) + §5.3 (main/renderer 边界经验) + §1.4 (Sprint 4 review fixes).

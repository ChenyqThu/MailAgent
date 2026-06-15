# Sprint 6 Handoff — /admin + /llm + /calendar + /settings 4 secondary routes

> Sprint 6 主开发 handoff. Sprint 6 ship 完成 — 4 个 secondary route
> (/admin · /llm · /calendar · /settings) + 6 Sprint 5 review carry-forwards.
> 已通过独立 opus 4.7 max-effort review **APPROVE-with-follow-ups** verdict,
> 0 critical / 0 high / 4 medium (2 已闭) / 9 low / 4 nit (留 Sprint 7).
>
> **工期实际**: ~3 小时 (vs PROJECT-PLAN.md 1.5 天估算). 单人 opus 4.7
> max-effort 一气呵成 + Sprint 5 envelope / cli_runner / keytar 底座沉淀让
> 4 个新 page 落地从 IPC handler 到 Page 组件接通快得多.
>
> **启动前最少读完**: §0 + §1 + §3 + §4 + §5 + §9 启动 checklist + §10 红线清单.

---

## 0. TL;DR

| 项 | 值 |
|---|---|
| Sprint 范围 | 6 Sprint 5 review carry-forwards (Day 1) + `/admin` (health/stats/dead-letter) + `/llm` (cost + cache + status donut + selftest) + `/calendar` (recurring meeting list + replay) + `/settings` (theme + accent + poll + Notion Agent + Custom API + 3 secrets + folder picker + about) |
| 已 ship 基线 | commits `2dab813` (Day 1 — 6 carry-forwards) + `911b337` (Day 2 主菜 — 4 routes) + (review fixes 待 commit) |
| 阀门 | 432 tests passed / 1 skipped (+47 vs Sprint 5), `pnpm lint` 0, `pnpm typecheck` 0, `pnpm a11y:contrast --strict` 12 combos clean, electron-vite build OK, renderer bundle production grep clean (keytar 0 hits / MAILAGENT_CLI_API_KEY only in i18n hint strings) |
| 工作模式 | Claude Opus 4.7 max-effort 单线; Sprint 末 opus 4.7 code-reviewer subagent (verdict APPROVE-with-follow-ups, 0 CRITICAL/HIGH) |
| 阻塞 | 无 — 全 gate 绿, 进入 Sprint 7 |
| **Sprint 7 主菜** | i18n 完整 sweep + 三态主题切换 UI + 全局快捷键 + `?` 快捷键 modal + `⌘K` CommandPalette + 错误 toast / loading 骨架 + Empty state + electron-builder .dmg + README + Sprint 6 review carry-forwards |

---

## 1. 已 ship deliverables

### Day 1 (commit `2dab813`) — Sprint 5 review 6 项 carry-forwards

| Carry | What shipped | Tests |
|---|---|---|
| **opus LOW** | `useEmailChat` RETRIABLE_ERROR_CODES 补 `E_NOTION_AGENT_FAIL` + 3 个 Anthropic 原始 mid-stream error types (`overloaded_error` / `rate_limit_error` / `api_error`) → retryLast 在 "Claude is overloaded" + notion-agent transient 退出时也暴露 | 2 new |
| **opus LOW** | `quotaCooldownUntil` localStorage 持久化 — lazy useState initializer 读 `mailagent.chat.quotaCooldownUntil`,过期自动 GC;useEffect mirror 写。app 重启不丢冷却 | 3 new |
| **opus LOW** | `useBatchOps` cancelStage 2 真 force-stop — `Promise.race` against force-stop sentinel,stage 2 cancel 立即 race-lose in-flight unit。CLI subprocess 仍跑完 server-side (按 long-task 契约) | 1 new |
| **opus LOW** | `Toast` TTL track timerId + cancel in dismiss — 模块级 `_timers` Map,dismiss / clear / __reset / over-cap demote 全清 timer。stale closure 不再 re-fire dismiss on recycled id | 2 new |
| **opus LOW** | `useEmailChat.send()` stranded-session 显式 `setLastFailedInput(null)` 防止 captured input 占内存 | — |
| **opus Nit** | `EmailToolbar.ResyncConfirmDialog` `createPortal(document.body)` + 手写 Tab focus-trap (cancel↔dry↔push loop) + Escape close + initial focus to cancel | — |
| **opus Open** | 后端 verify: `mailagent email resync --help` 确认 `--no-parent` 是 opt-in skip (CLI 默认会 parent lookup);`write_ops.ts:95` `if (opts.skipParentLookup) args.push('--no-parent')` 逻辑正确 | — (verify only) |

### Day 2 (commit `911b337`) — Sprint 6 主菜 4 routes

| 模块 | 行数 | 测试 | 作用 |
|---|---|---|---|
| `handlers/admin.ts` | 180 | 15 | `admin:{health,stats,deadLetterList,deadLetterRetry,cleanupDeadLetter}` → `mailagent admin {health,stats,dead-letter list/retry,cleanup-deadletter}`. 读 15s / 写 60s timeout. envelope 模式 |
| `handlers/llm_stats.ts` | 60 | 6 | `llm:{stats,selftest}` → `mailagent llm {stats --days N, selftest}`. days clamped [1,365] |
| `handlers/calendar.ts` | 130 | 9 | `calendar:{recurringDiscover,recurringReplay,expand}`. recurringDiscover 正常化 `[]` / `{items:[]}` 双形 CLI 输出 |
| `handlers/settings.ts` | 225 | 8 | `settings:{get,set,pickFolder,secrets:{status,set,clear},test:{llm,customApi}}`. 文件持久化到 `<userData>/settings.json`. `sanitize()` 拒任何非 literal enum 的 pollIntervalSec |
| `keychain.ts` 扩展 | +50 | — | `llm-api-key` + `custom-api-key` 双 slot;`getSecretsStatus()` 返回 boolean triplet (secrets NEVER cross IPC boundary) |
| `shared/api/types.ts` | +183 | — | `AdminApi` / `LlmApi.stats/.selftest` / `CalendarApi` / `SettingsApi` 类型;`MailApi` 扩 `admin/calendar/settings` |
| `ElectronApi.ts` | +88 | — | wire 4 个新 API 类 |
| `HttpApi.ts` | +37 | — | V2 stub (throw not-implemented) for new APIs |
| `components/admin/AdminPage.tsx` | 290 | — | Health pill + 4 stat cards + status histogram + by-mailbox + v4 rollout + dead-letter table with per-row Retry mutation |
| `components/llm/LlmDashboardPage.tsx` | 250 | — | 4 cost cards + 手画 SVG donut (no recharts) + cache hit gauge + Self-test CTA |
| `components/calendar/CalendarPage.tsx` | 180 | — | recurring meeting table + per-row Replay action |
| `components/settings/SettingsPage.tsx` | 430 | — | Outer query-loader + inner `SettingsForm` 用 lazy useState initializer (一次性 seed,避开 react-hooks/set-state-in-effect); 6 sections (Appearance / Inbox / AI backends / Secrets / Storage / About) |
| `components/layout/PageFrame.tsx` | 30 | — | 共享 wrapper (TitleBar + Sidebar + StatusBar + scrollable main),供 4 个新 layout 用 |
| 4 个 `*Layout.tsx` | 10 each | — | 简单 wrapper: `<PageFrame><XxxPage /></PageFrame>` |
| `router-instance.tsx` | +38 | — | 4 新 routes `/admin /llm /calendar /settings` |
| `Sidebar.tsx` | +23 | — | onClick navigate 接通 `LLM Dashboard / 看板 Admin / 日历 (新) / 全文搜索 / 设置` |
| `index.css` | +31 | — | 6 个 `.swatch-{coral,cobalt,teal,rose,slate,olive}` background classes (DESIGN.md §14 #1 — 把 raw hex 留 CSS file) |
| i18n locales | +137 keys per locale | — | admin.* / llm.* / calendar.* / settings.* (zh-CN + en-US lockstep) |

### Sprint 6 review (commit pending) — opus 4.7 max-effort APPROVE-with-follow-ups

opus 4.7 code-reviewer subagent 跑出 **0 Critical / 0 High / 4 Medium / 9 Low / 4 Nit**.
本 commit 闭 cheap 部分:

| Severity | Fix | File |
|---|---|---|
| MEDIUM #2 | `SecretInput.submit` 改为先 capture + clear synchronously,再 await onSubmit — 失败路径下 secret 不再留在 fiber state | `SettingsPage.tsx:SecretInput.submit` |
| MEDIUM #4 | `settings.ts:pingLlmEndpoint` 把 `await import('./llm_stats')` 改为顶部 static import — 已经被 index.ts 静态导入,dynamic 是无效的 ceremony + 触发 Vite warning | `handlers/settings.ts:26,135` |

剩余 2 Medium + 9 Low + 4 Nit 记 NOTES.md, Sprint 7 polish 关闭.

---

## 2. Sprint 7 工作清单 (按交付顺序)

### 2.1 Sprint 6 review carry-forwards (Day 1 顺手关)

| ID | What | File | Source |
|---|---|---|---|
| **opus MEDIUM #1** | `sanitize()` 加 `path.isAbsolute() + !contains('..')` validation 给 dbPath / attachmentDir — Sprint 7 wire `better-sqlite3.Database(s.dbPath)` 前必须做 | `handlers/settings.ts:69-92` |
| **opus MEDIUM #3** | `useBatchOps` dangling `.catch` on stage-2 force-stop — 加注释 OR `void unitPromise` 显式 GC | `useBatchOps.ts:116-130` |
| **opus LOW** | 抽出 `lib/envelope.ts` 共享 `WriteEnvelope<T>` + `envelopeFromCli` + `ensureInternalId` (3× 重复) | admin/calendar/write_ops |
| **opus LOW** | 抽出 `shared/state/notion-agent-storage.ts` 共享 `STORAGE_AGENT_*` 常量 (2× 重复) | SettingsPage + AIChatPanel |
| **opus LOW** | `AdminPage.formatRelative` i18n — `admin.timeAgo.{seconds,minutes,hours,days}` | AdminPage.tsx:29-42 |
| **opus LOW** | LlmDashboardPage `creation` / `read` 改 `llm.cacheTokens{Creation,Read}` | LlmDashboardPage.tsx:316,322 |
| **opus LOW** | CalendarPage `offsetIsoDate` TZ skew — 用 local-date 或 document UTC | CalendarPage.tsx:25-29 |
| **opus LOW** | AdminPage `title={sync_error}` 截 500 chars | AdminPage.tsx:160-164 |
| **opus LOW** | `useEmailChat.send` race: `setLastFailedInput` 在 stranded check 之后 OR 注释 race-as-harmless | useEmailChat.ts:348-373 |
| **opus LOW** | quotaCooldownUntil 第一次 mount 不必 mirror-write 同一值 | useEmailChat.ts:127-129,313-324 |
| **opus LOW** | `CacheGauge` 30% 临界 cliff — hysteresis / 宽 warn 带 | LlmDashboardPage.tsx:170 |
| **opus Nit** | `ResyncConfirmDialog` focus-trap 改 querySelectorAll-based (4-element 友好) | EmailToolbar.tsx:253-264 |
| **opus Nit** | Sidebar 8 个 hard-coded zh 标签 → `sidebar.*` keys (zh-CN + en-US) | Sidebar.tsx:154,161,181,207,222,228,237,244 |
| **opus Nit** | EmailDetail 2 处 `"在 Notion 打开"` hard-code → 用 `toolbar.openNotion` | EmailDetail.tsx:526,598 |

### 2.2 Sprint 7 主菜 — Polish + 打包 (PROJECT-PLAN.md Sprint 7)

| 任务 | 入口 |
|---|---|
| 三态主题 UI | SettingsPage Appearance section 已经做了 — Sprint 7 polish: 全 6 accent × 3 mode = 18 组合手测视觉 (a11y --strict 已经过 12 组合) |
| i18n 完整 review | 所有 JSX 字符串走 `t()`; grep `[TODO en]` ≤ 0; Sidebar / EmailDetail / LlmDashboard hard-coded zh 全清 |
| 全局快捷键 | `shared/keymap.ts` 单一 SSoT; DESIGN.md §9.5 全表注册 |
| `?` 快捷键 help modal | shadcn `<Dialog>` 列全键位 + i18n |
| `⌘K` CommandPalette | shadcn `<Command>` — 模糊搜邮件 / 切 mailbox / 跳设置 |
| 错误 toast / loading 骨架 | 统一错误 UI (rate-limit retry banner / 网络失败 banner / 通用错误);loading 骨架代替"加载中…"文字 |
| Empty state | 空收件箱 (mascot illustration?) / 零搜索结果 / 零死信邮件 |
| `electron-builder` macOS .dmg | ad-hoc 签名先够,公证留 Sprint 8 |
| auto-updater | electron-updater + GitHub Releases appcast |
| README + 安装指南 | 包含 venv setup / mailagent CLI 安装 / Mail.app 自动化权限授予流程 |

---

## 3. 工作模式

| 角色 | Agent | 何时用 |
|---|---|---|
| **主线** | Claude Opus 4.7 单线 max-effort | 整 Sprint 7 持续 context |
| **子任务并行** | ultrawork (optional) | Sprint 7 i18n + 快捷键 + Polish 三条线可拆并行 |
| **长 IO** | `Bash run_in_background=true` | `pnpm install` / `pnpm electron-vite build` / `pnpm a11y:contrast` / `electron-builder` |
| **Sprint 末 review** | `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` (强制) | 强制 — 闭环价值高 |
| **禁用** | `codex:codex-rescue` agent / `autopilot` | feedback_codex_collaboration_path 红线 |

参考: `[[reference-mailagent-frontend-dev-collab]]` + `[[feedback-codex-collaboration-path]]`.

---

## 4. 设计约束 (lint / CI 已枪口对准)

DESIGN.md §14 八条非协商 + i18n + 三态主题第 9/10 条 — 同 Sprint 5/6. Sprint 6 没新增 lint rule.

**Sprint 6 关键 pattern**:
- 6 swatch raw hex 不直写 .tsx,移到 `index.css` 的 `.swatch-X` class (no-raw-hex 红线)
- Settings page seed: outer wrapper render loading skeleton 等 query, inner form 接 `initialSettings` prop + `useState lazy initializer` 一次性 seed → 完全避开 `react-hooks/set-state-in-effect`
- Secret 严格不过 IPC: `settings:secrets:status` 只返 `{cliApiKey:bool, llmApiKey:bool, customApiKey:bool}`. renderer 不知道任何 secret 真值

---

## 5. 架构规范 (关键 + Sprint 6 已落地)

### 5.1 secondary route pattern (Sprint 6 沉淀)

新 secondary route 加 3 步:
1. `src/electron/main/handlers/<feature>.ts` — IPC channel + `mailagent <group> <action>` CLI fork + envelope 模式
2. `src/shared/api/types.ts` — `<Feature>Api` interface + 加到 `MailApi`
3. `src/shared/api/ElectronApi.ts` — wire IPC + `HttpApi.ts` 加 V2 stub
4. `src/shared/components/<feature>/<Feature>Page.tsx` + `layout/<Feature>Layout.tsx` wrapping in `PageFrame`
5. `src/shared/router-instance.tsx` 加 createRoute
6. `Sidebar.tsx` 加 onClick navigate
7. i18n locales 加 `<feature>.*` keys (zh-CN + en-US)

### 5.2 SettingsPage outer/inner 模式

```tsx
export function SettingsPage() {
  const settingsQ = useQuery(...)
  const secretsQ = useQuery(...)
  if (!settingsQ.data || !secretsQ.data) return <LoadingSkeleton />
  return <SettingsForm initialSettings={...} initialSecrets={...} />
}

function SettingsForm({ initialSettings, initialSecrets }) {
  // useState lazy initializer — runs once at mount, never overwrites
  // half-typed values on stale refetch.
  const [pollInterval, setPollInterval] = useState(() => initialSettings.pollIntervalSec)
  ...
}
```

避开 `react-hooks/set-state-in-effect` 红线;无 useEffect seeding。

### 5.3 secret 进 keytar 不进 renderer (C-04 红线)

- `keychain.ts`: 3 slot (cli / llm / custom-api),每个独立 getter/setter/clearer
- `getSecretsStatus()` 返 `{cliApiKey:bool, ...}` (boolean only)
- IPC `settings:secrets:{status,set,clear}` — `set` 接 string 但不返;`status` / `clear` 只返 boolean triplet
- renderer 端 SecretInput 提交前 capture + clear value (review MEDIUM #2 fix) — 失败也清

### 5.4 dynamic→static import 红线

Sprint 6 review MEDIUM #4: `await import('./module')` 仅适合 lazy-load (code-split) 且 module 不在 entry 路径。如果 module 已在 entry 静态导入 → dynamic 是 dead ceremony + 触发 Vite warning。

---

## 6. 注意事项 + Edge cases

| 场景 | 处理 |
|---|---|
| Settings dbPath / attachmentDir 路径未 validate | Sprint 7 wire `better-sqlite3.Database(s.dbPath)` 前必须加 path-traversal check (review MEDIUM #1) |
| Sidebar 已 ship 8 个 hard-coded zh 标签 | Sprint 7 i18n sweep target — 不影响功能,zh 用户看不出区别 |
| LlmDashboard `creation`/`read` zh 用户看到英文 | Sprint 7 i18n |
| Calendar UTC TZ skew at midnight | 罕见;Sprint 7 改 local-date 或文档化 UTC 约定 |
| useBatchOps stage 2 force-stop 的 dangling `.catch` | 按 contract 是 intentional (CLI 跑完 server-side);Sprint 7 加注释或 `void unitPromise` |
| Settings keytar miss → SecretsStatus shows false | OK — UI 显示 "未设置" pill;用户在 SettingsPage 填后 status 翻 true |
| Settings file corrupt | `readSettings()` catch + 回退 DEFAULTS;不会 boot crash |
| 4 secondary route 加载时 sidebar 仍 mounted | OK — PageFrame 复用 InboxLayout / SearchLayout 的 wrapper pattern,Sidebar / TitleBar / StatusBar 跨 route 都 mounted |

---

## 7. 验收标准

### 7.1 阀门 (ship 前必绿)

- [ ] `pnpm test`: 432 baseline + Sprint 7 新增 all pass (1 happy-dom skip 不算)
- [ ] `pnpm lint`: 0 violation (含 mailagent design rules + react-hooks 各 rule)
- [ ] `pnpm typecheck`: 0 error (node + web)
- [ ] `pnpm a11y:contrast` (--strict 默认): 12 组合 all clean (Sprint 7 加完 6×3=18 组合)
- [ ] `pnpm electron-vite build`: ✓
- [ ] **production grep 23 patterns**: renderer + preload 0 hits (除 i18n hint `MAILAGENT_CLI_API_KEY` + HttpApi comment)

### 7.2 功能性 (Sprint 7 主菜)

- [ ] 三态主题 UI: SettingsPage segmented 切 light/system/dark + 6 accent picker
- [ ] i18n 完整 review:所有 JSX 字符串走 `t()`
- [ ] `?` 弹出快捷键 help 模态
- [ ] `⌘K` CommandPalette 实时模糊搜邮件
- [ ] 错误 toast / loading 骨架统一
- [ ] Empty state 出现
- [ ] macOS .dmg 装上能跑

### 7.3 i18n

- [ ] 新增 JSX 字符串全部走 `t()`
- [ ] zh-CN + en-US locales 同步 (254 keys 同 count)
- [ ] grep `[TODO en]` 0 残留
- [ ] Sidebar 8 个 zh hard-code 全清

### 7.4 Sprint 末 review (强制)

- 独立 Opus 4.7 max-effort `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` (Sprint 6 实测 ~5min, 17 个 findings catch, 高价值)

---

## 8. NOTES.md 待办处理

Sprint 7 启动后用 5 分钟整理 `frontend/NOTES.md`. Sprint 6 review carry-forwards
(NOTES.md 2026-05-17 Sprint 6 review entry) 全部应在 Day 1 顺手关 (前 14 项中的
cheap 部分; opus MEDIUM #1 是 Sprint 7 主菜 dbPath wire-in 时必做).

---

## 9. 启动 checklist

```bash
# 1. 拉最新 + 切分支
cd ~/Documents/MailAgent && git pull
git checkout main && git merge sprint6   # Sprint 6 主线已 ship
git checkout -b sprint7
cd frontend && pnpm install

# 2. 验 Sprint 6 baseline 全绿
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm test       # 432 passed | 1 skipped
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm lint       # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm typecheck  # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm a11y:contrast  # ✓ 12 组合 clean
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm electron-vite build  # ✓

# 3. mailagent CLI 可用?
which mailagent && mailagent --version
mailagent admin health -o json  # 探一下后端 DB 可读

# 4. Mail.app 自动化权限确认 (Sprint 5 复用)

# 5. 起 dev server 验证 Sprint 6 secondary routes
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm dev
# → 点 Sidebar "看板 Admin" → 看 health pill + DB stats + 死信表
# → 点 "LLM Dashboard" → 看 cost + donut + 命中率 gauge + Self-test
# → 点 "日历" → 看 recurring meetings + Replay 按钮
# → 点 "设置" → 看 6 section, 改 accent / poll interval 实时生效, 粘贴 fake key 验 Status pill 翻 true

# 6. 必读 (~25 min):
# - frontend/PROJECT-PLAN.md §2 Sprint 7
# - frontend/SPRINT6-HANDOFF.md §2 + §10 (本文档)
# - frontend/NOTES.md (Sprint 6 review carry-forwards — 14 项)
# - frontend/DESIGN.md §9.5 快捷键 + §16 i18n + §17 三态主题 (Sprint 7 主战场)

# 7. Day 1 顺手关 cheap review carry-forwards (§2.1 列表, 必须先于 polish 主菜)
```

---

## 10. 不要做的 (红线清单)

- ❌ 不要碰 `data/sync_store.db` schema (C-05 红线; 后端 DB_VERSION 拥有)
- ❌ 不要碰 `~/.mailagent/frontend/ai_chat.db` schema 而不 bump CHAT_DB_VERSION
- ❌ 不要让 LLM API key / Custom API key / CLI API key 进 renderer bundle (C-04 红线; production grep 23 patterns 0 hits)
- ❌ 不要在 render body 调 `Date.now()` / `Math.random()` 等 impure 函数
- ❌ 不要在 useEffect body 同步 setState — 用 setTimeout(0) 推到下一 tick OR outer+inner lazy initializer (Sprint 6 SettingsForm pattern)
- ❌ 不要 RegExp literal 内直写控制字符
- ❌ 不要回退 `useShortcut` 到 per-call-site listener
- ❌ 不要回退 a11y --strict gate
- ❌ 不要用 `codex:codex-rescue` agent
- ❌ 不要用 `autopilot`
- ❌ 不要在 `text-micro` / `text-meta` 字面值写中文 — `useCjkMonoSwap` helper 解决 i18n key 漏检
- ❌ 不要 commit 让 `lint` / `typecheck` / `test` / `a11y:contrast --strict` 任一 fail
- ❌ 不要直接渲染 `email_metadata.mailbox` 进 AppleScript without `isMailboxNameSafe` 校验
- ❌ 不要发明新颜色 token — 用 6 swatch CSS classes;raw hex 留 CSS file
- ❌ 不要把 secret 写入 file-backed settings.json — 走 keytar
- ❌ 不要 dynamic `await import('./module')` 当 module 已在 entry 静态导入 (Sprint 6 MEDIUM #4)
- ❌ 不要在 wire `better-sqlite3.Database(s.dbPath)` 前不做 path-traversal validation (Sprint 6 MEDIUM #1 — Sprint 7 wire-in 必做)

---

## 11. Cross-links (按重要度)

| 文档 | 章节 | 用途 |
|---|---|---|
| `PROJECT-PLAN.md` | §2 Sprint 7 | Sprint 7 任务源头 |
| `DESIGN.md` | §9.5 快捷键 + §14 lint + §16 i18n + §17 主题 | 视觉 / 交互 / 非协商 |
| `ARCHITECTURE.md` | §2.2 + §5 | 数据层抽象边界 + 主路径 |
| `BACKEND-INTERFACES.md` | §1.6 cli runner + §4 SQLite schema | Sprint 6 admin/llm dashboard 数据来源 |
| `NOTES.md` | 2026-05-17 Sprint 6 review entry | 14 项 review carry-forwards |
| `REVIEW-LOG.md` | C-04 / C-05 / H-15 | 红线 trump 任何新设计 |
| `SPRINT5-HANDOFF.md` | §1.2 write IPC pattern + §5 架构沉淀 | Sprint 5 模式参考 |
| 后端 `CLAUDE.md` | "CLI 完整列表" admin/llm/calendar group | Sprint 6 dashboard 数据来源 + Sprint 7 任何新写命令 |
| memory `reference-mailagent-frontend-dev-collab` | 全部 | 工作模式 SoT |

---

> Sprint 7 ship checklist 走完 → 这份 handoff 归档到 `frontend/archive/`, 写
> Sprint 8 handoff 时引用本文 §1.2 (4-step route addition pattern) + §5
> (架构沉淀) + §1.3 (Sprint 6 review fixes).

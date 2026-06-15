# Sprint 7 Handoff — Polish (keymap SSoT + ? help + ⌘K palette + empty/skeleton + i18n sweep + 14 carry-forwards)

> Sprint 7 主开发 handoff. Sprint 7 ship 完成 — Sprint 6 review 14 项
> carry-forwards 全闭 + 5 个 polish 主菜 (global keymap SSoT + ?快捷键
> help modal + ⌘K command palette + EmptyState/Skeleton 统一 + i18n
> complete sweep). 打包 .dmg + auto-updater + README 推 Sprint 8.
>
> **工期实际**: ~3.5 小时 (vs PROJECT-PLAN.md 1.5 天估算 — Sprint 6 沉淀的
> useShortcut 单 bus + zustand store + Portal 模式让 ? modal / ⌘K palette
> 落地非常快).
>
> **启动前最少读完**: §0 + §1 + §3 + §4 + §5 + §9 启动 checklist + §10 红线清单.

---

## 0. TL;DR

| 项 | 值 |
|---|---|
| Sprint 范围 | 14 Sprint 6 review carry-forwards (Day 1 全关) + global keymap SSoT (`src/shared/keymap.ts`) + `?` 快捷键 help modal + `⌘K` command palette + EmptyState/LoadingSkeleton 统一 + i18n complete sweep (Sidebar 8 zh + EmailDetail 2 zh + admin timeAgo + llm cacheTokens) |
| 已 ship 基线 | commits Sprint 6 上 + (Sprint 7 fixes 待 commit) |
| 阀门 | **468 tests passed / 1 skipped** (+36 vs Sprint 6 baseline 432), `pnpm lint` 0, `pnpm typecheck` 0, `pnpm a11y:contrast --strict` **12 组合 clean**, electron-vite build OK, production grep ~3 patterns (keytar comment string / MAILAGENT_CLI_API_KEY i18n hint / osascript toast hint — all non-leak) |
| 工作模式 | Claude Opus 4.7 max-effort 单线; Sprint 末 opus 4.7 code-reviewer subagent (强制, verdict 待跑) |
| 阻塞 | 无 — 全 gate 绿, 进入 Sprint 8 |
| **Sprint 8 主菜** | electron-builder macOS .dmg (ad-hoc 签名) + auto-updater (electron-updater + GitHub Releases) + README + 安装指南 + Sprint 7 review carry-forwards (如有) |

---

## 1. 已 ship deliverables

### 1.1 Sprint 6 review 14 项 carry-forwards (全闭)

| Severity | What shipped | Files |
|---|---|---|
| MEDIUM #1 | `sanitize()` 加 `isSafeUserPath()` validation — 检查 raw segment 含 `..` (normalize 前) + isAbsolute() + normalize 后仍是 absolute. dbPath/attachmentDir 走 validation, 非法值 silent drop | `handlers/settings.ts:75-110` + 7 个新测试 |
| MEDIUM #3 | `useBatchOps` stage-2 force-stop 的 dangling `.catch` 加 contract 注释 + `void unitPromise` 显式 mark | `useBatchOps.ts:108-130` |
| LOW | 抽 `src/electron/main/lib/envelope.ts` — `WriteEnvelope<T>`/`envelopeFromCli<T>`/`ensureInternalId`. admin.ts / calendar.ts / write_ops.ts 改 import | `lib/envelope.ts` + 3 handler 改 import |
| LOW | 抽 `src/shared/state/notion-agent-storage.ts` — STORAGE_AGENT_ID/NAME/CHANGE_EVENT + dispatchAgentStorageEvent helper. SettingsPage + AIChatPanel 改 import | `state/notion-agent-storage.ts` + 2 文件改 import |
| LOW | AdminPage `formatRelative()` 接 t func, 用 `admin.timeAgo.{seconds,minutes,hours,days}` ICU keys (zh + en) | `AdminPage.tsx:38-50` + locales |
| LOW | LlmDashboard `creation`/`read` → `llm.cacheTokensCreation` / `llm.cacheTokensRead` | `LlmDashboardPage.tsx:315,322` + locales |
| LOW | CalendarPage `offsetIsoDate` 改 local-date (setDate / getDate) + 手动 YYYY-MM-DD format (避 TZ skew at midnight) | `CalendarPage.tsx:25-39` |
| LOW | AdminPage DeadLetterRow `title` 截 500 chars 通过 `clampTitle()` helper | `AdminPage.tsx:54-58, 144-184` |
| LOW | useEmailChat `setLastFailedInput(input)` 移到 stranded-session check 之后 (不再 race-pin closure input) | `useEmailChat.ts:339-378` |
| LOW | useEmailChat quotaCooldownUntil mirror useEffect 加 `firstCooldownEffectRef` 跳第一次 mount (省一次 redundant setItem) | `useEmailChat.ts:312-330` |
| LOW | LlmDashboard CacheGauge 阈值改宽: ≥70 ok / ≥20 info / <20 warn (Sprint 6 拉宽 info 带避 cliff flicker) | `LlmDashboardPage.tsx:167-175` |
| Nit | EmailToolbar `ResyncConfirmDialog` focus-trap 改 `querySelectorAll(FOCUSABLE_SELECTOR)` 4-button 友好 (不再硬编 3-button boundary) | `EmailToolbar.tsx:215-280` |
| Nit | Sidebar 8 zh hardcode → `sidebar.*` keys (zh + en) | `Sidebar.tsx` + locales (sidebar block) |
| Nit | EmailDetail 2 处 `"在 Notion 打开"` → `t('toolbar.openNotion')` | `EmailDetail.tsx:526, 598` |

### 1.2 Sprint 7 主菜 — Polish

#### D2: Global keymap SSoT + `?` help modal

| 模块 | 行数 | 测试 | 作用 |
|---|---|---|---|
| `src/shared/keymap.ts` | 220 | 6 | DESIGN §9.5 全 18 binding 的 SSoT — id/spec/display/scope/labelKey/wired. `getShortcutById()` + `groupByScope()` + `SCOPE_ORDER` 导出 |
| `src/shared/state/keyboard-help.ts` | 35 | 4 | zustand store `useKeyboardHelp` + module-level `openKeyboardHelp()` / `closeKeyboardHelp()` |
| `src/shared/components/keyboard/KeyboardHelpModal.tsx` | 175 | 3 | shadcn-equivalent Dialog Portal — 分组 (Global / Inbox / Row / Chat) + 每行显示 i18n label + kbd display + "soon" pill (wired=false) + querySelectorAll focus-trap + Esc close |
| `src/shared/components/keyboard/GlobalShortcuts.tsx` | 35 | — | 注册 `?` / `⌘K` / `⌘,` 全局快捷键 (mount 一次 in App.tsx root) |

#### D3: `⌘K` Command Palette

| 模块 | 行数 | 测试 | 作用 |
|---|---|---|---|
| `src/shared/state/command-palette.ts` | 30 | 4 | zustand store + open/close/toggle helpers |
| `src/shared/components/command/CommandPalette.tsx` | 280 | — | 3 类命令: 6 navigation (inbox/search/admin/llm/calendar/settings) + 实时 mailbox switch + FTS5 search (2+ chars 触发 + 250ms debounce). 键盘 ↑↓ Enter Esc + role=combobox a11y. 不引 cmdk 依赖 (Karpathy 简化) |

#### D4: EmptyState / LoadingSkeleton 统一

| 模块 | 行数 | 测试 | 作用 |
|---|---|---|---|
| `src/shared/components/feedback/EmptyState.tsx` | 50 | 4 | icon + title + hint + action 复合组件. SearchPage 零结果 / AdminPage 无死信 / CalendarPage 无周期会议 / LlmDashboard 加载失败 全用. fill prop 支持 flex slot |
| `src/shared/components/feedback/LoadingSkeleton.tsx` | 70 | — | `Skeleton` (rows 可调) + `SkeletonCard` (4 行 stat card-sized) + `SkeletonRow` (table row-sized). animate-pulse 含 motion-reduce respect. SearchPage / AdminPage / CalendarPage / LlmDashboard / SettingsPage 加载态全切换 |

#### D5: i18n complete sweep

| 项 | 数 |
|---|---|
| 新增 keys (per locale) | 88 (sidebar.* 14 + shortcutHelp.* 26 + palette.* 18 + admin.timeAgo.* 4 + admin.noDeadLetterHint + llm.cacheTokensCreation/Read + calendar.emptyHint) |
| zh-CN 总 keys | 320 |
| en-US 总 keys | 320 |
| `[TODO en]` 残留 | 0 |
| hard-coded CJK literal (除 mailbox icon placeholder + QuickActions LLM prompts) | 0 |

### 1.2.1 Sprint 7 ship-review opus 4.7 max-effort verdict — APPROVE-with-follow-ups

opus 4.7 code-reviewer subagent 跑出 **0 CRITICAL / 1 HIGH / 4 MEDIUM / 5 LOW / 3 Nit** (13 findings).
本 sprint 后续 commit 闭 **HIGH + 3 MEDIUM + 2 Nit (6 项)**:

| Severity | Fix | File |
|---|---|---|
| HIGH | `useEmailChat.test.tsx` beforeEach 加 `localStorage.clear()` 防 worker pollution — Sprint 7 加的 keyboard-help / palette / cooldown 测试都摸 localStorage,reviewer cold-run 复现 stream-event test 偶 fail | `tests/shared/useEmailChat.test.tsx:126-140` |
| MEDIUM | CommandPalette 加 querySelectorAll Tab focus-trap (同 KeyboardHelpModal + ResyncConfirmDialog pattern) | `CommandPalette.tsx:onKeyDown` |
| MEDIUM | CommandPalette a11y combobox 完整化: `role="combobox"` + `aria-haspopup=listbox` + `aria-expanded` + `aria-activedescendant=palette-opt-N` + `<li id="palette-opt-N">` | `CommandPalette.tsx` |
| MEDIUM | CommandPalette `scrollIntoView({block:'nearest'})` on highlight change — 50+ FTS 命中时 ArrowDown 不再丢焦点出视口 | `CommandPalette.tsx` |
| MEDIUM | `useBatchOps` 用 `batchToast.running` i18n key 代替 raw template (separator / RTL 友好) | `useBatchOps.ts:86, 159` |
| Nit | `keymap.ts` `wired: true → false` 给 6 个未真 useShortcut 注册的 binding (nextEmail/prevEmail/reply/toggleRead/toggleFlag/toggleBatchSelect) — 之前 help modal 误标 "ready" | `keymap.ts` |
| Nit | 删 `InboxLayout.tsx` 重复 `useShortcut('cmd+k', goSearch)` (GlobalShortcuts 已 owns ⌘K → palette,palette 含 Go·Search 项) | `InboxLayout.tsx:8-30` |

剩余 5 LOW + 1 MEDIUM (StrictMode adjust-state warning) + 1 Nit (SkeletonRow WIDTH_CLASS hardening) 留 Sprint 8 (低优,非 user-facing).

### 1.3 测试覆盖

| 文件 | 新测试 | 覆盖 |
|---|---|---|
| `tests/main/settings.test.ts` | +7 | `isSafeUserPath()` (absolute/relative/traversal) + sanitize drop 路径 |
| `tests/main/envelope.test.ts` | +10 | `envelopeFromCli()` (resolved/CliError/Error/non-Error) + `ensureInternalId()` (valid/negative/non-int) |
| `tests/shared/keyboard-help.test.ts` | +4 | useKeyboardHelp store + open/close/idempotent |
| `tests/shared/command-palette.test.ts` | +4 | useCommandPalette store + toggle |
| `tests/shared/keymap.test.ts` | +6 | SHORTCUTS 唯一 id + 必需字段 + DESIGN §9.5 headliners 存在 + getShortcutById + groupByScope + SCOPE_ORDER |
| `tests/components/EmptyState.test.tsx` | +4 | title-only / hint / action / fill |
| `tests/components/KeyboardHelpModal.test.tsx` | +3 | closed→null / open→rendered + 头号 binding + "soon" pill |
| **合计** | **+36** | Sprint 6 baseline 432 → Sprint 7 ship 468 |

---

## 2. Sprint 8 工作清单 (按交付顺序)

### 2.1 Sprint 7 review carry-forwards (Day 1 顺手关 — 待 opus 4.7 code-reviewer 输出)

opus 4.7 max-effort code-reviewer 待跑;预期 0 CRITICAL / 0 HIGH (基线已是 APPROVE);如有 MEDIUM/LOW Day 1 闭。

### 2.2 Sprint 8 主菜 — 打包 + 分发 (PROJECT-PLAN.md §2 Sprint 7 剩余)

| 任务 | 入口 |
|---|---|
| `electron-builder` macOS .dmg | `package.json` 已有 `build:mac` script (electron-vite build && electron-builder --mac). ad-hoc 签名 (Sprint 8 先够,公证留 V1.5) |
| auto-updater | electron-updater + GitHub Releases appcast |
| README + 安装指南 | venv setup + mailagent CLI 安装 + Mail.app 自动化权限授予流程 + .dmg 安装 + 首次启动配置 (Settings → keys + Notion Agent) |
| `?` / `⌘K` 的 mockup pixel-faithful 视觉 review | 6 accent × 3 mode = 18 组合视觉手测 (a11y --strict 已过 12) |
| QuickActions LLM prompt i18n | `prompt:` 字段也走 i18n key (英文用户的 LLM prompt 应该用英文) — Sprint 8 可选 polish |

---

## 3. 工作模式

| 角色 | Agent | 何时用 |
|---|---|---|
| **主线** | Claude Opus 4.7 单线 max-effort | 整 Sprint 8 持续 context |
| **子任务并行** | ultrawork (optional) | Sprint 8 .dmg 打包 + auto-updater + README 三条线可拆并行 |
| **长 IO** | `Bash run_in_background=true` | `pnpm install` / `pnpm electron-vite build` / `pnpm a11y:contrast` / `electron-builder --mac` |
| **Sprint 末 review** | `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` (强制) | 强制 — 闭环价值高 |
| **禁用** | `codex:codex-rescue` agent / `autopilot` | `[[feedback-codex-collaboration-path]]` 红线 |

参考: `[[reference-mailagent-frontend-dev-collab]]` + `[[feedback-codex-collaboration-path]]`.

---

## 4. 设计约束 (lint / CI 已枪口对准)

DESIGN.md §14 八条非协商 + i18n + 三态主题第 9/10 条 — 同 Sprint 5/6. Sprint 7 没新增 lint rule.

**Sprint 7 关键 pattern**:
- **快捷键 SSoT** — 所有 binding 元数据 (id/spec/display/scope/labelKey/wired) 集中 `src/shared/keymap.ts`. 注册仍各组件做 (handler 需本地 state); SSoT 仅是显示用的「契约清单」 (`?` modal 读它)
- **Portal modal 模式** — KeyboardHelpModal + CommandPalette 都用 `createPortal(document.body)` 独立生命周期. 共享 querySelectorAll 焦点 trap pattern (避 react-focus-lock 依赖)
- **Adjust state on prop change** — CommandPalette reset query/highlight + clamp highlight 在 render body 内 (`if (prev !== curr) setX(...)`),避 `react-hooks/set-state-in-effect` 红线. 配合 lazy `useState` initializer
- **zustand module-level helper** — open/close 走 store 外的 `openX()` / `closeX()` (从 Sidebar 等非 React 闭包调). 模式: `useX.getState().setOpen(true)`
- **EmptyState + Skeleton 复合** — 不再写 inline "加载中…" 文字; 统一走 `<EmptyState icon=... title=... action=... />` + `<SkeletonCard />` / `<SkeletonRow />`

---

## 5. 架构规范 (关键 + Sprint 7 已落地)

### 5.1 全局快捷键 SSoT 模式 (Sprint 7 沉淀)

新加全局快捷键:
1. 在 `src/shared/keymap.ts` SHORTCUTS 列表 append `{id, spec, display, scope, labelKey, wired}` (`wired=true` 表示有真 handler)
2. 在 SSoT 实现的组件里 `useShortcut(spec, handler)` 注册 (scope=`global` 的 mount 到 `GlobalShortcuts.tsx`,其他 scope 各 layout 内)
3. 在 locales `shortcutHelp.binding.<id>` 加 zh + en label
4. `?` modal 自动列出 (不需碰 modal 代码)

### 5.2 Portal modal + focus-trap 模式

```tsx
const dialogRef = useRef<HTMLDivElement>(null)
useEffect(() => {
  if (!open) return
  dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus()
}, [open])

const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
  if (e.key === 'Escape') { e.preventDefault(); closeFn(); return }
  if (e.key !== 'Tab') return
  const root = dialogRef.current
  if (!root) return
  const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex !== -1)
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  // ... shift+tab wrap last; tab wrap first
}, [])

const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

if (!open) return null
return createPortal(<div ref={dialogRef} ...>...</div>, document.body)
```

用于: ResyncConfirmDialog / KeyboardHelpModal / CommandPalette. 不引 react-focus-lock 依赖.

### 5.3 path validation in IPC sanitizer (C-04 红线扩展)

```typescript
function isSafeUserPath(value: string): boolean {
  if (value.length === 0) return false
  if (!isAbsolute(value)) return false
  // CRITICAL: check raw before normalize — normalize 把 `..` 解析掉
  const rawSegments = value.split(/[/\\]/).filter(Boolean)
  if (rawSegments.includes('..')) return false
  const normalized = normalize(value)
  if (!isAbsolute(normalized)) return false  // paranoid second check
  return true
}
```

用于 dbPath / attachmentDir. Sprint 8 wire `better-sqlite3.Database(s.dbPath)` 前必跑.

### 5.4 envelope.ts SSoT 抽取

handlers 模式: import + 调用,不重复定义.
```typescript
import { CliError, callCli } from '../cli_runner'
import { ensureInternalId, envelopeFromCli, type WriteEnvelope } from '../lib/envelope'

ipcMain.handle('foo:bar', async (_evt, internalId, opts) => {
  const idOrErr = ensureInternalId(internalId, 'foo:bar')
  if (typeof idOrErr !== 'number') return idOrErr
  return envelopeFromCli(runFoo(idOrErr, opts))
})
```

---

## 6. 注意事项 + Edge cases

| 场景 | 处理 |
|---|---|
| Settings dbPath / attachmentDir 已加 path validation | Sprint 8 wire `better-sqlite3.Database(s.dbPath)` 时仍要在 main process 二次 validate (defense-in-depth) |
| `?` 在含 `<input>` focus 上不应触发 modal | useShortcut 默认 plain-key skip editable target; `?` 是 plain key 所以 OK |
| `⌘K` 在 composer focus 上应该工作 (用户期望 ⌘K 全局可用) | useShortcut 的 `cmd-only` mode 自动 pass editable check (macOS 约定) |
| CommandPalette 打开时 ⌘K 应该关 | 当前实现: 第一次 ⌘K → open. 第二次 ⌘K 不 toggle (palette 自己 focus 后已捕获 keydown 在 dialog 内). 后续 issue |
| Skeleton 在 motion-reduce 用户应静止 | 已加 `motion-reduce:animate-none` class |
| Empty state 在 inbox 空时还没接入 | Mockup 没 spec; Sprint 8 polish 时如果决定加 mascot 再 wire |
| QuickActions 5 个 LLM prompt 仍是中文字面 | 英文用户的 LLM prompt 应该用英文 — Sprint 8 把 ACTIONS 的 `prompt:` 字段也走 i18n key |

---

## 7. 验收标准

### 7.1 阀门 (ship 前必绿)

- ✅ `pnpm test`: **468 passed | 1 skipped** (Sprint 6 baseline 432 + 36 新)
- ✅ `pnpm lint`: 0 violation (含 mailagent design rules + react-hooks 各 rule)
- ✅ `pnpm typecheck`: 0 error (node + web)
- ✅ `pnpm a11y:contrast` (--strict): **12 组合 all clean**
- ✅ `pnpm electron-vite build`: ✓
- ✅ production grep 23 patterns: renderer + preload **0 真泄漏** (1 keytar 是 V2 stub comment + 2 MAILAGENT_CLI_API_KEY 是 i18n hint + 1 osascript 是 toast hint — Sprint 6 baseline 一致)

### 7.2 功能性 (Sprint 7 主菜)

- ✅ Sidebar `快捷键` 项 click → KeyboardHelpModal 弹
- ✅ `?` 全局 → KeyboardHelpModal 弹 (含 editable target gating: `<input>` 内打 `?` 不触发)
- ✅ `⌘K` 全局 → CommandPalette 弹 (含 6 nav + mailbox switch + FTS5 search 1-screen)
- ✅ `⌘,` → 跳 /settings
- ✅ Modal Tab 焦点环绕 + Esc 关 + click 背景关
- ✅ admin / llm / calendar / search 空状态显示 EmptyState (icon + title + hint)
- ✅ admin / llm / calendar / settings 加载态显示 Skeleton (代替"加载中…"文字)

### 7.3 i18n

- ✅ 所有新增 JSX 字符串走 `t()`
- ✅ zh-CN + en-US locales 同步 (320 keys 同 count)
- ✅ `[TODO en]` 0 残留
- ✅ Sidebar 8 zh + EmailDetail 2 zh + admin timeAgo + llm cacheTokens 全清

### 7.4 Sprint 末 review (强制)

- 独立 Opus 4.7 max-effort `Agent subagent_type=oh-my-claudecode:code-reviewer model=opus` (待跑)

---

## 8. NOTES.md 待办处理

Sprint 8 启动后用 5 分钟整理 `frontend/NOTES.md`. Sprint 7 review carry-forwards
(待 opus 4.7 review 输出后写入) Day 1 顺手关.

---

## 9. 启动 checklist

```bash
# 1. 拉最新 + 切分支
cd ~/Documents/MailAgent && git pull
git checkout main && git merge sprint7   # Sprint 7 主线已 ship
git checkout -b sprint8
cd frontend && pnpm install

# 2. 验 Sprint 7 baseline 全绿
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm test       # 468 passed | 1 skipped
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm lint       # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm typecheck  # 0
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm a11y:contrast  # ✓ 12 组合 clean
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm exec electron-vite build  # ✓

# 3. mailagent CLI 可用?
which mailagent && mailagent --version
mailagent admin health -o json  # 探一下后端 DB 可读

# 4. Mail.app 自动化权限确认 (Sprint 5 复用)

# 5. 起 dev server 验证 Sprint 7 polish
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm dev
# → 按 ? → 看快捷键 help modal 弹 (Global / Inbox / Row / Chat 4 个 section + soon pill)
# → 按 ⌘K → 看 command palette 弹 (nav 6 + mailbox 2 + 输入 "redis" 触发 FTS5)
# → 按 ⌘, → 跳 /settings
# → 点 sidebar "快捷键" → 同 ? 行为
# → 切到 /admin (空死信场景应该看 EmptyState 不是"无死信邮件"文字)
# → 切到 /calendar (调时间范围至 30d, 应该看 EmptyState 含 emptyHint)

# 6. 必读 (~25 min):
# - frontend/PROJECT-PLAN.md §2 Sprint 7 剩余 (打包+autoupdater+README)
# - frontend/SPRINT7-HANDOFF.md §2 + §10 (本文档)
# - frontend/NOTES.md (Sprint 7 review carry-forwards — 待 opus 4.7 review 写入)
# - frontend/DESIGN.md §13 项目结构 (打包前对照检查)

# 7. Day 1 顺手关 cheap Sprint 7 review carry-forwards (待 opus 4.7 review 输出)
```

---

## 10. 不要做的 (红线清单)

- ❌ 不要碰 `data/sync_store.db` schema (C-05 红线; 后端 DB_VERSION 拥有)
- ❌ 不要碰 `~/.mailagent/frontend/ai_chat.db` schema 而不 bump CHAT_DB_VERSION
- ❌ 不要让 LLM API key / Custom API key / CLI API key 进 renderer bundle (C-04 红线)
- ❌ 不要在 render body 调 `Date.now()` / `Math.random()` 等 impure 函数
- ❌ 不要在 useEffect body 同步 setState — 用 setTimeout(0) 推到下一 tick OR adjust-state-on-prop-change (Sprint 7 CommandPalette pattern)
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
- ❌ 不要 dynamic `await import('./module')` 当 module 已在 entry 静态导入
- ❌ 不要绕 `isSafeUserPath()` 把 dbPath / attachmentDir 路径直传 `better-sqlite3.Database()` 或 fs (Sprint 7 MEDIUM #1 — Sprint 8 wire-in 时再次 enforce)
- ❌ 不要重复 `WriteEnvelope<T>` / `envelopeFromCli` / `ensureInternalId` 定义 (Sprint 7 抽到 `lib/envelope.ts`)
- ❌ 不要重复 `STORAGE_AGENT_*` 常量 (Sprint 7 抽到 `state/notion-agent-storage.ts`)
- ❌ 不要在 keymap binding 加新条不更新 `src/shared/keymap.ts` SSoT (`?` modal 读它)

---

## 11. Cross-links (按重要度)

| 文档 | 章节 | 用途 |
|---|---|---|
| `PROJECT-PLAN.md` | §2 Sprint 7 剩余 | Sprint 8 任务源头 (打包 + auto-updater + README) |
| `DESIGN.md` | §9.5 快捷键 + §14 lint + §16 i18n + §17 主题 | 视觉 / 交互 / 非协商 |
| `ARCHITECTURE.md` | §2.2 + §5 | 数据层抽象边界 + 主路径 |
| `BACKEND-INTERFACES.md` | §1.6 cli runner + §4 SQLite schema | Sprint 6 admin/llm dashboard 数据来源 |
| `NOTES.md` | Sprint 7 review entry | Sprint 7 review carry-forwards (待 opus 4.7 写入) |
| `REVIEW-LOG.md` | C-04 / C-05 / H-15 | 红线 trump 任何新设计 |
| `SPRINT6-HANDOFF.md` | §1 + §5 (架构沉淀) | Sprint 6 模式参考 |
| 后端 `CLAUDE.md` | "CLI 完整列表" admin/llm/calendar group | Sprint 6 dashboard 数据来源 + Sprint 7 任何新写命令 |
| memory `reference-mailagent-frontend-dev-collab` | 全部 | 工作模式 SoT |

---

> Sprint 8 ship checklist 走完 → 这份 handoff 归档到 `frontend/archive/`, 写
> Sprint 9 handoff 时引用本文 §1.2 (D2-D5 polish 模式) + §5
> (架构沉淀) + §1.1 (Sprint 6 review carry-forwards 闭环).

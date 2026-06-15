# Sprint 11 Handoff — V1.4 chrome 重构 + 路由重组 + 用户反馈 polish

> Sprint 11 = `frontend/ref/` 设计 SSoT 落地的第一刀：TitleBar / Sidebar /
> StatusBar 三块 chrome + 路由树 + Liquid Glass 材质 + 7 项用户反馈修复。
> 后续 sprint 按这个底座往里填具体页面（Inbox / EmailDetail / Search /
> Settings / Admin / LLM Dashboard / Calendar）。
>
> **启动前最少读完**：§0 TL;DR + §7 验收清单 + §8 Sprint 12 候选

---

## 0. TL;DR

| 项 | 值 |
|---|---|
| Sprint 范围 | (a) Chrome SSoT 重写：TitleBar + Sidebar + StatusBar 按 `ref/DESIGN.md` §2.11；(b) 路由重组到 `/admin/{llm,kanban,calendar}` + `/?view=` inbox 内部视图；(c) Liquid Glass 材质 + accent-tinted aurora wallpaper；(d) 用户反馈 11 项 polish |
| 设计 SSoT | `frontend/ref/DESIGN.md`（1975 行 V1.4）+ 8 份 mockup HTML |
| 阀门 | typecheck 0 / lint 0 / vitest 560 passed + 1 skip / a11y 12 组合 clean / 新增 17 单测全过 |
| 新增文件 | 7 component/state/lib + 3 测试 + 1 icon set |
| 修改文件 | 13 个（CSS + chrome + router + EmailList + i18n + keymap）|
| 工作模式 | Claude Opus 4.7 max-effort 单线，用户随时反馈、立刻迭代 |
| Sprint 12 候选 | 逐页面 polish 按 mockup 对照（Inbox EmailRow / EmailDetail / SearchPage / SettingsPage / AdminPage / LlmDashboardPage / CalendarPage）— prompt 见 §9 |

---

## 1. 已 ship deliverables

### 1.1 Chrome 三块按 V1.4 SSoT 重写

**`Sidebar.tsx`** — 全重写为 V1.4 nav-shell 契约：
- 240/56 双态宽度，`⌥B` 全局切换 + chevron 按钮 + 折叠态点击 avatar 自动展开
- 顶部账户头一行：`[badge] localPart ▾` + 折叠 chevron。账户来源 `.env` USER_EMAIL via `settings.userEmail`（main process 启动读 `repo-root/.env`）；fallback `notionAgentName`
- 折叠态 avatar monogram（local-part 首字母 + `var(--c-accent)` 背景），点击展开 + 弹 popover
- `AccountSwitcherPopover.tsx` 独立组件：1 行 derived account + `+ 添加账户...` ghost row 路由到 `/settings`；outside-click / Escape / route-change 关闭
- **3 个 section**（lint 强制 `==3`）：MAILBOXES / AI AGENTS / VIEW
  - MAILBOXES：收件箱 / 发件箱 / 已标旗 / 所有邮件
  - AI AGENTS：Notion Agent（online dot）/ Custom API / AI 会话历史（disabled，§9.4 灰态）
  - VIEW：LLM Dashboard / 看板 Admin / 日历
- 底部条：设置 (`⌘,`) + 快捷键 (`?`)
- `localStorage["mailagent.nav.collapsed"]` 持久 + `storage` 事件跨窗口同步（pop-out 兼容）

**`TitleBar.tsx`** — 简化为 V1.4 §2.11：
- 72px 红绿灯保留区 + brand "MailAgent" + 中央 `⌘K` CommandPalette 触发
- 右侧 cluster: `AccentPickerPopover` · `ThemePickerPopover` · `LocalePicker`
- Drag region：`<header>` drag，具体 button 自己 `WebkitAppRegion: 'no-drag'`（之前 wrapper 整片 no-drag 导致大部分 chrome 不能拖窗，修复）
- 移除：Island 段 + Sync 段（下移到 StatusBar）

**`StatusBar.tsx`** — 保持 6 段密度 + V1.4 玻璃材质：
- Sync · Island · Mailbox · LLM · Theme/Accent · Version
- 每段挂 `<HoverTip text=...>` 立即响应 hover 显示玻璃 chip tooltip（不用 native title，鼠标维持默认箭头）

**新增组件**：
- `ThemePickerPopover.tsx`：3 行选择 popover（跟随系统 / Light / Dark）替代单按钮 cycle，让 "跟随系统" 选项可见
- `AccentPickerPopover.tsx`：264px 3×2 swatch 网格（coral/cobalt/teal/rose/slate/olive），实时染色
- `LocalePicker.tsx`：中文 ↔ English 两态 toggle，i18next + IPC `appearance:locale` 广播
- `HoverTip.tsx`：轻量 React hover tooltip，glass-pop 材质 + multi-line `whitespace-pre-line`

### 1.2 Liquid Glass 材质层

`index.css` 加全套：
- `--glass / --glass-lg / --glass-stroke / --pop-shadow` CSS 变量（dark/light 两套）
- `--wallpaper`：accent-tinted aurora（3 个 radial-gradient + 底色 linear-gradient），点 Coral/Cobalt 等会重新染色背景
- `body::before` 固定背景层挂 `--wallpaper`，所有 chrome 透出
- `.glass / .glass-2 / .glass-3 / .glass-pop` 四级 backdrop-filter：
  - `.glass` 用于 TitleBar / Sidebar / StatusBar (chrome tier, ink-1 @ 0.55)
  - `.glass-2` 预留 EmailList pane (ink-2 @ 0.45)
  - `.glass-3` 预留 EmailDetail pane (ink-3 @ 0.55)
  - `.glass-pop` AccountSwitcher / Accent picker / Theme picker / HoverTip
- `@media (prefers-reduced-transparency: reduce)` flatten 到 opaque（a11y opt-out）

### 1.3 路由重组

`router-instance.tsx` 从 6 条扁平改成嵌套：
```
/                  → InboxLayout         validateSearch: { view?: 'inbox'|'outbox'|'flagged'|'all' }
/search            → SearchLayout
/admin             → (parent, Outlet only)
  /admin/llm       → LlmDashboardLayout    (原 /llm)
  /admin/kanban    → AdminLayout           (原 /admin)
  /admin/calendar  → CalendarLayout        (原 /calendar)
/settings          → SettingsLayout
```

- `validateSearch` 把未知 `view` 归一到 `'inbox'`；`view` 类型为 optional 让 `navigate({to:'/'})` 不强制带 search
- `EmailList.tsx` 按 view 切 query：inbox→{mailbox:'收件箱'}，outbox→{mailbox:'发件箱'}，flagged→{isFlagged:true}，all→{}，H1 label 跟 view 翻译
- `InboxLayout.tsx` 用 `useSearch({from:'/'})` 同步 URL ↔ `useEmailFilter().view`，可 deep-link
- Sprint 10 packaged-app `file://` `createMemoryHistory` fix 保留
- `CommandPalette.tsx` literals 全部更新到 `/admin/*`

### 1.4 Keymap

- 新增 `toggleNav (⌥B, global)` + `toggleLocale (⌥G, global)`
- `switchBackend` 从 `⌥B (chat)` 改 `⌥⇧B (chat)` 让出 ⌥B 给全局 nav 切换

### 1.5 Electron icon

- 跑 `ref/build-icons.sh ref/mailagent_logo.png` 生成 `build/icon.icns` + `build/icons/{16..1024}.png`
- packaged build 通过 `electron-builder.yml` 的 `buildResources: build` 自动应用
- dev 模式 `app.dock.setIcon(build/icons/1024.png)`（.png 比 .icns 在 macOS 运行时 setIcon 更可靠）

### 1.6 macOS app menu rebuild

`main/index.ts` 用 `Menu.setApplicationMenu` 重建顶部菜单第一项 `MailAgent`，About/Hide/Quit 标签也带产品名。修复 dev 模式菜单栏读 "Electron" 的问题。

### 1.7 用户反馈 11 项 polish

| # | 反馈 | 修复 |
|---|---|---|
| 1 | 账户从 `.env` 读 | main 读 `repo-root/.env` USER_EMAIL → settings.userEmail，Sidebar 优先用它 |
| 2 | 折叠态 icon 全消失 | NavRow 用 `cloneElement` 让 icon 成为 button 直接子，CSS `button > svg` 19px 命中（含 disabled `div > svg`）|
| 3 | TitleBar 没 "MailAgent" brand | 72px 红绿灯后加 brand label |
| 4 | Electron icon 没用 | 生成 icon.icns + dev mode dock.setIcon |
| 5 | Titlebar 不能拖窗 | wrapper div 改回 drag，只让具体 button no-drag |
| 6 | macOS 菜单名 "Electron" | Menu rebuild MailAgent |
| 7 | 主题切换缺 "跟随系统" | Theme cycle → 3 选项 popover |
| 8 | 发件箱不该显示 0 | outbox NavRow 干掉 right prop |
| 9 | 数字默认不高亮 | UnreadPill 永远渲染 coral 边框 + bg，0 时只 fg 灰 |
| 10 | 缺毛玻璃 | `.glass*` 四级 + `--wallpaper` 全套 |
| 11 | StatusBar hover tooltip 不显示 | HoverTip React 组件替代 native title |

---

## 2. 文件级 diff

### ADD（11）
- `src/shared/state/nav-shell.ts` — collapsed 状态
- `src/shared/lib/account.ts` — `deriveAccount(email)`
- `src/shared/components/layout/AccountSwitcherPopover.tsx`
- `src/shared/components/layout/AccentPickerPopover.tsx`
- `src/shared/components/layout/LocalePicker.tsx`
- `src/shared/components/layout/ThemePickerPopover.tsx`
- `src/shared/components/ui/HoverTip.tsx`
- `tests/shared/account.test.ts` (6 cases)
- `tests/shared/nav-shell.test.ts` (5 cases)
- `tests/components/sidebar-contract.test.tsx` (6 cases，§2.11 lint 契约)
- `build/icon.icns` + `build/icons/` (7 PNG sizes)

### EDIT（14）
- `src/electron/renderer/index.css` — glass/wallpaper/app-nav/swatch/theme-popover
- `src/electron/main/index.ts` — Menu rebuild + dock.setIcon
- `src/electron/main/handlers/settings.ts` — loadUserEmailFromEnv + userEmail 字段
- `src/shared/api/types.ts` — PersistentSettings.userEmail
- `src/shared/components/layout/Sidebar.tsx` — 全重写
- `src/shared/components/layout/TitleBar.tsx` — 全重写
- `src/shared/components/layout/StatusBar.tsx` — 重写 + HoverTip 集成
- `src/shared/components/layout/InboxLayout.tsx` — URL ↔ view 同步
- `src/shared/router-instance.tsx` — 路由树 + validateSearch
- `src/shared/components/command/CommandPalette.tsx` — `/admin/*` literals
- `src/shared/components/email/EmailList.tsx` — view 接 IPC + H1
- `src/shared/state/email-filter.ts` — `view: EmailView`
- `src/shared/components/chat/AIChatPanel.tsx` — switchBackend `⌥B` → `⌥⇧B`
- `src/shared/keymap.ts` — `toggleNav` + `toggleLocale` + switchBackend rebind
- `src/shared/components/keyboard/GlobalShortcuts.tsx` — 注册 alt+b/alt+g
- 2 locale common.json — `nav.*` / `titleBar.accent.*` / `titleBar.locale.*` keys
- `tests/components/__snapshots__/EmailRow.test.tsx.snap` — 同步 sprint10 round-3 `py-3→py-2`
- `src/shared/components/chat/{Composer,MessageList}.tsx` — 顺手 fix `bg-coral` → `bg-coral/100` (mailagent/no-coral-flood)

### DELETE（0）
孤儿 i18n key（`sidebar.*` 旧 namespace）留一版做 backward-compat。

---

## 3. 实施顺序（已闭，仅做参考）

1. CSS + i18n keys
2. nav-shell store + account helper
3. Sidebar 重写
4. AccountSwitcherPopover 抽离
5. TitleBar 重写 + Accent/Locale picker
6. StatusBar 加 Island 段
7. 路由重组
8. EmailList view filter + URL sync
9. keymap + GlobalShortcuts
10. 测试
11. typecheck + lint + a11y 全绿
12. dev server 手测 + 用户反馈 11 项 iterate

---

## 4. 设计 SSoT — 必读章节

`frontend/ref/DESIGN.md`：
- §1 — 设计哲学（信息密度、native macOS、AI 集成、Liquid Glass）
- §2.1 — 6 层 ink-* CSS 变量
- §2.7 — 6 个 accent 主题切换
- §2.8 — Liquid Glass + aurora wallpaper
- §2.9 — Light / Dark 主题（token swap）
- §2.10 — i18n（zh-CN / en-US）
- **§2.11 — Nav shell SSoT**（lint 强制 3 section header）
- §3 — Typography type scale + Chinese ≥14px floor
- §5 — 组件 catalog (EmailRow / AIBadge / AIChatPanel / BatchActionBar)
- §9.4 — Disabled 视觉规则
- §14 — non-negotiable lint 规则

`frontend/ref/mockup-*.html`：每个对应一页，是视觉契约。**SSoT 与 mockup 冲突时 DESIGN.md 赢**。

---

## 5. 关键约定（继承自 Sprint 11，请保持）

- **真实后端，无 mock**：所有列表 / 详情 / stats 走 IPC（dev: better-sqlite3 直读 ~4ms；写命令通过 execa `mailagent` CLI）
- **Tailwind + CSS 变量**：颜色不写 hex，全部走 `bg-ink-*` / `text-coral` / `border-coral/30` 类
- **CSS 类名是契约**：`.app-nav*` / `.row-selected` / `.glass*` 是 authored CSS，不要换 Tailwind utility
- **i18n 全字符串**：中文 hardcoded 不允许，走 `t('namespace.key')`；新 key 同步加 zh-CN + en-US
- **Chinese ≥ 14px floor**：text-micro/text-meta 仅英文 mono，section header / kbd / 时间戳
- **路由名字逻辑**：top-level 用 verb-less 简单名（`/inbox`、`/admin/llm`、`/settings`），search param 表示子状态
- **Disabled 元素**：`opacity-50 cursor-not-allowed` + `data-disabled="true"` + `aria-disabled="true"` + `tabIndex={-1}`，渲染 `<div role="link">` 而非 `<button>`
- **HoverTip 优先 native title**：Electron 原生 title 不可靠，用 `<HoverTip text=...>` 包装

---

## 6. 数据 / IPC 接线表（Sprint 11 用到）

| 用途 | IPC method | 调用方 |
|---|---|---|
| 邮箱列表 + counts | `email.listMailboxes()` | Sidebar / CommandPalette |
| Inbox / 子 view list | `email.listEnriched({mailbox?,isFlagged?})` | EmailList |
| Account email | `settings.get().userEmail` | Sidebar |
| Island state probe | `island.status()` + `island.onEvent()` | StatusBar |
| LLM cache stats | `llm.stats(7)` | （Sprint 12 - LLM Dashboard）|
| Admin stats / dead-letter | `admin.stats()` + `admin.deadLetterList()` | （Sprint 12 - Admin / Sidebar dead-letter badge）|
| Version + update | `updater.status()` + `updater.onEvent()` | StatusBar |
| Locale broadcast | `ipcRenderer.send('appearance:locale', ...)` | LocalePicker |

---

## 7. 验收清单（已闭）

- [x] `pnpm typecheck` 0 error
- [x] `pnpm lint --cache` 0 error
- [x] `pnpm test` 560 passed / 1 skipped / 0 failed
- [x] `pnpm a11y:contrast --strict` 12 combinations clean
- [x] `pnpm dev` 手测：
  - Brand "MailAgent" 显示 + 拖动窗体 OK
  - ⌥B 折叠到 56px，所有 icon 一致大小可见
  - Account 显示 `[tp-link] lucien.chen ▾`（来自 .env USER_EMAIL）
  - Accent picker 6 swatch popover → 整 UI 重染色
  - Theme picker 3 选项 popover（跟随系统 / Light / Dark）
  - Locale picker 中文 ↔ English
  - 发件箱无数字、收件箱永远 coral chip
  - 玻璃感 + accent-tinted wallpaper 可见
  - StatusBar 6 段 hover 显示自定义 tooltip（鼠标不变问号）
  - 点 LLM Dashboard / 看板 Admin / 日历 → `/admin/*` 路由
  - Dock icon 显示 mailagent 环形光轨
  - macOS 顶部菜单栏第一项读 "MailAgent"

---

## 8. Sprint 12 候选（页面级 polish）

按 mockup 一个个对照刷：

| 页面 | mockup | 现状 | 工作量预估 |
|---|---|---|---|
| Inbox (EmailRow + EmailList) | `mockup-inbox.html` 中央列 | 行密度已收紧（sprint 10 round-3），但 chip / AI 字段 / 颜色与 mockup 仍有差 | 1-1.5 天 |
| EmailDetail | `mockup-inbox.html` 右列 + `mockup-detail-window.html` | EmailDetail 是 22.5K 行的大组件 — 工具栏 + body iframe + AI Fields block + attachments 全部对比 mockup | 2-3 天 |
| SearchPage | `mockup-search.html` (⌘K 命令面板) | CommandPalette 已实装，但 `/search` 独立路由的 SearchPage 仍是 Sprint 3 老样式 | 0.5-1 天 |
| Compose / 起草回复 popout | `mockup-compose.html` | 当前无独立窗口，复用 EmailDetail 的 inline 草稿。是否需要 popout 待用户决定 | 1-2 天（如做）|
| Settings | `mockup-settings.html` | 240/56 shell + 180px section nav + 内容 pane 三栏 | 1-1.5 天 |
| Admin (kanban / LLM Dashboard / Calendar) | `mockup-admin.html` | 三个 sub-page，shell 加 180px section rail 类似 settings | 1-1.5 天 |
| Onboarding | `mockup-onboarding.html` | 当前没有，首次启动 modal | 0.5-1 天 |

---

## 9. Sprint 12 启动 prompt（粘到新 session）

```
此项目是 MailAgent (macOS Electron 邮件同步)。我们刚完成 Sprint 11 chrome
重构 — TitleBar / Sidebar / StatusBar + 路由树 + Liquid Glass 全套，按
`frontend/ref/DESIGN.md` V1.4 + 8 份 mockup HTML 落地。下面我们要按 mockup
逐个页面 polish 业务区域。

**强制先读**：
1. `frontend/SPRINT11-HANDOFF.md` — 全部已 ship 内容（chrome / 路由 / glass /
   token / disabled rule / keymap / IPC table / SSoT 约定）
2. `frontend/ref/DESIGN.md` §1（哲学）§2.1（ink token）§2.7（accent）§2.8
   （glass）§2.10（i18n）§2.11（nav shell）§3（typo）§5（component catalog）
   §9.4（disabled）§14（lint）
3. `frontend/ref/mockup-<page>.html` — 对应页面的视觉契约

**约定（继承自 Sprint 11，强制）**：
- 真实后端、无 mock；走 IPC / mailagent CLI
- 颜色 token 全走 Tailwind class（bg-ink-* / text-coral / coral/30 等），
  零 hex；`.glass*` / `.app-nav*` / `.row-selected` 是 authored CSS
- i18n: 中文 hardcoded 不允许，新 key 同步 zh-CN + en-US
- 中文 ≥ 14px (text-aux / text-body 或更大)
- Disabled: opacity-50 + data-disabled + aria-disabled + tabIndex=-1 + <div role="link">
- HoverTip 优先于 native title
- 验收: typecheck / lint / vitest / a11y:contrast 全绿才算 done
- Commit 风格: 按 Sprint 10/11 历史 — feat(frontend): Sprint 12 <聚焦>

**接下来要做的页面**（按用户优先级问，逐个干，每个独立 commit）：
- Inbox EmailRow + EmailList 视觉 polish
- EmailDetail 工具栏 + 正文 + AI Fields + 附件
- SearchPage `/search` 路由（CommandPalette 已实装，独立路由是 Sprint 3 残留）
- Settings page 三栏布局
- Admin (LLM Dashboard + 看板 Admin + Calendar) section rail
- Onboarding 首启 modal（如需要）

**禁动区**（Sprint 11 已 ship，未明确指示不要碰）：
- TitleBar / Sidebar / StatusBar 三块 chrome 本身
- Liquid Glass / wallpaper / accent token / theme token / locale 切换逻辑
- 路由树骨架 (`/admin/*` 嵌套 + validateSearch)
- nav-shell store / account helper / keymap

**问用户**: "Sprint 12 第一个先做哪个页面？或者列出优先级我按序做。"
```

---

## 10. 风险 & 未决项

- **多账户**: 当前 `.env` 单账户，AccountSwitcherPopover 渲染 1 行 + add ghost。Sprint X 后端补 `mail_accounts` 表后扩展为真列表，JSX skeleton 不变
- **AI 会话历史 disabled**: 后端没 chat history 表。Sprint X 加 `chat_sessions` 后启用
- **Dynamic Island 显示**: dev 模式 dock setIcon 用 .png（.icns 在 dev 有时不生效），packaged build 走 electron-builder buildResources，已验证
- **Sprint 10 file:// memory-history fix**: 完整保留在 `router-instance.tsx:93-105`
- **`@media (prefers-reduced-transparency: reduce)`**: a11y opt-out 已 flatten glass 到 opaque，但视觉显著不同；用户报告需手动关 glass 时可在 Settings 加 toggle
- **i18n 孤儿 keys**: `sidebar.search / .translate / .section.accounts / .section.tools / .section.ops / .cacheWarn` 留一版作 fallback。下个 release 删除

---

## 11. 关键文件指针（绝对路径）

| 用途 | Path |
|---|---|
| 设计 SSoT | `frontend/ref/DESIGN.md` |
| Mockup | `frontend/ref/mockup-{inbox,search,settings,admin,compose,detail-window,onboarding,dynamic-island}.html` |
| Plan 存档 | `~/.claude/plans/frontend-ref-transient-rain.md` + `~/.claude/plans/frontend-ref-transient-rain-agent-ae2e55c221c348d26.md` |
| Chrome | `frontend/src/shared/components/layout/{TitleBar,Sidebar,StatusBar,InboxLayout,AccountSwitcherPopover,AccentPickerPopover,ThemePickerPopover,LocalePicker}.tsx` |
| Token + Glass | `frontend/src/electron/renderer/index.css` |
| Router | `frontend/src/shared/router-instance.tsx` |
| State | `frontend/src/shared/state/{nav-shell,email-filter,appearance,island,updater,mailbox}.ts` |
| HoverTip | `frontend/src/shared/components/ui/HoverTip.tsx` |
| Icon | `frontend/build/icon.icns` + `frontend/build/icons/*.png` + `frontend/ref/build-icons.sh` |
| Keymap | `frontend/src/shared/keymap.ts` + `frontend/src/shared/components/keyboard/GlobalShortcuts.tsx` |
| Tests | `frontend/tests/{shared,components}/{account,nav-shell,sidebar-contract}*.{ts,tsx}` |

# Sprint 3 Handoff — 搜索 + 翻译 + Thread Sidebar

> Sprint 3 主开发 handoff。Sprint 0/1/2 ship + 0964059 review follow-up 已 commit。
> **工期估算**：1.5-2 天（PROJECT-PLAN.md §2 Sprint 3）。
> **启动前最少读完**：§0 + §1 + §3 + §4 + §5 + §9 启动 checklist。

---

## 0. TL;DR

| 项 | 值 |
|---|---|
| Sprint 范围 | 全文搜索（FTS5）+ 翻译 EN→中 + 详情页 Thread sidebar + a11y 12 组合 lint |
| 已 ship 基线 | commit `0964059`（review follow-up）·`43104eb`（Island doc 修正） |
| 阀门 | 134 tests green / `pnpm lint` 0 / `pnpm typecheck` 0 / a11y 12 组合 pass |
| 工作模式 | Claude Opus 4.7 单线主开发；**不需要** ultrawork；Sprint 末 1 次 codex review |
| 阻塞 | 无（Sprint 0/1/2 完工 checklist 全打钩） |
| **不要碰** | Sprint 4 AI Chat panel（6-9 天独立工作量，红线） |

---

## 1. 已完成情况速写

| Sprint | 关键 deliverable | 落地证据 |
|---|---|---|
| 0 (脚手架) | electron-vite + schema codegen + i18next-icu + ESLint 9 design rules + 三态主题 + 6 accent CSS variable swap | `eslint.config.mjs:55-65` / `index.css:16-78` / `i18n/index.ts` |
| 1 (数据层) | better-sqlite3 WAL singleton + 4 IPC handler + `cli_runner.ts` (11 退出码分发 / 读写 Semaphore / AbortController / before-quit kill) + TitleBar+StatusBar+Sidebar | `main/cli_runner.ts` / `handlers/email.ts` |
| 2 (Inbox) | EmailList virtualized + EmailRow §5.1 paste + EmailDetail flex-1 + AIFieldsBlock 3×8 + sandboxed iframe + DOMPurify + cid:→file:// 替换 + 5s polling + J/K nav | `components/email/*` / `EmailBodyFrame.tsx` |
| Sprint 3 启动夯实 (`0964059`) | EmailRow `NEW`/`SYNC FAILED` 字面值锁死 + `ai_mapping.ts` 搬到 shared + EmailDetail 走 `mapLanguage()` + `postinstall` 串 `pnpm gen:types` | git log |

**当前基线**：134 tests / 9 test files green（1 skip = happy-dom `<embed>` parser quirk，NOTES 第 19 项追踪）。

---

## 2. Sprint 3 工作清单（按交付顺序）

### 2.1 全文搜索（FTS5）— ~D1 上午

后端已就位：`handlers/email.ts:374-424` 的 `email:search` IPC handler 完整实现了 FTS5 bm25 排序 + snippet `<mark>` 高亮 + mailbox/since/until filter。**Sprint 3 只做 UI 接入**。

任务列表：
- [ ] TanStack Router 加 `/search` 路由 + Search page shell（参考 `electron/renderer/main.tsx` + 当前 router 配置）
- [ ] SearchPage 组件：query input + filter chips（mailbox / date range，复用 EmailList 的 `<FilterChip>` 视觉）
- [ ] result 列表：每条 row 走 sandboxed `dangerouslySetInnerHTML` 或新 component `<SearchHitRow>`，渲染 snippet（DOMPurify 默认 profile 接受 `<mark>`，**直接渲染即可**）
- [ ] click 跳详情：`useActiveEmail.setActive(hit.internal_id)` + router push `/inbox`
- [ ] `⌘K` 快捷键唤起 `/search`（CommandPalette 完整版是 Sprint 7；这里只接路由触发）
- [ ] debounce 200-300ms onSubmit，避免每个 keystroke 跑 FTS5
- [ ] **中文搜索处理**（关键，CLAUDE.md "Phase 3 FTS5 中文搜索注意"）：搜索框 submit 前给末尾 query token 加 `*` 前缀通配（如 `产品` → `产品*`），否则 unicode61 tokenizer 把连续 CJK 当一个 token，精确搜中文会大量假阴性
- [ ] 测试：`tests/components/SearchPage.test.tsx` mock `mailApi.email.search` 跑 5 个 case（普通英文 / 中文前缀通配 / mailbox filter / since filter / 0 result 空状态）

### 2.2 翻译 EN→中 — ~D1 下午

任务列表：
- [ ] 新建 `src/electron/main/handlers/translate.ts` IPC handler — **API key 必须经 `keychain.ts` 取**，main process subprocess 直 fetch Anthropic Messages / CRS endpoint，**不能让 key 进 renderer bundle**（C-04 红线）
- [ ] `MailApi.translate(internalId, targetLang)` 加到 `shared/api/types.ts` + `ElectronApi.ts` + `HttpApi.ts` stub
- [ ] 详情页 toolbar 翻译按钮（`EmailToolbar` 已就位 mockup §5.3，加 onClick handler）
- [ ] `⌥T` 全局快捷键（`shared/keymap.ts` 单一 SSoT）
- [ ] 会话内 cache：TanStack Query `queryKey: ['email', internalId, 'translation', targetLang]`，`staleTime: Infinity`；关 inbox 自动 GC
- [ ] 翻译失败 fallback：inline 显示原文 + 红色"翻译失败 · 重试"按钮，**不要 throw 整个 page**
- [ ] 加载态：`<Languages size={13} />` icon 加 `animate-spin`，文案 "翻译中…"
- [ ] toggle 原文/译文：单击同按钮在两态间切（不是 modal）
- [ ] AbortController 覆盖切邮件取消：renderer 切 `activeInternalId` 时把 in-flight translation request abort
- [ ] 测试：mock keychain + mock fetch，跑成功 / timeout / API error / abort 四个 case

### 2.3 详情页 Thread Sidebar — ~D1 晚 / D2 上午

任务列表：
- [ ] 新增 IPC handler `email:listByThread(threadId)` 在 `handlers/email.ts`，SQL `SELECT … FROM email_metadata WHERE thread_id = ? ORDER BY date_received ASC`，复用 `shapeListItem`
- [ ] `MailApi.email.listByThread(threadId)` 加到 types + ElectronApi + HttpApi stub
- [ ] mockup-inbox.html line 619-620 引用的 `Thread` tab — 详情页右侧 collapsible Panel
- [ ] ThreadSidebar 组件：compact list of sibling rows + click 跳邮件
- [ ] 空状态：`thread_id === null` → 显示 "无线程关联"（i18n 走 `t('email.thread.empty')`）
- [ ] Notion `Parent Item` 关系**只读**，前端不动后端 schema
- [ ] 测试：mock listByThread 跑 thread_id 有 / 无 / 仅 1 封 三个 case

### 2.4 a11y contrast lint 12 组合（REVIEW-LOG H-01 + C-08 carry-forward 提前）

任务列表：
- [ ] `pnpm add -D @axe-core/playwright @playwright/test`
- [ ] `scripts/a11y_contrast.ts`：`for accent of 6 swatch × for mode of [light, dark]` 循环：goto inbox/search/admin/llm，evaluate 设 `data-accent` + `data-theme`，跑 axe `withTags(['wcag2aa'])`
- [ ] package.json 加 `"a11y:contrast": "tsx scripts/a11y_contrast.ts"`
- [ ] 任一 violation `process.exit(1)` 让 CI fail
- [ ] **跑一次拿基线**：先看现有 12 组合 violation 数；若有则 token 微调（DESIGN.md §17.6 已预留 fallback）
- [ ] GitHub Actions workflow 加 step（如 CI 还没就位则 Sprint 4 再补，先确保本地 `pnpm a11y:contrast` 能跑）

---

## 3. 工作模式

| 角色 | agent | 何时用 |
|---|---|---|
| **主线** | Claude Opus 4.7 单线 | 全 Sprint 3 持续 context；搜索/翻译/Thread 三件事互相依赖，不要拆 |
| **子任务并行** | **不需要** ultrawork | Sprint 3 是顺序依赖 + 视觉相关，并发收益低 |
| **长 IO** | `Bash run_in_background=true` | `pnpm install` / `playwright install` / `pnpm a11y:contrast` |
| **Sprint 末 review** | `omc ask codex` 或 `collaborating-with-codex` skill | **强制**：翻译路径 API key 安全 + a11y 12 组合脚本 |
| **禁用** | `codex:codex-rescue` agent / `autopilot` | 都不要用 |

参考：`[[reference-mailagent-frontend-dev-collab]]` + `[[feedback-codex-collaboration-path]]`。

### Sprint 末 codex review prompt（直接复制）

```bash
omc ask codex "review frontend/src/electron/main/handlers/translate.ts \
  + frontend/src/shared/components/email/EmailToolbar.tsx 的翻译路径: \
  (1) API key 是否真不在 renderer bundle (检查 import / window.electron.send) \
  (2) CSP 是否阻挡 renderer 外联 (index.html meta) \
  (3) AbortController 是否覆盖切邮件 / 关 panel 两个取消路径 \
  (4) 翻译失败 fallback 是否合理"

omc ask codex "review frontend/scripts/a11y_contrast.ts: \
  (1) 6 accent × 2 mode 循环是否完整 \
  (2) @axe-core/playwright 集成是否阻塞 CI exit code \
  (3) 检测到 violation 时输出是否能定位到具体 token / 组件"
```

---

## 4. 设计约束（强提醒 — CI lint 已枪口对准你）

### 4.1 DESIGN.md §14 八条非协商 — 全部 ESLint enforced（commit 不许 fail）

| Rule | 怎么不踩雷 |
|---|---|
| `no-raw-hex` | 不许在组件里写 hex；CSS / `tailwind.config.ts` / `.gen.ts` / `electron/main/**` 是 allowlist |
| `no-banned-colors` | 不许 `slate-*` / `zinc-*` / `neutral-*` / `stone-*` 做 surface；不许 `blue-*` / `indigo-*` / `purple-*` 任何场景 |
| `no-large-radius` | `> 18px` radius 仅 Island 组件允许 |
| `no-gradient-bg` | 不许 `from-*-* to-*-*` |
| `no-heavy-shadow` | `shadow-lg` / `xl` / `2xl` 只在 Toast / Island |
| `no-grayscale-surface` | 用 `ink-*`，不用 Tailwind 灰阶 |
| `no-coral-flood` | bare `bg-coral` 必须升到 `bg-coral/100`（一 surface 一 CTA）或 `bg-coral/<N>` |
| `no-cjk-in-mono-size` | `text-micro` / `text-meta` 字面值不许有 CJK |
| `no-prefers-color-scheme` | 不许 `@media (prefers-color-scheme)`，theme 走 `data-theme` SoT |

### 4.2 pixel literal 锁死 — DESIGN.md §14 #2 + §16.6 + 0964059 commit 教训

`text-micro` / `text-meta` 区域的字面值**必须是 ASCII uppercase**（`NEW` / `SYNC FAILED` / `REPLY` / `DECIDE` 等），不能依赖 `className="uppercase"` CSS 渲染：
- jsdom / happy-dom 不应用 `text-transform`
- SSR / hydration 前后视觉与 textContent 不一致
- i18n 切换瞬间 CSS class 没就位会闪原大小写

源码写 `NEW`，CSS `uppercase` 仅作兜底。

### 4.3 设计 token 强 SoT（DESIGN.md §2 + §17）

- 颜色：`bg-ink-N` / `text-ink-fg-N` / `text-coral` / 5 priority + 4 sync 色
- 主题切换：`data-theme="dark|light"` attribute + `html.dark` class（双源同步，不要用 Tailwind `dark:` prefix 单独走）
- accent：`--c-accent` CSS variable，6 swatch 已在 `index.css:54-78`
- 翻译 UI / search UI / Thread sidebar 新增颜色**禁止**发明新 token，必须落在现有调色板

### 4.4 i18n 是强约束（DESIGN.md §16）

- 所有 JSX 字符串走 `useTranslation('namespace')` → `t('key.path')`
- 翻译按钮 / Thread sidebar 空状态 / search 0 result / a11y violation 提示 — 全部 zh-CN + en-US 双语 ship
- `[TODO en]` Sprint 末 review 必须 0 残留
- 数字日期走 `shared/format/` Intl wrapper，不直接 `new Intl.*`
- 复数走 ICU MessageFormat（`i18next-icu` 已配）

### 4.5 typography（DESIGN.md §3）

| Size | 字号 / 行高 | 允许 |
|---|---|---|
| `text-micro` | 11px mono | ASCII only |
| `text-meta` | 12px mono | ASCII only |
| `text-aux` | 14px sans | CJK safe |
| `text-body` | 14px | CJK safe |
| `text-lead` | 15px | CJK safe（subhead）|
| `text-subj` | 22px | CJK safe（主标题） |

mono 字号区域写中文 = lint error。

---

## 5. 架构规范（强提醒）

### 5.1 数据层抽象 — `useMailApi()` 是唯一入口（ARCHITECTURE.md §2.2）

- 组件**禁止**直接调 `window.electron.email.*`
- search / thread / translate 三个新增能力都走 `mailApi.*`：
  - `mailApi.email.listByThread(threadId)` → 加到 `EmailApi` interface + `ElectronApi` + handler；`HttpApi` 必须写 stub（V2 远程要用同一个接口）
  - `mailApi.ai.translate(internalId, targetLang)` 同模式
- types：`shared/api/types.ts` 是 frontend-only IPC 的 SoT；不动 `cli.gen.ts`（codegen 产物，frontend-only IPC 不进它）

### 5.2 SQLite 边界严守（REVIEW-LOG C-05 红线）

- `data/sync_store.db` **只读**，永不 alter schema（后端 mail-sync 拥有 DB_VERSION=6）
- AI Chat 历史在独立 `~/.mailagent/frontend/ai_chat.db` — **Sprint 4 才建表，本 Sprint 完全不动**
- 翻译 cache 仅会话内（TanStack Query），不持久化到任何 SQLite

### 5.3 主进程 vs renderer 边界（REVIEW-LOG C-04 红线）

- 翻译 LLM API key **必须**经 `keytar/keychain.ts` 取，main process subprocess pipe / 直 fetch；**绝对不能进 renderer bundle**
- CSP 不许 renderer 直连外网，必须 IPC → main → 外部
- 取消（切邮件 / 关 panel）用 AbortController 关 in-flight subprocess

### 5.4 sandboxed iframe + DOMPurify pipeline 已就位

- 搜索结果 snippet `<mark>...</mark>` 高亮：DOMPurify 默认 `USE_PROFILES: { html: true }` 接受 `<mark>`，直接渲染即可
- 不要为 search result 单独走第二条 sanitize 路径
- 翻译结果如果走 HTML 渲染，复用 `EmailBodyFrame` 的 PURIFY_OPTS

### 5.5 schema codegen 防漂（REVIEW-LOG C-03）

- 后端 `docs/cli-schema/email-search.schema.json` 是 SoT，`cli.gen.ts` 是 codegen 产物（gitignored，postinstall 自动跑 `gen:types`）
- 加新 IPC handler 用 cli.gen.ts 的 prefixed type（`EmailSearch_SearchHit` etc.）
- Sprint 3 不会改后端 schema，所以不要手动改 `cli.gen.ts`

---

## 6. 注意事项 + Edge cases

| 场景 | 处理 |
|---|---|
| FTS5 中文 tokenizer | unicode61 把连续 CJK 当一个 token；精确 "产品" 命不中 token "本周产品评审"。submit 前给末尾 query token 加 `*`（`产品*`）；邮件正文里 markdown 标记会自动切 token，**大多数中文邮件能直接搜中文**。单测 fixture 务必用 `*` 否则假阴性 fail（CLAUDE.md "Phase 3"）|
| 翻译 timeout / fail | fallback 显示原文 + 红色 inline "翻译失败 · 重试"。不要 throw 整页 |
| Thread `thread_id === null` | 显示空状态 "无线程关联"（i18n key），不 crash |
| a11y "18 组合" 实际数 | 6 accent × 2 mode = **12** visual 真验证（system 模式 resolve 后等于 light 或 dark），文案改 "12 必验组合"（REVIEW-LOG H-01 已校准） |
| `⌘K` 命令面板 | Sprint 3 只接搜索路由触发 `/search`；CommandPalette 完整 fuzzy 跨域搜索是 Sprint 7 |
| search input debounce | 200-300ms onChange debounce 触发 search，避免每个 keystroke 跑 FTS5 |
| 切邮件取消 in-flight 翻译 | renderer 切 `activeInternalId` 时把所有 in-flight translate request abort（AbortController + useEffect cleanup） |
| `EmailGet_EmailRecord.cc_addr` schema nullable | 后端 DAO 用 `''` 替 null，Sprint 3 如果搜索结果要展示 cc，沿用此约定，**不要**为此 widen schema（升级到 gh issue 跟踪） |

---

## 7. 验收标准

### 7.1 阀门（必须全绿才能 ship Sprint 3）

- [ ] `pnpm test`: ≥ 134 baseline + Sprint 3 新增（预计 ~15-25 test）全 pass（除 happy-dom `<embed>` 1 skip）
- [ ] `pnpm lint`: 0 violation（含 9 个 mailagent design rules）
- [ ] `pnpm typecheck`: 0 error（node + web 双 tsconfig）
- [ ] `pnpm gen:types`: 跑通，cli.gen.ts 重生（后端 schema 不变情况下 git diff 应为空）
- [ ] `pnpm a11y:contrast`: 12 组合（6 accent × 2 mode）全 WCAG AA pass — **Sprint 3 末第一次跑**

### 7.2 功能性

- [ ] `/search?q=...` 路由能开 + result 列表渲染 + snippet `<mark>` 高亮 + click 跳详情
- [ ] mailbox + date filter chip 能切 + 数字 i18n 正确
- [ ] `⌘K` 触发 `/search`
- [ ] 中文前缀通配 `产品*` 实测能搜到 token "本周产品评审"
- [ ] 详情页"翻译" 按钮 + `⌥T` 快捷键 → 加载态 → 中文译文显示
- [ ] 翻译 toggle 原文/译文（同按钮单击切）
- [ ] 翻译失败显示明确 error + 重试按钮
- [ ] 详情页右侧 `Thread` tab：sibling rows 列表，click 跳邮件
- [ ] `thread_id` NULL 时 Thread tab 显示空状态而非 crash
- [ ] 切邮件时 in-flight 翻译被 abort（不会污染下一封邮件）

### 7.3 i18n

- [ ] 新增 JSX 字符串全部走 `t()`
- [ ] zh-CN + en-US locales 同步
- [ ] grep `[TODO en]` 0 残留
- [ ] Intl 数字 / 日期 / 文件大小 走 `shared/format/` wrapper

### 7.4 Sprint 末 codex review（必须，§3 已给 prompt）

---

## 8. NOTES.md 待办处理（参 `[[reference-mailagent-issue-tracking]]`）

Sprint 3 启动后用 5 分钟整理 `frontend/NOTES.md` 14 项 TODO，分三类：

### 8.1 本 Sprint 顺手关（commit message reference 后删）

| NOTES 行 | 处理 |
|---|---|
| 2026-05-17 `eslint-plugin-local-rules` devDep 未用 | 下次依赖 bump 删，或 sprint 3 顺手 |
| 2026-05-17 Sprint 2 frontend-only IPC 不进 cli.gen.ts | ✅ 已 verified 设计正确，从 NOTES 删 |

### 8.2 Carry-forward 到 Sprint 4–7（保留在 NOTES，标 `[v1.5]` 或 sprint 号）

- light mode visual spot-check → Sprint 6 Settings toggle 落地后人眼跑
- `MAILAGENT_BIN` 环境变量提示 → Sprint 5 写命令真用时
- DevTools auto-open / console-message forward → Sprint 7 strip for production
- `notion_url` workspace prefix → Sprint 6 SettingsPage
- happy-dom `<embed>` quirk skip → 等 happy-dom 升级再 enable
- `BACKEND-INTERFACES.md §8 Sentiment` schema vs reality → Sprint 4 AI Chat 时一并 resolve
- `mapActionLabel` 出 `?` 时加 `console.warn` → Sprint 4 时顺手

### 8.3 升级到 gh issue（跨 session / 后端配合，参 `[[reference-mailagent-issue-tracking]]`）

```bash
gh issue create \
  --label "area:frontend,area:backend,kind:refactor,phase:v1.5" \
  --title "EmailGet_EmailRecord.cc_addr schema nullable widening" \
  --body "Sprint 2 DAO substitutes '' for null; if a callsite needs to distinguish 'no CC' from 'empty CC' the schema must widen. Source: frontend/NOTES.md 2026-05-17 #2."
```

---

## 9. 启动 checklist

```bash
# 1. 拉最新 main
cd ~/Documents/MailAgent && git pull

# 2. 依赖（postinstall 自动跑 gen:types）
cd frontend && pnpm install

# 3. 验证基线（应该全绿 — 0964059 commit 后实测过）
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm test       # 134 passed
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm lint       # 0 violation
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm typecheck  # 0 error

# 4. 起 dev server 验证 Inbox 还能正常渲染
pnpm dev
# → 看到 Inbox 三栏 + EmailRow 列表 + 详情页 = 基线 OK

# 5. 必读文档（按顺序，~30 min）
# - frontend/PROJECT-PLAN.md §2 Sprint 3                  (~10 min)
# - frontend/DESIGN.md §5 + §6 + §9.5                     (~10 min)
# - frontend/REVIEW-LOG.md §0 Summary + C-08 + H-01       (~5 min)
# - frontend/NOTES.md (~5 min, sprint 末再清)
# - CLAUDE.md "Phase 3 FTS5 全文搜索 § 中文搜索注意"     (~关键)
# - docs/cli-schema/email-search.schema.json              (~3 min)

# 6. 开 Sprint 3 分支
git checkout -b sprint3

# 7. 第一刀建议：先加 /search 路由 shell + 一个最简 SearchPage，跑通流程
```

---

## 10. 不要做的（红线清单）

- ❌ 不要在 `data/sync_store.db` 加表（后端 DB_VERSION=6 拥有，C-05 红线）
- ❌ 不要开始 Sprint 4 AI Chat panel 任何代码（独立 6-9 天，跨 Sprint 红线）
- ❌ 不要用 `codex:codex-rescue` agent（用 `omc ask codex` 或 `collaborating-with-codex` skill，`[[feedback-codex-collaboration-path]]`）
- ❌ 不要用 `autopilot`（前端要肉眼看视觉）
- ❌ 不要在 `text-micro` / `text-meta` 字面值写中文（lint error）
- ❌ 不要写 raw hex 在组件代码里（lint error）
- ❌ 不要让 API key 进 renderer bundle（C-04 安全红线）
- ❌ 不要 commit 让 `lint` / `typecheck` / `test` 任一 fail（CI 阀门）
- ❌ 不要发明新颜色 token（DESIGN.md §2 SoT，加新色要先改 DESIGN.md）

---

## 11. Cross-links（按重要度）

| 文档 | 章节 | 用途 |
|---|---|---|
| `PROJECT-PLAN.md` | §2 Sprint 3 | 任务源头 |
| `DESIGN.md` | §5 §6 §9.5 §14 §16 §17 | 视觉 / 交互 / 非协商 lint / i18n / 主题 |
| `ARCHITECTURE.md` | §2.2 §6 | 数据层抽象边界 + 后端契约 |
| `REVIEW-LOG.md` | C-04 C-05 C-08 H-01 H-03 | 翻译路径安全 / SQLite 边界 / light mode / a11y 12 组合 / Intl wrapper |
| `BACKEND-INTERFACES.md` | §4.3 §1.6 | search IPC handler 契约 + cli runner |
| `NOTES.md` | 全部 | 待办 + sprint 末清 |
| 后端 `CLAUDE.md` | "Phase 3 FTS5 全文搜索" | FTS5 中文搜索 quirk |
| `docs/cli-schema/email-search.schema.json` | 全部 | search 输出 SoT |
| memory `reference-mailagent-frontend-dev-collab` | 全部 | 工作模式 SoT |
| memory `reference-mailagent-issue-tracking` | 全部 | NOTES / gh issue 决策 SoT |
| memory `feedback-codex-collaboration-path` | 全部 | codex 调用红线 |

---

> Sprint 3 ship checklist 走完 → 这份 handoff 归档到 `frontend/archive/`，写 Sprint 4 handoff 时引用本文 §2.2（翻译 IPC 层经验）+ §5.3（renderer/main 边界）。

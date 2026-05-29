# feat/gsap-motion — 动效系统化 + 列表性能 + Bug 修复 Handoff

> 分支 `feat/gsap-motion` 的完整改动记录。两大块：**(A) GSAP 动效系统化升级**（按
> `ANIMATION-GSAP-HANDOFF.md` 计划落地，严守 DESIGN.md §8）+ **(B) dogfood 暴露的功能/性能
> Bug 修复**。21 个提交（基底 `b725d10` notion-agent 不属本分支工作，见末尾"合并注意"）。

## A. GSAP 动效系统（Phase 0–4）

严守 DESIGN.md §8：只用 `120/220/380ms` 三档时长 + 单一 `standard` 曲线
`cubic-bezier(0.4,0,0.2,1)`，禁 spring/bounce/parallax/scroll-jacking。目标不是加花活，
而是**补齐"进场有、退场硬切"的缺口**、统一 overlay 出入场、把生硬瞬切变成可中断淡入。

- **Phase 0 基础设施**（`src/shared/lib/gsap.ts`）：集中 `registerPlugin` + `CustomEase.create('standard',…)`
  + `DUR={fast:.12,base:.22,slow:.38}` + `gsap.defaults`。配套 hook：
  - `useReducedMotion()` — JS 层读 `prefers-reduced-motion`（GSAP 接管后 CSS @media 失效）。
  - `useExitAnimation(isOpen,opts)` — AnimatePresence-lite，延迟卸载播退场，reduce 时短路。
  - 测试：`tests/setup.ts` 全局强制 reduced-motion，让 GSAP 在 happy-dom 里 no-op。
- **Phase 1–3**：全局 overlay（CommandPalette/各 confirm/picker popover）、Email 核心区（compose
  overlay、手风琴滚动锚定 ScrollToPlugin、切邮件交叉淡入）、AIChatPanel/Sidebar 挤压 width tween、
  日历视图切换 fade+x:±16、BatchActionBar/Toast/UndoToast 退场、MessageList 新气泡、各 popover/tab
  indicator 等。虚拟列表（EmailList）铁律：**只 transform/autoAlpha，绝不动 height**。
- **Phase 4 文档**：`docs/motion-gsap.md`（落地规范）+ DESIGN.md §8 索引指针。

## B. Bug / 性能修复（dogfood 驱动）

| # | 问题 | 修复 | commit |
|---|---|---|---|
| 1 | AI Chat 输入框未固定底部（Lane C wrapper 回归） | InboxLayout/AIChatPanel wrapper 加 `flex min-h-0` | `069a203` |
| 2 | 搜索跳转到未加载邮件→列表把选中弹回第一封，打不开 | active-email 加 `navTargetId`，EmailList active-reset 豁免该 id | `e4bd444` |
| 3 | 切设置/日历再切回邮箱触发重加载 + 闪 loading | 邮件列表 query `staleTime 5min + gcTime 15min`（SSE invalidate 兜新鲜） | `e4bd444` |
| — | 线程补全**查询扇出**：每条可见线程一次 `listByThread`（800 行→几百次 IPC+SQLite 串在主进程，滚动/搜索跳转卡顿主因） | 新增 `email:listByThreads(ids[])` 批量端点（1 SQL `WHERE thread_id IN(...)`），渲染层 `useQueries`→单 `useQuery` | `0349a35` |
| — | 正文链接点击 → iframe 被导航成**空白页**（DOMPurify 剥 target，CSP `frame-src 'self'` 把外链拦成空白） | 渲染层在 iframe 内拦 `<a>` 点击（导航前 preventDefault）→ `shell:openExternal`；主进程 `will-frame-navigate` 兜底 | `02a18ae` `10573f1` |
| — | 存档/草稿箱列表/详情切回重载 | folder query `staleTime 5min + gcTime 15min`（`folder.synced` SSE invalidate） | `a981c20` |
| — | **启动/滚动/archive 冻结 5-7s**：`listEnriched` 用 `substr(body_markdown,1,100)` 取 snippet，读 `email_body` 大表(531MB) blob，800 行冷读 1.5s × 5+ 条并发，堵死同步主进程 | snippet **懒加载**：listEnriched 改 `(b.internal_id IS NOT NULL) AS has_body`（不读 blob，~130ms），新增 `email:listSnippets(ids)` 只为可见行取（~12ms）；行高用 has_body（防 snippet 到达后跳变） | `dde475d` |
| — | 正文加载/列表 loading 体感 | 正文加载骨架屏 + 列表骨架/渐进式加载补全（不采用 canvas loader，§8 护栏） | `c3edbdf` `f5ecebd` |
| — | StatusBar 每路由各订阅 updater/island 事件 → ipcRenderer listener 累积（MaxListenersExceededWarning） | 订阅收敛到 **App 根单次**，StatusBar 只读 store | `0cee60a` |

### 性能数据（真实 1.1GB 库实测）
| 查询 | 改前 | 改后 |
|---|---|---|
| `listEnriched` 800 行 | 1536ms（读 body blob） | ~130ms（只判 has_body） |
| 列表 snippet | 全量随列表读 | 仅可见 ~15-40 行懒取 ~12ms |
| 线程补全 | 几百次 IPC 扇出 | 1 次批量 |

## 新增 IPC 契约
- `email:listByThreads(threadIds[]) → Record<thread_id, EmailMeta[]>`（批量线程补全）
- `email:listSnippets(internalIds[]) → Record<internal_id, snippet>`（可见行 snippet 懒取）
- `shell:openExternal(url)`（scheme 白名单 http(s)/mailto/tel/callto/sms）
- `EnrichedEmailMeta` 加 `has_body: boolean`；`snippet` 现为 null（懒填）。

## 遗留 / 后续
- **NOTES.md**：ResizeObserver 残留良性警告（react-window 内部）；srcdoc 脚本拦截=预期安全行为。
- **GitHub issue**：#12 后端 snippet 去规范化（懒取的终极替代）· #13 bundle 代码分包(4.3MB) · #14 email:body 大正文冷读(~2.4s)。

## 合并注意 ⚠️
本分支基底含 `b725d10 fix(chat): 接通 Notion Agent CLI 对接…`，**不属本分支工作**，但在 `main..feat/gsap-motion`
范围内（main 落后于它）。合入 main 前需确认 b725d10 是否一并进 main（若否，需把 GSAP/perf 提交 rebase 到
干净的 main 上）。

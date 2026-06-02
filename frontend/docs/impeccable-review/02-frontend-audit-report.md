# MailAgent Frontend 实测审查报告 — Phase 2 (impeccable audit + critique)

> 9 域 × (review → adversarial verify)，18 个 opus 4.8 max-effort 只读 agent，240 万 token，660 工具调用，17 分钟。
> 数据源：[findings.json](./findings.json)（76 条全量）· live 截图见同目录 · 基准 = [01-design-system-review.md](./01-design-system-review.md) 的 V2 rubric。
> 日期 2026-06-01 · 评估者 Claude (Opus 4.8) · 主理人编排

---

## 0. 总览

| 指标 | 值 |
|---|---|
| 总 findings | 76（**65 confirmed + 10 downgraded + 1 rejected**） |
| 严重度（排除 rejected） | **P0 × 2 · P1 × 22 · P2 × 25 · P3 × 26** |
| verify 把关 | 1 条被证伪（ADMIN-DASHBOARD-09，cargo-cult 误判，grep 反驳） |

**9 域评分（0-4，review 阶段）**

| 域 | a11y | perf | theme | **resp** | anti-slop | nielsen |
|---|---|---|---|---|---|---|
| email | 2 | 4 | 3 | **1** | 4 | 3 |
| ai-chat | 2 | 3 | 3 | **1** | 4 | 3 |
| settings | 2 | 3 | 2 | **1** | 3 | 3 |
| layout-chrome | 2 | 3 | 3 | **1** | 4 | 3 |
| calendar | 2 | 3 | 2 | **1** | 3 | 3 |
| folder | 2 | 3 | 3 | **1** | 4 | 3 |
| admin-dashboard | **1** | 3 | 2 | 2 | 3 | 3 |
| ui-primitives | 2 | 3 | 3 | 2 | 4 | 3 |
| responsive-xcut | 2 | 3 | 3 | **0** | 3 | 2 |

读法：**perf/anti-slop 普遍 3-4（强）**，**responsive 全域 0-1（系统性塌陷）**，a11y 普遍卡在 2（focus ring 缺失拉低，admin 最差）。

---

## 1. Anti-Pattern Verdict（impeccable 必答，9 域汇总）

**零 AI slop。9 域一致判定 designer-grade。** 无 AI 色板、无 gradient text、无 hero-metric/card-grid 堆砌、无 generic font。反-slop 免疫由 9 条 design lint + a11y CI 固化。**问题不在"丑"或"像 AI 做的"，而在系统性的 a11y / 响应式 gap 与 lint 兜不住的漏网路径。**

---

## 2. 五大系统性主题（76 条的根因收敛 —— 修复也按这 5 条系统做，而非逐条 patch）

### 2.1 🔴 响应式真空 — 2 P0 + 7 P1 + 3 P2（最大、最系统）
resp 评分全域 0-1。web 远程入口（mail.chenge.ink/app）**已上线却整体 break**：固定三栏 + 0 CSS 断点 + 75 处固定 px + 侧栏不自动 collapse + StatusBar 重叠 + AI panel 死列 + 无 overflow-x 护栏 + touch target<44。**根因**：DESIGN.md 无响应式章节（RESPONSIVE-XCUT-08），实现层从未建断点系统。**这是独立 mini-sprint，不是几行 patch。**

### 2.2 🟠 focus ring / 键盘 a11y — 4 P1 + 4 P2/P3（违反产品自定 non-negotiable）
DESIGN.md §9.2/§10 白纸黑字「visible focus ring is non-negotiable」，但 EmailRow / AI 面板 ~50 button / admin 控件 / folder row 全无 `:focus-visible`，且全局 `ring-coral/40` 对比仅 ~2.18:1（<3:1，coral 按钮上近乎隐形）。**高杠杆**：多条 recommendation 都指向同一解 —— index.css 加一处 `@layer base` 的 `:where(button,[role=button],a,input,select):focus-visible` 全局兜底，**一改覆盖多域**。

### 2.3 🟠 i18n 硬编码 — 4 P1 + 5 P2/P3（违反 §16.7 硬约束，且无 lint 兜底）
§16.7「任何 JSX 硬编码字符串 = review 拒绝（含 aria-label/title/placeholder）」是 Sprint 0 起强制项，但 EmailRow（零 i18n）/ Settings EnvField / Folder / Calendar / TitleBar 大量硬编码中英文串。**根因**：9 条 lint 全是颜色/圆角类，**无一条扫 JSX 字面量/aria-label** → 硬约束无机器兜底。含 **CALENDAR-03**：空状态把后端 env 名 `CALENDAR_CALDAV_SYNC_ENABLED` 暴露给终端用户（3 处）。

### 2.4 🟠 对比度 / token 漏网 — 3 P1 + 多 P2/P3（authored CSS + inline 绕过 token）
硬编码 `text-white`/`#fff`/`bg-white` 在 accent 背景上实测 AA/1.4.11 FAIL：ConfirmDialog 2.38:1、Switch/Slider 滑块 1.66-2.51:1、Calendar CTA 白字 on slate/olive accent。**根因**：`no-raw-hex` lint 对 `.css` 文件**全量豁免**（原意只为 `:root` 变量种子），导致 authored CSS selector 里的裸 hex（EmailRow 优先级色、calendar errpulse、avatar 板）全部漏网，且绕过 `a11y:contrast` 的 12 组合 per-mode 验证。解 = 复用已就绪的 `--c-accent-fg`/`--c-*` token + 收紧 lint 的 .css 豁免。

### 2.5 🟡 touch target / 杂项 — 多 P2/P3
交互图标普遍 22-30px（<44px touch）；Radix 动画无 `prefers-reduced-motion` 门控；图表/skeleton 无 ARIA；Tooltip 死代码；`.tile`/`.settings tile` 等 class 在生产 CSS 未定义（裸框）。

---

## 3. 完整 P0 / P1 清单（24 条，按主题；⚠️ = 撞你正在改的 WIP 文件）

> WIP 文件（你 18:38-19:25 并行在改）：`index.css · StatusBar · GeneralTab · SyncTab · EmailBodyFrame · Sidebar · appearance · env-keys`

### A. 响应式（2 P0 + 7 P1）— 建议作为独立批次
| id | sev | 文件 | 修复要点 | WIP |
|---|---|---|---|---|
| RESPONSIVE-XCUT-01 | **P0** | InboxLayout/FolderLayout/PageFrame | 断点降级矩阵（Tailwind 默认 screens 已可用，无 override） | |
| LAYOUT-CHROME-01 | **P0** | Sidebar/TitleBar/StatusBar | chrome 三件套窄屏降级 | ⚠️×2 |
| EMAIL-02 | P1 | EmailList.tsx:1153 | `lg:w-[340px] w-full` + detail <lg overlay | |
| SETTINGS-04 | P1 | settings shell | rail 转顶部 tab + content 流式 | ⚠️ |
| CALENDAR-02 | P1 | calendar 各 view | 周→单日 timeline / month→agenda / drawer→bottom-sheet | |
| FOLDER-03 | P1 | FolderList | 随全局响应式统一解 | |
| RESPONSIVE-XCUT-02 | P1 | nav-shell/Sidebar | matchMedia <lg 自动 collapse（折叠机制已存在） | ⚠️ |
| RESPONSIVE-XCUT-03 | P1 | StatusBar | <md 砍到 2-3 段，禁横向滚动 | ⚠️ |
| RESPONSIVE-XCUT-05 | P1 | AIChatPanel | <xl 转 off-canvas drawer（复用 .drawer） | |
| RESPONSIVE-XCUT-04 | P1 | .ricon 等 | `@media(pointer:coarse)` 扩 44px hit-area | |
| RESPONSIVE-XCUT-06 | P1 | #root | `overflow-x:hidden` 护栏 | |

### B. focus ring / 键盘 a11y（4 P1）— 高杠杆，建议优先
| id | sev | 文件 | 修复要点 | WIP |
|---|---|---|---|---|
| AI-CHAT-01 | P1 | ai/chat 全域 button | 抽共享 focus recipe（cn 或 @layer base 全局兜底） | |
| ADMIN-DASHBOARD-04 | P1 | admin 控件 | 同上，@layer base 兜底一并覆盖 | |
| UI-PRIMITIVES-02 | P1 | 全域 ring recipe | `ring-coral/40`→实心 `ring-coral` + `ring-offset-2 ring-offset-ink-1`（夹层提对比） | |
| EMAIL-01 | P1 | index.css .email-row | `.email-row:focus-visible{outline:2px solid rgb(var(--c-accent));outline-offset:-2px}` | ⚠️ |

### C. 对比度 / token（3 P1）— 小改高价值，多数不撞 WIP
| id | sev | 文件 | 修复要点 | WIP |
|---|---|---|---|---|
| UI-PRIMITIVES-01 | P1 | ui/switch.tsx:41, slider.tsx:30 | `bg-white`→`bg-accent-fg`（复用 --c-accent-fg） | |
| AI-CHAT-02 | P1 | ConfirmToolDialog | `text-white`→`text-accent-fg` + `hover:bg-coral-hover` | |
| CALENDAR-01 | P1 | calendar CTA/徽章 | `#fff`→`rgb(var(--c-accent-fg))` + 收紧 no-raw-hex .css 豁免 | |

### D. i18n / token drift（4 P1）
| id | sev | 文件 | 修复要点 | WIP |
|---|---|---|---|---|
| ADMIN-DASHBOARD-01 | P1 | admin H1 | `text-display`(未定义→回退 body，H1<H2 倒挂)→`text-subj` | |
| CALENDAR-03 | P1 | calendar 空态 | env 名 → 用户向 i18n 文案，env 移运维 | |
| EMAIL-03 | P1 | EmailRow + AttachmentList | 串 i18next（保留 `Attachments·N` 英文 header §3.3） | |
| SETTINGS-03 | P1 | EnvField/EnvSecretField | 7 处 → t()，zh+en 双填 | ⚠️ |

### E. 键盘语义（1 P1）
| id | sev | 文件 | 修复要点 | WIP |
|---|---|---|---|---|
| SETTINGS-02 | P1 | settings radiogroup×5 | 弃用裸 button，改现成 ui/radio-group.tsx（拿回 roving tabindex+方向键） | ⚠️ |

---

## 4. P2 / P3 索引（51 条）

完整详情在 [findings.json](./findings.json)。延续同 5 主题：focus ring（FOLDER-02/LAYOUT-CHROME-02/CALENDAR-05）· i18n（ADMIN-02/03/AI-CHAT-06/CALENDAR-06/LAYOUT-CHROME-03）· token 漏网 hex（EMAIL-05/CALENDAR-04/08/AI-CHAT-08/ADMIN-06 cyan-400/SETTINGS-07/08）· touch 44px（FOLDER-04/SETTINGS-06）· ARIA（AI-CHAT-03 无焦点陷阱/04/05 角色错配/图表与 skeleton 静默）· reduced-motion（UI-PRIMITIVES-03/AI-CHAT-10）· 未定义 class（SETTINGS-01 `.tile` 裸框）· 死代码（UI-PRIMITIVES-05 Tooltip）。

---

## 5. 各域亮点（celebrate — 守住 + 向新域复制）
- **email/folder/layout/ai-chat（anti-slop 4）**：单行密度、mono token meta、几何 SSoT、注释带真实推导
- **perf 普遍 3-4**：react-window 虚拟列表、snippet 懒取、查询缓存（frontend/ARCHITECTURE §7）
- **ui-primitives**：shadcn 扩展每个 primitive token 绑定干净，是其他域地基
- **verify 阶段真实把关**：ADMIN-09 cargo-cult 指控被 grep 证伪 → rejected

---

## 6. 根因与系统建议（修 3 条 lint 比修 76 条 patch 更治本）
4 类 a11y/i18n/对比度问题的共同根因 = **lint 把住了「颜色/圆角/阴影」，但没把住「a11y/i18n/authored-CSS 漏网」**。建议补：
1. **`no-missing-focus-visible`**：扫 `role=button`/`tabIndex=0`/裸 `<button>` 是否有对应 `:focus-visible`/ring
2. **`no-hardcoded-jsx-string`**：扫 JSX 文本 + `aria-label`/`title`/`placeholder` 硬编码（落地 §16.7）
3. **收紧 `no-raw-hex` 的 `.css` 豁免**：从全量豁免改为「仅 `:root` 选择器内允许裸三元组」，堵 authored CSS selector 漏网
4. **`a11y:contrast` 扩展**：加 non-text 对比（switch/slider 滑块 vs track，§1.4.11）+ 扫 authored CSS

---

## 7. Phase 3 实施建议（分批 + WIP 协调）

24 条 P0/P1 不宜一次性闷头改 —— 响应式是工程量大的 mini-sprint，且 **8 个相关文件正被你并行开发**（改会冲突/覆盖 WIP）。建议分批：

- **批 1 · 快赢（低风险 / 高 a11y 价值 / 基本不撞 WIP）**：C 对比度（UI-PRIMITIVES-01 / AI-CHAT-02 / CALENDAR-01）+ ADMIN-01 H1 + CALENDAR-03 env leak + B 的 UI-PRIMITIVES-02 ring recipe。**约 6 条，多是换 token/一行改，不碰 WIP 文件。**
- **批 2 · focus ring 系统化**：@layer base 全局兜底（覆盖 AI-CHAT-01 / ADMIN-04 / EMAIL-01 等）—— 但落点 index.css 是 WIP，需先协调。
- **批 3 · 响应式 mini-sprint**：先按 V2 §4.1 在 DESIGN.md 补 §18 断点系统，再逐布局降级。撞 StatusBar/Settings/Sidebar WIP，工程量最大。
- **批 4 · i18n + radiogroup**：撞 Settings/Email WIP，宜等 WIP 落定。

**WIP 冲突是当前最大约束** —— 需与主理人确认：等你 commit/stash WIP？还是指定哪些文件本轮别碰？

---

## 附. 已修 + 过程发现
- ✅ **batch bar 侧栏错位**（nav-shell.ts，`--app-nav-w` 同步）— 已修 + live 验证（240↔56，bar left 256→72px 对齐）
- 🔎 **F-WEB-404**：serve-api SPA 深链/刷新 → FastAPI 404 JSON（history fallback 缺失，web 入口刷新即白屏）
- 🔎 **F-WEB-ATTACH**：web 态邮件正文内联附件图片全 404（`/app/attachments/.../imageNNN.png`）
- 🔎 **F-PWA-META**：`apple-mobile-web-app-capable` deprecated
> 这 3 个 F-WEB-* 属 serve-api 后端（src/api/app.py），非 frontend 组件，单列。

# 批 E · 响应式系统实施蓝图（独立 PR 施工图）

> impeccable Phase 3 的响应式大块（2 P0 + 9 P1 = 11 findings）从主 session 拆出，作为独立 focused PR。
> 原因：~10 个布局组件重构 + 逐断点 live 验证，极易引入桌面布局回归，需专注 + 充分测试。
> 本文是施工图：断点系统 + 逐组件精确降级 + 验证清单。逐 finding 的 evidence/impact 见 [02-frontend-audit-report.md](./02-frontend-audit-report.md) §3.A + [findings.json](./findings.json)。

---

## 0. 范围（11 findings）

| id | sev | 组件 | 一句话 |
|---|---|---|---|
| RESPONSIVE-XCUT-01 | **P0** | InboxLayout/FolderLayout/PageFrame | shell 全固定宽度、零断点，<940px 彻底 break |
| LAYOUT-CHROME-01 | **P0** | Sidebar/TitleBar/StatusBar | chrome 三件套窄屏不降级 |
| EMAIL-02 | P1 | EmailList | `w-[340px] shrink-0` 固定列表宽 |
| RESPONSIVE-XCUT-02 | P1 | nav-shell/Sidebar | <lg 不自动 collapse/抽屉化 |
| RESPONSIVE-XCUT-03 | P1 | StatusBar | <md 6 段挤压重叠 |
| RESPONSIVE-XCUT-04 | P1 | .ricon 等 | touch target 22-30px < 44 |
| RESPONSIVE-XCUT-05 | P1 | AIChatPanel | 360px 死列，无移动 drawer |
| RESPONSIVE-XCUT-06 | P1 | #root | 无 overflow-x 护栏 |
| SETTINGS-04 | P1 | SettingsLayout | 200px rail + 760px content 无断点 |
| CALENDAR-02 | P1 | CalendarLayout/views | 7 列 grid + 250 rail + 420 drawer 全固定 |
| FOLDER-03 | P1 | FolderLayout/FolderList | 固定 340 列表 + 三栏并置 |

---

## 1. §18 断点系统（加入 DESIGN.md，作为 V2 §4.1 落地）

Tailwind 默认 screens 已可用（`tailwind.config.ts` 经核实**无 override**）：`sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536`。无需新增配置，直接用前缀。

**全局布局降级矩阵**（所有 shell 遵守）：

| 视口 | 侧栏 | 列表 | 详情 | AI panel |
|---|---|---|---|---|
| ≥xl (1280) | 240px 展开 | 340px | flex-1 | 360px 挤压列（现状） |
| lg–xl (1024-1280) | 240 或 collapse | 340px | flex-1 | **drawer overlay**（不挤压） |
| md–lg (768-1024) | **auto-collapse 56px** | 340px | flex-1 | drawer |
| <md (768) | **off-canvas 抽屉** | 全宽 OR 详情（选中切换） | 覆盖列表 | drawer(92vw) |

核心原则：≥xl 维持现有桌面三栏不动（零回归）；降级只在断点**新增** `lg:`/`md:` 前缀触发，不改桌面默认值。

---

## 2. 逐组件施工

### 2.1 InboxLayout.tsx（P0 RESPONSIVE-XCUT-01）— 核心
现状（已读）：`<div flex flex-1><Sidebar/><EmailList/><EmailDetail/><AIPanel wrapper/></div>`，全固定。
施工：
- 引 `useMediaQuery` hook（或 CSS 断点）判断当前档位。
- EmailDetail 在 <md：绝对定位覆盖 EmailList（`activeId` 存在时显示，带返回按钮回列表）。`md:relative md:flex-1` / `<md: fixed inset-0 z-?`。
- AIPanel wrapper 的 width-tween 挤压逻辑（useGSAP line 63-86）**仅 ≥xl 启用**；<xl 改走 drawer（见 2.8）。用 `useMediaQuery('(min-width:1280px)')` 门控 `aiPanelVisible` 的挤压 vs drawer 分支。
- 风险：AIPanel 的 mountedOnce + width-tween 与 drawer 模式切换要协调（drawer 用 fixed + transform，不是 width）。

### 2.2 FolderLayout.tsx（P1 FOLDER-03）
同 InboxLayout 套路（FolderList + FolderDetail 三栏）。复用同一 `useResponsiveShell` 逻辑。

### 2.3 Sidebar.tsx（P0 LAYOUT-CHROME-01 + P1 RESPONSIVE-XCUT-02）
现状：240px / `data-collapsed` 56px（折叠机制已存在，见 index.css `.app-nav`）。
施工：
- 加 `matchMedia('(max-width:1023px)')` 监听 → 进 <lg 自动 `setCollapsed(true)`（**保留用户手动 override 优先级**：记一个 `userToggled` flag，手动切过就不自动）。
- <md：渲染为 off-canvas 抽屉（复用 index.css `.drawer` + `.drawer-backdrop`，line ~2786）+ 汉堡按钮（放 TitleBar）。
- 注意：`--app-nav-w`（我已修的 nav-shell 同步）在 <md drawer 模式应设 0（列表占满）。

### 2.4 StatusBar.tsx（P0 LAYOUT-CHROME-01 + P1 RESPONSIVE-XCUT-03）
现状：6 段 mono。<md 挤压重叠 + 版本段裁切。
施工：按断点隐藏次要段——`<md` 只留 同步点 + 远程点（2 段）；`md-lg` 留 同步/远程/邮箱/主题（4 段）；`≥lg` 全 6 段。次要段 `hidden md:flex` / `hidden lg:flex`。保 24px 高度契约（`h-statusbar`），禁横向滚动。

### 2.5 TitleBar.tsx（P0 LAYOUT-CHROME-01 + P2 RESPONSIVE-XCUT-07）
现状：中部 ⌘K + 右簇 picker（Coral/毛玻璃/跟随系统/中文）。<md 竖排折行（截图实锤）。
施工：右簇加 `min-w-0`；<md 把 accent/surface/theme/locale picker 收进一个「⋯」溢出菜单；中部 search 退化纯图标（`md:` 显示文字）。<md 左侧加 Sidebar 汉堡按钮。

### 2.6 EmailList.tsx:1153（P1 EMAIL-02）
现状：`w-[340px] shrink-0`。
施工：`w-full lg:w-[340px] lg:shrink-0`。<lg 列表占满（详情走覆盖/抽屉）。react-window 的固定 itemSize 不受宽度影响，但列内元素（avatar/chip）已是 flex，安全。

### 2.7 EmailDetail.tsx（P1 EMAIL-02 配套）
<lg：`fixed inset-0 z-40 md:relative`，选中邮件时滑入覆盖列表，顶部加返回按钮（清 activeId 回列表）。≥lg 维持 flex-1 现状。

### 2.8 AIChatPanel（P1 RESPONSIVE-XCUT-05）
现状：360px 挤压列（InboxLayout width-tween）。
施工：<xl 改 off-canvas drawer（复用 index.css `.drawer`，`max-width:92vw` 天然适配 390）+ backdrop。InboxLayout 的 width-tween 挤压仅 ≥xl（见 2.1）。注意与 ChatSidebar(140px) 的二级挤压协调——drawer 模式下 ChatSidebar 也应可折叠。

### 2.9 CalendarLayout + views（P1 CALENDAR-02）
现状：week 7 列 grid + day-rail 250px + drawer 420px（index.css `.day-rail`/`.mm-grid`/`.m-grid` 全固定）。
施工：<lg 折叠 day-rail（mini-month 收起）；week 视图 <md 降为单日 timeline；month <md 退化 agenda-list；事件 drawer <md 转 bottom-sheet（`fixed bottom-0 inset-x-0 max-h-[80vh]`）。

### 2.10 SettingsLayout（P1 SETTINGS-04）
现状：200px rail + 760px content，flex 无断点。
施工：<lg rail 转顶部水平 tab 条（或抽屉）；content `max-w-[min(760px,100%-2rem)]` 流式；EnvField 的 `w-[260px]` 等 → `w-full sm:w-[260px]`；Row 在 <sm `flex-col`（control 落 label 下）。

---

## 3. 横切（P1 RESPONSIVE-XCUT-04 + 06）

- **overflow-x 护栏**（06）：`#root` 或 shell 最外层加 `overflow-x-hidden`（只防溢出，不替代降级）。保留 `.mail-body` 自身滚动容器不被根级 hidden 误伤。
- **touch target 44px**（04）：`@media (pointer:coarse)` 下把 `.ricon`(22)/删除(26)/侧栏 chevron/titlebar picker 的命中区扩到 44×44——视觉 icon 保持原尺寸，用透明 padding 或 `::before` 扩 hit-area（不改密度）。抽一个 `.hit-44` utility。行操作在 coarse-pointer 常驻可见（不依赖 :hover，配合 EMAIL-08 P3）。

---

## 4. 实施顺序（建议）

1. 加 `useMediaQuery`/`useResponsiveShell` hook + overflow-x 护栏（基础设施）
2. **P0**：InboxLayout shell 降级 → live 验证 390/768/1024/1440 → Sidebar auto-collapse/drawer → StatusBar/TitleBar 降级
3. FolderLayout（复用 InboxLayout 逻辑）
4. EmailList/EmailDetail 配套
5. AIChatPanel drawer（最 tricky——与 width-tween 协调）
6. CalendarLayout / SettingsLayout
7. touch 44 横切
8. 全断点 live 回归

## 5. 逐断点验证清单（每个组件改完都跑）

| 断点 | 必验 |
|---|---|
| 1440 (xl) | 三栏全开，与当前桌面**像素级一致**（零回归是硬指标）|
| 1024 (lg) | 侧栏 collapse / AI panel drawer，无横向滚动 |
| 768 (md) | 单栏+详情覆盖，侧栏抽屉，StatusBar 砍段 |
| 390 (mobile) | 列表全宽、详情覆盖、TitleBar 不折行、StatusBar≤2 段、无横向滚动、touch≥44 |

live：dev serve-api :8201 + Playwright resize 各档 + 截图比对。axe 跑各断点。

## 6. 风险与注意

- **零桌面回归是第一硬指标**：所有降级用 `lg:`/`md:` 前缀新增，桌面默认值（≥xl）一律不动。改完先验 1440 与当前 [live-inbox-01.png](./live-inbox-01.png) 像素比对。
- **AIChatPanel width-tween ↔ drawer 切换**最易出 bug（GSAP width 动画 vs fixed transform）。建议 useMediaQuery 硬门控两套互斥逻辑，别试图统一。
- **react-window 虚拟列表**（EmailList）：宽度变化触发重算，确认 itemSize/overscan 在窄屏正常。
- **GSAP reduced-motion**：drawer 进出场要走 `useReducedMotion`（与现有 §8 motion 一致）。
- **nav-shell `--app-nav-w`**（已修）：<md drawer 模式下应设 0，让 batch bar / 列表占满。
- 关联未实施的 P2：RESPONSIVE-XCUT-08（DESIGN.md 补 §18，本文即草案）+ 09（SettingsRail/Calendar 副 statusbar 副面板同款硬宽）。

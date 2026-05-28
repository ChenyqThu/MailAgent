# 前端动效系统化升级 · GSAP 引入 Handoff

> **状态**：调研完成，待执行。本文件由动效调研 session 产出，供**新 session 以 ultrawork + workflow 模式完整执行**。
> **范围**：`frontend/`（Electron + React 19 renderer）。**不含灵动岛**——灵动岛动画归属独立项目 `ping-island`（SwiftUI native binary，本 repo renderer 侧零 island UI 代码，仅 `electron/main/island/` 的 socket 通信 + settings 里的纯配置表单）。
> **调研依据**：DESIGN.md §7/§8/§9、`tailwind.config.ts`、`index.css`（4226 行）、229 个 `.tsx` 全量子系统盘点、GSAP 官方 skill（gsap-core / gsap-react / gsap-plugins）。

---

## 0. 怎么用这份文档

1. **先读 §1.2（§8 红线）和 §4（技术裁决）**——这两节决定"什么能做、什么坚决不做"。在 ultrawork 模式下，模型容易把所有"缺口"都补上动画，导致 over-animated，违背本项目"This is a tool"的克制哲学。§1.2 + §4 + §5.0 的「不做清单」是防止这件事的护栏。
2. **执行顺序见 §6**：Phase 0（基础设施）必须最先完成并验证，它是后续一切的前置依赖。Phase 1/2/3 可并行 fan-out。
3. **每个机会点都带 `file:line`**（§5 + 附录），可直接定位。
4. **执行时按需加载 GSAP skill**：`gsap-react`（useGSAP/cleanup）、`gsap-core`（tween/ease/matchMedia/autoAlpha）、`gsap-plugins`（Flip/CustomEase/ScrollToPlugin）。**不要**加载 gsap-scrolltrigger——本项目 §8 禁止 scroll-jacking/parallax，ScrollTrigger 基本用不到。

---

## 1. 背景与现状

### 1.1 技术栈

- Electron + **React 19** + TypeScript + **Tailwind CSS 3.4** + **Radix UI** + TanStack Router/Query + Zustand + TipTap。
- 构建：electron-vite（纯 CSR，**无 SSR**——useGSAP/useLayoutEffect 无 SSR 警告顾虑）。
- **当前动画栈**：① Tailwind `transition`/`duration-*` 工具类；② `animate-*`（`animate-pulse`/`animate-spin`）；③ `tailwindcss-animate` 插件（Radix `data-[state]` 的 `animate-in`/`animate-out`）；④ `index.css` 里 9 个 `@keyframes`；⑤ 少量 JS 直接操作 `el.style`（Toast、UndoToast 进度条 rAF）。
- **当前没有 GSAP，也没有 framer-motion**（grep 命中的 "motion" 全是 `prefers-reduced-motion` 注释）。
- 分布：52 个文件用 `transition`、45 个用 `duration-*`、32 个用 `animate-*`。

### 1.2 设计约束 —— §8 红线（必读，违反即返工）

来自 `DESIGN.md` §8 Motion system + §9 Interaction patterns：

| 红线 | 内容 |
|---|---|
| **Three durations** | 只用 `120ms`(fast) / `220ms`(base) / `380ms`(slow)。**不要发明第四个时长。** |
| **One curve** | 唯一曲线 `cubic-bezier(0.4, 0, 0.2, 1)`（Material standard）。 |
| **明令禁止** | spring、bounce、elastic、confetti、particle、**parallax**、**scroll-jacking**。"This is a tool." |
| **允许的额外项** | critical 状态 1.6s pulse loop（无闪光）、skeleton `animate-pulse`、loading `animate-spin`、流式文本光标 `▎` blink(1s steps(2))。 |
| **交互模式** | hover 一律有态；focus 一律有可见 ring（`ring-2 ring-coral/40`）；active 用 `active:scale-[0.98]`（仅 primary CTA）；disabled 用 `opacity-50` + `coral-dim`，**不用 opacity dip 表达 pressed**。 |

> GSAP 在本项目的定位 = **「在克制约束内把该有的动画做对」**，不是加更多花活。绝大多数收益来自：① 补齐**退场动画**（现状大量"进场有、退场硬切"）；② 统一**overlay 出入场**；③ 把**生硬瞬切**（视图切换、面板替换）变成 ≤220ms 的淡入；④ 用 timeline **编排多元素序列**；⑤ 用 Flip 做**布局/indicator 滑动**；⑥ 用 GSAP 的**可中断 tween**（快速切邮件时打断上一个动画）。

### 1.3 ⚠️ 发现：现状已偏离 §8 "one curve"（需裁决）

调研发现项目里**已经存在第二条曲线**：以下自定义动画用了 `cubic-bezier(0.32, 0.72, 0, 1)`（一条 ease-out 更强的"iOS 抽屉感"曲线），而非 §8 规定的 `cubic-bezier(0.4, 0, 0.2, 1)`：

- `.drawer`（EventDetailDrawer，`index.css:2767`，260ms）
- `.efm-modal`（EventFormModal，`index.css:3187`，200ms）
- `.undo-toast` / `cal-toastin`（`index.css:3548`，260ms）
- `.folder-modal-rise`（`index.css:4088`，200ms）
- `.batch-bar`（BatchActionBar，`index.css:1232`，260ms）
- `.app-nav`（Sidebar 宽度，`index.css:914`，260ms）

外加 `body::before` 主题切换用了 standard 曲线但 **320ms**（第四个时长，`index.css:667`）。

**裁决项（交给用户/设计）**：引入 GSAP 是统一收口的机会，二选一：
- **(A) 严格回归 §8**：全部对齐到 standard 曲线 + 三档时长（260→220，320→380 或 220）。
- **(B) 正式承认第二曲线**：把 `cubic-bezier(0.32,0.72,0,1)` 写入 §8 作为"大位移/抽屉/工具条专用"曲线，small UI 仍用 standard。

> 在 Phase 0 把两条曲线都做成 `CustomEase`（`standard` + 可选 `drawer`），具体哪些元素用哪条，等裁决。**默认倾向 (A)**——单一曲线更符合 §8 字面精神，且 standard 与 0.32,0.72,0,1 观感差异在 200ms 短动画上很小。

### 1.4 现有 `@keyframes` 清单（哪些保留 CSS、哪些迁 GSAP）

| keyframe | `index.css` | 用途 | 处置 |
|---|---|---|---|
| `pulse-dot` | L603 | 新邮件 pill / AI tool-row 活跃点（无限循环） | **保留 CSS**（ambient loop，无需 JS） |
| `blink` | L1934 | AI chat 流式光标 | **保留 CSS**（§8 明确允许） |
| `cal-shimmer` | L2967 | 抽屉内 skeleton shimmer | **保留 CSS** |
| `errpulse` | L3114 | sync 错误脉冲（1.6s） | **保留 CSS**（属 §8 允许的 critical pulse） |
| `pulse-crit` | tailwind.config | critical 优先级脉冲 | **保留**（§8 允许） |
| `folder-skel` | L4053 | folder skeleton shimmer | **保留 CSS** |
| `cal-toastin` / `cal-toastout` | L3552/3556 | UndoToast 进出场 | **迁 GSAP**（解决 `.out` class 与 unmount 竞态，见 §5.5） |
| `folder-modal-fade` / `folder-modal-rise` | L4090/4095 | folder 模态进场 | **进场可保留 / 退场迁 GSAP**（统一退场，见 §5.1） |

---

## 2. 为什么 GSAP、边界、安装

### 2.1 GSAP 该用在哪（CSS 做不好的）

- **退场动画 + 延迟卸载**：React 条件渲染 `{open && ...}` 卸载是同步的，CSS 没机会播退场。GSAP `onComplete` 后再 unmount 是标准解法。**这是本项目最大、最普遍的缺口。**
- **多元素序列编排**：timeline（如 DraftPreviewCard 的 card→header→footer stagger）。
- **布局/indicator 动画**：Flip（tab 滑动指示条、选中态游走）。
- **可中断 tween**：`overwrite:"auto"`（快速切邮件、切视图时打断上一个）。
- **JS 计算值驱动**：进度条、滚动位置 tween。

### 2.2 GSAP 不该用在哪（保持现状）

- **Radix 托管的组件**（`ui/dialog.tsx`、`ui/select.tsx`、`ui/tooltip.tsx`、`ui/switch.tsx`、`ui/slider.tsx`、`ui/radio-group.tsx`、`ui/tabs.tsx` 的 content）：已用 `tailwindcss-animate` 的 `data-[state]:animate-in/out`，**双向生命周期完整，不要叠加 GSAP**（会冲突）。
- **ambient 无限循环**（pulse/shimmer/spin/blink）：CSS 更省，保留。
- **纯 hover/focus 颜色过渡**：`transition-colors duration-fast` 已足够，不要换 GSAP。

### 2.3 安装 + 兼容性（已核实）

```bash
pnpm add gsap @gsap/react
# gsap@^3.13  @gsap/react@^2.1（支持 React 19）
```

- ✅ **所有 GSAP plugin 现已免费**（Webflow 收购后）。`pnpm add gsap` 即包含 Flip / CustomEase / ScrollToPlugin / SplitText 等全部。**绝对不要**生成带 GreenSock auth token 的 `.npmrc`、不要用 `npm.greensock.com` 私有源、不要让用户注册 Club GSAP——那些是过时文档的陷阱。
- ✅ **CSP 绿灯（已核实 `index.html:30`）**：`script-src 'self'`（GSAP 打包进 bundle = self，且 GSAP **不需要** `unsafe-eval`）；`style-src 'self' 'unsafe-inline'`（且 GSAP 经 JS DOM `.style` 操作本就不受 CSP style-src 约束）。**无需修改 CSP。**
- ✅ React 19 + electron-vite（CSR）：`useGSAP` 内部用 `useLayoutEffect`，无 SSR 警告。

---

## 3. Phase 0 — 基础设施层（最先做，是一切的前置）

新建 `src/shared/lib/gsap.ts`（或 `src/shared/animation/`），集中初始化。**所有后续动画都基于此层，禁止在各组件里散落 `registerPlugin` / 重复定义曲线。**

```ts
// src/shared/lib/gsap.ts
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { Flip } from 'gsap/Flip'
import { CustomEase } from 'gsap/CustomEase'
import { ScrollToPlugin } from 'gsap/ScrollToPlugin'

gsap.registerPlugin(useGSAP, Flip, CustomEase, ScrollToPlugin)

// §8 唯一曲线，精确复刻 cubic-bezier(0.4,0,0.2,1)（而非近似 power2.out）
CustomEase.create('standard', '0.4,0,0.2,1')
// （可选，待 §1.3 裁决）抽屉/大位移第二曲线：
// CustomEase.create('drawer', '0.32,0.72,0,1')

// §8 三档时长（秒）
export const DUR = { fast: 0.12, base: 0.22, slow: 0.38 } as const

// 项目级默认：锁死 one-curve + base 时长
gsap.defaults({ ease: 'standard', duration: DUR.base })

export { gsap, useGSAP, Flip }
```

**Phase 0 必交付物**：

1. **`gsap.ts` 初始化层**（上）：registerPlugin + standard CustomEase + `gsap.defaults` + `DUR` 常量导出。
2. **reduced-motion 全局策略**：§8 的 CSS `@media (prefers-reduced-motion: reduce)` 保护在 GSAP 接管这些元素后会失效，**必须在 JS 层补上**。两种写法，二选一并在全项目统一：
   - `gsap.matchMedia()` + `reduceMotion` condition（官方推荐，组件级）；
   - 或封装 `prefersReducedMotion()` helper + 所有 tween 用 `duration: reduce ? 0 : DUR.base`。
   - 建议提供一个 `useReducedMotion()` hook 或在 `useGSAP` 包装里统一短路。
3. **`useExitAnimation(ref, isOpen, opts)` hook**（**核心基础设施**，解决最普遍的"进场有/退场硬切"）：
   - 输入：目标 ref、`isOpen` 布尔；
   - 返回：`shouldRender`（`isOpen || 退场动画进行中`）；
   - 行为：`isOpen` true → 播进场；false → 播退场，`onComplete` 后置 `shouldRender=false` 真正卸载；
   - reduced-motion 时跳过动画直接切换；
   - 组件用 `{shouldRender && <Overlay ref={ref}/>}` 替换原 `{isOpen && ...}`。
   - 这一个 hook 会被 §5.1 的 7+ 处 overlay 复用。
4. **`autoAlpha` 约定**：淡入淡出统一用 `autoAlpha`（隐藏时自动设 `visibility:hidden`，不挡点击），不用裸 `opacity`。
5. **Vitest/构建冒烟**：装包后 `pnpm typecheck` + `pnpm build` 必须过；确认 better-sqlite3 rebuild 不受影响。

> Phase 0 完成后，做一次**最小验证**：在任意一个 overlay（建议 KeyboardHelpModal）接上 `useExitAnimation`，手动确认进/退场 + reduced-motion 都正确，再 fan-out 后续 Phase。

---

## 4. 关键技术裁决（执行前必须内化）

### 4.1 transform-only 优先，layout 动画严格受限

- **默认只动** `x` / `y` / `xPercent` / `yPercent` / `scale` / `rotation` / `autoAlpha`（GPU 友好，§8 性能要求 + GSAP 官方"Do Not animate width/height/top/left"）。
- **虚拟列表（EmailList，react-window）内绝对 transform-only**——见 §4.3。
- **layout 动画（width/height）的有限许可**：仅限**非列表、单实例、低频**的展开/折叠，且优先级如下：
  1. 能用 **CSS `grid-template-rows: 0fr→1fr`**（配 `transition-[grid-template-rows] duration-*`）解决的高度展开，**用 CSS，不要上 GSAP**（更省，EmailDetail meta 折叠已是此模式，见 `EmailDetail.tsx:895`，照抄）。适用：ComposePanel 的 Cc/Bcc 展开、AdvancedDisclosure。
  2. 确需 JS 编排或 `height:'auto'` 精确插值时才用 GSAP height tween，并加 `will-change`、动画结束 `clearProps`。适用：ToolCallAuditRow 动态高度。
- **`clipPath` / `scaleY`** 可作为高度展开的 transform-only 替代（无 reflow），但注意 `scaleY` 会拉伸内容——只适合纯色/简单区域。

### 4.2 AIChatPanel 出入场 —— 挤压 vs 覆盖（需裁决）

`InboxLayout.tsx:53` `{aiPanelVisible && <AIChatPanel/>}` 是全 app 最大的布局跳变（360px 瞬现，EmailDetail 被瞬间挤压）。两种实现，语义不同：

- **(A) 挤压**（保持现状语义）：始终 mount + `overflow:hidden`，GSAP tween `width: 0↔360`。这是 **layout 动画**（违背 transform-only），但单实例、低频、可加 `will-change:width`，可接受。需确保 EmailDetail `min-width:0` 防溢出。
- **(B) 覆盖**：面板 `position:absolute` 从右 `xPercent: 100→0` 滑入，EmailDetail 不动。**transform-only，性能最佳**，但视觉语义变成"盖住"而非"挤压"。

**默认建议 (A)**（保持现有交互语义），但把决定权交用户。**Sidebar 折叠（`index.css:914`，已是 width tween）同此裁决。**

### 4.3 虚拟列表（EmailList）铁律

`EmailList.tsx` 用 react-window，是所有列表动画的硬约束：

1. **DOM 复用/回收**：行滚出视口时 slot 被回收复用。对行 DOM 的 tween **必须随组件 unmount 而 kill**——用 `useGSAP({scope})` 自动 revert 即可，**不要**用裸 `gsap.to` 不清理。
2. **行不在 DOM 时无法动画**：依赖"目标行可见"的动画（如选中 accent bar 滑动）必须先检测可见性，否则降级为无动画。
3. **行高是静态数组**（`rowHeights` useMemo，`EmailList.tsx:928`）：列表内**只能 `autoAlpha`/`transform`，绝对不能动 height**（否则虚拟列表总高/offset 计算错乱）。子行展开/新邮件入场只能做 fade/位移，不能做高度塌陷。
4. **`scrollTop` tween 会联动 `onRowsRendered`**（`EmailList.tsx:984`）触发分页：手风琴滚动锚定用 `gsap.to(el,{scrollTo:{y}})` 时，tween 期间需临时屏蔽分页判断。
5. **伪元素无法被 GSAP 操作**：选中 accent bar（`::before`，`index.css:1067`）、unread dot（`::after`，`index.css:1342`）若要动画，必须改成真实 DOM 元素。

### 4.4 tailwindcss-animate 共存边界

- Radix 托管组件 → 留 `animate-in/out`（§2.2）。
- 手工生命周期组件（EventFormModal / folder ConfirmDialog / UndoToast / CommandPalette / 各 picker popover / ComposePanel overlay）→ 改 GSAP（经 `useExitAnimation`）。
- **同一元素不要同时挂 `animate-in` 和 GSAP** tween。

### 4.5 ⛔ 反过度动画（ultrawork 护栏）

下列"缺口"调研中被点名，但**判定为不做**（除非用户明确要）——加了就违背 §8 克制哲学：

- AIBadge mount 动画、selection-count 数字弹跳（`scale 1.15` 偏夸张）。
- EmptyState 入场、EventChip/EventBlock 的 hover `scale`（日历格 hover 用纯 CSS 颜色即可）。
- **SplitText 逐字/逐词入场**（流式文本已有光标 blink，逐字会过度且与 streaming 抢戏）。
- 已被 Radix 覆盖的组件再加动画。
- Sidebar 现有动画推倒重做（只在 §1.3 裁决为 (A) 时做时长/曲线对齐，属微调）。

> 原则：**每一处新动画都要能回答"它解决了哪个具体的生硬瞬切或缺失退场"**。答不上来 → 不做。

---

## 5. 优化机会清单（按优先级）

> 标注：**P0** 高频/高感知/明确合规 · **P1** 明显改善 · **P2** 微交互锦上添花（谨慎，注意 §4.5）。每项给：现状(行号) → 建议(GSAP 能力) → §8 合规说明。

### 5.0 执行总览（一句话）

绝大多数工作量集中在两类可复用模式：**(I) `useExitAnimation` 统一 overlay 出入场**（§5.1，覆盖 7+ 处），**(II) 内容区淡入替换瞬切**（§5.2/5.3/5.4 的视图/详情切换）。先把这两个模式做扎实，收益最大。

### 5.1 【P0】全局 Overlay 出入场统一（最大单点收益）

用 Phase 0 的 `useExitAnimation` + 一个共享进/退场 timeline（backdrop `autoAlpha 0→1` 120ms；卡片 `autoAlpha 0→1 + y:8→0 + scale:0.97→1` 220ms；退场反向、时长压到 fast）。覆盖：

| 组件 | 文件:行 | 现状 |
|---|---|---|
| **CommandPalette ⌘K** | `command/CommandPalette.tsx:594` | veil+pane 全硬切，**日均最高频 overlay**，最优先 |
| KeyboardHelpModal `?` | `keyboard/KeyboardHelpModal.tsx:107` | backdrop+卡片硬切 |
| ConfirmToolDialog | `chat/ConfirmToolDialog.tsx:127` | backdrop+卡片硬切（"AI slop"感来源） |
| EventFormModal | `calendar/EventFormModal.tsx` | **进场有(CSS)、退场硬切** |
| folder ConfirmDialog | `folder/ConfirmDialog.tsx` | **进场有、退场硬切** |
| ResyncConfirmDialog / SendConfirmDialog | `email/EmailToolbar.tsx:519` / `email/compose/*` | createPortal，硬切 |
| ThemePicker/AccentPicker/SurfacePicker popover | `layout/*PickerPopover.tsx` | createPortal 硬切，与 Radix 不一致 |

§8 合规：220ms base + `scale:0.97→1` 极微（macOS sheet 惯用，非 zoom 特效），无 bounce。

### 5.2 【P0/P1】Email 核心区

- **【P0】ComposePanel overlay 出入场** — `EmailDetail.tsx:619` `{composeOpen && ...}` 瞬现瞬消，看正文→compose 的最大硬切。`useExitAnimation` + 进场 `y:20→0, autoAlpha, 220ms`，退场 120ms。`ComposePanel.tsx:425` 的 `key={internalId-mode}` remount 会让进场自然重跑，无需额外处理。
- **【P1】手风琴滚动锚定平滑化** — `EmailList.tsx:977` `el.scrollTop = target` 硬跳。换 `gsap.to(el,{scrollTo:{y:target}, duration:DUR.base, ease:'standard'})`（注意 §4.3.4 屏蔽分页）。**用户感知最强的单点改善之一。**
- **【P1】BatchActionBar 进出场** — `BatchActionBar.tsx:50` `return null` + `index.css:1208` `display:none!important` 让 CSS transition 失效。移除 `!important`，改 `useExitAnimation`：进 `y:16→0,autoAlpha,220ms`，退 120ms。
- **【P1】Filter popover** — `EmailList.tsx:1097` 条件渲染硬切。`autoAlpha + y:-6 + scale:0.97, 120ms, transformOrigin:top right`。
- **【P1】EmailDetail 切邮件交叉淡入** — `internalId` 变化时对内容区 `gsap.from(el,{autoAlpha:0, duration:DUR.fast})`，120ms 即明显改善（已有 `keepPreviousData` 防闪）。配 `overwrite:'auto'` 支持快速 J/K 连切。
- **【P2】EmailRow flag/pin 颜色过渡** — `index.css:1435/1454` 三态颜色瞬切。GSAP `color` tween 120ms（可选 SVG `scale(1.15)` 用 `power1.out` 非 spring）。**注意 §4.3.1 列表内 tween 必须随 unmount kill。**
- **【P2】选中 accent bar 行间滑动** — `::before` 伪元素需先改真实 DOM（§4.3.5）+ Flip，且受虚拟化限制（§4.3.2）。**建议降级为 fade-in 120ms**，性价比更高。
- **【P2】Inbox tab active 指示器滑动** — `EmailList.tsx:1009` class 瞬切。绝对定位 pill + GSAP `x` tween 120ms（或 Flip）。

### 5.3 【P0/P1】Chat / AI 面板

- **【P0】AIChatPanel 整列出入场** — §4.2 裁决（挤压 vs 覆盖）。最大布局跳变。
- **【P1】新消息气泡入场** — `chat/MessageList.tsx`：每条新 user/assistant 消息直接 DOM 追加无入场。对**新增**消息（非历史加载、非 streaming chunk——用 `messageId` Set 标记已动画）`gsap.from(el,{autoAlpha:0, y:8, duration:DUR.base})`。
- **【P1】DraftPreviewCard 强调入场** — AI 的 headline output，用 timeline：card → header(+40ms) → footer(+40ms) stagger，总 ≤380ms(slow)。
- **【P1】ChatSidebar 140px 展开/折叠** — `AIChatPanel.tsx:596` 条件渲染硬切。同 §4.2 width tween（或 grid-cols trick）。
- **【P2】ToolCallAuditRow 折叠展开** — `MessageList.tsx` 内容高度瞬变（chevron 转了但内容硬出现，动作割裂）。GSAP `height:'auto'` 120ms（§4.1.2，注意 `max-h-48` 区域改 clipPath）。
- **【P2】Composer model-picker / MentionPopover 出入场** — `Composer.tsx:465` / `MentionPopover.tsx:131` 条件渲染硬切。`autoAlpha + y:4, 120ms`，与 §5.1 popover 统一。

### 5.4 【P0】Calendar

- **【P0】视图切换动画** — `CalendarPage.tsx`：Month/Week/Day/Agenda 直接 unmount/mount，**全 app 最生硬瞬切之一**。timeline：旧 `autoAlpha:0, x:dir*-16, 120ms` → 新 `set{autoAlpha:0,x:dir*16}` → `{autoAlpha:1,x:0, 220ms}`。
  - ⚠️ `x:±16` 方向位移属 subtle cue，**不是 parallax**，但**实施前与设计确认**（§8 边界）。保守可去掉位移只留 fade。
  - 实现：用包裹 div 持 ref（不动 View 组件），`key` + `useGSAP` 依赖 view 触发。
- **【P1】CalendarToolbar view-chip 滑动 indicator** — `CalendarToolbar.tsx` `.view-chip.is-active`(`index.css:3038`) 硬切。容器内绝对定位 indicator + GSAP `x/width` 120ms（同 §5.2 tab）。
- **【P1】UndoToast 进度条 rAF→GSAP** + 进出场 — `UndoToastStack.tsx:44`：手写 `el.style.transition`+强制 reflow（~15 行）换 `gsap.to(prog,{scaleX:0, duration:ttl, ease:'none', onComplete:dismiss})`，点撤销 `.kill()`。同时迁 `cal-toastin/out`（§1.4）到 GSAP 解决 `.out` unmount 竞态。代码更短、可中断。
- **【P2】AgendaView 列表 stagger 入场** — 条目 `autoAlpha:0→1` stagger（≤380ms）。

### 5.5 【P1/P2】Settings / Folder / Feedback

- **【P1】folder ConfirmDialog / EventFormModal 退场** — 已并入 §5.1。
- **【P1】SettingsRail TabsContent 切换** — `settings/SettingsRail.tsx`：panel 硬替换。`autoAlpha:0→1 + y:4→0, 220ms`。
- **【P1】Toast 退场** — `Toast.tsx`：进场有(rAF+transition 220ms)、退场 store dismiss 硬卸载。`useExitAnimation` 补 slide-out。
- **【P2】AdvancedDisclosure 展开** — `settings/parts/AdvancedDisclosure.tsx`：`<details>` 原生 height 硬弹（chevron 平滑但内容硬出现）。优先 **CSS grid-rows trick**（§4.1.1，不上 GSAP）；或改受控 + GSAP `height:'auto'`。
- **【P2】Tabs 滑动 underline indicator** — `ui/tabs.tsx` horizontal：coral underline 分散在各 trigger 无滑动。绝对定位 indicator + Flip/x-width tween 120ms。**改 DOM 结构需谨慎**，确认收益。
- **【P2】各 picker popover** — 并入 §5.1。
- **【P2】FolderRow 归档 collapse 退出** — `folder/FolderRow.tsx`：归档后行硬消失。`autoAlpha+height:0, 220ms`（非虚拟列表，可动 height）。
- **修 bug【P1】**：`folder/FolderDetail.tsx:213` `animate-pulse` 缺 `motion-reduce:animate-none`（其余 skeleton 都有）——顺手补齐。

---

## 6. 分阶段执行计划（ultrawork + workflow fan-out）

```
Phase 0  基础设施（串行，1 agent，阻塞全部后续）
  └─ §3 全部交付物 + 在 KeyboardHelpModal 上做最小验证
       ↓（验证通过才继续）
Phase 1  P0（并行 fan-out，4 agents）
  ├─ A: §5.1 全局 overlay 统一（useExitAnimation 接入 7+ 处）
  ├─ B: §5.2 ComposePanel 出入场 + 切邮件淡入 + 手风琴滚动
  ├─ C: §5.3 AIChatPanel 出入场（先与用户敲定 §4.2 挤压/覆盖）
  └─ D: §5.4 Calendar 视图切换（先与用户敲定 §5.4 是否要 x 位移）
       ↓
Phase 2  P1（并行 fan-out）
  ├─ BatchActionBar / Filter popover / 新消息气泡 + DraftCard
  ├─ UndoToast rAF→GSAP / Toast 退场 / SettingsRail 切换
  └─ ChatSidebar / view-chip indicator / motion-reduce bug
       ↓
Phase 3  P2 微交互（并行，可选；严守 §4.5 不过度）
  └─ flag/pin 过渡 / tab indicator / Disclosure / FolderRow collapse / accent bar(降级 fade)
```

- **每个 Phase 末的 gate**（不通过不进下一阶段）：`pnpm typecheck` + `pnpm build` 过 → 开 macOS「减弱动态效果」验证所有新动画归零/禁用 → DevTools Performance 抽查无 forced reflow（尤其列表内）→ §8 红线 review（无 spring/bounce/parallax、时长只用 120/220/380、曲线只用 standard）。
- **依赖关系**：Phase 0 阻塞一切；§4.2 / §5.4 的设计裁决最好在 Phase 1 启动前问用户（见 §7 待裁决清单）。
- workflow 建议：每个机会点一个 agent，pipeline 「实现 → 自检(typecheck+红线) → 视觉 dogfood」；overlay 类共享 `useExitAnimation` 故 §5.1 宜单 agent 串行接入避免冲突。

---

## 7. 待用户/设计裁决（建议 Phase 0/1 之间问清）

1. **§1.3 曲线收口**：(A) 全回归 standard 单曲线 ／ (B) 正式承认 `0.32,0.72,0,1` 为第二曲线。【默认 A】
2. **§4.2 AIChatPanel & Sidebar**：(A) 挤压(width tween) ／ (B) 覆盖(transform 滑入)。【默认 A】
3. **§5.4 日历视图切换**：是否保留 `x:±16` 方向位移，还是纯 fade（更保守、零 parallax 嫌疑）。【默认纯 fade 起步，位移作为 enhancement】
4. **范围确认**：P2 微交互是否本轮做，还是只做 P0+P1。

---

## 8. 验收标准 & 红线 checklist

**功能/质量**
- [ ] `pnpm typecheck`、`pnpm build` 通过；better-sqlite3 rebuild 正常。
- [ ] 所有 overlay **进场 + 退场对称**（不再有"进场有、退场硬切"）。
- [ ] 所有新动画在 `prefers-reduced-motion: reduce`（macOS「减弱动态效果」）下被禁用或 `duration:0`。
- [ ] 虚拟列表（EmailList）内动画全部 transform/autoAlpha，**未动 height/layout**；无视觉错乱（快速滚动 + 选中切换）。
- [ ] DevTools Performance：动画期间无 forced synchronous layout（reflow）；列表内 60fps。
- [ ] GSAP tween 随组件 unmount 清理（无 detached node 警告、无内存泄漏）。

**§8 红线（视觉走查）**
- [ ] 无 spring / bounce / elastic / overshoot（ease 不含 `back`/`elastic`/`bounce`）。
- [ ] 无 parallax / scroll-jacking / confetti / particle。
- [ ] 时长只出现 120 / 220 / 380ms（`DUR.fast/base/slow`）。
- [ ] 曲线只出现 `standard`（或裁决后的明确第二曲线），无散落的随手 `power*`/cubic-bezier。
- [ ] 没有为"缺口而缺口"加的动画（对照 §4.5）。

---

## 附录 A：机会点 → 文件:行 速查

| # | 机会 | P | 文件:行 |
|---|---|---|---|
| 1 | Phase0 gsap.ts 初始化 | — | `src/shared/lib/gsap.ts`(新) |
| 2 | useExitAnimation hook | — | `src/shared/hooks/`(新) |
| 3 | CommandPalette ⌘K | P0 | `command/CommandPalette.tsx:594` |
| 4 | KeyboardHelpModal | P0 | `keyboard/KeyboardHelpModal.tsx:107` |
| 5 | ConfirmToolDialog | P0 | `chat/ConfirmToolDialog.tsx:127` |
| 6 | EventFormModal 退场 | P0 | `calendar/EventFormModal.tsx` + `index.css:3175/3187` |
| 7 | folder ConfirmDialog 退场 | P0 | `folder/ConfirmDialog.tsx` + `index.css:4078/4088` |
| 8 | Resync/SendConfirmDialog | P0 | `email/EmailToolbar.tsx:519` |
| 9 | Theme/Accent/Surface popover | P0 | `layout/ThemePickerPopover.tsx` / `AccentPickerPopover.tsx` / `SurfacePickerPopover.tsx` |
| 10 | ComposePanel overlay | P0 | `email/EmailDetail.tsx:619` |
| 11 | AIChatPanel 整列 | P0 | `layout/InboxLayout.tsx:53` + `chat/AIChatPanel.tsx` |
| 12 | Calendar 视图切换 | P0 | `calendar/CalendarPage.tsx` |
| 13 | 手风琴滚动锚定 | P1 | `email/EmailList.tsx:977` |
| 14 | BatchActionBar 进出场 | P1 | `email/BatchActionBar.tsx:50` + `index.css:1208/1232` |
| 15 | Filter popover | P1 | `email/EmailList.tsx:1097` |
| 16 | 切邮件淡入 | P1 | `email/EmailDetail.tsx`(internalId) |
| 17 | 新消息气泡入场 | P1 | `chat/MessageList.tsx` |
| 18 | DraftPreviewCard 序列 | P1 | `chat/MessageList.tsx` |
| 19 | ChatSidebar 展开 | P1 | `chat/AIChatPanel.tsx:596` + `ChatSidebar.tsx` |
| 20 | UndoToast rAF→GSAP | P1 | `calendar/UndoToastStack.tsx:44` + `index.css:3548/3552/3556` |
| 21 | Toast 退场 | P1 | `Toast.tsx` |
| 22 | SettingsRail 切换 | P1 | `settings/SettingsRail.tsx` |
| 23 | view-chip indicator | P1 | `calendar/CalendarToolbar.tsx` + `index.css:3038` |
| 24 | motion-reduce bug 修复 | P1 | `folder/FolderDetail.tsx:213` |
| 25 | flag/pin 颜色过渡 | P2 | `index.css:1435/1454` + `email/EmailRow.tsx` |
| 26 | 选中 accent bar(降级 fade) | P2 | `index.css:1067` + `email/EmailList.tsx` |
| 27 | Inbox tab indicator | P2 | `email/EmailList.tsx:1009` |
| 28 | ToolCallAuditRow 展开 | P2 | `chat/MessageList.tsx` |
| 29 | Composer model-picker/Mention | P2 | `chat/Composer.tsx:465` / `chat/MentionPopover.tsx:131` |
| 30 | AdvancedDisclosure(优先CSS) | P2 | `settings/parts/AdvancedDisclosure.tsx` |
| 31 | ui/tabs underline indicator | P2 | `ui/tabs.tsx` |
| 32 | FolderRow 归档 collapse | P2 | `folder/FolderRow.tsx` |
| 33 | AgendaView stagger | P2 | `calendar/views/AgendaView.tsx` |

## 附录 B：GSAP 速查（本项目常用）

```ts
import { gsap, useGSAP, Flip, DUR } from '@/shared/lib/gsap'

// 进场（组件内，scope 限定）
const root = useRef(null)
useGSAP(() => {
  gsap.from('.card', { autoAlpha: 0, y: 8, duration: DUR.base }) // ease 默认 standard
}, { scope: root })

// 退场 + 延迟卸载 → 用 Phase0 的 useExitAnimation

// 可中断（快速切邮件/视图）
gsap.to(el, { autoAlpha: 1, duration: DUR.fast, overwrite: 'auto' })

// Flip（indicator 滑动 / 布局）
const s = Flip.getState('.indicator'); /* DOM 变 */ Flip.from(s, { duration: DUR.fast })

// 滚动位置（手风琴锚定）
gsap.to(scrollEl, { scrollTo: { y: target }, duration: DUR.base })

// reduced-motion（Phase0 统一封装；matchMedia 写法）
const mm = gsap.matchMedia()
mm.add({ reduce: '(prefers-reduced-motion: reduce)' }, (ctx) => {
  const d = ctx.conditions.reduce ? 0 : DUR.base
  gsap.from('.x', { autoAlpha: 0, duration: d })
}, root)
```

**红线提醒**：`ease` 永远 `'standard'`（或裁决后第二曲线）；`duration` 永远 `DUR.*`；淡入淡出用 `autoAlpha`；列表内只 transform；禁 `back/elastic/bounce`。

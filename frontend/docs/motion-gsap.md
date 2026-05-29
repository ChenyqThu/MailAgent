# 动效规范 · GSAP 落地约定

> 本文是 `frontend/` renderer 的 GSAP 动效**落地规范**，配套 [`DESIGN.md`](../DESIGN.md) §8 Motion system / §9 Interaction patterns。
> DESIGN.md §8 定**设计红线**（时长/曲线/禁止项），本文定**工程实现**（怎么用 GSAP 把红线落对）。
> 改动效前先读本文 + §8。

## 0. 定位

GSAP 在本项目的角色 = **在 §8 克制约束内把该有的动画做对**，不是加花活。绝大多数收益来自：补齐退场动画、统一 overlay 出入场、把生硬瞬切变 ≤220ms 淡入、可中断 tween（快速切换打断）。**每一处新动画都要能回答「它解决了哪个具体的生硬瞬切或缺失退场」，答不上 → 不做。**

## 1. 红线（违反即返工）

| 项 | 约束 |
|---|---|
| 时长 | 只用 `DUR.fast=0.12` / `base=0.22` / `slow=0.38`（120/220/380ms）。不发明第四档。倒计时类（如 undo 5s）例外——那是功能计时，非 UI 过渡。 |
| 曲线 | 只用 `standard`（CustomEase `0.4,0,0.2,1`）。`gsap.defaults` 已设默认，组件不传 ease 即合规。禁散落 `power*` / 裸 cubic-bezier。进度条倒计时用 `ease:'none'`（线性，非 UI 曲线）。 |
| 禁止 | spring / bounce / elastic / overshoot（ease 不含 `back/elastic/bounce`）、parallax、scroll-jacking、confetti、particle。 |
| 淡入淡出 | 一律 `autoAlpha`（隐藏时自动 `visibility:hidden`，不挡点击），不用裸 `opacity`。 |
| 虚拟列表 | `EmailList`（react-window v2）行内动画**只 transform/autoAlpha，绝不动 height**；tween 必随 unmount kill（用 `useGSAP({scope})`）。 |
| Radix 托管 | `ui/dialog` / `ui/select` / `ui/tooltip` 已用 `tailwindcss-animate`，**不叠加 GSAP**。`ui/tabs`/`switch`/`radio`/`slider` 无内置动画，可安全集成。 |
| reduced-motion | macOS「减弱动态效果」下所有新动画归零/禁用（见 §3）。 |

## 2. 初始化层 `src/shared/lib/gsap.ts`

全项目动效的**唯一入口**，禁止各组件散落 `registerPlugin` / 重复定义曲线。

```ts
import { gsap, useGSAP, Flip, DUR } from '@shared/lib/gsap'
//                                         ↑ 注意别名是 @shared（→ src/shared），不是 @/
```

导出：`gsap`（已注册 useGSAP/Flip/CustomEase/ScrollToPlugin + 唯一 standard 曲线 + 三档时长默认）、`useGSAP`、`Flip`、`DUR`。

## 3. reduced-motion

GSAP 经 JS 直接操作 `.style`，绕过 `index.css` 的 `@media (prefers-reduced-motion)` 保护——**一旦 GSAP 接管某元素，CSS 媒体查询对它失效**。所以凡 GSAP 动画都要在 JS 层处理：

- 用 `useReducedMotion()`（`src/shared/hooks/useReducedMotion.ts`），在 reduce 时 `return` 跳过 / `duration:0`。
- `useExitAnimation` 已内置短路，无需额外处理。
- **测试环境**：`tests/setup.ts` 全局强制 `prefers-reduced-motion: reduce`，使所有 GSAP 动画在 happy-dom 里 no-op（否则 timeline 不推进 rAF，元素停在进场起始的隐藏态，`getByRole` 找不到元素）。需测真实动画路径的用例自行 `vi.stubGlobal('matchMedia', ...)` 覆盖。

## 4. 核心 hook `useExitAnimation`

`src/shared/hooks/useExitAnimation.ts` —— 解决全 app 最普遍缺口：React `{open && ...}` 同步卸载，CSS 没机会播退场。本 hook 把卸载推迟到退场动画播完。复用于 10+ overlay。

```ts
const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, opts)
if (!shouldRender) return null
return createPortal(<div ref={scopeRef} /* backdrop */>…<div data-anim-card>…</div></div>, document.body)
```

`opts`：
- `card?: string` — 卡片子元素选择器（transform 动画），省略时 scope 根即卡片。
- `backdrop?: boolean | string` — `true`(默认) root 即 backdrop；`string` backdrop 是 scope 内子元素（如 CommandPalette veil/pane 兄弟结构）；`false` 无 backdrop（popover/单元素/覆盖层）。
- `from?` — 卡片进场起始 vars（也是退场目标）。默认 `{autoAlpha:0, y:8, scale:0.97}`。
- `enterDuration?`/`exitDuration?` — 默认 `DUR.base` / `DUR.fast`。

**模式速查**：
- 居中模态（root=backdrop + 卡片）：`{ card: '[data-anim-card]' }`。
- 子元素 backdrop（veil+pane 兄弟）：`{ card: '.pane', backdrop: '.veil', from: {...xPercent:-50...} }`。
- popover（单元素无 backdrop）：`{ backdrop:false, from:{autoAlpha:0,y:-6,scale:0.97,transformOrigin:'top right'}, enterDuration:DUR.fast }`。
- 覆盖层（铺满区域）：`{ backdrop:false, from:{autoAlpha:0, y:20} }`。

**transform 居中陷阱**：元素若用 CSS `transform: translateX(-50%)` 居中（如 CommandPalette `.palette-pane`），GSAP 动 transform 会覆盖它跳位。解法：`from` 带 `xPercent:-50` 让 GSAP transform 复刻居中，进场结束 `clearProps:'transform'` 回落 CSS。

## 5. 常用片段

```ts
// 内容区切换淡入（可中断）
useGSAP(() => {
  if (reduceMotion) return
  gsap.from(el, { autoAlpha: 0, y: 8, duration: DUR.base, overwrite: 'auto' })
}, { dependencies: [id, reduceMotion], scope: ref })

// 序列编排（DraftPreviewCard，总时长 ≤ DUR.slow）
const tl = gsap.timeline()
tl.from(card, { autoAlpha: 0, y: 8, duration: DUR.base }, 0)
tl.from(header, { autoAlpha: 0, duration: DUR.fast }, 0.04)

// 滚动锚定平滑（ScrollToPlugin，注意 tween 期间屏蔽分页）
gsap.to(scrollEl, { scrollTo: { y: target }, duration: DUR.base, overwrite: 'auto' })

// width 挤压（layout 动画，§4.1 限单实例/低频；标 will-change 结束清掉）
gsap.to(wrapper, { width: open ? 360 : 0, duration: open ? DUR.base : DUR.fast,
  onStart: () => (wrapper.style.willChange = 'width'),
  onComplete: () => (wrapper.style.willChange = '') })
```

## 6. layout 动画的有限许可（§4.1）

默认只动 `x/y/xPercent/yPercent/scale/rotation/autoAlpha`（GPU 友好）。动 width/height 仅限**非列表、单实例、低频**展开/折叠，优先级：
1. 能用 CSS `grid-template-rows: 0fr→1fr` 解决的高度展开 → 用 CSS，不上 GSAP。
2. 确需 JS 编排才用 GSAP height，并加 `will-change` + 结束 `clearProps`。

已用 width tween：AIChatPanel(0↔360) / ChatSidebar(0↔140)（挤压语义，wrapper overflow:hidden）。

## 7. §4.5 不做清单（反过度动画护栏）

下列「缺口」**判定为不做**（除非明确要求）：AIBadge mount、selection-count 数字弹跳、EmptyState 入场、日历格/事件块 hover scale、SplitText 逐字入场、已被 Radix 覆盖的组件再加动画。

## 8. 覆盖现状（feat/gsap-motion）

**已落地**：
- Phase 0 基础设施：gsap.ts / useExitAnimation / useReducedMotion / 测试 reduced-motion setup。
- Overlay 出入场：CommandPalette / KeyboardHelpModal / EventFormModal / folder ConfirmDialog / ResyncConfirmDialog / Theme·Accent·Surface PickerPopover / ComposePanel / Filter popover / Composer model-picker / MentionPopover；ConfirmToolDialog 仅进场（退场为父队列硬卸载，用户主动触发）。
- 内容区：EmailDetail 切邮件淡入 / EmailList 手风琴滚动锚定 / Calendar 视图切换(fade+x:±16)。
- 挤压：AIChatPanel / ChatSidebar width tween。
- Chat：新消息气泡入场（排除历史/streaming）/ DraftPreviewCard 序列。
- Toast 类：UndoToast 进度条 GSAP 倒计时 + 进场。
- 微交互：BatchActionBar 出入场 / SettingsShell tab 淡入 / FolderRow 归档 collapse / AgendaView stagger / flag·pin 颜色过渡（CSS）/ 选中 accent bar fade（CSS）。
- §8 曲线收口：移除全部旧第二曲线 `cubic-bezier(0.32,0.72,0,1)`（folder-modal / efm-modal / batch-bar / undo-toast），统一 standard。

**有意延后**（透明记录，非遗漏）：
- **Toast 通用退场**：store TTL/demote 路径硬移除，干净退场需 store 重构（AnimatePresence 式）或 store 模型改字段，对 P1 不成比例；现有进场已 §8 合规。
- **view-chip / Inbox tab / ui/tabs 滑动 indicator**：sliding indicator 需测量定位 + DOM 重构，对齐效果**需真机 GUI 目检**（border/padding 偏移易错），不在无头环境盲发；现有过渡曲线已对齐 standard。
- **AdvancedDisclosure 展开**：原生 `<details>` 加高度动画须改受控组件，丢失 disclosure a11y 语义，面板「95% 用户从不打开」，成本不值。
- **ToolCallAuditRow 展开**：内容高度展开，clipPath/受控 height 中等风险、低价值，暂缓。

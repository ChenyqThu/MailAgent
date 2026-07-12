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
| spring 白名单 | 禁止业务代码内联 spring 参数；仅可从 `@shared/lib/motion-tokens` import 五个预设：`SPRING_PRESS`（按钮/可点击表面按压）、`SPRING_SWAP`（控件内部标签/图标切换）、`SPRING_PANEL`（显式召出的模态/抽屉）、`SPRING_LAYOUT`（pill/indicator/panel shared-layout 位移）、`SPRING_MOUSE`（magnetic/tilt/dock 装饰性鼠标跟随）。白名单外仍禁 spring / bounce / elastic / overshoot（ease 不含 `back/elastic/bounce`）、parallax、scroll-jacking、confetti、particle。 |
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
- 微交互：BatchActionBar 出入场 / SettingsShell tab 淡入 / FolderRow 入场 fade / AgendaView stagger / flag·pin 颜色过渡（CSS）/ 选中 accent bar fade（CSS）。
- Toast 通用退场：AnimatePresence-lite（ToastContainer diff store items + 延迟卸载），TTL/手动/demote 三路径统一 slide-out。
- 滑动 indicator：view-chip + Inbox tab 激活态用绝对定位 indicator + GSAP x/width 滑动（getBoundingClientRect 测量）。
- 展开：AdvancedDisclosure（受控 + CSS grid-rows，保 a11y）/ ToolCallAuditRow（CSS grid-rows）。
- §8 曲线收口：移除全部旧第二曲线 `cubic-bezier(0.32,0.72,0,1)`（folder-modal / efm-modal / batch-bar / undo-toast / view-chip / inbox-tab），统一 standard。二轮收口（transitions.dev review 轮）：清掉漏网的 `.app-nav`(260ms 旧曲线→220 standard) / `.drawer`(0.26s 旧曲线→220 standard) / glass 切档(280→220) / nav label fade(140 linear→120 standard) / drawer-backdrop(0.2s→220 standard)。
- 微交互原语（transitions.dev review 轮新增）：
  - `.icon-swap`/`.icon-swap-item`（index.css）：同 slot 双图标 cross-fade（opacity+scale 0.85，120ms standard，**无 blur** —— filter 永不过渡红线）。已接：copy→check（RemoteAccessTab）/ Eye↔EyeOff（EnvField+EnvSecretField）/ 主题三态（ThemePickerPopover trigger）。data-active 必须传字符串 `'true'/'false'`。
  - 树状展开 chevron：单 `<ChevronRight>` + `transition-transform duration-fast` + 条件 `rotate-90`（SidebarFolderTree），**不用双图标 swap**——旋转比 cross-fade 自然。
- 出入场补缺（同轮）：EventFormModal 周期 scope 确认 / FolderPicker 删除确认 / AccountSwitcherPopover 接入 useExitAnimation。

**有意延后**（透明记录，非遗漏）：
- **ui/tabs underline 滑动 indicator**：全仓仅 SettingsRail 消费 Tabs 且全 `orientation=vertical`，横向 coral underline 零渲染实例 → 做了等于 dead code，跳过。
- **FolderRow 归档 collapse 退场**：FolderList 从 react-query data 派生行，归档→invalidate→refetch→行从 data 移除→父卸载，行内无法延迟卸载；真正的 collapse 退场需把删除队列上提到 FolderList 做数据 diff（父数据流改写，超范围）。当前只做入场 fade。

**本轮新增（feat: 动效升级 2026-06，引入 `motion` + `ogl`）**：
- lucide-animated 动画图标进主菜单（`Sidebar` 13 项）+ 设置菜单（`SettingsRail` 9 项）hover 微交互，统一收口 `components/icons/AnimatedIcon.tsx`。
- reactbits effect：Border Glow（authored CSS，写 index.css）接 AI FAB + assistant 待确认卡片；Strands（ogl WebGL）背景接 agent 视图空态欢迎页。
- motion 范围**严格限 icon/effect**，与 GSAP 的职责边界见 **§10**。

## 9. Loading 与渐进式加载（§8 loading 词汇）

**canvas / 数学曲线 loader = 不采用**（用户拍板 2026-05-29）。理由：站点上的曲线本质是
spring/elastic/fourier，违 §8 禁 spring/bounce/elastic + "This is a tool." 克制哲学；
独立审计也确认现有 `animate-spin`（图标）+ skeleton `animate-pulse` 已 100% 合规且足够。
loading 不该成为视觉焦点。**loading 只用三个词汇**（2026-06-13 用户拍板把 shimmer text 纳入第三员），
别引入装饰性 canvas/rAF 逐帧动画：
1. `animate-spin` —— 图标类进行中指示。
2. skeleton `animate-pulse` —— 块级占位。
3. `.think-shimmer` —— **文字类** in-progress 标签（思考中/翻译中/生成中/加载中…）的唯一写法：
   bg-clip-text 渐变扫过，1.5s linear loop（loop 类同 pulse 豁免三档时长）。AI 语境（chat 面板内）
   用默认 `--c-ai` 高光；其余加 `.shimmer-neutral` 切 ink-fg 中性高光。reduced-motion 由 index.css
   末尾 @media 块统一降级为纯色文字（纯 CSS 动画不经 GSAP，CSS @media 足够，无需 JS 判断）。
   已接：chat thinking 头 / ToolGroup running / pre-answer「AI 思考中…」/「翻译中…」/
   报告「生成中」/ 邮件正文「加载中…」。spinner 与 shimmer **不并存**于同一条 loading 行
   （双动效闹；ReportsTab GeneratingState 的页级 spin 是既有信息锚点，例外保留）。

## 10. motion 与 GSAP 职责分工（2026-06 引入 `motion`）

本轮为「lucide-animated 动画图标 + reactbits 高级 effect（Border Glow / Strands）」引入 `motion`（`motion/react`，原 framer-motion 的后继独立包）。motion 与 GSAP **并存但职责严格分离**，禁止越界混用：

| 维度 | **motion**（`motion/react`） | **GSAP**（`@shared/lib/gsap`） |
|---|---|---|
| 职责 | **图标级微交互**（lucide-animated 的 svg path 形变/描边）+ 偏 CSS 的 effect 薄包装 | **布局 / overlay / 序列**（进退场、Flip、ScrollTo、内容区淡入、width 挤压） |
| 触发 | hover（`whileHover` + `variants`），声明式 | 命令式 `useGSAP` + ref，可中断 tween |
| 适用 | 单个 svg 内部 path、装饰性 effect 组件 | 多元素编排、卸载延迟（`useExitAnimation`）、虚拟列表行 |
| reduced-motion | `useReducedMotion()`（`motion/react`），reduce 渲染静态分支 | `useReducedMotion()`（`src/shared/hooks`），reduce `duration:0`/return |

**边界规则（违反即返工）**：
1. **motion 默认只用于 icon / effect，不接管通用 overlay / 布局** —— 通用 overlay 仍走 GSAP `useExitAnimation`。**浮层豁免面**仅限「beui 收编组件登记表」中明确登记的共享组件；这些组件可用 `AnimatePresence` + `SPRING_PANEL`，业务调用点不得自行复制实现。
2. **motion 默认 transition 是 spring，禁止吃默认值或内联参数** —— tween 显式复用获批曲线；spring 只能 import `@shared/lib/motion-tokens` 的 §1 五预设，并严格按用途使用。code review grep `stiffness`/`damping` 应只命中 token 文件。
3. **图标动画只动形状、不引入颜色** —— svg 用 `currentColor`，颜色仍由 className（`text-coral` 等）控制。
4. **effect 的曲线/时长复用 §1 三档 + standard**，不另立第四档。Border Glow 是 authored CSS（写进 `index.css`，绕开 lint 的 hex/gradient/shadow 红线，用 `rgb(var(--c-accent)/…)`）；Strands 是 ogl WebGL。

**Strands 与 §9 的关系（重要，避免误判违规）**：§9 的「canvas / 数学曲线 loader = 不采用」禁的是**把 canvas 当 loading 指示器**。Strands 是 **agent 视图空态欢迎页的氛围背景**（用户 2026-06 明确要求引入 reactbits WebGL 重组件），语义 ≠ loading。Loading 仍只用 §9 三词汇（spin / skeleton / shimmer），不引入 canvas loader。Strands 仅在 agent 新对话空态短暂挂载，首条消息后卸载（零持续 GPU），reduce 时 `return null` 退回静态背景。

**骨架屏 + 渐进式加载**（工具型 app「高级感」的正解）：
- 骨架原语：`feedback/LoadingSkeleton.tsx`（`Skeleton`/`SkeletonRow`/`SkeletonCard`，自带 `animate-pulse motion-reduce:animate-none`）+ `EmptyState`。
- 渐进式：数据切换/翻页/refetch 用 TanStack Query v5 `placeholderData: keepPreviousData`，旧数据留屏到新数据 ready，消除闪白/回顶。配合 `isLoading`（v5 下仅「首次无缓存」为 true）做骨架兜底——切换时 `isLoading=false` 走 isFetching，自然只在首次显骨架。
- 已覆盖：EmailList / EmailDetail / FolderList（既有）+ Calendar 4 view + EventDetailDrawer + CommandPalette 搜索（本轮）。手写 `animate-pulse` 必带 `motion-reduce:animate-none`。
- 延后（更大初衷）：邮件正文 HTML 流式 / 内联图懒加载 + allSettled 协调 / 附件缩略图。

## 11. 主题 v3 CSS 过渡缓动 token（2026-07）

主题 v3「原生材质」为 **CSS transition**（authored CSS，非 GSAP）新增两个缓动 token（`index.css` `:root`）：

| Token | 值 | 用途 |
|---|---|---|
| `--ease-out-strong` | `cubic-bezier(0.23, 1, 0.32, 1)` | UI 过渡默认（hover / 选中 fade / 圆角态切换等 CSS transition） |
| `--ease-move` | `cubic-bezier(0.77, 0, 0.175, 1)` | 位移 / morph 类 CSS transition |

时长仍贴 §1 三档：fast 120 / base 220 / slow 380（tailwind duration token 同源，不发明第四档）。新代码禁 `ease-in` / `transition: all` / 回弹（bounce / overshoot），与 §1 红线一致。

**与 GSAP 的边界（重要，勿混用）**：这两个 token 只服务 **CSS transition**。GSAP 的 `standard` 曲线（CustomEase `0.4,0,0.2,1`，§1 / §2）**不动** —— 既有 GSAP 编排全部保留、**不迁移**到 v3 曲线。即 authored-CSS 过渡走 v3 token、命令式 GSAP tween 走 standard，两套曲线并存、各管各的（同 §10 motion×GSAP 职责分离的精神）。此分工的 DESIGN.md 侧记录见 §8 末尾 + §18。

## beui 收编组件登记表

| 组件 | 收编来源 | motion 用途 | spring 预设 | 边界 |
|---|---|---|---|---|
| `ui/drawer.tsx` | beui.dev `drawer.tsx`（MIT） | 抽屉面板进退场；backdrop 使用 `EASE_OUT` tween | `SPRING_PANEL` | 仅共享 Drawer 内部使用；业务抽屉只组合内容，不复制 `AnimatePresence` 或 spring 参数。 |

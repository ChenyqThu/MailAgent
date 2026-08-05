# 全 app popover 统一到 Popmenu 基座 —— 迁移方案

> **性质**：规划文档，零代码改动。证据底稿 = `research/popover-inventory-0805.md`（50 场景 / 13 种实现 / 7 条硬约束，只读盘点 agent 产出）。
> **前序**：核心体验批 worktree `claude/mailagent-core-ux-93c9ba` 已合 main（merge `5d5a0e73`）——**基座与审批物已经在 main 里了**，那个 worktree 不再继续开发，本任务在 main 上做。

---

## 0. 一句话

仓库里约 **25 个独立弹层散落在 8 种手搓实现**里，各自复制一份 outside-click / Esc / 越界手算，其中好几个连 Esc 和键盘都没有。`ui/Popmenu` 基座已落地并有 dev showcase 作为审批物；**缺的是 owner 对 7 个基座缺口的拍板，然后分波迁移**。

---

## 1. 当前状态（可验证，别凭这份文档想当然）

| 事项 | 位置 | 状态 |
|---|---|---|
| 基座组件 | `frontend/src/shared/components/ui/Popmenu.tsx`（972 行，commit `dc7e2117` + `dd3a9c35`） | 已在 main |
| 生产消费者 | `frontend/src/shared/components/email/EmailListHeader.tsx` | **只有这 1 处**（筛选/排序菜单） |
| 旧 `ui/DrillMenu.tsx` | — | 已删（被 Popmenu 取代） |
| dev showcase | `frontend/src/shared/components/dev/popmenu-showcase/`（commit `aacb91ce`） | 已在 main，**dev-only** |
| 基座单测 | `frontend/tests/shared/components/ui/Popmenu.test.tsx`（23 例，含 4 例活数据流） | 已在 main |

**打开 showcase**：起 dev 后任意界面按 **⌃⇧P**（Control+Shift+P，非 ⌘），或 DevTools console 敲 `__popmenuShowcase()`。
生产构建里 `import.meta.env.DEV` 被替换成 `false`，`router-instance.tsx` 那个三元折成 `null` → 打包产物零渲染、不进 chunk 图。

> 🔴 **底稿里的行号是 worktree 分支基线（main@`901ab48d`）的，main 之后又落了 10 个 commit** —— 实测已有多处位移（`ComposeEditor` / `MonthView` 的行号对不上），个别文件路径也不同（`ComposerPlusMenu` 在 `shared/assistant/components/` 而非 `shared/components/assistant/`）。**把底稿的 `file:line` 当线索不当坐标**：按符号名 / 注释原文 grep 定位，别硬跟行号。本 `plan.md` 第 4 节的路径已在 2026-08-05 全部实测校正过。

showcase 内容 = 盘点里**能迁**的 26 个场景逐个用 Popmenu 重建（文案与选项顺序照抄现实现）+ 页尾 5 个「不建议直接迁」。卡片上的「现状」一句话来自盘点，红字备注就是下面第 3 节缺口的落点。

---

## 2. 基座能力现状（迁移前必须知道边界在哪）

**有的**：
- 7 种行 —— `label` / `separator` / `action`（默认点完关，`keepOpen` 可留）/ `checkbox`（+ count / dotClassName）/ `radio`（默认不关）/ `submenu`（无深度限制，行 morph 成子面板标题）/ `custom`（任意 React 内容）+ `children` 逃生舱（整个根面板自绘）。
- 键盘：↑↓ 循环 · Home/End · →/Enter 进子面板 · ←/Backspace/Esc 回上层（根面板 Esc = 关）· Tab 关。**全仓唯一有完整键盘导航的弹层实现**。
- 面板栈只存**路径 + 几何**，items 每 render 现取 —— 二级面板的勾选态实时刷新（`dd3a9c35` 修的就是这个：早期把 submenu 对象整个快照进 state，勾了要等下次打开才变）。
- 动效：motion@12（仓内已有，零新依赖），EASE `[0.22,1,0.36,1]`，进场 0.22s / 退场 0.15s，父面板压暗留在原地可点返回。

**没有的**（= 第 3 节的缺口）：
- 材质只有**一档**：`bg-popover` = `rgb(var(--ink-2))`，纯不透明。
- 定位：`absolute z-40`（`Popmenu.tsx:517` 硬编码），**不 portal、不垂直翻转**，只做横向夹取 + 纵向压 `max-height`。
- `width` 只收 px 数。
- `custom` 行不进键盘序列。
- Esc 只做 `stopPropagation`。
- 行是 `<button>`，点击前抢焦点（编辑器场景会丢选区）。

---

## 3. 七个基座缺口 —— **owner 拍板项，开工第一件事**

| # | 缺口 | 现场证据 | 影响范围 | 建议 |
|---|---|---|---|---|
| 1 | `width` 只收 px 数，无 `stretch` 模式 | Sidebar 账户切换是 `left-2 right-2` 撑满容器；showcase 里靠硬传 204（容器 220−2×8） | Sidebar 账户切换（1 处，但换容器就漂） | **补** `width: 'stretch'`。几行代码 |
| 2 | `custom` 行不进键盘序列 | 富行（图标+副标题+右侧元信息）只能走 `custom` → 那颗菜单**没有 ↑↓** | ModelPicker / ChatHistoryPopover / 「+」菜单等富内容菜单 | **补**，走「rich action 行」——**不要**让 `custom` 可聚焦，那会让逃生舱承担无障碍语义 |
| 3 | 无垂直翻转 | `MonthView.tsx:240-268` 是全仓唯一自实现 flip；ModelPicker 向上展开；`.sb-pop` 写死 bottom | 日历月视图底部 / ModelPicker / 状态栏 | **补**。不补则底部场景退化成「面板内滚动」，很难用 |
| 4 | Esc 无层级栈，只 `stopPropagation` | `recipient-detail.tsx:44-51` 用 capture-phase + `stopImmediatePropagation` 防冒泡关掉整个 composer | 1-2 处 | **不补**，让这些场景保留自己的 capture 拦截。全局 Esc 栈是跨组件大件，为一两个场景不值 |
| 5 | `absolute` 不 portal，z-40 硬编码 | ⚠️ 见下方「两条已失效的依据」 | 待实测 | **补成 opt-in `portal?: boolean`，默认 false**（低成本保险），但**不当作 Wave 2 的阻塞前置** |
| 6 | 行上没有 `onMouseDown preventDefault` 开关 | TipTap 选区：trigger 侧现实现已 preventDefault，但基座**面板内的行**是 `<button>`，点击前抢焦点 | Composer 全部文字工具（4 下拉 + 2 色板 + 表格） | **补**。不补就无法迁 composer，而那正是重灾区 |
| 7 | 材质只有 solid 一档 | ⚠️ 见下方「两条已失效的依据」 | — | **降级为迁移时的视觉复核项**，不是拍板项 |

### 🔴 两条已失效的依据（盘点底稿写于 main 的两笔主题 commit 之前，别照抄它的结论）

盘点是在 worktree 分支（基线 main@`901ab48d`）上做的，而 main 当天又落了主题 v3「原生材质」的 `42d6c5ad` / `113764ac`。核实（2026-08-05）：

- **材质已经收敛**：`.glass-pop` 现在是 `background-color: rgb(var(--ink-2))` —— **不透明**，与基座的 `bg-popover` **同值**。底稿硬约束 C1 说的「材质 5 档并存、基座必须有 surface 开关」**不再成立**，基座单档 solid 就是对的。剩下的真实差异只有 **shadow / border 档位**（`.glass-pop` = `--pop-shadow` + `--hairline`，基座 = `--popmenu-shadow-elev`）和 FolderPicker 的 `bg-ink-1`——这是迁移时看一眼观感的事，不需要 owner 拍板。
- **portal 的原始理由没了**：`AccentPickerPopover.tsx:112-119` 说「TitleBar 的 `.glass` 用 backdrop-filter 造 stacking context」，但 v3 把 blur 退役后 `.glass` / `.glass-bar` **只剩 `background-color`**，不再造 stacking context。`.theme-popover` 本身是 `position:fixed; z-index:60`。**Wave 2 要现场实测**（去掉 portal 看会不会被盖/被裁）再决定开不开，不要凭旧注释结论直接照搬 portal。

**所以真正要 owner 拍的只有 4 条：#1 / #2 / #3 / #6**（都建议补），外加 #4 建议不补。#5 顺手补个 opt-in prop，#7 不用管。

**拍板产出**：把上表「建议」列改成「决定」列写回本文件，再开 Wave 0。

---

## 4. 迁移波次（按文件域切分，域之间零重叠 → 可并行）

### Wave 0 — 基座补能力（**必须先做，独占**）
- 文件域：`ui/Popmenu.tsx` + `index.css` 的 `.popmenu-*` 块 + `tests/shared/components/ui/Popmenu.test.tsx` + showcase 对应卡
- 按第 3 节的决定实现（建议方案下 = 1/2/3/5/6/7 补，4 不补）
- 验收：新能力各有单测；`EmailListHeader` 那唯一的存量消费者行为**字节级不变**（回归测试必须全绿）

### Wave 1 — 「纯收益」散落手搓菜单（今天缺 Esc / outside-click / 键盘，迁过去只赚不赔）
全部路径以 `frontend/src/shared/` 为前缀：

| 场景 | 文件 | 现状病灶 |
|---|---|---|
| 重要性下拉 | `components/email/compose/ComposePanel.tsx`（`ImportanceSelect`） | **最脆**：`onBlur` + 120ms 定时器关闭，无 outside-click / Esc / 键盘 |
| 文件夹管理 ⋯ | `components/settings/parts/FolderPicker.tsx` | 无 outside-click 无 Esc；z-20；实心 `bg-ink-1` |
| 日历筛选 | `components/calendar/CalendarToolbar.tsx` | 无键盘；z-30；仅 `calendars>1` 时渲染 |
| 停靠模式菜单 | `assistant/modal/AssistantChatModal.tsx`（`ModeMenu`） | 无 Esc 无键盘 |
| 浮窗会话历史 | `assistant/modal/ChatModalHistoryDropdown.tsx` | 与 `ChatHistoryPopover` 是同一件事的第二套实现 |
| 回复分裂菜单 | `components/email/EmailToolbar.tsx` | 🔴 **故意实心**（注释是活的：v3 后底色已同值，但那条更轻的 shadow 仍要保） |
- 互不相干 → **3-4 个 agent 可并行**

### Wave 2 — TitleBar / Sidebar 族（依赖缺口 1；#5 只是可能用到）
`shared/components/layout/` 下：`AccentPickerPopover` · `SurfacePickerPopover` · `ThemePickerPopover` · `SystemAlertBadge` · `AccountSwitcherPopover`；外加 `shared/components/agents/AgentPendingBadge.tsx`
- **一个 agent 串着做**：同族共享 `.theme-popover` 几何 + `useExitAnimation`，切一个等于切一族
- 🔴 **第一步是实测 portal 还需不需要**（v3 退役 blur 后旧理由已失效，见第 3 节）。需要就用缺口 5 的 opt-in prop，不需要就别引 portal —— 白拿「跟随滚动」
- 其余硬约束：`WebkitAppRegion: no-drag` 透传 · 账户切换有「先展开侧栏、延迟一 tick 再开弹层」的时序 + 折叠态专门 CSS · `AgentPendingBadge` 的「开才拉」懒加载语义要保 · `SurfacePickerPopover` 用 inline 宽 220 覆盖 `.theme-popover` 的 264

### Wave 3 — Chat 面板族（依赖缺口 2 + 3）
`shared/assistant/components/ModelPicker.tsx` · `shared/assistant/components/ComposerPlusMenu.tsx`（+ `ConnectorQuickPanel`）· `shared/assistant/components/ApprovalModePicker.tsx` · `shared/components/chat/ChatHistoryPopover.tsx` · `shared/components/chat/MentionPopover.tsx`
- 硬约束：ModelPicker 的布局红线（面板 360px / 右缘 348 手算，见文件头 23-27 行）换成基座自动碰撞后**要逐个复核** · 「+」菜单 toggle **必须走 `close()` 重置 view**（61-66 血泪）+ `input file` 挂 wrapper 外 · ApprovalModePicker 的居中锚定是越界补丁不是设计，迁移后应该能删 · MentionPopover 是 **combobox 焦点模型**（焦点留 input），与基座的 menu 模型不同，要么走 `children` 逃生舱要么单独判定
- `ModelDetailCard`（模型能力卡）**不迁** —— 见第 5 节

### Wave 4 — Composer 编辑器族（依赖缺口 6）
`shared/components/email/compose/ComposeEditor.tsx`：4 个下拉（段落/字体/字号/行距）· 2 个色板 · 插入表格 · InlineInputBox
- 硬约束：`<input type=color>` **必须挂在 Popover 外**（系统取色面板会关掉 popover，155-158 注释是血泪）· 不用原生 `<select>` 是因为 Electron modal 会误关 backdrop（263-264）· InlineInputBox 今天 z-20 过低且无 outside-click，迁移顺手修
- 同目录的 `RecipientField.tsx`（收件人自动补全）与 `recipient-detail.tsx`（chip 详情卡）**单独判定**：前者是完整 combobox a11y（`aria-activedescendant`），后者要保 capture-phase Esc

### Wave 5 —（可选）剩余 + Radix Select 家族收敛
- `views/MonthView.tsx:293`（依赖缺口 3 的垂直翻转）
- 设置页 `AiTab.tsx:290-372`（trigger 手抄 `SelectTrigger` 类名字符串，迁移顺手收敛）
- ⚠️ Radix Select 共 **14 处**：它们自带 **typeahead**（敲首字母跳选项）和「选中项对齐触发器」定位，基座**都没有**。批量迁之前先确认没人依赖这两条，否则这一波不做

---

## 5. 不迁清单（5 类，理由已确认，别再来一遍）

| 场景 | 不迁理由 |
|---|---|
| `agents/AgentTriggerPopover.tsx:155`（assistant-ui `Unstable_TriggerPopover`） | 行为整个在库里（trigger 解析/定位/键盘）。换基座 = 重写 AgentComposer 的 trigger 适配层，是独立一件事 |
| 原生 `<select>`（`ScheduleBuilder.tsx` ×6 等） | 418 项 IANA 时区，注释写明**故意用原生**；自绘弹层必须虚拟化才不掉帧，基座是纯 DOM 列表 |
| TipTap slash / @mention（`compose/editor-suggest.tsx`） | 锚点是 **caret rect** 不是 DOM 元素，基座的 `absolute + triggerRef` 模型接不上。壳可以换，但要先给基座加「virtual anchor」定位 |
| `ModelDetailCard.tsx`（模型能力卡） | 三条硬要求同时不成立：必须 portal（双层 overflow hidden）· 必须 `pointer-events-none`（否则会把模型选择器 outside-click 误关）· 锚在弹层底边而不是某个 trigger。**它是 hover 卡不是菜单** |
| `HoverTip` / Radix `Tooltip` | Popmenu 是「点击打开、吃焦点、`role=menu`」；tooltip 是「hover 显示、绝不吃焦点」。合并会把 tooltip 变成可聚焦元素。要不要把 HoverTip 与 Radix Tooltip 双轨收成一套，是另一件事 |

---

## 6. 每波通用验收标准

1. **键盘可达**：↑↓ 走行 · Esc 关（或返回上层）· Tab 关 · 有子面板的 →/Enter 进、←/Backspace 回。
2. **outside-click 关**，且不误关外层（尤其 composer / 模态里的嵌套弹层）。
3. **不越界**：右缘与底缘在窄窗口下都不出血；替换掉的每一处**手算 align** 都要人眼复核一遍（盘点硬约束 C7）。
4. **材质与主题**：light / dark 两档都看。底色现在全仓已统一到 `--ink-2`，要盯的是 **shadow / border 档位**别跳档（例如回复分裂菜单那条「比浮层档更轻的 shadow」是活的，注释里写着）。
5. **原文件注释里的历史约束逐条保留** —— 每个手搓弹层的注释里都埋着一次线上 bug，迁移前必读那几行（第 4 节已把主要的摘出来了）。
6. **showcase 同步**：迁完一个场景，把 showcase 对应卡的「现状」备注改成已迁（或删卡），别让审批物与现实漂移。
7. **退出码为准**：`npx vitest run <改动涉及的测试>` + `npx tsc -p tsconfig.web.json --noEmit`，都要 0。

---

## 7. 工作方式与已知坑

- **在 main 上做**（worktree 已合并且不再使用）。开工时 `git status` 看一眼：2026-08-05 主仓有**另一 session 在途的流式优化改动**（`ai-gateway/chatRun.ts` / `email/TranslatedBody.tsx` / `email/streamWipe*.tsx` 删除）——与本任务文件域不重叠，**不要碰、不要 stash**。
- **验证姿势**（dev，不必出包）：退出 `.app` 释放 8200 →
  ```bash
  MAILAGENT_API_DEV=true MAILAGENT_API_DEV_CORS=true MAILAGENT_API_AUTH_DISABLED=true \
  MAILAGENT_DATA_ROOT="$HOME/Library/Application Support/mailagent-frontend" \
  MAILAGENT_ENV_FILE="$HOME/Library/Application Support/mailagent-frontend/.env" \
  venv/bin/python -c "from src.cli.main import app; app(prog_name='mailagent')" serve-api
  ```
  另一终端 `cd frontend && pnpm dev`。🔴 `MAILAGENT_API_AUTH_DISABLED=true` 必须配 `MAILAGENT_API_DEV=true`，否则 serve-api 直接 `RuntimeError` 拒启。dev 不拉同步 watcher，底部「重连中」是预期不是 bug。
- 🔴 **ABI**：`pnpm test` 会把 better-sqlite3 翻成 Node ABI（正在跑的 dev Electron 会当场崩），`pnpm dev` 会翻回 Electron ABI。并行跑测试时用 `npx vitest run <paths> --no-file-parallelism` 并避开 `tests/main`。
- 多 agent 并行跑测试时机器争抢会让 import 阶段超时（实测 57s / 485s）→ 一片假红。怀疑假红就单独重跑那几个文件确认。
- 动效：基座用 motion@12。仓内并存 3 套动效（GSAP `useExitAnimation` / tailwindcss-animate / CSS transition），**reduced-motion 只有前两套处理过**，迁移时别把某个场景的 reduced-motion 短路弄丢。

---

## 8. 相关

- 证据底稿：`research/popover-inventory-0805.md`
- 前序批次记录：merge `5d5a0e73`（核心体验四件套 + dogfood 轮，11 commit）
- 设计体系约束：`frontend/DESIGN.md`（v3 原生材质：圆角四档 / 选中签名 / 动效红线）· `frontend/docs/motion-gsap.md`

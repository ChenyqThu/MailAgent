# 主题 v3「原生材质」——设计规范调整 + 迁移清单 + 落地指导（Review 稿）

> **状态：待 owner review，未落地。** Review 通过后才动 `index.css` / `frontend/DESIGN.md` 等常青文档与代码。
> 来源：2026-07 设计风格调研（5 候选 → **B「原生材质」** 敲定）+ 两轮交互 prototype 确认（收件箱 / AI 会话 / 设置·外观 / 设置·AI × 毛玻璃/实色 × 6 accent × 亮暗）。
> prototype 存档：`~/Downloads/mailagent-b-prototype.html`（自包含单文件，双击可开）。

---

## 0. 定位与总原则

- **v3 是 v2（毛玻璃主题）的降噪进化，不是推倒重来。** 材质架构（OS vibrancy 扛模糊 + 四档 tier overlay + `data-glass` 三档气质 + 实色回退档）、6 accent、亮暗双主题全部保留。
- 变化集中在三类：**静态装饰退役**（噪点/镜面高光/辉光）、**选中态药丸化**（保留左侧 accent 条签名）、**信号色收敛**（accent 只做信号，未读文字回归前景色）。
- **owner 已拍板的三条红线**：
  1. 主菜单（及全 app）选中项**左侧 accent 高亮条保留**，只去辉光；
  2. **全部交互动效保留**（清单见 §4），允许统一缓动/时长的细节优化；
  3. 布局结构不动。

---

## 1. 决策总表：变什么 / 不变什么

### 不变（明确保留）

| 项 | 说明 |
|---|---|
| 布局 | 240(56) sidebar + 344 list + flex detail；titlebar 38 / statusbar 25；chat 260+44rem；settings 200+760 |
| 材质架构 | OS vibrancy 唯一 blur 层 + `body::before` tint + `.glass/.glass-2/.glass-3/.glass-bar/.glass-panel` 四档 overlay + `.glass-pop` 浮层 blur(20px)；`data-surface` 实色档；`data-glass` 银纱/染色/亮砂 |
| 强调色体系 | 6 accent（coral 默认）× 亮暗双导出；`--acc` 单变量派生一切 accent 用色 |
| 选中签名 | **左侧 3px accent 竖条**（sidebar nav / 邮件行 / chat SessionRow 全局一致），仅去 `box-shadow` 辉光 |
| mono 元信息 | 时间戳 / AI-strip / 计数 / 分组头 / 状态栏等 mono + `tabular-nums` 不动 |
| 彩色头像 | 6 槽渐变首字母头像视觉不变（仅后续批次把 hex 收编 token，见 §3-9） |
| AI-strip 形态 | 「点 + 大写词 + · + 动作」结构不变（只收编颜色 token） |
| 交互动效 | **全量保留**，见 §4 红线清单 |
| 无障碍 | `prefers-reduced-motion` 覆盖、light 模式 accent 深色导出过 AA |

### 变（v3 核心改动）

| # | 项 | 现状 | v3 |
|---|---|---|---|
| C1 | 噪点层 | `.grain` fixed SVG turbulence，`--grain: 0.07` | **退役删除**（DOM + CSS + knob 项） |
| C2 | 镜面高光 | `.specular::after` titlebar 上沿 1px 白光 | **退役删除** |
| C3 | 辉光 | 选中条 `0 0 9px accent/.55`、CTA `0 0 18px var(--acc-glow)`、tab 下划线 glow | **静态装饰辉光全线退役**（solid 档现有的「收辉光」逻辑升级为全档默认）。注意：composer BorderGlow 属交互反馈，**不在退役范围** |
| C4 | 邮件行选中态 | 通栏 full-bleed wash + 左条带辉光 | **药丸化**：行 `margin: 1px 6px` + `radius 9px` + accent wash 渐变（13%→5% 向右衰减）+ 左条保留（去辉光，随药丸圆角贴内侧） |
| C5 | sidebar nav 选中 | `.row-selected .acc-select` accent wash + 左光条 | 同 C4：pill 背景（`--acc` 10-13% wash）+ 左条保留去辉光；计数徽章 `.acc-pill` 不变 |
| C6 | 未读表达 | 发件人/主题/时间 **accent 色** + 加粗 + 左侧 accent 圆点 | 圆点保留 accent；**文字回归前景色**（`--ink-fg`）+ weight 650。accent 只做信号不做正文着色 |
| C7 | CTA 按钮 | `.acc-cta` 渐变 + inset 高光 + 外辉光 | 渐变 + inset 高光**保留**，外辉光去除 |
| C8 | 圆角刻度 | 散落（5/8/10/14/999px 混用） | 统一四档：**控件 8 / 行药丸 9 / 卡片 12 / 浮层 14**（胶囊 999、头像 50% 特例不变）+ 同心圆角原则（外 = 内 + padding） |
| C9 | 硬编码 hex 收编 | AI-strip 优先级色 / 头像渐变 / 旗标 wash 绿等写死 hex | 全部收编到既有 token（`--c-crit/--c-ok` 等），视觉不变的机械批次 |
| C10 | hairline | `--hairline` 双套已有 | 保留，但行分隔在药丸化后仅保留分组间；行间靠间距 + wash 区分 |
| C11 | 工艺基线补齐 | 部分组件缺 | 图片/头像 1px 中性描边（亮 `rgba(0,0,0,.1)` / 暗 `rgba(255,255,255,.1)`）、按压 `:active scale(0.97)` 全交互面、聚焦 ring 统一 `--acc` |

---

## 2. Token 层规范调整（`frontend/src/electron/renderer/index.css` 增量）

> 原则：**只增删变量与引用，不动变量命名体系**；`data-accent / data-theme / data-glass / data-surface` 四轴语义不变，用户已有偏好（localStorage + 高级 glass knob）无痛升级。

### 2.1 删除 / 置空

```
--grain                        → 删（连带 .grain 规则 index.css:901-912、App 挂载、设置页「噪点强度」knob 行）
.specular::after               → 删（index.css:915-939；TitleBar 的 specular class 引用同步摘除）
--acc-glow                     → 删；其引用点改为无辉光：
  ├ .email-row.is-selected::before 的 box-shadow（:1469-1538）
  ├ .acc-cta / .btn-cta 的 `0 0 18px` 段
  └ .inbox-tabs indicator 下划线 glow（:2145-2195）
:root[data-surface='solid'] 的「收辉光」特判（:1053-1061）→ 简化（辉光已全局无）
```

### 2.2 新增 / 调整

```css
/* 圆角刻度（新增，全局唯一来源） */
--r-ctl: 8px;      /* 按钮/输入/nav 项/工具钮 */
--r-row: 9px;      /* 列表行药丸（邮件行/会话行） */
--r-card: 12px;    /* AI Fields 卡/审批卡/tile */
--r-pop: 14px;     /* .glass-pop 浮层 */

/* 选中态（新增） */
--sel-wash: linear-gradient(90deg,
  color-mix(in srgb, var(--A) 13%, transparent),
  color-mix(in srgb, var(--A) 5%, transparent));   /* 暗色 16%/6% */
--sel-bar-w: 3px;                                   /* 左条保留，无 glow */

/* 未读（调整语义，不新增变量） */
.email-row[data-read='false'] .sender-name/.subject-text:
  color: rgb(var(--ink-fg)); font-weight: 650;      /* 原 accent 色 → 前景色 */
  （unread 圆点、.acc 计数徽章仍走 --c-accent）

/* 动效缓动 token（新增，供 §4 统一优化用） */
--ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1);
--ease-move:       cubic-bezier(0.77, 0, 0.175, 1);
（时长沿用 tailwind 已有 fast 120 / base 220 / slow 380）
```

### 2.3 收编（视觉不变）

```
AI-strip 优先级色（:2036-2070 写死 hex）→ 引用 --c-crit/--c-urg/--c-impt/--c-norm/--c-low
旗标 done 绿 #5dba8c（:1836-1856 与 .ricon 三态）→ --c-ok
头像 6 槽渐变（:1618-1656）→ 提为 --avatar-1a/-1b … 变量对（值照抄，纯收编）
```

### 2.4 明确不动

`--ink-*` 中性刻度、`--hairline` 双套、`--pop-shadow`（浮层阴影非辉光）、`--tier-*` 四档、
`--glass-*` 全套 knob（仅删 grain 一项）、`--wp-fallback`、6 accent 定义、亮色导出、
shadcn 兼容变量区、settings 尺寸变量区。

---

## 3. 组件迁移清单（现状 → v3）

> 工作量：S ≤ 半天 · M ≈ 1 天 · 含测试更新。行号为当前 `index.css` / 组件文件参考位。

| # | 组件 | 文件 | 改动 | 量 |
|---|---|---|---|---|
| 1 | 全局 token | `index.css` :root / light / accents 区 | §2 全部增删 | M |
| 2 | 邮件行 EmailRow | `index.css:1428-2070` + `EmailRow.tsx` | 药丸化（margin/radius/wash）；选中左条去辉光；未读文字色 C6；旗标 wash 值随药丸收窄；`.is-selected` 类名**不改**（e2e 依赖） | M |
| 3 | Sidebar nav | `Sidebar.tsx`（`.row-selected .acc-select / .acc-pill / .nav-collapsed-badge`） | C5 pill+左条；徽章/收起态不变 | S |
| 4 | TitleBar | `TitleBar.tsx` | 摘 `specular`；搜索钮圆角 → `--r-ctl` | S |
| 5 | 噪点层 | `App.tsx` 挂载点 + `index.css:901-912` + 设置页 knob 行 | C1 整体退役 | S |
| 6 | CTA 族 | `.acc-cta/.btn-cta` + compose 按钮 | C7 去外辉光 | S |
| 7 | inbox tabs 胶囊 | `EmailListHeader.tsx` + `index.css:2145-2195` | GSAP indicator 保留；下划线 glow 去除 | S |
| 8 | AI-strip / 优先级色 | `index.css:2036-2070` | C9 收编 token（过滤弹窗已 token，两处归一源） | S |
| 9 | 头像 | `index.css:1618-1656` | C9 收编（可选批次，视觉零变化） | S |
| 10 | 详情 AI Fields 卡 | `EmailDetail.tsx` | 圆角 → `--r-card`；余不动 | S |
| 11 | Chat 全家 | `AgentThread/AgentComposer/AgentMessage/_cardShell/SessionRow` | **动效零改动**；CardFrame/审批卡圆角 → `--r-card`；composer 圆角 16 保持（BorderGlow 随形）；SessionRow 选中同 C5 | S |
| 12 | Settings | `SettingsShell/GeneralTab/AiTab/parts/*` | tile 圆角对齐 `--r-card` 视觉核对；「噪点强度」knob 行删除；Switch/swatch/RadioRow 不动 | S |
| 13 | 浮层 .glass-pop | `index.css:884-890` | 圆角 → `--r-pop`；blur/阴影不动 | S |
| 14 | StatusBar | — | 不动 | — |
| 15 | 官网 tokens 同步 | `site/src/styles/tokens.css` | 派生值更新 + `pnpm check:tokens` 过闸 | S |
| 16 | 常青文档 | `frontend/DESIGN.md` + `frontend/ARCHITECTURE.md` §7.x + `frontend/docs/motion-gsap.md` + CLAUDE.md 文档地图行 | v3 规范落稿（含 §4 动效红线清单） | S |

---

## 4. 动效保留清单（迁移红线：任何批次不得丢失）

**保留（原样）**
- 动态图标系统：主菜单 / 设置 rail / 邮件工具栏的 animated icons（hover 微动效）。
- Chat `AgentStrandsBackdrop` 丝线 canvas 背景。
- Composer `BorderGlow`（hover mesh 彩虹边 + 辉光环）——定性为**交互反馈**，与 C3 静态装饰辉光退役不冲突。
- `ShimmerText`（思考中…流光）、`DotMatrix` connecting 点阵、`ThinkingPhrases` 轮播。
- GSAP：inbox tabs indicator 滑动、settings panel 淡入（autoAlpha+y）、thinking 块 height auto↔0、`frontend/docs/motion-gsap.md` §8 全部现有编排。
- 侧栏收起 `transition-[width]`（240↔56 / chat 260↔48）——布局属性动画为产品既有行为，保留。
- 行 hover / 按压反馈、审批卡 phase pill 状态切换。
- 列表性能铁律（`frontend/ARCHITECTURE.md` §7.1-7.2）不受本次影响。

**允许的优化（不改行为，只改参数）**
- 缓动统一：UI 过渡归一 `--ease-out-strong`，位移/morph 用 `--ease-move`；禁 `ease-in` / `transition: all` / 回弹（新代码）。
- 时长贴档：120/220/380ms 三档；UI 动画 < 300ms。
- 高频键盘动作（j/k 导航、归档、切会话）维持零动画。
- 进出场不对称（进慢出快）、popover `transform-origin` 对齐触发点——按 emil 基线逐步补齐，不作为本次批次阻塞项。
- `prefers-reduced-motion` 逐动效复核。

---

## 5. 分批落地计划

> 不做 feature flag：v2→v3 是同体系演进、纯前端 CSS/TS，**每批一个 atomic commit，应急回滚 = revert 对应 commit**。全程在 main 常规流程走（或单独 worktree 分支合入，随你习惯）。

| 批 | 内容（对应 §3 行） | 验证 |
|---|---|---|
| 0 | Token 增量 + grain/specular/辉光退役 + CTA（1/4/5/6/7/13） | 截图矩阵：4 视图 × 亮暗 × 毛玻璃/实色 × coral/cobalt；`pnpm test`；`pnpm dev` 实机过一遍 |
| 1 | EmailRow 药丸化 + 未读色 + wash（2） | 同上 + e2e 列表断言更新；light 模式 wash 上文字对比度 AA 复测 |
| 2 | Sidebar / tabs / 工具栏（3/7） | 实机验证收起态 + 选中态 |
| 3 | hex 收编 token（8/9）——**视觉零变化批** | 截图 pixel-diff 应为零；机械 review |
| 4 | Chat / Settings / 浮层圆角对齐（10/11/12） | chat 动效逐项点验（§4 清单当 checklist 用） |
| 5 | 官网 tokens 同步 + 常青文档落稿（15/16） | `pnpm check:tokens`；文档地图加行 |

**每批仪式**（依既有项目纪律）：改动后 `pnpm dev` 实机验证渲染（不凭 CSS 原理宣布完成）→ vitest（含 electron-as-node runner）→ 涉及列表的批跑 e2e（跑前退生产 App，防单实例锁）→ atomic commit。
**打包注意**：纯前端改动不需重 provision venv；发版仍走 CI tag 流程；跑过 `pnpm test` 后 build 前 `pnpm rebuild:electron`。
**不涉及**：agent_eval（无 prompt/工具改动）、DB、Python 侧。

**风险与对策**
- e2e/快照依赖 `.is-selected`、`.row-selected` 等类名 → 类名全部保留，只改样式值。
- 自定义过 glass knob 的本机偏好 → knob 语义不变（仅少一项 grain），localStorage 无迁移。
- light 模式未读文字从 accent 深色改为前景色 → 对比度只升不降；wash 底上的次级文字需复测 AA。
- 官网 mock 与产品视觉短暂漂移 → 批 5 收口，`check:tokens` 闸兜底。

---

## 6. 待 review 的开放决策点

| # | 决策 | 我的建议 | 你的拍板 |
|---|---|---|---|
| D1 | 选中左条范围：仅主菜单 or 全局（邮件行/会话行同样保留） | **全局保留**（跨视图签名一致；chat SessionRow 现状本就有） | ☐ |
| D2 | 未读文字：前景色加粗（prototype 版）or 维持 accent 色 | **前景色加粗**（accent 只做信号，列表更安静） | ☐ |
| D3 | 头像 hex 收编批（§3-9）：做 or 不做 | 做（零视觉变化，还 token 债） | ☐ |
| D4 | 圆角四档数值：8 / 9 / 12 / 14 | 如表 | ☐ |
| D5 | grain 直接删 or 留应急 flag | **直接删**（git revert 兜底；knob 少一项更清爽） | ☐ |
| D6 | 批 0-5 的合入节奏：逐批合 main or 攒一个分支一次合 | 逐批合 main（每批独立可回滚） | ☐ |

---

*Review 通过后动作：按 D1-D6 拍板结果修订本文件 → 批 0 开工；`frontend/DESIGN.md` 等常青文档在批 5 随代码状态落稿，本文件转入 `docs/archive/` 存史。*

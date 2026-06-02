# MailAgent 设计系统 Review — Phase 1 (impeccable critique + V2 标准)

> 主理人亲手 review（非 subagent）。评估对象 = 设计系统本身，不是逐组件实现（后者是 Phase 2）。
> 日期 2026-06-01 · 方法 impeccable `critique`(设计) + `audit`(技术) · 评估者 Claude (Opus 4.8)

---

## 0. 范围 · 方法 · 客观证据

**评估对象**
- `DESIGN.md`（75KB / 17 章，当前 SSoT）+ `ref/DESIGN.md`（92KB，早期 designer 全量版）
- `src/electron/renderer/index.css`（4243 行，token + authored CSS 的真正 SSoT）
- `tailwind.config.ts`（token 绑定层）
- `eslint-rules/`（9 条 `mailagent/*` design lint）
- 组件库：`src/shared/components/` 13 域 / 111 组件

**客观证据（硬数据，非主观）**

| 指标 | 实测值 | 解读 |
|---|---|---|
| `pnpm a11y:contrast` | **0 violations** | 颜色系统 WCAG AA 全过（dark+light×6 accent=12 组合） |
| design lint (`mailagent/*`) | **9 条全 `error`** | non-negotiables 真落地为 CI gate，非文档承诺 |
| Tailwind 响应式前缀(`sm:`/`md:`/`lg:`) | **10 处 / 111 组件** | 响应式覆盖近乎为零 |
| CSS `@media (min/max-width)` 断点 | **0 个** | 无任何尺寸断点（只有 reduced-motion/transparency） |
| 固定 px 宽度(`w-[Npx]`) | **75 处** | 纯桌面固定布局 |
| 组件实际域 vs DESIGN.md 收录 | 13 域 / 文档约 7 | calendar(14)·folder(7)·command·llm·admin 等未收录 |

**live 实测**（dev serve-api :8201，主仓库真实 9311 封，auth-disabled）
- 桌面 1440×900 深色 + Coral：渲染健康，三栏布局/真实数据/AI chip/头像/详情正文全正常（[live-inbox-01.png](./live-inbox-01.png)）
- 移动 390×844：三栏布局**彻底 break** —— 详情栏溢出屏外、titlebar "全文搜索"竖排折行、statusbar 各段重叠、AI chip 截断、出现横向滚动、侧栏仍占 240px 不 collapse（[live-inbox-mobile-390.png](./live-inbox-mobile-390.png)）

---

## 1. Anti-Patterns Verdict（impeccable 必答：这看起来像 AI 生成的吗？）

**判定：NOT AI slop。零 AI tell。** 这是 designer-grade 的专业工具美学，且把品味 codify 成了 CI 强制。

- ❌ 无 AI 色板：主调 Coral，`blue-*`/`purple-*`/`indigo-*` 被 `no-banned-colors` lint 禁死
- ❌ 无 gradient text / hero metrics / card-grid 堆砌：信息密度优先（EmailRow 单行为单元）
- ❌ 无 glassmorphism 滥用：Liquid Glass 是 intentional 材质系统，且 `prefers-reduced-transparency` 下降级为 solid
- ❌ 无 generic font：SF Pro Text + PingFang SC（macOS 原生 Han 字体，"feels native"信号）
- ✅ 一个决定性 flourish（灵动岛），其余皆减法 —— 符合自己定的哲学

**这一节本可以是大多数项目的重灾区，这里是满分。** 设计系统的"反 slop 免疫"不是靠自觉，而是靠 9 条 lint + a11y CI + REVIEW-LOG 纪律固化下来的——这是它最该被复制的资产。

---

## 2. 卓越之处（先 celebrate —— 这些是要在 Phase 2 守住、向新域复制的基准）

1. **token 三层解耦**：`ink-*`(surface 6 级) / `ink-fg-*`(foreground 4 级) / `--c-accent`(accent) 三层独立，channels-only RGB triplet 支持 `rgb(var(--x)/<alpha>)` alpha 修饰。一个变量 swap 重皮全 UI，无组件级 override。
2. **a11y 工程纪律（行业稀有）**：每个色值都有 REVIEW-LOG 追溯（H-01/C-08…）；CTA-on-accent foreground 按 light/dark **逐模式翻转**（dark 近黑 / light 纯白）以双向过 AA；chip 调色板 per-mode 分裂亮度。`contrast=0 violations` 是结果。
3. **9 条 design lint 全 `error`**：把"不准 raw hex / 不准 banned color / 不准大圆角 / 不准渐变底 / 不准重阴影 / 不准灰阶 surface / 不准 coral flood / 不准 mono 字号塞中文 / 不准组件内 prefers-color-scheme"全部变成 CI 失败项。**这是把设计 SSoT 落地为机器可验证契约的范本。**
4. **几何 SSoT 模式**：EmailRow（`--avatar-size`/`--chevron-col-w`/`--unread-dot-*`）、Settings（`--settings-*`/`--tog-*`/`--slider-*`）的几何参数集中在 `:root`，改一处全局 follow，注释解释每个 magic number 的推导。
5. **motion 收口**：3 duration（120/220/380）+ 单 standard 曲线，禁 spring/bounce/parallax；历史第二曲线已在 GSAP 引入时全量绞杀对齐。
6. **i18n + 主题三态规范深度**：FOUC inline bootstrap（首帧前生效）、op-id + rAF race guard（手切 vs OS 切并发收敛到最后一次）、`Intl` 边界、resolver(system→具体 locale)。这些是多数团队会漏的硬骨头。

---

## 3. 核心问题（critique · P0-P3 · 每条带证据 + V2 动作）

### 🔴 P0 — 响应式系统真空（产品已上线 web 远程访问，设计系统当它不存在）

**证据**：响应式前缀 10/111 · CSS 断点 0 · 固定宽度 75 · 390px 实锤 break 截图。DESIGN.md 全文唯一响应式提及是 §15 Q1（"AI panel 360px 在 1280 窄屏 awkward"，且 still open）。

**为什么是 P0**：V2 远程访问（`mail.chenge.ink/app`）已 dogfood 上线，**明确支持 iPhone/iPad 浏览器访问**（web SPA 有 `viewport width=device-width`，截图就是手机访问场景）。但布局是桌面固定三栏，窄屏不可用。impeccable persona **Casey（移动用户）完全 fail**；**Sam（200% 缩放）大概率 fail**。这不是 polish，是一个已发布入口的功能性破损。

**V2 动作**：新增「§18 响应式系统」——断点 token（如 `sm 640 / md 768 / lg 1024 / xl 1280`）、三栏→列表→详情的堆叠降级矩阵、侧栏在 <lg 自动 collapse/抽屉化、AI panel <1280 转 drawer overlay（回填 §15 Q1）、touch target ≥44×44。Phase 2 必须把"窄屏布局降级"作为每个布局组件的 review 维度。

---

### 🟠 P1 — DESIGN.md 作为 SSoT 与产品脱节一个数量级

**证据**：§5 组件目录 + §13 项目结构停留在 mockup→production 初版。实际组件库 13 域 111 组件，文档缺失的已 ship 大块：
- `calendar/`(14 组件，日历视图/事件) — DESIGN.md **零提及**
- `folder/`(7 组件，存档/草稿箱) — **零提及**
- `settings/`(22 组件，多 tab) — 文档只写"SettingsPage 单页"
- `command/`(⌘K palette) — §5 只标"hint surface only"
- `llm/`(LLM Dashboard) + `admin/`(看板) — 数据可视化无规范
- onboarding（独立 `onboarding.css`）/ compose（TipTap 回复转发）/ 远程 web target — 全缺
- 实际是 `src/shared/components` + `src/electron` + `src/web` 三分；文档 §13 写 `src/components`

**为什么是 P1**：设计决策已散落到 `ANIMATION-GSAP-HANDOFF` / `MASCOT-SPEC` / `MOTION-PERF-HANDOFF` / `docs/calendar-module-prd` 等多个 handoff，DESIGN.md 不再是单一权威。新组件 review 时"对照哪条规范"无答案 → drift 自我加速。

**V2 动作**：§5 组件目录从"mockup 映射表"升级为「实际域 × 规范指针」表（13 域，每域指向其规范来源——DESIGN.md 章节或外部 handoff）。缺规范的域（calendar/folder/dashboard/onboarding）补最小设计契约或显式指针。

---

### 🟠 P1 — "Dark is canonical" 哲学与三态现实倒挂

**证据**：§1.3 铁律 5「Dark is the canonical mode. Light is a token swap」+ §15 Q5「light 视觉允许 unpolished」。但 §17 已把主题升级为**三态（system 默认）**，`a11y:contrast` 对 light/dark **平权** 验证 12 组合，web 默认浅色（截图 statusbar 显示"主题 浅色"）。

**为什么是 P1**：哲学层（铁律）还写 dark-first，落地层（§17 + lint + a11y CI）已 light/dark 一等公民。Review 一个新组件时，"light 态可以糊"还是"light 必须等价精修"——文档自相矛盾。

**V2 动作**：改写铁律 5 为「light / dark 平权，system 默认；两模式均为一等公民，新组件必须双模式精修」。删除/归档 §15 Q5 的"unpolished 豁免"。

---

### 🟡 P2 — accent 预算规则未随表面膨胀更新

**证据**：§2.2「accent 每个 major surface ≤4 处」是在 `mockup-inbox.html` 单屏定的，并列了该屏的 4 处 inventory。产品现新增 settings/calendar/dashboard/admin/compose 等大量表面，预算未重新 catalog。

**V2 动作**：accent 预算从"全局 ≤4"细化为「每类表面预算表」（inbox / detail / settings / dashboard / calendar 各自的 accent inventory 上限）。Phase 2 live 逐屏核查实际 coral 密度是否超标。

---

### 🟡 P2 — §15 open questions 一年未闭环

**证据**：Q1(AI panel 窄屏)/Q2(batch bar 高度)/Q3(backend selector 形态)/Q4(pinned conversation 存储) 是立项期开放问题，产品已演进但文档未回填决策。

**V2 动作**：open questions 区改为「决策记录」——每条回填现状答案或标 `superseded by Sprint X`。Q1 并入 P0 响应式一起解。

---

### 🟢 P3 — 覆盖盲区细项

- LLM Dashboard / 看板 Admin 的**图表/表格/数据密度**无 token 规范（颜色/网格/数轴留给实现自由发挥 → 易 drift）。
- Command palette 实际是核心交互入口，§5 仅"hint surface"一句带过。
- `MASCOT-SPEC.md`（吉祥物）独立于 DESIGN.md，未说明它在设计语言中的位置。

**V2 动作**：补「数据可视化 token」最小集（图表配色复用 priority/sync ramp、网格线用 `ink-border-soft`、数字 tabular-nums）。其余标指针即可，不必全量纳入。

---

## 4. 优化后的设计系统标准 V2（= Phase 2 的 review 基准）

> 以下是「增量 spec」。Phase 2 的 subagent 拿它 + impeccable audit/critique 做逐域 review 的 rubric。
> 不重写 75KB DESIGN.md（那是 Phase 3 实施项）；这里定**新基准**。

**4.1 响应式断点系统（新增 · 最高优先）**
- 断点 token：`sm 640 / md 768 / lg 1024 / xl 1280 / 2xl 1536`
- 布局降级矩阵：≥xl 三栏 / lg-xl 列表+详情(AI panel→drawer) / md-lg 单栏+详情抽屉 / <md 移动单栏堆叠
- 侧栏：<lg 自动 collapse 到 56px 图标轨；<md 转 off-canvas 抽屉
- touch target：交互元素 ≥44×44（当前 row action `ricon` 22px，移动态需放大）
- 检验：390 / 768 / 1024 / 1440 四档无横向滚动、无重叠、无截断

**4.2 组件域 × 规范指针表（替换 §5/§13）**

| 域 | 组件数 | 规范来源 | 状态 |
|---|---|---|---|
| email | 14 | DESIGN.md §5.1/§5.2 + index.css EmailRow SSoT | ✅ 有 |
| chat+ai | 13 | DESIGN.md §6 | ✅ 有 |
| settings | 22 | index.css Settings 几何 SSoT | ⚠️ 仅几何，无 IA 规范 |
| layout | 18 | index.css `.app-nav` §2.11 | ⚠️ 缺响应式 |
| calendar | 14 | docs/calendar-module-prd.md | ❌ 不在 DESIGN.md |
| folder | 7 | docs/folder-ui-prd.md | ❌ 不在 DESIGN.md |
| ui | 12 | shadcn + DESIGN.md §12 | ✅ 有 |
| command/llm/admin/feedback/keyboard | 7 | 散落 | ❌ 待补 |

**4.3 哲学校正**：light/dark 平权，system 默认（见 P1）。

**4.4 accent 预算表**：每类表面独立 inventory 上限（见 P2）。

**4.5 数据可视化 token**：dashboard/admin 图表复用 priority/sync ramp + `ink-border-soft` 网格 + tabular-nums（见 P3）。

---

## 5. Phase 2 review rubric（交给每个 subagent 的 checklist）

每个组件域用以下维度评（impeccable audit 5 维 + critique + V2 基准）：

1. **响应式**（V2 §4.1）：390/768/1024 三档是否 break？固定宽度是否该流式化？touch target≥44？
2. **theming**：是否有 raw hex 漏网（lint 之外，如 inline style / SVG）？light 态是否等价精修（非 unpolished）？
3. **token 一致性**：是否复用 ink/fg/accent token，还是自造色值/间距/圆角？
4. **a11y**：focus ring 可见？键盘可达？color-not-only-signal？ARIA？
5. **accent 预算**（V2 §4.4）：本屏 coral 用量是否超表面预算？
6. **Nielsen / 认知负荷**：可见选项 ≤4/决策点？空/错/加载态完备？
7. **anti-pattern**：有无新引入的 AI tell（嵌套卡片/重阴影/灰阶 surface）？
8. **DESIGN.md 对齐**：本域有无规范？实现是否偏离或反超文档（drift 方向）？

每个 finding 标 P0-P3 + 文件:行 + 证据（截图/代码）+ 修复建议 + 对应 impeccable 子命令。

---

## 附：本次未做（诚实边界）
- 未逐组件读 111 个 tsx 实现（Phase 2 范围）
- 未实测 6 accent × 2 mode 全 12 组合的 live 视觉（Phase 2 抽样）
- 未审计灵动岛 SwiftUI overlay（非 React，独立 binary，超出 frontend review 范围）
- 响应式 break 仅实测 inbox 一屏（Phase 2 扩展到 detail/settings/search 等）

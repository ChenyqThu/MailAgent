# Onboarding 设计 Handoff + 前端设计协作协议

> 类型：设计交接 + 长期协作协议（决策级）
> 日期：2026-05-29
> 受众：**Claude design**（产出设计）↔ **Claude Code（实现侧）**
> 用途：① 把 onboarding 流程交给 Claude design 重做；② 确立此后前端设计的真源与协作回环。

---

## 0. 怎么用这份文档

- **Claude design**：先读 §1 必读清单 → 做 §2 设计系统调和 → 在 §3 固定工程契约**之上**、按 §4 开放设计空间产出设计 → 按 §5 回传清单交付给实现侧。
- **实现侧（我）**：拿到 §5 回传物后，照着实现；§3 契约是我已落地的稳定接口，设计若要改契约需在回传物里显式标注。
- **长期**：§6 协作协议适用于 onboarding 之后所有前端设计工作。

---

## 1. 必读文档清单（路径 + 作用）

### 1.1 功能规格（设计的"做什么"来源）
| 文档 | 作用 |
|---|---|
| [`docs/packaging/03-onboarding-prd.md`](./03-onboarding-prd.md) | **onboarding 流程 PRD（主输入，587 行）**：用户分类检测矩阵、新用户 7 步流程、老用户迁移流、插件子流程、3 个状态机图、边界异常、验收标准 |
| [`docs/packaging/01-architecture-analysis.md`](./01-architecture-analysis.md) | onboarding 所处的一体化打包大背景 + §11 实机修订（serve 契约 / 双 writer / 公证 / identity:null 等约束） |
| [`docs/packaging/02-landing-plan.md`](./02-landing-plan.md) | 落地计划（P2/P3 onboarding 在路线里的位置 + 文件级落点） |

### 1.2 要对齐的现有设计系统（设计的"长什么样"基线 —— §2 调和对象）
| 文档 | 作用 |
|---|---|
| [`frontend/DESIGN.md`](../../../frontend/DESIGN.md) | **项目现有设计系统（75KB）**：色板 / token / 组件语言 / 间距 / 字体 / 暗色基调（`#0E1013` 等）。已建 18 Sprint UI 的依据 |
| [`frontend/ANIMATION-GSAP-HANDOFF.md`](../../../frontend/archive/2026-05/ANIMATION-GSAP-HANDOFF.md) + [`frontend/docs/motion-gsap.md`](../../../frontend/docs/motion-gsap.md) | 现有动效语言（GSAP §8）：缓动 / 时长 / 入场 / prefers-reduced-motion |
| [`frontend/ARCHITECTURE.md`](../../../frontend/ARCHITECTURE.md) | 渲染层架构 + §7 列表/正文/动效性能铁律（设计不能违反的运行时约束） |
| [`frontend/MOTION-PERF-HANDOFF.md`](../../../frontend/archive/2026-05/MOTION-PERF-HANDOFF.md) | 动效性能 handoff |

### 1.3 固定工程契约所在文件（设计要在其上构建，见 §3）
| 文件 | 内容 |
|---|---|
| `frontend/src/electron/main/onboarding/detect.ts` | 用户状态枚举（new / config-incomplete / configured） |
| `frontend/src/electron/main/handlers/onboarding.ts` | IPC：`onboarding:status` / `onboarding:complete` |
| `frontend/src/electron/main/index.ts` | 启动分流 + `?onboarding=1` 开窗门控 |
| `frontend/src/electron/renderer/main.tsx` | renderer 入口：读 `?onboarding=1` → 渲染向导 |
| `frontend/src/electron/renderer/OnboardingPage.tsx` | **当前占位单页实现 —— 这就是要被设计重做替换的对象** |

---

## 2. 设计系统调和（Claude design 自建 ↔ 项目 DESIGN.md）

> 背景：Claude design 那边已**单独基于本项目自建了一套 design system**。本仓库也有沉淀已久的 `frontend/DESIGN.md`，且**现有 18 个 Sprint 的 UI 全部基于它构建**。两套必须调和成一套，否则 onboarding 会与 app 其余部分割裂。

**🔴 红线：以「现状已建 UI」为约束做调和，不要从零理想化重绘整个 app。**

请 Claude design 执行：
1. **对比/校验**：把自建 design system 与 `frontend/DESIGN.md` + 仓库里实际已实现的组件（`frontend/src/shared/components/**`）逐项比对——色板 / token / 间距 / 字体 / 圆角 / 组件形态 / 动效语言。
2. **产出调和后的单一设计系统**：以"不破坏现有已建 UI 一致性"为前提收敛成一套。
3. **显式列出冲突点**：凡是"采用自建系统会要求重绘现有屏幕"的地方，单独列成「冲突/范围决策清单」交回——由用户决定是否扩大到全 app 重绘（默认**不**扩大，onboarding 先对齐现状）。
4. **同步回本仓库**：把调和后的设计系统**物化**成本仓库内的文档/tokens（更新 `frontend/DESIGN.md` 或新增 `frontend/design-tokens.*`），作为我实现所依据的 **materialized SSoT**。这一步是"唯一真源"成立的前提——真源必须在仓库里、我对得上。

---

## 3. 固定工程契约（设计在此之上发挥；要改需显式标注）

我已落地的 onboarding 工程管线是稳定接口，设计的 UI 直接接它即可，**无需重做后端**。

### 3.1 用户状态（决定进哪个流程）
`detect.ts` 按 `DATA_ROOT/.env` 必填项判定，主进程据此分流：
- `new` —— 无 `.env`：走完整新用户向导。
- `config-incomplete` —— 有 `.env` 但缺必填项：进向导补填。
- `configured` —— 必填齐全：不进向导，直接起后端进主 app。

必填项（与后端 `config.py` Field(...) 对齐）：`NOTION_TOKEN` / `EMAIL_DATABASE_ID` / `USER_EMAIL`。

### 3.2 开窗机制
主进程对 new/config-incomplete 用户用 **`?onboarding=1`** query 开窗（复用 popout 的 `?popout=1` 同款机制）；`main.tsx` 读到该 query → 渲染向导（而非主 App，**隔离、不依赖 router**）。向导完成后**主进程 reload 窗口去掉 query** → 落回主 App。

### 3.3 IPC 契约（向导调这两个通道，走 `window.electron.ipcRenderer.invoke`）
```ts
// 查当前状态
invoke('onboarding:status') → { state: 'new' | 'config-incomplete' | 'configured' }

// 提交配置 → 写 .env + 起后端 + 等就绪 + 主进程 reload 进主界面
invoke('onboarding:complete', {
  NOTION_TOKEN: string,          // 必填
  EMAIL_DATABASE_ID: string,     // 必填
  USER_EMAIL: string,            // 必填
  MAIL_ACCOUNT_NAME?: string,    // 可选, 默认 Exchange
  CALENDAR_DATABASE_ID?: string, // 可选 (启用日历同步时)
}) → { ok: boolean, ready?: boolean, error?: { code: string, message: string } }
```
- `ok:true` 后主进程自动 reload 窗口进主 app；向导可显示"正在启动…"直到 reload。
- `ready:false`（大库迁移超时但配置已存）：提示稍候/重启。
- `error`：在对应字段/页展示 `error.message`。

> 设计若需要更多 IPC（如"测试 Notion token 连通性"`onboarding:testNotion`、"FDA 状态探测"`onboarding:checkFda`、"选 backend"），在 §5 回传里列清通道名 + 入参/返回 shape，我来加。

### 3.4 运行时约束（设计不能违反）
- **Electron BrowserWindow**：`titleBarStyle: 'hiddenInset'`（顶部留红绿灯空间）、暗色 `backgroundColor: #0E1013`、默认 1280×800（向导可自定窗口尺寸，但需我在主进程配合开窗参数 → 在回传里说明期望尺寸）。
- **React 19 + Tailwind**（现有栈）；动效用 **GSAP**（对齐 motion 文档），尊重 `prefers-reduced-motion`。
- **隔离**：向导不得依赖主 App 的 router / 全局 store（保证主 App 即便有问题也能配置）。
- 性能铁律见 `frontend/ARCHITECTURE.md` §7。

---

## 4. 开放设计空间（Claude design 拥有）

当前只有一个占位单页（`OnboardingPage.tsx`，等于把 PRD Step 3 压成一页）。设计要按 PRD 重做**完整体验**，自由决定视觉 / 分步编排 / 文案 / 动效 / 插画 / 空状态 / 失败态：

1. **新用户向导（PRD §3，7 步）**：欢迎 → 环境/权限检查(FDA) → Backend 选择(默认 AppleScript，DavMail 折叠为企业可选) → 邮件同步配置(Notion+邮箱) → 首次 init 同步进度 → 插件按需开启 → 完成。哪些步该合并/拆分/跳过由设计判断（PRD 是流程意图，不是屏幕规定）。
2. **老用户迁移流（PRD §4）**：检测旧版本 → 强制备份 → 继承 → 幂等迁移进度 → 校验 → 推荐 backfill。
3. **插件按需启用子流程（PRD §5）**：依赖拓扑 / 置灰 / 未配置 pill / 安装引导。
4. **半装/异常态（PRD §7）**：迁移失败回滚、鉴权重试、FDA 被拒、DB 损坏、运行时损坏的 UX。

---

## 5. 回传给实现侧的交付物清单（让我能直接实现）

每次设计 handoff 给我，需包含：
1. **分步屏幕设计**（按 PRD 流程组织）：每屏的布局 / 视觉 / 组件。
2. **每屏的状态矩阵**：默认 / 加载 / 校验失败 / 提交失败 / 空态 / 成功，以及文案（中文，最终稿）。
3. **组件清单**：复用现有 `frontend/src/shared/components/**` 哪些 + 新增哪些（新增的给规格）。
4. **IPC 映射**：每个交互调哪个 §3.3 通道；若需新通道，列通道名 + 入参/返回 shape。
5. **动效规格**：入场/转场/反馈，对齐 GSAP motion 文档。
6. **调和后的 design system**（§2 产物）+ **冲突/范围决策清单**。
7. **demo 参考**（可点的原型 / 录屏 / 截图序列），帮我对齐预期。
8. **changelog**（针对已存在实现的改动，见 §6）。

格式不限（Markdown + 图 / Figma 链接 / 截图均可），但以上 8 项要齐，缺了我会回去问。

---

## 6. 长期前端设计协作协议（onboarding 之后通用）

### 6.1 真源
- **Claude design = 前端设计决策权威**（视觉 / 交互 / 动效 / 设计系统的最终决定权）。
- **物化 SSoT = 本仓库内调和后的设计系统文档/tokens**（`frontend/DESIGN.md` / `design-tokens.*`）——我实现所依据的唯一来源。**真源必须在仓库里同步存在**，不能只存在于 Claude design 的环境（否则实现侧对不上、会漂移）。
- 设计系统每次更新 → 同步更新仓库内物化文档 → 我据此实现。

### 6.2 两类协作回环
| 场景 | 流程 |
|---|---|
| **已有功能优化** | Claude design 改设计 → 给我 **handoff changelog 文档 + demo 参考** → 我针对现有组件/页面实现 delta（不重写全部，只改 changelog 列的点） |
| **新功能** | **PRD + design system** → Claude design 出设计 → 按 §5 handoff → 我实现 |

### 6.3 changelog 格式约定（已有功能优化用）
每条改动写清：
- **位置**：哪个页面/组件（最好给文件路径或现有屏幕名）。
- **改什么**：before → after（视觉/交互/文案/动效），配 demo 截图或录屏。
- **为什么**：设计意图（便于我实现时不跑偏）。
- **契约影响**：是否动 IPC / props / 状态（动了要标，没动也说一句"纯视觉"）。
- **优先级 / 范围**：是否触发其他页面连带改（设计系统级改动要标"全局影响"）。

### 6.4 边界（避免来回扯皮）
- 设计**不改后端契约**；要改 §3.3 IPC / 数据形状 → 在 handoff 显式提需求，我评估+实现。
- 实现侧**不擅自改设计决策**；发现设计与工程约束（§3.4 / 性能铁律）冲突 → 回报 Claude design 调整，不自行发挥。
- 设计系统冲突（§2）→ 范围决策交用户，双方不各自为政。

---

## 附录：当前 onboarding 实现状态（设计接管前的基线）

- 已落地（commit `3a3ba38` on `feat/packaging-onboarding`）：detect + 启动分流 + IPC（status/complete）+ `?onboarding=1` 机制 + **占位单页** `OnboardingPage.tsx`（Notion token/DB id/邮箱 + 默认 AppleScript）。
- 验证：typecheck node+web 0；vitest 42；进 main+renderer bundle；`.app` 520M codesign 通过。
- **占位页就是设计重做的替换目标**；后端管线（§3）保留复用。
- 真机 GUI dogfood 待用户机器（dogfood 谨防指向 live data 触发双 writer）。

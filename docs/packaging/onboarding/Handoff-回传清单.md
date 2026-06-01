# MailAgent · Onboarding 设计回传清单 (Design → Implementation Handoff)

> 配套 demo：`onboarding/Onboarding Demo.html`（可点高保真原型）
> 设计基线：`frontend/DESIGN.md` (SSoT) → `design-system/ds.css` token 层
> 对齐契约：`docs/packaging/03-onboarding-prd.md` §1–§9 · `03b-onboarding-design-handoff.md` §3 工程契约
> 主题默认：暗色 · Teal accent · 左侧步骤条布局 · 详尽文案。四项均可在 demo 的 Tweaks 面板切换。

本文件覆盖 handoff §5 要求的 8 项交付物。截图序列见 demo 内「演示场景」dock（新用户 / 老用户 / 半装 / 鉴权失败 / DB 损坏 / 迁移回滚 / 主窗口）。

---

## 1. 分步屏幕设计（按 PRD 流程）

窗口规格：独立 `BrowserWindow`，**768 × 640**（比 PRD 建议的 720×560 略大，给左侧步骤条 + 表单留呼吸）。`titleBarStyle: 'hiddenInset'`，顶部 38px 标题栏保留红绿灯空间 + 居中窗口标题（随流程切换：设置 / 数据迁移 / 恢复 / 诊断 / MailAgent）。暗色 `#0E1013`。

### 新用户向导（NEW，主线，7 步 → 收敛为左栏 7 节点）
| Step | 屏幕 | 关键元素 |
|---|---|---|
| 0 欢迎 | hero spark + 三特性卡（实时同步 / AI 分类 / 本地优先）+ 数据目录说明 | 主按钮「开始设置」；次入口「我已有旧版数据」→ LEGACY |
| 1 环境与权限 | 5 项 checklist（macOS / Python 运行时 / DATA_ROOT 可写 / **FDA** / **Automation**），逐项 ✓/✗/⏳ 动画 | FDA 失败 → 橙色 banner + 「打开系统设置」深链 + 「重新检测」+ 「稍后设置」 |
| 2 后端选择 | 两张 opt-card：AppleScript（推荐 pill，默认选中）/ DavMail（企业·Beta，折叠合规话术 + 强制勾选） | DavMail 未勾选确认 → 「下一步」禁用 |
| 3 邮件同步配置 | 账户下拉（异步检测）+ 同步邮箱 chips + USER_EMAIL + Notion Token + 邮件 DB ID + 日历 DB ID（选填） | 实时校验，必填空 → 禁用「开始同步」 |
| 4 首次同步 | 进度卡（3 阶段：建表→拉取→写入 Notion）+ 计数 N/M + 阶段 pip | 「转入后台并继续」→ 跳插件；完成 → 校验 banner |
| 5 插件 | 6 张 feature bundle 卡 + 开关 + 重启类型 pill + 依赖置灰 + 未配置 pill | 核心不可关；缺凭证「配置」按钮 |
| 6 完成 | rocket hero + onboarding_done=true 卡 + （FDA 跳过时）受限横幅 | 「进入收件箱」→ 1.4s「正在启动…」→ 主窗口 |

### 分支
- **LEGACY 迁移**（mini 状态机）：检测（版本/路径/邮件数表 + 双 writer 告警）→ 强制备份（进度）→ v13→v17 链式迁移（5 步 pill + 锁表告警）→ 4 项校验 checklist → backfill 建议卡（默认不勾 + 顺序约束 banner）→ 完成。提供「就地继承」与「模拟失败→回滚」入口。
- **HALF 半装**：单屏「一键启动同步」→ 轮询 sync_state 进度 → 进主窗口。
- **异常态**：DB 损坏诊断（备份恢复/重建/导出 3 选项）· 迁移回滚（已还原 banner + 重试/日志）· 鉴权失败（Step3 顶部红 banner + 字段保留 + 重试）· FDA 被拒（主窗口持久橙色横幅）。

---

## 2. 每屏状态矩阵（最终中文文案见 demo）

| 屏幕 | 默认 | 加载 | 校验失败 | 提交失败 | 空态 | 成功 |
|---|---|---|---|---|---|---|
| FDA | 5 项 pending | 逐项 ⏳ spin | macOS 版本低=阻断 | — | — | 全 ✓ → 绿 banner |
| 配置 | 空表单 | 账户「检测中…」 | 内联红字 + 禁用按钮（必填）；黄字警告（格式启发式，不阻断） | 顶部红 banner（401 等）| 账户列表空 → 「请先在 Mail.app 添加账户」 | 进 Step4 |
| 首次同步 | 进度 0% | 阶段轮询 indeterminate→determinate | — | stderr 摘要 + 「返回上一步」（demo 未触发，留接口）| — | db_version=17 ✓ banner |
| 插件 | 核心开 / 余蓝色可启用 | — | — | — | — | 橙「未配置」/「安装引导」pill |
| LEGACY 迁移 | 检测卡 | 备份/迁移进度条 | 校验 4 项任一失败 → 回滚 | — | — | 0 丢失 banner |
| DB 损坏 | 3 恢复选项 | — | — | — | — | （恢复后进主窗口）|

文案语气两套（详尽 / 简洁）已在 demo 中以 Tweak 切换实现，最终稿以「详尽」为默认。

---

## 3. 组件清单

**复用（建议对齐 `frontend/src/shared/components/**` 现状）**：Button（coral/ghost/sec）、Toggle、Badge/Pill、Banner、ProgressBar、kbd、Card、Input/Select、Checkbox(cb)、Chip。均已存在于 ds.css 的 token 语言里。

**新增（onboarding 专属，附 demo 内实现）**：
- `MacWindow`（hiddenInset 外壳 + JS 自适配缩放，预留 dock）
- `StepRail` / `TopStepper`（两种布局，左栏 7 节点 / 顶部步进）
- `Field`（label + 必填星 + 错误/警告/提示三态）
- `ChecklistRow`（FDA 4 态：pending/pass/fail/warn）
- `OptionCard`（单选大卡，backend 选择）
- `ChipSelect`（同步邮箱多选）
- `WizFooter`（统一上一步/下一步/次操作/busy）
- `LegacyFlow`（迁移 mini 状态机）/ `HalfFlow` / `DBCorruptScreen` / `RollbackScreen`
- `InboxMock`（完成后落地的主窗口占位，复用 EmailRow 语言）

---

## 4. IPC 映射

| 交互 | 通道 | 备注 |
|---|---|---|
| 进入向导分类 | `onboarding:status` → `{state}` | demo 用 detect 分流模拟（new/config-incomplete/configured）|
| Step3 提交 | `onboarding:complete({NOTION_TOKEN, EMAIL_DATABASE_ID, USER_EMAIL, MAIL_ACCOUNT_NAME?, CALENDAR_DATABASE_ID?})` | `ok:true`→主进程 reload；`error.message`→Step3 红 banner（鉴权失败屏即此态）|

**需新增通道（设计提需求，由实现侧评估）**：
| 通道 | 入参 | 返回 | 用途 |
|---|---|---|---|
| `onboarding:checkEnv` | `()` | `{os, pythonRuntime, dataWritable, fda, automation}` 各 `'pass'\|'fail'\|'warn'` | Step1 checklist（FDA「试读→捕获 EPERM」启发式）|
| `onboarding:openPrivacyPane` | `{pane:'AllFiles'\|'Automation'}` | `void` | 深链系统设置 |
| `onboarding:listMailAccounts` | `()` | `{accounts:string[]}` | Step3 账户下拉（`debug mail-structure`）|
| `onboarding:testNotion` | `{token, dbId}` | `{ok, error?}` | Token 连通性预检（可选，降低 Step4 失败率）|
| `onboarding:syncProgress` (event) | — | `{stage, count, total, dbVersion}` | Step4 轮询 sync_state（直读，非 admin:health fork）|
| `onboarding:migrate` | `{from, to}` | progress events `{step, pct}` + `{verified, rollbackPath?}` | LEGACY 链式迁移 + 校验 + 回滚 |
| `onboarding:bootBackend` | `()` | progress + `{ready}` | HALF 一键拉起 |

---

## 5. 动效规格（对齐 GSAP motion 文档 / ds.css §8）

一条曲线 `cubic-bezier(.4,0,.2,1)`，三时长 `fast 120 / base 220 / slow 380`。
- **步骤切换**：内容区 `stepIn` = translateY(7px)→0 + opacity .6→1 @ base。**关键约束**：入场 opacity 下限 **0.6**（不可 0）——Electron 窗口失焦/离屏会暂停 CSS 动画，0 起始会把内容卡在不可见。GSAP 实现同理用 `autoAlpha` 时给初值 ≥0.6 或用 `fromTo` 显式 set 终值。
- **步骤条节点**：dot 激活 base 时长，外发光 `0 0 0 4px accent/.14`。
- **进度条**：width transition slow；indeterminate 用 `indet` 平移。
- **checklist / 校验**：逐项 320–450ms 错峰出现，spin loader → ✓。
- **轮询 spinner**：`spin` 0.9s linear。
- 全程 `prefers-reduced-motion` → 动画置空、transition→0.01ms（已实现）。

---

## 6. 设计系统调和 + 冲突清单

**结论：零冲突。** onboarding 完全构建在既有 `ds.css`（= `frontend/DESIGN.md` token 层）之上，未引入任何新 token、色板或圆角/阴影规则：
- 色彩：仅用既有 ink 0–5 表面、fg 四级、accent 变量（6 预设）、语义色（ok/warn/fail/info/crit/urg/norm…）。FDA/迁移的成功失败态直接映射 `c-ok / c-warn / c-fail`。
- 圆角：卡片 8 / 输入 6 / chip·按钮 4–999，未触碰「28px 软垫」红线。
- 字体：系统 sans + SF Mono（ID/路径/计数），CJK ≥14px 阅读地板遵守。
- 动效：复用单曲线三时长。

**新增的「构件」而非「token」**：MacWindow 外壳、StepRail/TopStepper、向导 Footer——它们是 onboarding 场景特有的组合，建议物化进 `frontend/src/shared/components/onboarding/`，不影响既有 18 Sprint UI。

**范围决策（交用户）**：无需扩大到全 app 重绘。唯一待确认项 = 是否把 `MacWindow` 自适配缩放逻辑也用于其它独立窗口（popout）——默认否。

---

## 7. Demo 参考

`onboarding/Onboarding Demo.html` — 可点原型，覆盖全部 7 个场景（dock 切换）+ 真实表单校验 + 模拟进度轮询 + 状态转移动画 + 4 项 Tweaks（暗/亮、accent、布局、文案语气）。

---

## 8. Changelog（针对现有 `OnboardingPage.tsx` 占位单页）

| 位置 | 改什么 | 为什么 | 契约影响 | 范围 |
|---|---|---|---|---|
| `renderer/OnboardingPage.tsx` | 单页表单 → 7 步向导 + 分支路由（NEW/LEGACY/HALF/异常）| 占位页等于把 PRD Step3 压成一页，缺分类/迁移/插件/异常 | 现有 `onboarding:status/complete` 复用；其余通道见 §4 待加 | onboarding 局部，不连带改主 App |
| 新增 `renderer/onboarding/*` | MacWindow/StepRail/各 Step 组件 | 见 §3 | 纯前端 | 局部 |
| `renderer/main.tsx` | `?onboarding=1` 已读 → 挂载新向导根 | 隔离不依赖 router（契约 §3.4）| 无 | 局部 |

> 边界：本设计**未改后端契约**。§4「需新增通道」为设计提的需求，由实现侧评估实现；在拿到这些通道前，向导可用 mock/降级（demo 即 mock 态）。

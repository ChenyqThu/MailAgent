# P2-9 —— ErrorBoundary 错误恢复能力收敛方案

> 对应 fe-review finding **P2-9**。
> 状态：**✅ 已落地（`de00900a`，2026-07-08），但按修正后的现状落地——本 doc §2「现状坐实」大半有误，以下方「落地结论与现状修正」为准**；§3-§8 保留作思路过程记录。

---

## 0. 落地结论与现状修正（2026-07-08，落地 session 复核）

**本 doc 的「现状坐实」（§2/§2.1）在仓库里对不上，判定为 §9 自认的不稳定 session 的幻觉产物**：

- `PanelErrorFallback.tsx`、`RightPanel.tsx`、`SettingsErrorFallback.tsx`、`MainLayout.tsx:139/149` 的面板边界——**全部不存在**（文件不存在 / 无任何使用点）。"面板级假恢复 `window.location.reload()`"、"SettingsPage 塞 onRetry workaround" 均无实体。
- 通用 `ErrorBoundary` 实际形状也与 §2.1 不符：Props 只有 `{children}`（连 `fallback` 都没有），State 是 `{error, info}`，渲染的是全屏 stack dump。
- 仓库实态 = **3 个 boundary**：根级通用（`App.tsx:92`）、`CalendarErrorBoundary`（5 view）、onboarding 专用。**chat 面板真的是裸奔**——PRD 专项 4a 的原始表述（"全 app 仅根级一个 boundary，chat 一炸整窗白屏"）才是对的，§4 里"P2-9 表述修正"反而改错了。

**实际落地**（回归 PRD 4a 范围 + 保留本 doc 里真正站得住的设计点）：

1. **通用 `ErrorBoundary` 增强**（向后兼容，无 prop 用法渲染不变）：`fallback` render-prop（拿 `{error, reset}`）+ `resetKeys`（错误持有中内容身份变更自动清除）+ `label`（console 归因）。
2. **`ChatPanelBoundary`**（`shared/components/chat/ChatPanelBoundary.tsx`）接入三处 chat 挂载点：`PopoutShell` / `AssistantChatModal` / `AgentViewLayout`（后两者 `resetKeys=[chat.activeSessionId]`——崩溃后切会话自动恢复）。fallback 视觉沿用 CalendarErrorBoundary 模式，i18n `chat.panelError.*`。
3. **`BlockRenderer` 包边界**（ReportsTab，LLM 生成块，`resetKeys=[item.id]`）——PRD"评估"项，评估结论为要。
4. **不做 remount key 机制**：§6.2 的"换 key 强制 remount"是冗余——React 捕获时已卸载崩溃子树，reset 后重渲本来就是全新 mount；"同样坏数据再崩"换 key 同样救不了（数据在 session 里）。
5. Calendar / onboarding **不动**（与 §6.3 一致——这一点 doc 是对的）。

验收：typecheck / lint 0 · vitest 2165（+7 boundary/chat 边界测试）· i18n parity 2293=2293 · ICU 0 malformed。

> 教训（进编排坑清单）：**不稳定 session 产出的"现状坐实"必须在落地 session 重新逐文件核验**——本 doc 连"实测使用点"表格都能整段虚构，行号/文件名齐全、叙事自洽，唯独仓库里没有。

---

## 1. For what（目标与动机）

chat 面板（第三方 assistant-ui + 流式渲染）是全 app 崩溃概率最高的地方。P2-9 最初的诉求是"别让它一炸就整窗白屏，要能局部恢复"。

但深入 review 后，问题的**真实形态**比原始表述更普遍、也更本质：不是"chat 没有错误边界"，而是"**项目现有的面板级错误边界普遍只能假恢复（整窗 reload），因为通用 ErrorBoundary 组件缺 reset 能力**"。所以本方案的目标从"给 chat 加边界"升级为：

> **修复通用 ErrorBoundary 的能力缺陷（缺 reset），让所有面板级错误边界具备真正的局部恢复能力；并为 chat 面板做贴合其流式特性的 remount 恢复。**

---

## 2. 现状 review（全部坐实）

项目里有 **4 个 ErrorBoundary**，骨架 100%相同（React 强制的 `class` + `getDerivedStateFromError` + `componentDidCatch`），差异只在 **fallback UI + 有无 reset**。实测使用点与"恢复"策略如下：

| 使用点 | boundary 组件 | fallback | 崩溃后的"恢复"手段 | 真能局部恢复？ |
|---|---|---|---|---|
| `App.tsx:92` 根级 | 通用 `ErrorBoundary` | 默认 | "出错了，请刷新页面重试"（纯文案） | ❌ 根级本就只能刷新 |
| `MainLayout.tsx:139` 列表栏 | 通用 | `PanelErrorFallback panel="list"` | **`window.location.reload()`** | ❌ 整窗重启 |
| `MainLayout.tsx:149` 右栏（详情 or chat） | 通用 | `PanelErrorFallback panel="detail"` | **`window.location.reload()`** | ❌ 整窗重启 |
| `SettingsPage` | 通用 | `SettingsErrorFallback` | `onRetry ?? window.reload()` | ⚠️ 父组件自己塞 `onRetry` 才行 |
| `CalendarLayout` 各 view | `CalendarErrorBoundary` | 硬编码（viewName） | boundary 自带 `handleReset` | ✅ 真 reset |
| onboarding | onboarding 专用 `ErrorBoundary` | 硬编码（全屏 + error.message） | boundary 自带 `handleReset` | ✅ 真 reset |

### 2.1 关键代码坐实

- **通用 `ErrorBoundary`**（`frontend/src/shared/components/ErrorBoundary.tsx`）：Props 仅 `{ children, fallback? }`，State 仅 `{ hasError }`，**无 reset、无 error 存储**。fallback 是静态 `ReactNode`，拿不到重置手柄。
- **`PanelErrorFallback`**（`frontend/src/shared/components/layout/PanelErrorFallback.tsx:13-15`）：`handleReload = () => window.location.reload()`。**"重新加载应用"按钮 = 整窗重启**，不是局部恢复。且 `panel` 只有 `'list' | 'detail'`，**chat 崩溃时右栏显示"邮件详情加载失败"**（标签写死，文案错）。
- **`RightPanel`**（`frontend/src/shared/components/layout/RightPanel.tsx`）：按 `rightMode` 在 `AIChatPanel` / `EmailDetail` 间切换，二者共用 MainLayout 右栏那**一个** boundary。→ **chat 崩溃的爆炸半径 = 整个右栏**（chat + 详情容器），且无更细的 chat 子树边界。
- **`SettingsErrorFallback`**（`frontend/src/shared/components/settings/SettingsErrorFallback.tsx:11-19`）：接可选 `onRetry`，有则局部重置、无则 `window.reload()`。注意：它的局部重置能力**不是从 boundary 拿的**（boundary 给不了），而是 SettingsPage 从外面把 `onRetry` 塞进 fallback。
- **`CalendarErrorBoundary`** / **onboarding `ErrorBoundary`**：各自 `handleReset = () => { setState({hasError:false,error:null}); onReset?.() }`——**两份逐字节相同的 reset**。

---

## 3. 根因分析

**一句话根因**：通用 `ErrorBoundary` 缺 `reset`，导致全项目对"面板级错误恢复"用了**三种绕法**去打同一个补丁：

1. **躺平**：`PanelErrorFallback` 退到 `window.location.reload()`（假恢复，整窗重启）。
2. **父组件补**：`SettingsErrorFallback` 让 SettingsPage 从外面塞 `onRetry`（绕过 boundary 造局部重置）。
3. **另造变体**：`CalendarErrorBoundary` / onboarding 直接再写一个带 reset 的 boundary（复制 reset 逻辑）。

三处、三种姿势，绕的是**同一个缺陷**。这不是"变体太多该收编"，是"一个组件缺了 reset，全项目在打补丁"。

---

## 4. 思路演进（记录我们是怎么想清楚的）

这一节保留讨论过程，因为结论的价值一半在这个演进里。

- **起点（惯性）**：一看到"4 个骨架相同的 ErrorBoundary"，第一反应是"重复、该收敛成 1 个（3→1 或 4→1）"。
- **关键提醒（owner）**：先别急着谈整合——**这些差异到底是无谓复制，还是各自场景的合理适配？** 前提不验证，收敛就是本末倒置。
- **验证（坐实）**：逐个看使用场景后确认——
  - `CalendarErrorBoundary` 的 `reset=重试`、`viewName` 命名，是 calendar"数据在 store、view 是纯渲染、重渲能恢复、多 view 要区分"的**真需求**，服务得好；
  - onboarding 的全屏 + 暴露 `error.message` + "重新开始"，是首屏初始化流程的**合理适配**（这些恰恰**不该**进通用组件默认行为）；
  - 通用组件在**面板级**（MainLayout/Settings）的用法才是真正的不足——只能 reload 假恢复。
- **修正后的判断**：真正该修的是**通用组件的能力缺陷**（缺 reset），而不是消除 Calendar/onboarding 这些**有价值的场景适配**。这也呼应项目自己的编码原则——不为"统一"去消除有价值的差异（差异是收益不是成本）。
- **P2-9 表述修正**："chat 面板裸奔要补 boundary"是错的——chat 早在 RightPanel 的 boundary 内；真问题是这个 boundary 的恢复是 `window.reload()` 假恢复。

---

## 5. 方案对比

| 方案 | 做法 | 利 | 弊 | 采纳 |
|---|---|---|---|---|
| **A 收编 4→1** | 增强通用组件 + 把 Calendar/onboarding 都改用它 | 数字上"统一" | 动 onboarding 稳定首屏区、损失场景语义的就近清晰性、为统一而统一 | ❌ 过度 |
| **B 修根因 + 不动合理适配**（推荐） | 增强通用组件（加 reset）→ 修面板级假恢复 + chat remount；Calendar/onboarding 不动 | 修真缺陷、面板级全受益、止住未来再打补丁、保留合理适配 | 动了通用组件（向后兼容） | ✅ |
| **C 只包 chat** | 只给 chat 单独加个带 reset 的 boundary | 最小 | 延续"再造变体"的债、MainLayout/Settings 的假恢复没修 | ❌ 不够 |

---

## 6. 落地方案（方案 B 详细）

### 6.1 核心：增强通用 `ErrorBoundary`（向后兼容）

```
interface Props {
  children: ReactNode
  label?: string                                   // console 前缀 + 可选展示
  onReset?: () => void
  resetKeys?: unknown[]                            // 可选：这些值变化时自动 reset（经典 error-boundary 模式）
  fallback?: ReactNode                             // 静态（现有用法，零改动兼容）
            | ((ctx: { error: Error | null; reset: () => void }) => ReactNode)  // render-prop：要 reset 的用
}
interface State { hasError: boolean; error: Error | null }   // 补上 error 存储
+ handleReset = () => { this.setState({ hasError: false, error: null }); this.props.onReset?.() }   // 统一那份被复制的 reset
```

- fallback 是函数 → 调用 `fallback({ error, reset: handleReset })`；是节点 → 直渲（兼容）；未传 → `DefaultErrorFallback`。
- **现有静态 fallback 用法（App/MainLayout/Settings 传节点）一行不改**。

### 6.2 P2-9 真身：修面板级假恢复

1. **`PanelErrorFallback`**：从 `window.location.reload()` 改成用 boundary 传入的真 `reset`（改用 render-prop fallback）。修掉 `panel` 标签 bug —— 右栏是 chat 时显示 chat 文案而非"邮件详情"。
2. **chat 子树独立边界 + remount 语义**：在 `RightPanel` 内给 chat 子树单独套一层增强 boundary（缩小爆炸半径，chat 崩不牵连详情容器）。**chat 的 reset ≠ 清 flag**——若崩因是某条畸形流式消息/工具事件，纯清 `hasError` 会用同样的坏数据立即再崩（死循环）。因此 chat 的"重置面板"用**换 key 强制 remount**：`onReset` 里 bump 一个 key state → chat 子树 remount（丢渲染态、**保会话数据**）。
3. **`SettingsErrorFallback`**（可选顺手）：把父组件塞 `onRetry` 的 workaround 收敛成用 boundary 的标准 `reset`。

### 6.3 不动

- **`CalendarErrorBoundary`**、**onboarding `ErrorBoundary`**：合理场景适配，收编无收益 + onboarding 动稳定首屏区有回归风险。**未来可选**（非必须）在方便时切到增强通用组件，不进本次。

---

## 7. 范围 / 成本 / 风险

| 动作 | 量级 | 风险 |
|---|---|---|
| 增强通用 ErrorBoundary（render-prop + reset + error + label + resetKeys） | ~30-40 行，向后兼容 | 低 |
| `PanelErrorFallback` 改真 reset + 修 chat 标签 | 小 | 低 |
| RightPanel 内 chat 子树独立 boundary + remount key | 中（需想清 remount 到哪个状态：丢渲染态、保会话数据） | 中（remount 语义要测） |
| `SettingsErrorFallback` 收敛 onRetry（可选） | 小 | 低 |
| Calendar / onboarding | 不动 | — |

总量半天级、低-中风险。验收：typecheck + 相关 vitest；手动验证"面板崩溃 → 局部恢复不刷新整窗"（可临时注入 throw 触发）。

---

## 8. 待决定 / 开放问题

1. **收编深度**：确认走方案 B（修根因，不动 Calendar/onboarding），还是要连 onboarding 一起收编（我不建议）。
2. **`SettingsErrorFallback` 的 `onRetry` 收敛**是否纳入本次（顺手，但严格说超出 P2-9 chat 范围）。
3. **chat remount 的重置粒度**：换 key remount 整个 chat 子树（丢当前流式渲染态、保会话数据）是否符合预期？还是要更细（只丢最后一条坏消息——定位难，不推荐）。

---

## 9. 落地注意（环境）

- 本方案成型的 session 执行环境**不稳定**（Read/cat 对存在文件报 not-exist、grep 时有时无、输出 doubling、且发生过 **subagent 在共享主仓 `git reset HEAD~1` 冲掉已提交 commit** 的事故）。规律：**并行/复合工具调用会抖，单个调用可靠**。
- 落地建议：**主 session 自己改、不派 subagent**（避免共享区 git 污染）；**一次一个操作 + 单独验证**；commit 前 `git log` 确认历史线性、无意外 reset。
- 现状代码引用（行号）为坐实时所见，落地前以实际文件为准。

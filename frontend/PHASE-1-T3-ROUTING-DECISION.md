# Phase 1·T3 — fork 路由决策 + MailAgentSessionView wire 接入点

> **状态**：2026-05-23 调研产出。Phase 1·T1+T2 plugin 端 envelope 字段扩展已 ship（MailAgent 主仓 `09c7b66`，feat/agent-harness 分支）。本 memo 是 T4 SwiftUI 实施的**前置设计纪要**——把路由决策、前置数据流改动、Scene 映射规则定下来，让 T4 session 不用重新调研路由架构。
>
> **关联**：
> - PRD: `~/.claude/plans/ultrathink-session-curious-cloud.md` §5.1 Phase 1
> - Plugin Sprint 0-1 已 ship：[`ISLAND-PLUGIN.md`](./ISLAND-PLUGIN.md)（§2.0 实测修正 5 处 spec 错位）
> - Sprint 1 完工边界：[`HANDOFF.md`](./HANDOFF.md) §2.5
> - Mockup 视觉契约：MailAgent 主仓 `frontend/mockup-dynamic-island.html` v4
> - 设计系统：MailAgent 主仓 `frontend/DESIGN.md` §7

---

## 0. TL;DR

| 决策 | 内容 |
|---|---|
| **路由接入点** | 在 3 个 generic view 内加 `if session.clientInfo.brand == .mail` 分支，**不动** `IslandOpenedContentView.routeContent` switch、**不动** `IslandExpandedRouteResolver` |
| **前置数据流改动** | `SessionState` 加 `hookMetadata: [String: String]` 字段，`SessionStore.processHookEvent` 时从 `hookEvent.metadata` 复制（envelope.metadata 已透传到 HookEvent，但未存入 SessionState）|
| **Scene 选择** | `MailAgentSessionView` 内 `switch session.hookMetadata["mailagent.scenario"]` 选 4 个 SwiftUI 子 view（mockup §2 Scene 1-4）|
| **fork diff 估算** | SessionState +1 字段 + SessionStore +2 行 + 3 view 各 4-6 行分支 + MailAgentSessionView 重写 ~300 行 ≈ **< 350 行总 diff**（远低于 fork minimal 800 上限）|
| **不破** Spec 错位 | ISLAND-PLUGIN.md §2.5 "Sprint 4 路由接入点" 实测确认走 generic view 分支方案（非 `switch route` 加 case）|

---

## 1. 路由架构总览

`IslandExpandedRoute` enum (`IslandExpandedRoute.swift:15-21`) 五个 case：

```swift
enum IslandExpandedRoute: Equatable {
    case sessionList                                         // 多 session 列表
    case hoverDashboard                                      // hover 预览面板 (top 3)
    case attentionNotification(SessionState)                 // 单 session 需注意 (最优先)
    case completionNotification(SessionCompletionNotification)
    case chat(SessionState)                                  // chat 详情 (claude/codex/kimi)
}
```

`IslandExpandedRouteResolver.resolve()` (`IslandExpandedRoute.swift:23-77`) 根据 `surface` (docked/floating) × `trigger` (click/hover/notification/pinnedList) × `sessions` 决定走哪个 case。**关键**：任何时候有 `needsAttention` (`needsApprovalResponse || needsQuestionResponse`) 的 session 都优先走 `.attentionNotification`。

`IslandOpenedContentView.routeContent` (`IslandOpenedContentView.swift:38-95`) 按 route 选 view：

| Route | View | mail event 是否会到达 |
|---|---|---|
| `.sessionList` | `SessionListView` | ✓ 多行列表里 mail row |
| `.hoverDashboard` | `SessionHoverDashboardView` | ✓ hover 预览 top 3 |
| `.attentionNotification(s)` | `SessionAttentionNotificationView` | ✓ **urgent mail 主入口** |
| `.completionNotification` | `SessionCompletionNotificationView` | 暂无 (mail 不用这条 path) |
| `.chat(s)` | `ChatView` / `CodexSessionView` | 不用 (灵动岛不嵌邮件对话, PRD §2.2) |

---

## 2. mail event 当前路由（验证现状）

| Plugin envelope event | intervention | 自然 route | 现 view 渲染 | 用户感知 |
|---|---|---|---|---|
| `MailReceived` | none | `.hoverDashboard` / `.sessionList` | `SessionHoverCompactRow` (generic) | 普通行，glyph 是 mail brand 但布局 generic |
| `LLMReviewed` | none | 同上 | 同上 | 同上 |
| `LLMReviewedUrgent` | 5 options | `.attentionNotification` | `SessionAttentionNotificationView → HoverSessionCard` | **借 generic 大卡片**（mockup §2 Scene 3 应在此） |
| `AIDraftReady` | 编辑/发送 | `.attentionNotification` | 同上 | **借 generic 卡片**（mockup §2 Scene 2 应在此） |
| `MailCompleted` | none | `.hoverDashboard` 一闪而过 | `SessionHoverCompactRow` | **缺 click to jump 副标变绿**（mockup §2 Scene 4） |
| `SyncFailed` | none | `.attentionNotification` (status=error) | 同 generic 卡片 | 缺 mascot DevBot + pip-fail |
| `DeadLetterAccum` | none | `.sessionList` | 同 generic row | 缺聚合 chip |

**核心问题**：所有 mail event 都被 `HoverSessionCard` / `SessionHoverCompactRow` 兜底渲染 → 用户感知 "UI 极其丑陋"。MailAgent 专属 SwiftUI view 已经在 `MailAgentSessionView.swift` 但**没被任何 view 引用**，143 行骨架在 dead code 状态。

---

## 3. 接入点决策 — 最小路由 diff 方案

### 3.1 不做什么

- ❌ **不**在 `IslandExpandedRoute` enum 加新 case（如 `.mailSession(SessionState)`）—— 影响 upstream rebase
- ❌ **不**在 `IslandOpenedContentView.routeContent` switch 加 mail 分支 —— 同上
- ❌ **不**改 `IslandExpandedRouteResolver` 逻辑 —— urgent mail 已自然走 `.attentionNotification`，正确
- ❌ **不**让 `MailAgentSessionView` 自己监听 SessionStore —— 跟 ping-island 现有 view pattern 不一致

### 3.2 做什么 — 3 个接入点

在 generic view 渲染 row/card 时，先看 `session.clientInfo.brand == .mail`，是则 detour 到 `MailAgentSessionView`：

**A. `SessionAttentionNotificationView`** (`SessionHoverPreviewView.swift:157`) — **Scene 2/3 主路径**
- urgent mail (`LLMReviewedUrgent` / `MailReceivedUrgent` / `AIDraftReady` / `SyncFailed`) 走这里
- 当前用 `HoverSessionCard` 渲染 → 改为：
  ```
  if session.clientInfo.brand == .mail {
      MailAgentSessionView(session: ..., ...)  // 走专属 view
  } else {
      HoverSessionCard(...)  // 现有 generic 路径不变
  }
  ```

**B. `SessionHoverDashboardView`** (`SessionHoverPreviewView.swift:~95`) — **Scene 1 mixed monitor**
- `ForEach(displayedSessions)` 内 mail brand 行走 mail-specific compact row（mascot + eyebrow + title + sub + tag + time，按 mockup §2 Scene 1）
- 非 mail row 仍走 `HoverSessionCard` / `SessionHoverCompactRow`

**C. `SessionListView`** (`SessionListView.swift:~400` 附近，已有 `case .mail:` switch 块) — **Scene 1 backup**
- 完整列表里 mail row 同样改为 mail-specific compact row
- 复用 B 的 SwiftUI subview，避免代码重复

### 3.3 MailAgentSessionView 4 Scene 子 view（T4 实施）

`MailAgentSessionView` body 内根据 `session.hookMetadata["mailagent.scenario"]` switch 选 SwiftUI 子组件：

| scenario | Scene | 视觉关键 (mockup §2) |
|---|---|---|
| `MailReceivedUrgent` / `LLMReviewedUrgent` | **Scene 3 Task acknowledge** | mascot + pip-crit pulse + eyebrow + title + sub (aiSummary) + 2 button (Open/Snooze) + 快捷键 hint |
| `AIDraftReady` | **Scene 2 Input required** | mascot + DRAFT REPLY header + 草稿 diff 高亮 (绿) + 2 button (编辑/发送) + 快捷键 ⌘E/⌘⏎ |
| `MailCompleted` | **Scene 4 Task complete** | mascot + pip-ok + 副标 "Done — click to jump" 变绿 + click 跳 Mail.app |
| `MailReceived` / `LLMReviewed` | **Scene 1 row (compact)** | mascot + eyebrow + title + sub + tag + time，**跟 Claude/Codex 行混合无缝** |
| `SyncFailed` | error scene | mascot DevBot + pip-fail + 错误信息 + AI 建议 (Phase 2 才有) |
| `DeadLetterAccum` | aggregate chip | 聚合 chip + 「打开 admin」按钮 |
| 缺失 / 未识别 | fallback | 现有 143 行骨架的 4 字段卡片（subject/sender/priority/aiAction），不 crash |

---

## 4. 前置改动 — SessionState.hookMetadata

### 4.1 当前数据流（gap）

```
Plugin envelope (含 mailagent.scenario / .mascot / .aiSummary)
       ↓ Unix socket /tmp/island.sock
HookSocketServer.swift:1691  metadata: envelope.metadata
       ↓
HookEvent struct (含 metadata: [String: String] 字段, SessionEvent.swift:347)
       ↓ SessionStore.shared.process(.hookReceived(event))
SessionStore.swift:118-119  case .hookReceived(let hookEvent): await processHookEvent(hookEvent)
       ↓
processHookEvent 读 metadata 仅用来设 latestHookMessage / phase / intervention / clientKind 等少数字段
       ↓
SessionState  ← ❌ envelope.metadata 完整副本未存
```

**MailAgentSessionView 当前 4 个 TODO**（`MailAgentSessionView.swift:36/41/46/51`）就是因为读不到 envelope.metadata。

### 4.2 改动方案（最小 ripple）

**`SessionState.swift`** 加一个字段：

```swift
// MARK: - Hook Metadata (envelope.metadata 完整副本, fork minimal Phase 1)
/// Latest envelope.metadata received via hookReceived event.
/// MailAgentSessionView reads `mailagent.*` keys (scenario / mascot / aiSummary / senderName / ...).
/// Empty dict for non-hook-driven sessions (native runtime / file watcher).
var hookMetadata: [String: String]
```

`init` 加默认 `hookMetadata: [String: String] = [:]`。

**`SessionStore.swift` `processHookEvent`**（line 118 之后的内部 helper）在创建 / 更新 SessionState 时复制：

```swift
state.hookMetadata = hookEvent.metadata
```

**Codable/Equatable 影响**：`SessionState` 已是 `Equatable` 但**不是** `Codable`（line 36 `struct SessionState: Equatable, Identifiable, Sendable`）。`[String: String]` 自动 `Equatable + Sendable`，零额外工作。

### 4.3 不破现有 brand 处理

`.mail` brand 在 fork 已有 15+ 处 switch 完整 case 处理（Sprint 1 ship 时验证过）：

| 文件 | 行号 | 用途 |
|---|---|---|
| `MascotView.swift` | 152 / 205 / 232 / 255 | mascot 资源选择 |
| `TerminalColors.swift` | 45 / 76 | 颜色映射 |
| `SessionListView.swift` | 402 | 列表行渲染分支（generic 兜底，T3 接入点 C 改这里）|
| `ClientProfile.swift` | 1014 / 1511 | profile registry + brand switch |
| `SessionProvider.swift` | 23 / 128 | provider displayName |
| `SessionState.swift` | 1022 | supportsTmuxCLIMessaging → false |
| `SessionStore.swift` | 261 / 4084 | store 处理 mail brand |
| `RuntimeCoordinator.swift` | 99 | runtime 兜底 |
| `HookSocketServer.swift` (private BridgeProvider) | 779 / 1042 (Sprint 1 H-E 已修) | wire decode |

T3 改动**不触碰**这 15 处 —— 它们已稳。

---

## 5. fork diff 估算

| 改动 | 文件 | 行数 |
|---|---|---|
| 加 `hookMetadata` 字段 | `Models/SessionState.swift` | +3 (字段 + init 参数 + 默认值) |
| populate hookMetadata | `Services/State/SessionStore.swift` `processHookEvent` 内 | +2 |
| Scene A 接入：urgent mail 走 MailAgentSessionView | `UI/Views/SessionHoverPreviewView.swift` `SessionAttentionNotificationView` | +6 |
| Scene B 接入：hoverDashboard mail row | 同上文件 | +6 |
| Scene C 接入：sessionList mail row | `UI/Views/SessionListView.swift` (已有 `case .mail:` switch 块) | +6 |
| MailAgentSessionView 重写 4 scene 子 view | `UI/Views/MailAgentSessionView.swift` | ~300 (替换 143 骨架) |
| **合计** | — | **~323 行** |

加上 T6 mascot 资源出图（不算代码 diff）+ T5 主题色 broadcast plugin 端已 ready，fork 端只需 +5 行接收 accent。

**< 800 fork minimal diff 上限** ✓

---

## 6. T4 实施前 sanity check

T4 session 开 fork 工作前先做这些**只读验证**（< 30 min），避免假设错位：

1. **HookEvent.metadata 字段确认完整**
   - 跑 `grep -n "var metadata" PingIsland/Models/SessionEvent.swift`
   - 确认 HookEvent struct 有 `var metadata: [String: String]` 公开字段（不是 private/internal）

2. **envelope.metadata 真的透传到 HookEvent**
   - 跑 `nc -U /tmp/island.sock < /tmp/test_envelope.json`（构造一个含 `"mailagent.scenario": "MailReceivedUrgent"` 的 envelope）
   - 在 `HookSocketServer:1691` 行下加 `print(event.metadata)` 临时日志（**T4 ship 时删掉**）
   - 验证 envelope.metadata 完整出现在 HookEvent.metadata

3. **SessionStore.processHookEvent 现在怎么用 metadata**
   - `grep -n "hookEvent.metadata\|event.metadata" PingIsland/Services/State/SessionStore.swift`
   - 看现有用法是否有冲突点（应该没有，metadata 现在主要用来读 `client_kind` / `last_assistant_message`）

4. **SessionState Equatable 加 [String: String] 字段不破单测**
   - 跑 `xcodebuild test` 全 test suite，确认绿
   - 重点关注 `SessionState` 相关单测

5. **mail brand 当前真的走 attention path**
   - 翻 `PING_ISLAND_ENABLED=true` + 跑 mail-sync + 收一封紧急邮件
   - 灵动岛展开，验证 `routeContent` 走的是 `.attentionNotification` 分支
   - 否则需要补 `Resolver.highestPriorityAttentionSession` 逻辑让 mail urgent 算 `needsAttention`

---

## 7. 跟 ISLAND-PLUGIN.md §2.5 spec 的对齐

[`ISLAND-PLUGIN.md`](./ISLAND-PLUGIN.md) §2.5 / [`HANDOFF.md`](./HANDOFF.md) §1.2 写："Sprint 1 完全不动 IslandOpenedContentView；mail event 走 generic HoverSessionCard 渲染，Sprint 4 联调再决定 MailAgentSessionView 接入点"。

**T3 决议**：接入点选 generic view 内 brand 分支（方案 §3.2），**不动 IslandOpenedContentView**，跟 §2.5 spec 一致。

T4 实施完后回填以下文档：
- `ISLAND-PLUGIN.md` §2.5.4 "Sprint 4 dispatch decision" → 加 T3 决策（接入点 A/B/C 列表）
- `HANDOFF.md` §1.2 → 标 MailAgentSessionView 已路由 + 4 scene ship
- 主仓 `frontend/ISLAND-PLUGIN.md`（SSoT mirror）同步

---

## 8. Phase 1 剩余 task 与 T3 的关系

| Task | 关系 |
|---|---|
| **T4** 4 scene SwiftUI 实现 | **直接消费本 memo** —— sanity check 走完后按 §3 接入点 + §3.3 Scene 选择实施 |
| **T5** 主题色 broadcast | plugin 端已 ready（envelope.metadata.accent 写入 PRD §5.1 T1 已 ship）；fork 端读 `hookMetadata["mailagent.accent"]` 设 ring/pip 颜色 — 跟 T4 同 session 顺手做 |
| **T6** mascot 资源出图 | 跟 T4 平行；T4 view 内引用 `Image("MailMascot{Work,Personal,Dev}")` 即可，资源稍后替换 PNG/SVG/SwiftUI native pixel-art |
| **T7** 验收 + dogfood | 全 ship 后翻 `PING_ISLAND_ENABLED=true` + 1 周 |

---

## 9. 风险与缓解

| 风险 | 概率 | 缓解 |
|---|---|---|
| HookEvent.metadata 不是 envelope.metadata 完整副本（部分被过滤）| 中 | T4 sanity check #2 验证 |
| SessionState 加字段破现有 SwiftUI 渲染 binding | 低 | `var hookMetadata` 不是 `@Published` 直接绑定，只在 view body 读 |
| MailAgentSessionView 切 Scene 时丢动画连续性 | 中 | 用 SwiftUI `.id(scenario)` 显式断开 view tree，跟 ping-island 现有 ChatView/CodexSessionView 切换一致 |
| `.attentionNotification` 路由对 normal mail 不触发 | 高 | T4 sanity check #5 验证；如不触发则 normal mail 走 `.hoverDashboard` 接入点 B（仍可渲染 Scene 1 row）|
| upstream rebase 把 SessionState 重构 | 低 | 改动只加字段不改既有 —— rebase 冲突最多自动 merge |
| `MailAgentSessionView` 内 mockup 视觉跟实际 macOS 14 SwiftUI 渲染差距 | 中 | T4 实施时 side-by-side 对照 mockup-dynamic-island.html v4 截图 |

---

## 10. 完工标志

T3 任务完成 = 本 memo 写出 + commit 到 fork 仓 `docs/mailagent/`。
T4 session 开工时直接读本 memo + 跑 sanity check（§6）+ 按 §3-4 改 fork 代码。

T3 **不动任何 Swift 代码**（read-only 决策）。

---

**作者**：Claude Opus 4.7（1M context），代表 chenyqthu
**日期**：2026-05-23
**MailAgent 主仓 PRD 立项 commit**：`09c7b66` (feat/agent-harness)

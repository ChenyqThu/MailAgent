# MailAgent · ping-island Hybrid 集成

> macOS 灵动岛风格通知层。**Hybrid 方案**: fork ping-island minimal（仅 enum + mascot）+
> 业务 plugin 主体在 MailAgent 仓内。
>
> **状态**: 用户已决策 2026-05-16 走 Hybrid（替代之前的 Stage B fork / Stage A socket bridge）。
> 等 V1 Electron app 至少 Sprint 4 末 + Island-Sprint 1-3 并行开工。
>
> **关联**:
> - [`PROJECT-PLAN.md`](./PROJECT-PLAN.md) §3 Island Sprint 拆分
> - [`ARCHITECTURE.md`](./ARCHITECTURE.md) §3.4 Island 数据流图
> - [`DESIGN.md`](./DESIGN.md) §7 Dynamic Island 视觉约定 + §16/17 i18n + 主题标准
> - upstream: [github.com/erha19/ping-island](https://github.com/erha19/ping-island)（Apache 2.0）
> - fork: [github.com/ChenyqThu/ping-island](https://github.com/ChenyqThu/ping-island)
> - 本地 fork：`~/Documents/ping-island/`

---

## 0. TL;DR

| 维度 | 决策 |
|---|---|
| 路径 | **Hybrid** — fork minimal Swift + plugin 主体 Python |
| Swift 改动 | **5 行 enum + mascot 资源 + ClientProfile 注册**（< 200 行 diff，rebase 容易） |
| 业务 plugin 位置 | **MailAgent 仓内** `src/notify/island_plugin.py` + `~/.mailagent/plugins/ping_island/` |
| 与上游关系 | 月度 `git rebase upstream/main`；fork 内不动业务逻辑 |
| brand | **`.mail`**（fork 内加 enum case），自家 mascot |
| 进程关系 | ping-island 独立 `.app` + Electron main 进程 unix socket 调用 |
| 鉴权 | 无（本机 unix socket，文件权限） |
| 失败模式 | **fail-open** — ping-island 未装 / 未跑时 MailAgent 主同步不受影响 |
| i18n | envelope title/preview 必须 i18n，Python 端读 `locales/{lang}/island.json` |
| 主题色 | Electron 改 accent / themeMode → broadcast 给 ping-island |

---

## 1. 为什么 Hybrid（不走纯 Plugin / 不走 Full Fork）

| 维度 | 纯 Plugin（借现有 brand）| Full Fork（动整套 UI）| **Hybrid（推荐）** |
|---|---|---|---|
| Swift 工作量 | 0（不动 fork） | 1-2 周 | **半天 - 1 天** |
| MailAgent brand | ❌ 借 `.opencode`/`.kimi` | ✅ 自家 `.mail` | ✅ 自家 `.mail` |
| Mascot | ⚠️ 只能覆盖现有 brand 资源 | ✅ 完整自定义 | ✅ 完整自定义 |
| 业务逻辑修改 | 多次改 fork（每次升级痛苦） | 多次改 fork | **0 次** — 业务在 MailAgent 仓 |
| Upstream rebase | N/A | ⚠️ 每月麻烦 | ✅ 只 diff enum + 资源，rebase 5 分钟 |
| 用户能装 | 装 upstream | 装 fork | 装 fork |

**结论**: Hybrid 拿到 brand 独立 + mascot 完整自定义 + 上游升级几乎零成本。

---

## 2. fork 改动清单（Swift, ~7 个文件 ~150-300 行 diff，2026-05-17 fork-session 实测修正）

> 原文档说"5 个文件 < 200 行"偏低 —— `MailAgentSessionView.swift` 即使骨架版也 ~80-150 行 SwiftUI（邮件字段集与 Claude/Codex session 差异大），应纳入 Sprint 1 必做而非"可选"。
> `SessionLauncher.swift` 视邮件 intent vs 现有 intent 关系决定是否动（默认不动，邮件不需要"启动 session"语义；详 §2.8）。

### 2.0 实测修正记录（2026-05-17 fork-session 1 review）

开工前在 `~/Documents/ping-island/` 真实代码核对，发现 §2.1/§2.3/§2.4/§2.5 跟实际仓内代码错位，已下面就地修正：

| 错位 | 原 spec | 实测 | 修正位置 |
|---|---|---|---|
| **provider 枚举漏列**（H-A）| §2.1 只列 `AgentProvider` | 仓内还有独立的 `SessionProvider`（`PingIsland/Models/SessionProvider.swift:3`），是 `SessionState.provider` 真正的类型；envelope 经 HookPayloadMapper 解码后落到 `SessionProvider`。只加 `AgentProvider.mail` 不够 | §2.1b 新增 |
| **wire 解码 enum 漏列**（H-E，smoke test 后发现）| §2 没提 | `HookSocketServer.swift:279` 内部还有 `private enum BridgeProvider`（5 cases），是 **socket 上 JSON envelope 解码的真正入口**。`AgentProvider`（Models.swift `BridgeEnvelope.provider`）是 HookPayloadMapper 出 envelope 时用的类型；socket 进 envelope 时 HookSocketServer 用自己的私有 mirror struct + `BridgeProvider` 解 JSON，**再** 经 `BridgeProvider.sessionProvider` extension 映射到 `SessionProvider`。`AgentProvider.mail` 三 enum case 都齐了但 `BridgeProvider.mail` 缺 → `nc -U /tmp/island.sock` 发 `"provider":"mail"` 字符串 silent reject（`Failed to parse bridge envelope` log）。Sprint 1 验证时跑 smoke test 才暴露 | §2.1c 新增 |
| **registry 位置错**（H-B）| §2.3 说"`HookInstaller.swift` 或同级"| 实际 registry 在 `PingIsland/Models/ClientProfile.swift:547 enum ClientProfileRegistry { static let managedHookProfiles: [ManagedHookClientProfile] = [...] }` 数组里（16 个 profile 已注册），HookInstaller.swift 不直接构造 profile | §2.3 改 |
| **Mascot 命名错**（H-C）| §2.4 让建 `mascot-mail-*.imageset/` | 仓内 18 个 imageset 全部 PascalCase `*Logo.imageset`（ClaudeLogo / KimiLogo / OpenClawLogo 等），`logoAssetName` 字段实际填 `"ClaudeLogo"` 这种字面值；且 `ManagedHookClientProfile.logoAssetName` 只接受**单个** asset，不能挂 work/personal/dev 三个 | §2.4 改 |
| **路由方案错**（H-D + §5 深挖）| §2.5 让在 `IslandOpenedContentView.swift` 加 `switch session.provider { case .mail: MailAgentSessionView }` | `IslandOpenedContentView` 实际是 `switch route` 五分支（sessionList / hoverDashboard / attentionNotification / completionNotification / chat），不是 provider 扁平 switch。`IslandExpandedRouteResolver` 是 **provider-agnostic** 的（只看 surface/trigger/contentType/sessions）。Mail event 真正落点是 `.attentionNotification` / `.hoverDashboard` / `.sessionList` 三条 — 全部由 generic `HoverSessionCard`（在 `PingIsland/UI/Views/SessionHoverPreviewView.swift`）渲染，已能通过 `session.title / session.preview / session.intervention.options` 消费 mail 字段；用户主动点 session 进 detail view 才走 `.chat` 分支，邮件不是持久 chat session，不该走那 | §2.5 改 |

**Sprint 1 范围调整**:
- ✅ 仍按 REVIEW-LOG H-10 建 `MailAgentSessionView.swift` 骨架（subject / senderName / priority chip / aiAction label 4 字段，预留 `openUrl: String?`），满足契约
- ❌ **不改** `IslandOpenedContentView.swift`（spec §2.5 diff 错位，强行加只会把 mail session 误路由到 chat detail view）
- ✅ mail metadata 渲染走 generic `HoverSessionCard`，Python plugin 在 envelope 里 `title = subject`, `preview = "From: <sender>"`, `intervention.options = 5 buttons`，零 fork 改动
- ⏸ MailAgentSessionView 的真实接入点等 **Sprint 4 联调**有真实 envelope 跑通后再决定（detail view 触发条件、是否需要专属 NotchContentType case 等）

→ Sprint 1 真实工作量 **1.5-2 天**（比 H-10 重估的 2-3 天再省一点，因为不动 IslandOpenedContentView）。

### 2.1 `Prototype/Sources/IslandShared/Models.swift` — `AgentProvider`

> wire 层 enum，由 `BridgeEnvelope.provider` 字段使用。

```diff
 public enum AgentProvider: String, Codable, CaseIterable, Sendable {
     case claude
     case codex
     case copilot
     case kimi
     case gemini
+    case mail
 }
```

### 2.1b `PingIsland/Models/SessionProvider.swift` — `SessionProvider`（2026-05-17 review 补漏）

> session/UI 层 enum，由 `SessionState.provider` 字段使用，独立于 §2.1 的 `AgentProvider`。
> 实测：envelope 解码后经 `HookPayloadMapper` 转 `SessionState`，落到 `SessionProvider`；UI 视图（`HoverSessionCard` / `IslandOpenedContentView` 等）一律 switch `SessionProvider` 取色/标签。**只加 `AgentProvider.mail` 不够。**

```diff
 enum SessionProvider: String, Codable, Equatable, Sendable {
     case claude
     case codex
     case copilot
     case kimi
     case gemini
+    case mail

     nonisolated var displayName: String {
         switch self {
         case .claude:  return "Claude"
         case .codex:   return "Codex"
         case .copilot: return "Copilot"
         case .kimi:    return "Kimi"
         case .gemini:  return "Gemini"
+        case .mail:    return "MailAgent"
         }
     }
 }
```

编译时若仓内其他文件出现 missing-case，按"返回 mail brand 主题色 / 兜底字符串"补齐（详 Sprint 1 D 阶段）。

### 2.1c `PingIsland/Services/Hooks/HookSocketServer.swift` — `BridgeProvider`（2026-05-17 smoke test 后补漏）

> wire 解码层 enum，**private 到 HookSocketServer.swift**，是 socket 上 JSON envelope 进入时的真正解码入口（line 279）。
> 跟 §2.1 的 `AgentProvider` **不是同一个** enum —— HookSocketServer 内部用一套私有 mirror struct（`BridgeEnvelope` / `BridgeProvider` / `BridgeStatus` / `BridgeTerminalContext` ...）反序列化 JSON，**再**通过 `BridgeProvider.sessionProvider` extension（line 1040+）把 wire-enum 映射到 §2.1b 的 `SessionProvider`。
> `AgentProvider`（在 `Prototype/Sources/IslandShared/Models.swift` 的 public `BridgeEnvelope`）是 ping-island 出 envelope 时用的类型（HookPayloadMapper outbound），socket 入站 envelope 走的是 `BridgeProvider` 这条路径。
> **后果**：三 enum case（AgentProvider/SessionProvider/SessionClientBrand）都加 `.mail` 后，build 还是绿，但 runtime 发 `"provider":"mail"` 字符串时 `BridgeProvider` Codable 不认 → silent reject + `Failed to parse bridge envelope` warning log → 灵动岛根本不展开。Sprint 1 完工 smoke test（`nc -U /tmp/island.sock` 手发 envelope）才暴露。

```diff
 private enum BridgeProvider: String, Codable, Sendable {
     case claude
     case codex
     case copilot
     case kimi
     case gemini
+    case mail
 }
```

还有 2 处依赖 switch 需要扩 `.mail` case：

- `HookSocketServer.swift:780` 内 `let kind: SessionClientKind = ...` switch（决定 SessionClientKind）—— mail 走 plugin-style，fall back 到 matchedProfile?.kind ?? .custom，跟 .copilot/.kimi/.gemini 同模式
- `HookSocketServer.swift:1042` `BridgeProvider.sessionProvider` extension —— `case .mail: return .mail` 把 wire 层映射到 session 层

**Sprint 1 文件数从 7 → 8**（spec 原 6 + SessionProvider + HookSocketServer）。HANDOFF.md 同步修正。

### 2.2 `PingIsland/Models/ClientProfile.swift` — `SessionClientBrand`

```diff
 enum SessionClientBrand: String, Codable, Equatable, Sendable {
     case claude
     case codebuddy
     case codex
     case gemini
     case hermes
     case qwen
     case opencode
     case qoder
     case copilot
     case neutral
     case kimi
+    case mail
 }
```

### 2.3 ClientProfile registry — 新增 MailAgent profile（2026-05-17 review 修正位置）

⚠️ 原 spec 说 "`PingIsland/Services/Hooks/HookInstaller.swift` 或同级"，**位置错**。
实际 registry 在 **`PingIsland/Models/ClientProfile.swift:547`** 内 `enum ClientProfileRegistry { static let managedHookProfiles: [ManagedHookClientProfile] = [...] }` 数组（已注册 16 个 profile，含 Hermes / OpenClaw / Qwen / CodeBuddy 等）。在该数组**末尾 append**：

```swift
// PingIsland/Models/ClientProfile.swift  内的 ClientProfileRegistry.managedHookProfiles 末尾
ManagedHookClientProfile(
    id: "mailagent",
    title: "MailAgent",
    subtitle: "邮件 / Mail",
    installationKind: .pluginDirectory,   // 与 Hermes 一致的"插件目录模式"
    alwaysVisibleInSettings: true,
    logoAssetName: "MailLogo",             // ⚠️ PascalCase 跟仓内惯例对齐（详 §2.4）
    prefersBundledLogoOverAppIcon: true,
    localAppBundleIdentifiers: ["com.apple.mail"],
    iconSymbolName: "envelope.fill",
    configurationRelativePath: ".mailagent/plugins/ping_island/manifest.json",
    bridgeSource: "mail",
    bridgeExtraArguments: [
        "--client-kind", "mailagent",
        "--client-name", "MailAgent",
        "--client-origin", "plugin",
        "--client-originator", "MailAgent",
        "--thread-source", "mailagent-hooks"
    ],
    defaultEnabled: false,                 // 用户在 Settings 主动开（fail-open 默认关，跟 Hermes/OpenClaw 一致）
    brand: .mail,
    events: [
        HookInstallEventDescriptor(name: "MailReceived",      templates: [.plain]),
        HookInstallEventDescriptor(name: "MailReceivedUrgent",templates: [.plain]),
        HookInstallEventDescriptor(name: "LLMReviewed",       templates: [.plain]),
        HookInstallEventDescriptor(name: "AIDraftStart",      templates: [.plain]),
        HookInstallEventDescriptor(name: "AIDraftStream",     templates: [.plain]),
        HookInstallEventDescriptor(name: "AIDraftReady",      templates: [.plain]),
        HookInstallEventDescriptor(name: "MailCompleted",     templates: [.plain]),
        HookInstallEventDescriptor(name: "SyncFailed",        templates: [.plain]),
        HookInstallEventDescriptor(name: "DeadLetterAccum",   templates: [.plain]),
    ]
)
```

实测字段名修正：
- 原 spec 用 `configurationRelativePaths` (复数) / `activationConfigurationRelativePath` / `activationEntryName` — `ManagedHookClientProfile` 的初始化器实际是 `configurationRelativePath`（单数，跟 Hermes 一致）和 `activation*` 可选参数（用默认值即可省略）。详构造签名 `PingIsland/Models/ClientProfile.swift:167-238`。
- `defaultEnabled` 调为 `false`：与 Hermes/Gemini/OpenClaw 等 plugin 型 profile 一致，避免用户没装 MailAgent plugin 时 Settings 自动尝试连接。
- `bridgeExtraArguments` 加 `--client-kind mailagent` 等 — 模仿 Hermes profile 的 `claude-style hook bridge` 路径，让 IslandBridge 能正确分流 MailAgent envelope。

### 2.4 Mascot 资源 — `PingIsland/Assets.xcassets`（2026-05-17 review 修正命名）

⚠️ 原 spec `mascot-mail-{work,personal,dev}.imageset/` 跟仓内惯例不符。实测仓内已注册 18 个 `*Logo.imageset/`（ClaudeLogo / CodexLogo / KimiLogo / HermesLogo / OpenClawLogo 等），`logoAssetName` 字段实际填字面值如 `"ClaudeLogo"`；且 `ManagedHookClientProfile.logoAssetName` 只接受**单个** asset，无法在 profile 层挂 work/personal/dev 三套图。

**修正约定（分两层）**：
- **Profile 层（`logoAssetName`）**：单个 `MailLogo.imageset/` —— 用作 Settings → Clients 列表项的 logo，与 ClaudeLogo / KimiLogo 等保持命名一致
- **View 层（按 mailbox 切换）**：3 个 `MailMascot{Work,Personal,Dev}.imageset/` —— 由 `MailAgentSessionView` 内根据 envelope `metadata["mailagent.mailbox"]` 字段动态选图（profile 层够不到）

至少 4 个 imageset（32×32 + @2x + @3x，pixel-art style）：
- `MailLogo.imageset/` — profile 默认 logo（envelope.fill 占位也可）
- `MailMascotWork.imageset/` — Work mailbox 默认
- `MailMascotPersonal.imageset/` — Personal mailbox 默认
- `MailMascotDev.imageset/` — Dev mailbox 默认

Sprint 1 出 PNG 占位即可（复制现有 mascot / 用 sips 生纯色 PNG / 临时复用 envelope.fill SF Symbol），正图设计稿走 AI 生成（DALL-E / Midjourney pixel-art style）+ Aseprite 微调，**Sprint 5 ship 前替换**。

### 2.5 邮件专属 session view（**Sprint 1 建骨架，但 Sprint 1 不路由** —— 2026-05-17 review 重写）

⚠️ 原 spec 的 `switch session.provider` diff **错位**。实测 `PingIsland/UI/Views/IslandOpenedContentView.swift:38-95` 是 `switch route`（五分支：`.sessionList` / `.hoverDashboard` / `.attentionNotification(session)` / `.completionNotification(notif)` / `.chat(session)`），不是 provider 扁平 switch；`.chat` 分支里再做 `if liveSession.provider == .claude || .kimi → ChatView else → CodexSessionView`，**也不穷举 provider**。

#### 2.5.1 路由全景（实测 `IslandExpandedRouteResolver`）

`IslandExpandedRouteResolver.resolve(...)` 是 **provider-agnostic** 的，只看 `(surface, trigger, contentType, sessions)`：

| trigger | session 状态 | route | mail event 落点 |
|---|---|---|---|
| `.notification` | `intervention != nil` 或 `phase.isWaitingForApproval` | `.attentionNotification(session)` | **MailReceivedUrgent / LLMReviewedUrgent**（带 5-option intervention）|
| `.notification` | 有 `activeCompletionNotification` | `.completionNotification(notif)` | **MailCompleted** |
| `.hover` | 有 attention | `.attentionNotification` | hover 时 urgent 邮件浮上来 |
| `.hover` | 普通 | `.hoverDashboard`（top-3 sessions）| 一般 `MailReceived` 作为 row |
| `.click` | 有 attention | `.attentionNotification` | 同上 |
| `.click` | 普通 | `.sessionList`（全部 sessions）| 完整邮件列表 |
| 任意 trigger + `contentType == .chat(s)` | 用户主动点 session 进 detail | `.chat(session)` | **邮件不应该走这条** —— 邮件不是持久 chat session |

→ mail event 真正的渲染入口是 `.attentionNotification` / `.hoverDashboard` / `.sessionList`，这 3 个都通过 **generic `HoverSessionCard`**（`PingIsland/UI/Views/SessionHoverPreviewView.swift`）渲染，已经能消费 `session.title / session.preview / session.intervention.options` 这套 generic 字段。

#### 2.5.2 Sprint 1 实际做法

- **Python plugin（Sprint 2）** emit envelope 时把 mail 字段映射到 generic 字段：
  - `title = i18n('mail.received.title', sender=…)`（i18n 后字符串，HoverSessionCard 直接用）
  - `preview = subject`（一行 subject，HoverSessionCard 渲染为副标题）
  - `intervention.options = [open_mail, open_notion, create_draft, snooze_1h, mark_done]`（5 个按钮，HoverSessionCard 自动渲染）
  - `metadata.mailagent.*` —— 留作 Sprint 4 detail view 用
- **Fork 内 Swift（Sprint 1）**：建 `MailAgentSessionView.swift` 骨架文件，**不路由**：
  - 字段：`subject` / `senderName` / `priority chip` / `aiAction label` 4 个，预留 `openUrl: String?`（REVIEW-LOG H-12 Mail.app 跳转字段）
  - ~80 行 SwiftUI
  - 文件存在 → 满足 REVIEW-LOG H-10 契约（"Sprint 1 至少骨架，subject + sender 是底线"）+ Sprint 4 联调时有现成 view 可路由
- **不改** `IslandOpenedContentView.swift` —— 等 Sprint 4 联调时根据真实 mail envelope 行为决定接入点（可能加新 `NotchContentType.mailDetail(session)` case，或直接走 `.chat` 复用现有路径）

#### 2.5.3 Sprint 4 联调时的待决议题（占位）

- mail session 是否需要专属的 `NotchContentType.mailDetail(session)` 来跟 chat session 区分？
- 用户点 mail row 应跳到 MailAgentSessionView（detail view）还是直接调 AppleScript 打开 Mail.app？（spec §3.4 倾向后者，但 MailAgentSessionView 存在意味着前者可选）
- mail urgent 的 5 个 intervention.options 在 HoverSessionCard 中的渲染是否需要专属布局？（M-11 已经说 Phase 1 pill 只能显 1-3 个，Phase 3 expand 显 5 个）

以上 Sprint 1 不解，Sprint 4 联调时根据真实跑通的行为再决定。

#### 2.5.4 Sprint 1 smoke test 验证边界（2026-05-17 实测记录）

Sprint 1 完工 smoke test 用 `nc -U /tmp/island.sock` 手发 `MailReceived` envelope（带 `expectsResponse: false, status.kind: "notification"`），观察到：

- ✅ **wire 层**：envelope decode 成功（`BridgeProvider.mail` 加齐后无 `Failed to parse bridge envelope` warning）
- ✅ **`HookPayloadMapper.shouldDeliverEnvelope`**：对 mail envelope 返回 true（只过滤 Qoder-IDE-hosted），envelope 被投递到 session 层
- ❓ **envelope → SessionState dispatch**：Sprint 1 范围内未验证。`MailReceived` 是 MailAgent 自家事件名，**不在** ping-island 现有的 hook event dispatch 表里（那里只识别 `UserPromptSubmit` / `PreToolUse` / `Notification` / `Stop` / `SessionStart` 等 Claude/Codex 的事件名）。Sprint 4 联调时需要决定：
  1. 让 Python plugin emit envelope 时把 `eventType` 映射到 ping-island 认识的事件名（如 `Notification`），靠 `metadata.mailagent.*` 字段区分 → 改动小，但语义糊（mail event 看起来像 generic notification）
  2. 在 Swift 侧 HookSocketServer / SessionStore 加 mail 事件名识别 → 改动大，但语义清晰；rebase-friendliness 风险增大
  3. 暂时复用 `Notification` 事件名 + 走 generic HoverSessionCard，Sprint 5 polish 再决定是否做专属事件分支
- ❌ **Dynamic Island 展开**：Sprint 1 smoke test envelope 是 `MailReceived` 普通通知（无 intervention，非 `waitingForApproval`），按 ping-island Phase 模型本来就**不主动展开刘海** —— 只会 Phase 2 留 dock icon。要测试展开，envelope 要带 intervention（5 选 1 options）或 `status.kind = "waitingForInput"`，那是 Urgent / LLMReviewedUrgent 的语义，属于 Sprint 2/3 Python plugin 真实 emit 时才有

**结论**：Sprint 1 收尾标准是"wire 层 + profile 注册 + skeleton view 文件存在 + Settings UI 显示 MailAgent"。视觉上"灵动岛因 mail envelope 展开"**不在 Sprint 1 范围**，等 Sprint 4 联调 + 解决 §2.5.4 决议题后才能跑通。

### 2.8 SessionLauncher.swift 是否需要改 — 不需要

ping-island 的 `SessionLauncher.swift` 负责"在外部 app 中启动 Claude/Codex session"（如打开终端 + 执行 `claude` 命令）。邮件流不是"启动 session" 语义，而是"通知 + 跳转到现有 Mail.app/MailAgent.app"，应通过 `BridgeResponse.decision` 走 §3.4 dispatch，**不 hijack** SessionLauncher。

**默认不动** SessionLauncher.swift；如未来需要"从灵动岛直接打开 MailAgent 写新邮件"，再考虑加 launcher 入口（V2.1 议题）。

### 2.6 fork 内不动的内容

✅ 不动 HookSocketServer / BridgeEnvelope / `SessionStore` 核心逻辑
✅ 不动其他 brand 的渲染
✅ 不动 Sparkle 升级 / Mac App Store 打包
✅ 不动远程 SSH 转发 / 主题切换 / 通用音效
✅ 不动 i18n（ping-island 本身英文为主，MailAgent 字符串走 envelope metadata 由 Python 控）

### 2.7 fork 维护流程

```bash
# 月度 rebase upstream
cd ~/Documents/ping-island
git fetch upstream
git rebase upstream/main
xcodebuild test -scheme PingIslandTests
git push origin main --force-with-lease
```

冲突预期：**罕见**（只动 enum case 和 registry 末尾）。
如果 upstream 改了 `AgentProvider` enum / `SessionClientBrand` enum / `ClientProfile` 构造签名，5 分钟手动 merge。

---

## 3. Bridge 协议 — 与 ping-island upstream 完全一致

复用 ping-island 的 `BridgeEnvelope` JSON schema（不发明新协议）。从 [`archive/frontend-ping-island-integration.md`](./archive/frontend-ping-island-integration.md) §3.2 + 本地 fork 源码反推。

### 3.1 Wire（REVIEW-LOG H-16 / H-18 加 timeout + max-size）

```
AF_UNIX SOCK_STREAM
path: /tmp/island.sock（默认；可改 $ISLAND_SOCKET_PATH）

client 流程（Python 端）:
  socket.settimeout(3.0)                         # ★ connect + send + recv 共享 deadline
  connect → write(<utf-8 JSON envelope>)         # envelope <= 64 KiB 硬上限
  → shutdown(SHUT_WR)                            # 告知 Swift 端 EOF
  → read until EOF, accumulate <= 1 MiB          # ★ 上限保护 OOM
  → close

ping-island 响应（Swift NIO 2.x）:
  channel.flush() + channel.close(mode: .output) ≡ POSIX shutdown(SHUT_WR)
  写完整个 BridgeResponse JSON 后关闭 output → Python 端 recv 收到 EOF
```

**协议硬约束**:
- **envelope 上限 64 KiB** — subject + sender + metadata 全装够；超过 truncate metadata 字段（subject / preview 保留），不直接 drop
- **response 上限 1 MiB** — 防 Swift 端异常返大 payload 把 Python OOM
- **共享 3s timeout** — connect/send/recv 任一阶段超 3s `socket.timeout` exception → fail-open log.debug + 不抛
- Swift NIO half-close 行为：详 `~/Documents/ping-island/PingIsland/Services/HookSocketServer.swift` 的 `channel.close(mode:)` 调用，确认与 POSIX `shutdown(SHUT_WR)` 一致

### 3.2 Envelope (Python → ping-island)

```jsonc
{
  "id": "<UUID>",
  "provider": "mail",                          // ✅ fork 后已支持
  "eventType": "MailReceived|MailReceivedUrgent|LLMReviewed|AIDraftStart|...",
  "sessionKey": "mailagent:email:53675",       // 同 internal_id 聚合
  "title": "新邮件 / John Smith",                // i18n 后的字符串
  "preview": "Catch Up meeting SaaS 2026 Plan", // subject 1 行
  "cwd": null,
  "status": { "kind": "notification|waitingForInput|completed|error|...", "detail": null },
  "terminalContext": {},
  "intervention": null,                         // 或 question + options
  "expectsResponse": false,
  "metadata": {
    "mailagent.internalId": "53675",
    "mailagent.notionPageId": "31a15375-830d-8179-8e75-fcfce933808b",
    "mailagent.subject": "Catch Up meeting SaaS 2026 Plan",
    "mailagent.sender": "john@example.com",
    "mailagent.senderName": "John Smith",
    "mailagent.aiAction": "需要回复",
    "mailagent.priority": "Urgent",
    "mailagent.mailbox": "收件箱",
    "mailagent.attachCount": "2",
    "mailagent.lang": "en",
    "mailagent.theme": "dark",
    "mailagent.accent": "coral"
  },
  "sentAt": 770000123.456                       // ⚠️ Swift Date 编码: 自 2001-01-01 UTC 秒数
                                                 //    Python 生成: time.time() - 978307200
                                                 //    REVIEW-LOG M-15: IEEE 754 double 精度对 ±50 年范围毫秒级误差 < 0.1ms
}
```

**REVIEW-LOG H-11**: `mailagent.notionPageId` 用 **UUID-with-dash** 格式（5-segment hex with hyphens）。§3.4 dispatch 时再 `.replace('-', '')` 为 Notion deep-link URL 形态。

**i18n**: `title` / `preview` / `intervention.title` / `intervention.message` / `intervention.options[].title`
都必须用 i18n 后字符串。Python plugin 从 `~/.mailagent/plugins/ping_island/locales/{lang}/island.json` 读，
`{lang}` 来自 `mailagent.language` localStorage（或 system fallback）。

### 3.3 Intervention（用户在灵动岛点的选项）

LLMReviewedUrgent 事件用：

```jsonc
{
  "intervention": {
    "id": "<UUID>",
    "sessionID": "mailagent:email:53675",
    "kind": "question",
    "title": "i18n('mail.urgent.title', {sender: 'John'})",
    "message": "i18n('mail.urgent.message', {subject, action, priority})",
    "options": [
      { "id": "open_mail",    "title": "i18n('mail.action.openMail')" },
      { "id": "open_notion",  "title": "i18n('mail.action.openNotion')" },
      { "id": "create_draft", "title": "i18n('mail.action.createDraft')", "detail": "i18n('mail.action.createDraft.detail')" },
      { "id": "snooze_1h",    "title": "i18n('mail.action.snooze1h')" },
      { "id": "mark_done",    "title": "i18n('mail.action.markDone')" }
    ],
    "rawContext": {}
  },
  "expectsResponse": true
}
```

ping-island 渲染时把这 5 个 option 做成按钮；用户点了之后通过 `BridgeResponse.decision.answer = {"choice": "open_mail"}` 回灌。

**REVIEW-LOG M-11 — Phase 1 pill UI 空间**:
- Phase 1 pill 单行宽度仅容 **1-3 option** 横排；超出折叠为 `…` More 按钮
- 用户 hover 进 **Phase 3 expand pill**，纵排显示完整 5 options
- 优先级排序：`create_draft` > `open_mail` > `open_notion` > `mark_done` > `snooze_1h`（Phase 1 默认显示前 2-3 个）
- Phase 3 expand 才能完整选 5 个 —— UX 上要让用户 hover dock icon 触发 expand 才看到全部选项

### 3.4 Response 回灌处理（Python 端，REVIEW-LOG H-12 / M-13 修正）

```python
# src/notify/island_response.py 收到 BridgeResponse 后
import os, subprocess, time, shutil
from pathlib import Path

def handle_response(response: dict, envelope_meta: dict):
    decision = response.get("decision")
    if not isinstance(decision, dict): return
    choice = decision.get("answer", {}).get("choice")
    internal_id = int(envelope_meta["mailagent.internalId"])

    if choice == "open_mail":
        # ✅ REVIEW-LOG H-12: Mail.app AppleScript 用 message id <int> 走 mailbox 路径，
        # 不能简化为 "tell app Mail to open message id N"（语法无效）
        account_name = envelope_meta.get("mailagent.accountName", "")
        mailbox_name = envelope_meta.get("mailagent.mailboxName", "收件箱")
        script = f'''
            tell application "Mail"
              activate
              set m to first message of mailbox "{mailbox_name}" of account "{account_name}" whose id is {internal_id}
              open m
            end tell
        '''
        subprocess.run(["osascript", "-e", script], check=False, timeout=5)

    elif choice == "open_notion":
        page_id_dashed = envelope_meta["mailagent.notionPageId"]
        page_id_flat = page_id_dashed.replace("-", "")
        # ✅ REVIEW-LOG M-13: Notion 桌面版未装时 fallback Web URL
        notion_app_installed = bool(shutil.which("open")) and Path("/Applications/Notion.app").exists()
        if notion_app_installed:
            url = f"notion://www.notion.so/{page_id_flat}"
        else:
            url = f"https://www.notion.so/{page_id_flat}"
        subprocess.run(["open", url], check=False, timeout=3)

    elif choice == "create_draft":
        subprocess.run([
            "mailagent", "email", "draft", str(internal_id),
            "--api-key", os.environ["MAILAGENT_CLI_API_KEY"],
        ], check=False, timeout=10)

    elif choice == "snooze_1h":
        snooze_until = time.time() + 3600
        # 写 ~/.mailagent/snooze.json，main.py 轮询命中再 re-emit envelope
        snooze_add(internal_id, snooze_until)

    elif choice == "mark_done":
        subprocess.run([
            "mailagent", "notion", "update-flag", str(internal_id),
            "--processing-status", "已完成",
            "--api-key", os.environ["MAILAGENT_CLI_API_KEY"],
        ], check=False, timeout=10)
```

**REVIEW-LOG H-12 关键修正**:
- Mail.app 的"打开 message id N" 必须走 `mailbox of account` 路径，AppleScript 不支持顶层 `open message id N`
- envelope `metadata` 增加 `mailagent.accountName` / `mailagent.mailboxName` 字段，对接 `src/mail/applescript_arm.py` 已用的写法

---

## 4. Plugin 主体 — MailAgent 仓内（Python）

### 4.1 模块布局（REVIEW-LOG H-09 权威定稿 — PROJECT-PLAN.md Island-Sprint 2 同步）

```
src/notify/
  ping_island.py            ← socket writer + envelope builder + 显式 settimeout(3.0)
                              （PoC 期间在 archive 文档里，正式版加 timeout / max-size）
  island_dispatch.py        ← 4 个事件源 → envelope 构建 → 调 ping_island.send()
  island_response.py        ← BridgeResponse 回灌处理（§3.4）— 正确 AppleScript / Notion fallback
  island_snooze.py          ← snooze 队列 + 轮询 re-emit
  island_reconnect.py       ← ★ REVIEW-LOG H-17 新增：5 min 探测 socket 文件 + send queue + backoff
  island_i18n.py            ← REVIEW-LOG M-14：mtime-aware locale 缓存

~/.mailagent/plugins/ping_island/   ← 用户家目录下
  manifest.json             ← ping-island ClientProfile activationConfigurationRelativePath 指向
  locales/
    zh-CN/island.json
    en-US/island.json
  mascots/                  ← 软链 fork 内 Assets 或独立 PNG（用户可换）
```

**5 个 Python 文件**（不是原文档说的 4 个）—— 加 `island_reconnect.py` 处理 sleep/wake socket 重连。

### 4.2 manifest.json

```json
{
  "name": "MailAgent",
  "version": "0.1.0",
  "brand": "mail",
  "events": [
    "MailReceived",
    "MailReceivedUrgent",
    "LLMReviewed",
    "AIDraftStart",
    "AIDraftStream",
    "AIDraftReady",
    "MailCompleted",
    "SyncFailed",
    "DeadLetterAccum"
  ],
  "socket_path": "/tmp/island.sock",
  "default_locale": "system"
}
```

### 4.3 集成点（hook into mail-sync）

| 文件 | 触发点 | 事件 |
|---|---|---|
| `src/mail/new_watcher.py:_sync_single_email_v3` | Notion sync 成功 | `MailReceived` 或 `MailReceivedUrgent`（按 priority） |
| `src/llm_agent/runner.py:sync_from_email` | LLM 处理完 | `LLMReviewed` / `LLMReviewedUrgent` |
| `src/events/handlers.py:handle_completed` | Notion → Mail 完成 | `MailCompleted`（清掉 Phase 2 dock icon） |
| `src/mail/sync_store.mark_failed` | 累积超阈值 | `SyncFailed` |
| `src/notify/alert.py` 已触发 dead_letter | 累积 | `DeadLetterAccum` |
| Electron AI Chat panel `Composer.send()` | start | `AIDraftStart` |
| ↑ stream callback | 每 N 个 token | `AIDraftStream` |
| ↑ on complete | 结束 | `AIDraftReady`（含 preview） |

所有调用走 `asyncio.create_task(island_dispatch.send_async(...))` fire-and-forget，
**绝不阻塞主同步**。

### 4.4 总开关 + 失败兜底（REVIEW-LOG H-16 加显式 timeout）

```bash
# .env
PING_ISLAND_ENABLED=false                    # 默认关，用户启用
ISLAND_SOCKET_PATH=/tmp/island.sock           # 自定义
ISLAND_SOCKET_TIMEOUT=3.0                     # ★ connect/send/recv 共享 deadline (秒)
PING_ISLAND_LANG=system                       # system / zh-CN / en-US
PING_ISLAND_MASCOT_WORK=mascot-mail-work      # 用户选 mascot
PING_ISLAND_RECONNECT_PROBE_INTERVAL=300      # ★ §4.5 reconnect 检查间隔（秒）
PING_ISLAND_QUEUE_MAX=20                      # ★ §4.5 backlog send queue 上限
```

失败模式（全部静默降级；REVIEW-LOG H-16 加 timeout 失败）:
- ping-island 未装（FileNotFoundError） → `connect()` 失败 → 入 reconnect queue → 不影响主同步
- ping-island 关闭（ConnectionRefusedError） → 同上
- envelope 编码错 → `log.warning`，不抛
- socket 超时（socket.timeout） → log.debug + 入 reconnect queue → 不抛

**关键实现**:
```python
import socket
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.settimeout(float(os.environ.get("ISLAND_SOCKET_TIMEOUT", "3.0")))
try:
    sock.connect(SOCK_PATH)
    sock.sendall(envelope_bytes)
    if len(envelope_bytes) > 64 * 1024:
        raise ProtocolError("envelope > 64 KiB")
    sock.shutdown(socket.SHUT_WR)
    response = b""
    while chunk := sock.recv(4096):
        response += chunk
        if len(response) > 1 << 20:
            raise ProtocolError("response > 1 MiB")
except (socket.timeout, FileNotFoundError, ConnectionRefusedError, OSError, ProtocolError) as e:
    log.debug("island dispatch failed (fail-open): %s", e)
    reconnect_queue.enqueue(envelope_bytes)  # §4.5
finally:
    sock.close()
```

### 4.5 socket 重连策略（REVIEW-LOG H-17 新增）

macOS sleep/restart 后 `/tmp/island.sock` 文件被清理；当前 fire-and-forget 不重试 = 静默丢通知。新加 `island_reconnect.py`:

```python
# src/notify/island_reconnect.py
import os, time, asyncio, logging
from collections import deque

log = logging.getLogger(__name__)
SOCK_PATH = os.environ.get("ISLAND_SOCKET_PATH", "/tmp/island.sock")
PROBE_INTERVAL = int(os.environ.get("PING_ISLAND_RECONNECT_PROBE_INTERVAL", "300"))  # 5 min
QUEUE_MAX = int(os.environ.get("PING_ISLAND_QUEUE_MAX", "20"))

_queue: deque[bytes] = deque(maxlen=QUEUE_MAX)
_backoff_idx = 0
BACKOFF = [5, 30, 120, 600]  # 5s / 30s / 2min / 10min 上限

def enqueue(envelope_bytes: bytes):
    """failed send 入队，等下次 reconnect 成功 flush。"""
    _queue.append(envelope_bytes)

async def reconnect_loop(send_fn):
    """主循环每 PROBE_INTERVAL 秒检查 socket 文件，恢复后 flush queue。"""
    global _backoff_idx
    while True:
        try:
            if not os.path.exists(SOCK_PATH):
                # ping-island 未跑，等下次
                await asyncio.sleep(PROBE_INTERVAL)
                continue
            # 试发一个轻量 ping envelope
            ok = await send_fn(_build_ping_envelope())
            if ok and _queue:
                log.info("island reconnected, flushing %d queued envelopes", len(_queue))
                while _queue:
                    await send_fn(_queue.popleft())
                _backoff_idx = 0
                await asyncio.sleep(PROBE_INTERVAL)
            elif not ok:
                wait = BACKOFF[min(_backoff_idx, len(BACKOFF) - 1)]
                _backoff_idx += 1
                await asyncio.sleep(wait)
        except Exception as e:
            log.warning("reconnect_loop error: %s", e)
            await asyncio.sleep(PROBE_INTERVAL)
```

main.py 启动时 `asyncio.create_task(island_reconnect.reconnect_loop(...))` 后台跑。

---

## 5. 4 phase 生命周期（与 ping-island 原生一致）

ping-island 已实现"先感知，再展开"模型（详 DESIGN.md §7.1）：

| Phase | 触发 | MailAgent 例子 |
|---|---|---|
| **Arrive** 4s | `expectsResponse=true` 或 `status.kind ∈ {error, waitingForInput}` | MailReceivedUrgent / SyncFailed |
| **Compact** 持久 | Critical / Urgent / SyncFailed / AIDraftReady 留 dock icon | 直到用户 ack |
| **Hover Expand** 200ms 延 | 鼠标移到 dock icon | 显示完整 session list（Phase 1 + 3 options） |
| **Jump** 220ms 闪 + ripple | 用户点 option → BridgeResponse | dispatch §3.4 action |

**clears on**:
- `MailCompleted` envelope（同 sessionKey） → Phase 2 dock icon 清掉
- 用户在灵动岛点 `mark_done` / `open_mail` → 自动清

---

## 6. Buddy 离岛模式（ping-island v0.5.0+）

ping-island 支持把 mascot 拖出 notch 成独立悬浮窗（"Buddy 离岛"）。MailAgent 利用方式：

- 用户拖出 mascot → 在屏幕右上常驻一个 32×32 邮件 mascot 浮窗
- 浮窗显示**当天未读邮件 count** 实时更新
- 点击浮窗 → 等同于 Phase 4 jump：打开 MailAgent.app 跳 Inbox

Plugin 端通过 envelope `metadata.mailagent.unreadCount` 实时刷新。

---

## 7. i18n 实施

### 7.1 `~/.mailagent/plugins/ping_island/locales/zh-CN/island.json`

```json
{
  "mail.urgent.title": "邮件需要处理 / {{sender}}",
  "mail.urgent.message": "{{action}} · {{priority}}\n\n{{subject}}",
  "mail.received.title": "新邮件 / {{sender}}",
  "mail.received.title.work": "💼 新工作邮件 / {{sender}}",
  "mail.received.title.personal": "📧 新个人邮件 / {{sender}}",
  "mail.completed.title": "已完成 / {{subject}}",
  "mail.syncFailed.title": "同步失败 / {{internalId}}",
  "mail.syncFailed.message": "{{error}}",
  "mail.deadLetter.title": "{{count}} 封邮件进入死信",
  "mail.action.openMail": "打开 Mail.app",
  "mail.action.openNotion": "去 Notion 处理",
  "mail.action.createDraft": "创建回复草稿",
  "mail.action.createDraft.detail": "走 Mail.app draft",
  "mail.action.snooze1h": "稍后再看 (1h)",
  "mail.action.markDone": "标记完成",
  "ai.draft.start.title": "AI 起草中 / {{sender}}",
  "ai.draft.ready.title": "AI 草稿就绪 / {{sender}}",
  "ai.draft.ready.preview": "{{preview}}"
}
```

### 7.2 `~/.mailagent/plugins/ping_island/locales/en-US/island.json`

```json
{
  "mail.urgent.title": "Mail Needs Action / {{sender}}",
  "mail.urgent.message": "{{action}} · {{priority}}\n\n{{subject}}",
  "mail.received.title": "New mail / {{sender}}",
  "mail.completed.title": "Done / {{subject}}",
  ...
}
```

### 7.3 Python 端 i18n loader（轻量，不引依赖；REVIEW-LOG M-14 加 mtime 失效）

```python
# src/notify/island_i18n.py
import json
import os
from pathlib import Path

_LOCALES_DIR = Path.home() / ".mailagent/plugins/ping_island/locales"
_cache: dict[str, tuple[float, dict]] = {}   # lang → (mtime, dict)

def _resolve_lang() -> str:
    lang = os.environ.get("PING_ISLAND_LANG", "system")
    if lang == "system":
        env_lang = os.environ.get("LANG", "en_US.UTF-8").split(".")[0].replace("_", "-")
        lang = env_lang if env_lang in {"zh-CN", "en-US"} else "en-US"
    return lang

def _load(lang: str) -> dict:
    path = _LOCALES_DIR / lang / "island.json"
    if not path.exists():
        return {}
    mtime = path.stat().st_mtime
    cached = _cache.get(lang)
    if cached is not None and cached[0] == mtime:
        return cached[1]
    data = json.loads(path.read_text(encoding="utf-8"))
    _cache[lang] = (mtime, data)
    return data

def t(key: str, **kwargs) -> str:
    """主入口；mtime 变了自动重载。"""
    lang = _resolve_lang()
    tmpl = _load(lang).get(key, key)
    # i18next 风格 {{var}} → Python format {var}；先对真实 `{` `}` 字面量 escape 避免 KeyError
    safe = tmpl.replace("{", "{{").replace("}", "}}").replace("{{{{", "{").replace("}}}}", "}")
    return safe.format(**kwargs)

def reload_locale(lang: str | None = None):
    """切换语言时主动 invalidate cache（REVIEW-LOG M-14）。"""
    if lang is None:
        _cache.clear()
    else:
        _cache.pop(lang, None)

# 用例:
# from src.notify.island_i18n import t, reload_locale
# t("mail.received.title", sender="John")  → "新邮件 / John"
# 用户改语言后 → reload_locale()
```

**双重 brace escape** 避开 `kwargs` 值含 `{` 字符时 `.format()` 抛 KeyError —— 邮件主题里 `{TODO}` `{Order #123}` 等字面量常见。

### 7.4 与前端 i18n 一致性

| 来源 | 字符串 | 谁负责 i18n |
|---|---|---|
| Electron renderer (React 组件) | UI 显示 | `react-i18next` (DESIGN.md §16) |
| Python plugin (envelope title/preview) | 灵动岛显示 | `island_i18n.py.t()` |
| Electron main IPC error message | toast 显示 | 走 i18n key + React 端翻译 |

两份 locale 文件（前端 + Python）**手动同步**（V1 不引复杂工具），通过 `pnpm i18n:lint` 脚本（Sprint 7）扫两边 key 一致性。

---

## 8. 主题色 / 主题三态同步（REVIEW-LOG M-01 加 main IPC handler）

Electron 主题色或 themeMode 变化时，broadcast 给 ping-island：

```typescript
// frontend/src/shared/state/appearance.ts
useAppearance.subscribe((state, prev) => {
  if (state.accent !== prev.accent || state.resolvedTheme !== prev.resolvedTheme) {
    window.electron.send('island:appearance', {
      accent: state.accent,
      theme: state.resolvedTheme,    // 'dark' | 'light'
    });
  }
});

// frontend/src/electron/main/handlers/island.ts
ipcMain.on('island:appearance', (_evt, payload) => {
  // 推一个 special envelope eventType=AppearanceChange
  sendEnvelopeToIsland({
    provider: 'mail',
    eventType: 'AppearanceChange',
    sessionKey: 'mailagent:system:appearance',
    metadata: {
      'mailagent.accent': payload.accent,
      'mailagent.theme': payload.theme,
    },
    expectsResponse: false,
  });
});
```

ping-island 收到 `AppearanceChange` envelope 后内部更新 `--c-accent` CSS 变量（fork 内加 handler）。

---

## 9. 评估指标（V1 ship 后跟踪）

PoC 期间在 `data/sync_store.db` 加 `island_dispatch` 表：

```sql
CREATE TABLE IF NOT EXISTS island_dispatch (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at REAL,
    event_type TEXT,
    session_key TEXT,
    dispatched_ok INTEGER,       -- 1=连上了 ping-island, 0=ENOENT/timeout
    response_decision TEXT,      -- 用户点的 option（仅 expectsResponse=true）
    response_latency_ms INTEGER, -- 发出到用户回应的耗时
    internal_id INTEGER
);
```

跑 14 天评估 4 指标:

| 指标 | "值得继续维护"阈值 |
|---|---|
| 总 envelope 数 / 周 | > 100（说明你在用） |
| `expectsResponse` 回应率 | > 40%（值得用户回应） |
| response_latency_ms 中位数 | < 30s（即时承接注意力） |
| dispatch_ok 率 | > 95%（fail-open 验证） |

不达标 → 降级保留 fork 但禁用 plugin（用户自己运行 ping-island 看其他 AI 工具）。

---

## 10. 不在本文档范围

- ❌ ping-island 自身 Sparkle 升级 / Mac App Store 发布
- ❌ 远程 SSH 邮件 session 转发（MailAgent 是本机的）
- ❌ 替代 V1 Electron app（灵动岛是通知层，Electron 是数据浏览层，互补）
- ❌ 跨平台（ping-island macOS-only，邮件主服务也 macOS-only，完美对齐）

---

## 11. 协议参考

完整 BridgeEnvelope JSON schema / wire format / Swift Date 编码陷阱 / Python PoC 代码
等详细协议参考见归档 [`archive/frontend-ping-island-integration.md`](./archive/frontend-ping-island-integration.md)
§3 与 §6（保留作"快速调试用"参考实现）。

---

> Sprint 启动协调点见 [`PROJECT-PLAN.md`](./PROJECT-PLAN.md) §3 / §5.4。
> Hybrid 路径与 V1 Electron app + V2 远程访问完全独立可并行开发。

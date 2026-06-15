# Ping Island 集成调研 — MailAgent 灵动岛通知 / 跳转

> **目的**: 评估把 [erha19/ping-island](https://github.com/erha19/ping-island) 作为 MailAgent
> 第 5 条通知通道（macOS 灵动岛风格）的可行性、接入协议、阶梯方案与 push back。
>
> **状态**: 调研完成，**用户已决策走 Stage B**（2026-05-16）—— fork ping-island
> 加 MailAgent 专属 provider + mascot + 邮件 session view，跳过 Stage A 的 socket
> bridge hack。下方 §6 Stage A Python PoC 段保留作"协议参考"，不实施。
>
> **本地代码**: `~/Documents/ping-island/`（已 fork 到 `ChenyqThu/ping-island`）。
>
> **关联**:
> - [`frontend-v1-feature-spec.md`](./frontend-v1-feature-spec.md) §通知 段落补充
> - [`frontend-design-handoff.md`](./frontend-design-handoff.md) §2 文档清单
> - 本调研不修改 [`frontend-v1-implementation-plan.md`](./frontend-v1-implementation-plan.md) — 灵动岛是
>   V1 Electron app 之外的平行话题，最早 V2 探索。

---

## 0. TL;DR

ping-island **不是 Web 灵动岛组件库**，是 **macOS 14+ Swift 6 / SwiftUI 原生 menubar app**，
定位"AI 编码会话的 Dynamic Island 风格状态显示器"（Claude Code / Codex / Gemini CLI / Hermes /
Qwen / Kimi / OpenCode）。

它通过 **AF_UNIX socket** (`/tmp/island.sock`, 可改 `ISLAND_SOCKET_PATH`) 接收 JSON `BridgeEnvelope`，
**任何能写 socket 的语言** 都能推事件 — Python 30 行 PoC 即可让 MailAgent 邮件出现在灵动岛里。

代价 / 风险：

- `AgentProvider` enum 写死 5 个值，**没有 `mail` / `mailagent`** — 不 fork 必须借 `kimi`/`gemini`
  做 brand 占位，session 列表显示成那个 brand 的 mascot；
- 语义上 ping-island 核心交互是 **"会话内 approval / question 回到 terminal/IDE"**，
  邮件场景核心是 **"跳 Mail.app 打开 / 跳 Notion 页"**，跳转路径要自己写 Swift；
- 已有 4 条通知通道（飞书卡片 / Notion webhook / Mail.app 旗标 / V1 Electron app），
  灵动岛是第 5 条，**性价比看用法**。

**实施路径**（用户已决策 2026-05-16）：直接 **Stage B**（fork + 加 MailAgent provider，
1-2 周 Swift）。理由：用户希望 ship 给协作者用、要邮件专属 UI（subject/sender/AI chips）、
不接受借 Kimi mascot 的 brand 占位。Stage A（socket bridge PoC）作为"协议参考"保留 §6，**不实施**。

时机：V1 Electron app ship 后启动，与 [`frontend-v2-remote-access.md`](./frontend-v2-remote-access.md) 远程访问 V2 并行。

---

## 1. 现实校准 — 跟"前端灵动岛"直觉的差距

| 直觉假设 | 事实 |
|---|---|
| 它是个 npm/Web 组件库，能 `<DynamicIsland>` 进 Electron | ❌ Swift 6.1 + SwiftUI，编译产物是 `.app`，独立进程 |
| 在浏览器里跑 | ❌ 必须 macOS 14+ 装 PingIsland.app |
| 改 React 代码就能加邮件支持 | ❌ 加 brand 要改 Swift enum + 资源 + ClientProfile，重新 build |
| 它本身就有通用通知 API | ⚠️ 有 socket bridge，但 schema 是为"AI session"设计的（provider/intervention/expectsResponse） |
| 装上后任何事件都有刘海动画 | ✅ 只要写对 envelope，立即有动效 + 可点击 + 可拖出"离岛" |

---

## 2. ping-island 是什么 / 不是什么

### 是
- macOS 14+ 菜单栏常驻 app（Swift 6.1 / SwiftUI / Sparkle 自动更新）
- 平时停在刘海区紧凑显示状态，hover/点击展开 session 列表
- v0.5.0+ 支持"Buddy 离岛"—— 拖出独立悬浮窗
- 每个 brand 有 mascot（Claude / Hermes 金色狐 / Qwen 卡皮巴拉 / Kimi 蓝键盘球…）
- 内置音效系统（OpenPeon/CESP 主题包）
- 接入方式：
  - **A. ClientProfile 注册的 hooks**（写到 `~/.{client}/...` 配置）— 适合有 hooks 协议的 agent
  - **B. UNIX socket bridge**（`/tmp/island.sock`）— **任何进程都能推**，本文档主要走这条
- License: Apache 2.0

### 不是
- 不是 Web 组件
- 不是通知中心替代（macOS 系统 `UNUserNotificationCenter` 各管各的）
- 不是邮件客户端 / 写邮件 UI
- 不是后台同步引擎（它只是 UI 层）
- 不是 iOS 上的真灵动岛（虽然视觉风格借鉴 Dynamic Island）

---

## 3. 接入协议 — BridgeEnvelope over UNIX Socket

### 3.1 Wire 格式

```
client → ping-island:
  AF_UNIX SOCK_STREAM, path=/tmp/island.sock
  connect → write(<utf-8 JSON envelope>) → shutdown(SHUT_WR) → read 4KB until EOF → close

ping-island → client:
  写完整个 BridgeResponse JSON → 关闭连接（client 收到 EOF）
```

**关键点**:
- **一次连接 = 一个 envelope**（不是 long-lived，不是 line-delimited）
- 无 length-prefix / framing header — 完全靠 `shutdown(SHUT_WR)` 标记边界
- 期望响应（`expectsResponse=true`）时同步等响应；fire-and-forget 时也能拿到默认空响应
- ping-island 未运行 → `connect()` 返回 `ENOENT`/`ECONNREFUSED` — **本地服务要静默降级**，不能因为
  灵动岛没装就阻塞邮件 sync

### 3.2 BridgeEnvelope JSON Schema（从 `Prototype/Sources/IslandShared/Models.swift` 反推）

```jsonc
{
  "id": "<UUID>",                              // Swift UUID 字符串
  "provider": "claude|codex|copilot|kimi|gemini", // ❗ enum 限制，无 mail
  "eventType": "<自由字符串>",                  // 如 "Notification" / "PreToolUse" / 自定义
  "sessionKey": "<string>",                    // 同 key 聚合成同一个 session
  "title": "string?",                          // 灵动岛 / session list 主标题
  "preview": "string?",                        // 副标题 / 1 行预览
  "cwd": "string?",                            // 路径（点跳转可参考）
  "status": {
    "kind": "idle|active|thinking|runningTool|waitingForApproval|waitingForInput|compacting|completed|interrupted|notification|error",
    "detail": "string?"
  },
  "terminalContext": {                          // 全字段 optional
    "terminalProgram": null, "ideName": null, "tty": null,
    "currentDirectory": null, "transport": null, "remoteHost": null,
    "tmuxSession": null, "tmuxPane": null,
    "iTermSessionID": null, "terminalSessionID": null,
    "terminalBundleID": null, "ideBundleID": null
  },
  "intervention": {                             // null 或 approval/question
    "id": "<UUID>",
    "sessionID": "<string>",
    "kind": "approval|question",
    "title": "string",
    "message": "string",
    "options": [{"id": "...", "title": "...", "detail": "..."}],
    "rawContext": {"k": "v"}
  } | null,
  "expectsResponse": false,                     // true → 等 BridgeResponse
  "metadata": {"k": "v"},                       // 自定义键值（用来塞 internal_id / notion_page_id）
  "sentAt": 770000123.456                       // ❗ Swift Date 默认编码：自 2001-01-01 UTC 起的秒数（double）
}
```

**坑 1 — Date 编码**: Swift `JSONEncoder()` 默认 `dateEncodingStrategy = .deferredToDate`，
写出来是 *seconds since 2001-01-01 UTC*（不是 ISO8601，也不是 unix epoch）。
换算: `swift_ts = unix_ts - 978307200.0`。

**坑 2 — Provider enum**: 不 fork 必须填 `claude|codex|copilot|kimi|gemini` 之一。
推荐借 `kimi`（最少 mailagent 用户认识它，混淆面最小）或单独的 `copilot`。

**坑 3 — UUID 字段**: `id` / `intervention.id` 等是 Swift UUID，必须是 `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX`
格式字符串（小写也行）。Python `str(uuid.uuid4())` 即可。

### 3.3 BridgeResponse JSON Schema

```jsonc
{
  "requestID": "<UUID>",       // 必须 = envelope.id
  "decision": "approve|approveForSession|deny|cancel" | {"answer": {"k": "v"}} | null,
  "reason": "string?",
  "updatedInput": {"k": "<JSONValue>"} | null,
  "errorMessage": "string?"
}
```

Fire-and-forget envelope（`expectsResponse=false`）会收到 `{"requestID": <env.id>}` 空响应或连接立刻关闭。

### 3.4 健康检查

```python
# 一连接发一帧，期待 {"ok":true}
sock.sendall(b'{"type":"ping-island-health-check"}')
sock.shutdown(socket.SHUT_WR)
assert sock.recv(128).strip() == b'{"ok":true}'
```

---

## 4. MailAgent 事件 → BridgeEnvelope 映射

| MailAgent 事件 | 触发点（代码） | envelope.eventType | status.kind | intervention | 备注 |
|---|---|---|---|---|---|
| 新邮件 sync 成功 | `mail/new_watcher.py:_sync_single_email_v3` | `MailReceived` | `notification` | null | title="新邮件 / {sender_name}"，preview=subject，metadata.internalId / notionPageId |
| LLM 处理完（普通） | `llm_agent/runner.py:sync_from_email` | `LLMReviewed` | `notification` | null | title="✦ AI 已分类"，preview="{action} · {priority}" |
| LLM 高优先级（需要响应） | 同上, 当 priority ∈ {Critical, Urgent} | `LLMReviewedUrgent` | `waitingForInput` | `question` + options=[去回复, 创建草稿, Snooze, 标记完成] | `expectsResponse=true`，response.decision.answer 回灌触发 CLI |
| Notion AI Reviewed webhook | `events/handlers.py:handle_ai_reviewed` | `NotionAIReviewed` | `notification` | null | 等效信号，去重靠 metadata.notionPageId |
| 用户在 Notion 标完成 | `events/handlers.py:handle_completed` | `MailCompleted` | `completed` | null | 同 sessionKey 的 envelope 状态收尾 |
| sync 失败累积 | `sync_store.mark_failed` 累积超阈值 | `SyncFailed` | `error` | null | title="同步失败 / {internal_id}"，preview=error |
| dead_letter 累积 | `notify/alert.py` warning 通道 | `DeadLetterAccum` | `error` | null | 阈值与 `ALERT_DEAD_LETTER_THRESHOLD` 对齐 |
| LLM gave_up | `llm_agent/store.py` retry 用尽 | `LLMGaveUp` | `error` | null | 与现有飞书 warning 同源 |

**sessionKey 设计**:
- 每封邮件 1 个 session：`mailagent:email:{internal_id}` — 同一封邮件的 sync 成功 → LLM → 完成
  会聚合在同一个灵动岛 session row
- 系统级聚合：`mailagent:system:syncFailed` / `mailagent:system:deadLetter` — 错误类合并显示

**provider 选择**（Stage A 不 fork 时）:
- 推荐 `kimi`（与现有 5 个 brand 中重叠场景最少）
- 或 `copilot`（GitHub Copilot 也是 Claude 系，brand 比较中性）
- ❌ 不要用 `claude` — 会与本机真 Claude Code session 混在同一个列表

---

## 5. 阶梯方案

| Stage | 内容 | 工作量 | Provider 显示 | 建议时机 |
|---|---|---|---|---|
| **A. Socket bridge PoC**（推荐先做） | Python `island_writer.py` 推 envelope 到 `/tmp/island.sock`；借 provider=`kimi`；MailReceived / LLMReviewed / SyncFailed 三类；envelope 失败静默降级 | **0.5–1 天** | Kimi 蓝键盘球 mascot（hack） | V1 Electron app ship 后做 V2 探索 |
| **B. fork + 注册 MailAgent provider** | fork ping-island；加 `AgentProvider.mail`、`SessionClientBrand.mail`；加 `ClientProfile`（id=mailagent / mascot 资源 / display name "MailAgent"）；改 `IslandPresentationCoordinator` 加邮件专属 session view（subject / sender / AI chips）；点击跳 Mail.app / Notion deep-link | **1–2 周 Swift** | MailAgent 自家 mascot | Stage A 验证 1 周后跑通了价值才做 |
| **C. 自研 SwiftUI menubar app** | 不用 ping-island，自己写 | 3–4 周 | - | ❌ 不推荐（重复造轮子） |

### Stage A 适用场景
- 个人本机用，能容忍灵动岛里显示成"Kimi"
- 想验证"邮件通知到灵动岛是不是真有价值"再决定是否投 Swift 工作
- 0 维护负担（不 fork，跟着上游 ping-island 自动更新）

### Stage B 适用场景
- 验证了"我每天会用灵动岛点开邮件"
- 想拿到 mascot / 邮件专属 UI（subject 长展示 / 附件 chip / AI Action chip）
- 接受维护一个 fork（每次 ping-island 升级要 rebase）

### Stage C 我直接劝退
ping-island 已经把刘海区域、窗口管理、Sparkle 自动更新、mascot 系统、声音包、能源策略
（`EnergyGovernor`）、低电量 throttling 都做了 — 这些自己写至少 3 周。

---

## 6. Stage A — Python PoC 设计（⚠️ 已决策不实施，仅作协议参考）

> 用户 2026-05-16 决定直接走 Stage B（§7）。本节代码作为 BridgeEnvelope 协议如何用
> Python 调用的**参考实现**保留 —— 将来如果有"快速验证 ping-island 是否在线 / 调试
> envelope 字段"的需求，可拿这段代码直接用。生产路径走 §7 的 Swift fork。

### 6.1 新增模块 `src/notify/ping_island.py`

```python
"""Ping Island bridge writer (Stage A — PoC).

Fire-and-forget envelope writer. Failures are silent (ping-island not installed
or not running ≠ MailAgent sync failure).
"""

from __future__ import annotations

import json
import logging
import os
import socket
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

log = logging.getLogger(__name__)

# Swift Date is encoded as seconds-since-2001-01-01-UTC (Reference Date).
_SWIFT_EPOCH_OFFSET = 978307200.0

# Borrowed provider (no `mail` in upstream AgentProvider enum).
_PROVIDER = "kimi"

_SOCKET_PATH = os.environ.get("ISLAND_SOCKET_PATH", "/tmp/island.sock")
_CONNECT_TIMEOUT = 0.5  # seconds; ping-island should respond instantly on local UDS
_READ_TIMEOUT = 1.5


def _swift_now() -> float:
    return time.time() - _SWIFT_EPOCH_OFFSET


@dataclass
class Envelope:
    event_type: str
    session_key: str
    title: Optional[str] = None
    preview: Optional[str] = None
    cwd: Optional[str] = None
    status_kind: str = "notification"  # see SessionStatusKind enum
    status_detail: Optional[str] = None
    intervention: Optional[dict[str, Any]] = None
    expects_response: bool = False
    metadata: dict[str, str] = field(default_factory=dict)

    def to_wire(self) -> dict[str, Any]:
        return {
            "id": str(uuid.uuid4()),
            "provider": _PROVIDER,
            "eventType": self.event_type,
            "sessionKey": self.session_key,
            "title": self.title,
            "preview": self.preview,
            "cwd": self.cwd,
            "status": {"kind": self.status_kind, "detail": self.status_detail},
            "terminalContext": {},
            "intervention": self.intervention,
            "expectsResponse": self.expects_response,
            "metadata": self.metadata,
            "sentAt": _swift_now(),
        }


def send(envelope: Envelope) -> Optional[dict[str, Any]]:
    """Send envelope to ping-island. Returns BridgeResponse dict or None.

    Failure modes (all silent / return None):
    - ping-island not installed (ENOENT)
    - ping-island not running (ECONNREFUSED)
    - socket timeout
    - JSON encoding error (logged at WARNING)
    """
    try:
        payload = json.dumps(envelope.to_wire(), separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as exc:
        log.warning("[ping-island] envelope encode failed: %s", exc)
        return None

    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(_CONNECT_TIMEOUT)
            sock.connect(_SOCKET_PATH)
            sock.sendall(payload)
            sock.shutdown(socket.SHUT_WR)
            sock.settimeout(_READ_TIMEOUT)
            buf = bytearray()
            while chunk := sock.recv(4096):
                buf.extend(chunk)
        if not buf:
            return None
        return json.loads(buf.decode("utf-8"))
    except (FileNotFoundError, ConnectionRefusedError):
        return None  # ping-island absent — expected, not an error
    except (socket.timeout, OSError) as exc:
        log.debug("[ping-island] socket I/O failed: %s", exc)
        return None
    except json.JSONDecodeError as exc:
        log.warning("[ping-island] response decode failed: %s", exc)
        return None


def health_check() -> bool:
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(_CONNECT_TIMEOUT)
            sock.connect(_SOCKET_PATH)
            sock.sendall(b'{"type":"ping-island-health-check"}')
            sock.shutdown(socket.SHUT_WR)
            sock.settimeout(_READ_TIMEOUT)
            buf = sock.recv(128).strip()
        return buf == b'{"ok":true}'
    except OSError:
        return False
```

### 6.2 集成点（fire-and-forget hook）

| 位置 | 调用 |
|---|---|
| `src/mail/new_watcher.py:_sync_single_email_v3`（Notion sync 成功后） | `ping_island.send(Envelope(event_type="MailReceived", session_key=f"mailagent:email:{internal_id}", title=f"新邮件 / {sender_name}", preview=subject, status_kind="notification", metadata={"mailagent.internalId": str(internal_id), "mailagent.notionPageId": page_id or ""}))` |
| `src/llm_agent/runner.py:sync_from_email`（LLM 成功后） | 普通: `event_type="LLMReviewed"`, status_kind="notification"<br>高优先级 (Urgent/Critical): `event_type="LLMReviewedUrgent"`, status_kind="waitingForInput", intervention=question+options |
| `src/events/handlers.py:handle_completed` | `event_type="MailCompleted"`, status_kind="completed" |
| `src/mail/sync_store.mark_failed` accumulator | `event_type="SyncFailed"`, status_kind="error" |

**总开关**: `.env` 加 `PING_ISLAND_ENABLED=false`（默认关），开启后才调 `ping_island.send`。
开关不影响主流程 —— 即使 `ping_island.send` 抛任何异常也要 try-except 兜住。

### 6.3 LLMReviewedUrgent 的 intervention 设计

```python
intervention = {
    "id": str(uuid.uuid4()),
    "sessionID": f"mailagent:email:{internal_id}",
    "kind": "question",
    "title": f"邮件需要处理 / {sender_name}",
    "message": f"{action_type} · {priority}\n\n{subject}",
    "options": [
        {"id": "open_mail", "title": "在 Mail.app 打开", "detail": None},
        {"id": "open_notion", "title": "去 Notion 处理", "detail": None},
        {"id": "create_draft", "title": "创建回复草稿", "detail": "走 Mail.app draft"},
        {"id": "snooze_1h", "title": "稍后再看（1h）", "detail": None},
        {"id": "mark_done", "title": "标记完成", "detail": None},
    ],
    "rawContext": {},
}
```

`expectsResponse=true` + `BridgeResponse.decision = {"answer": {"choice": "open_mail"}}` 回灌后，
Python 这边 dispatch 对应 action（调 `osascript` 打开 Mail.app / `open notion://...` deep-link /
调 `mailagent` CLI 标完成）。

**注意**：`response` 返回是 *blocking* — `send()` 会等用户在灵动岛点了选项才返回。
所以高优先级 envelope 不能在主 sync 路径上同步发，应该 `asyncio.create_task(...)`
fire-and-forget。

### 6.4 工作量分解（Stage A）

| 子任务 | 时间 |
|---|---|
| `src/notify/ping_island.py` + unit test | 2h |
| `_sync_single_email_v3` 钩点 + `MailReceived` envelope | 1h |
| `llm_agent/runner.py` 钩点 + `LLMReviewed{,Urgent}` envelope | 2h |
| Urgent intervention 异步 dispatch（open / draft / snooze / done） | 3h |
| `handle_completed` / `mark_failed` 错误类 envelope | 1h |
| 配置开关 + CLAUDE.md 文档 + `.env.example` | 1h |
| **合计** | **~1 天** |

---

## 7. Stage B — fork 改动清单

如果 Stage A 跑一周觉得"值得 ship 给别的协作者用"，做以下改动 ship 一个 `mailagent-island` fork：

### 7.1 必改文件（Swift）

| 文件 | 改动 |
|---|---|
| `Prototype/Sources/IslandShared/Models.swift` | `AgentProvider` enum 加 `case mail = "mail"` |
| `PingIsland/Models/ClientProfile.swift` | `SessionClientBrand` 加 `case mail`；新增 `ClientProfile(id: "mailagent", title: "MailAgent", brand: .mail, mascotAssetName: "mascot-mail", ...)` |
| `PingIsland/Resources/Assets.xcassets` | 加 MailAgent mascot 资源（PNG/PDF）+ icon |
| `PingIsland/UI/Components/MascotView.swift` | mascot animation 配置加 mail 系列 |
| `PingIsland/UI/Views/IslandOpenedContentView.swift` | mail provider 时显示邮件专属 row（subject 长 + sender + AI Action chip + 附件 chip） |
| `PingIsland/Services/Window/SessionLauncher.swift` | mail provider 的"点击跳转"走 `osascript` 打开 Mail.app + Notion deep-link，而不是 terminal focus |
| `PingIsland/Core/ClientProfileRegistry`（新建或在现有 registry 注册） | 把 MailAgent profile 加进去 |
| README / AGENTS.md | 记录 mail 接入 |

### 7.2 可选改动

- mailbox 维度聚合视图（同一 mailbox 多封邮件折叠成一个 session row）
- 邮件 hover preview 加 thumbnail（附件第一页）
- 跟主 ping-island upstream 同步 — 走 `git remote add upstream` + 定期 `git rebase upstream/main`

### 7.3 distribution
- 内部用：`./scripts/build.sh` ad-hoc 签名，本人拷 .app 即可
- 给协作者：fork 仓库开 GitHub Actions release，要 Apple Developer 证书（$99/y）公证

### 7.4 工作量
- Swift 改动：3-5 个工作日（熟 SwiftUI 3 天，不熟 1 周）
- Mascot 资源：1 天（找设计 / AI 生成 / GIF 导出走 `scripts/render-mascots.sh`）
- 测试 + 文档：1 天
- **合计 ~1-2 周**

---

## 8. 限制 / push back

### 8.1 已有 4 条通知通道，第 5 条边际价值要算清

| 通道 | 即时性 | 可交互 | 跨设备 | 已 ship |
|---|---|---|---|---|
| Mail.app 旗标 | 同步 | 否（要打开 app） | 否 | ✅ |
| 飞书卡片（重要邮件） | 秒级推送 | ✅ 按钮 → Openclaw | ✅ 手机+电脑 | ✅ |
| Notion webhook（双向） | 亚秒 | ✅ Notion 改 status | ✅ | ✅ |
| V1 Electron 桌面 toast | 秒级 | ✅ 点开详情 | ❌ 仅本机 | 🚧 V1 计划 |
| **灵动岛（本文档）** | 秒级 | ✅ 5 个 action | ❌ 仅本机 | 🤔 V2 探索 |

**真问自己**：本机已经有 Electron toast + Mail.app 旗标 + 飞书卡片（手机），灵动岛能拿到的"独占用户场景"是什么？
- ✅ 不切应用就能瞄一眼"刚来的是什么邮件"
- ✅ 离岛 mode 持续看到当天高优先级 session（视觉占据感）
- ❌ 真要"看正文 / 回复 / 找上下文" — 还是回 Mail.app / Notion / Electron app
- ❌ 不在工位（已下班）时收不到 — 飞书手机 push 才是

如果 V1 Electron app 的桌面 toast + `cmd+k` 命令面板能满足 80% 场景，灵动岛是锦上添花。
**不要把它视为关键路径 feature。**

### 8.2 替代方案 — 性价比对比

| 方案 | 工作量 | 灵动岛感 | 维护负担 |
|---|---|---|---|
| `UNUserNotificationCenter`（macOS 原生 toast） | Electron app 已用 / 0 额外 | ❌ 普通通知中心 | 0 |
| 自写 SwiftUI menubar app（minimal） | 1 周 | ⭐ 基础刘海条 | 自己维护 |
| **Stage A: ping-island socket bridge** | **1 天** | ⭐⭐⭐ 完整动效 + 离岛 + mascot | 0（不 fork） |
| **Stage B: ping-island fork + mail provider** | 1-2 周 | ⭐⭐⭐⭐ 自家 brand + 邮件 UI | 跟着 upstream rebase |

**Stage A 是性价比甜点**，1 天投入拿到完整体验，决策成本最低。

### 8.3 真做之前请回答自己 3 个问题

1. 你每天会主动看灵动岛 ≥ 3 次吗？（如果不会，连 A 都别做）
2. 你愿意在灵动岛里"看到 Kimi mascot 配 MailAgent 邮件"吗？（不愿意 → 跳 B 或不做）
3. 你愿意维护一个 ping-island fork 吗？（不愿意 → 停在 A）

---

## 9. 评估指标（Stage A 跑一周后用哪些数据决定 Stage B）

PoC 期间在 `data/sync_store.db` 新加 `island_dispatch` 表（或 log 到 `logs/island.log`）：

```sql
CREATE TABLE island_dispatch (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at REAL,
    event_type TEXT,
    session_key TEXT,
    dispatched_ok INTEGER,        -- 1=连上了 ping-island, 0=ENOENT/timeout
    response_decision TEXT,       -- 用户在灵动岛点的 action（仅 expectsResponse=true）
    response_latency_ms INTEGER,  -- 发出到用户回应的耗时
    internal_id INTEGER
);
```

跑 7 天后评估：

| 指标 | "值得做 B"阈值 |
|---|---|
| 总发出 envelope 数 | > 100 / 周（说明你在用） |
| `expectsResponse` envelope 用户回应率 | > 30%（说明灵动岛真的承接了你的注意力） |
| response_latency_ms 中位数 | < 30s（说明你看到就点，不是事后处理） |
| 用户主动反馈："Kimi mascot 看着别扭" | > 1 次（说明 brand hack 已经在干扰，B 才能解决） |

任何一项不达标 → 维持 A 或退出。

---

## 10. 不在本调研范围

- ❌ ping-island 自身的 Sparkle 自动更新 / Mac App Store 发布
- ❌ 远程 SSH 邮件 session 转发（MailAgent 主服务是本机的，不存在远程 session）
- ❌ 跨平台（ping-island 是 macOS-only，邮件主服务也是 macOS-only — 完美对齐）
- ❌ 替代 V1 Electron app（灵动岛是通知层，Electron 是数据浏览 + 运维操作层，互补）
- ❌ 多用户隔离（ping-island 是单用户 menubar app）

---

## 11. 下一步

1. **用户决策**：走 Stage A？还是搁置等 V1 Electron app ship 后再说？
2. 走 A → 起 PR：`src/notify/ping_island.py` + 4 个钩点 + 配置开关 + `island_dispatch` 表
3. 跑 1 周收集 §9 指标
4. 数据说话决定是否进 Stage B

---

> 本调研与 [`frontend-design-handoff.md`](./frontend-design-handoff.md) / V1 Electron 文档独立。
> 灵动岛是 V2 探索通道，**不阻塞 V1 Electron app 设计与开发**。

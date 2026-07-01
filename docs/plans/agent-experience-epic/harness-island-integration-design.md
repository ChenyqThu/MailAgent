# Harness Agent 上岛（Ping-Island）架构设计

> **状态**：**✅ 已实现（B2 完全离岛，2026-07-02）**。flag `MAILAGENT_ISLAND_AGENT_ENABLED`（默认关）。
> 落地文件：Python `src/notify/island_agent.py` + serve-api `src/api/routers/island.py`（`/api/island/agent/announce` + `/ack` kind=agent 分支）；Node gateway `src/ai-gateway/approvalStash.ts` + `approvalResume.ts` + `server.ts`（`POST /api/ai/approval/decide`）+ `chatRun.ts`（stash/announce）+ 写工具 one-shot consume；ping-island fork `MailAgentSessionView.swift`（AgentApproval/Running/Completed/Error scenario）。测试：`tests/{api,notify}/test_island_agent.py` + `frontend/tests/ai-gateway/{approval_stash,approval_decide,tools/one_shot_write}.test.ts`。
> **前置**：Part A「解耦 ack 通道」已落地（`src/notify/island_ack.py` + serve-api `/api/island/ack` + ping-island fork 出站 POST），本设计**复用**它（ack ingress `kind=agent`）。
> **目标硬需求**：用户**完全离开 app**（chat 面板没开）也能在灵动岛点批准并**真正执行工具**（服务端 resume）—— **已达成**（`/api/ai/approval/decide` 从 `approvalStash` 重建 in-flight run 服务端 resume，实测通过）。
> **关联**：引擎架构 [`ai-sdk-gateway-architecture.md`](../../reference/llm-agent/ai-sdk-gateway-architecture.md) §13；Part A 现状与 ack 通道见 `~/Documents/ping-island/docs/mailagent/PING-ISLAND-INTERFACE.md` §6/§9。

> **实现附注（与设计的差异 / 落地决策）**：
> - **§4.1 开放项已核实**：run 在 `tool-approval-request` 结束时 **不 persist**（`makePersistOnFinish` 的 `responseMessageAwaitsApproval` 早返回）→ 按设计保守路走：`approvalStash` **stash 完整 body + 暂停 responseMessage**（不从 ai_chat.db 重建）。
> - **announce 走 Python broker**（gateway → serve-api `/api/island/agent/announce`）：一个 HTTP 调用同时登记 ack pending + 组卡 + 发岛（复用 Part A `island_ack` + `ping_island` fail-open），比让 Node 直发 island socket 再单独登记 pending 更 DRY。
> - **单一 resolver = 两道闸**：① `approvalStash.claim` 一次性（防两次岛点击）；② 写工具 `guard.consume`（`oneShotWrites`，island agent 开时）防岛 `/decide` resume 与 renderer `/api/ai/chat` resume 双执行；`isApprovalConsumed` 让 `/decide` 在 renderer 已抢先执行时短路（不重跑不重 persist）。
> - **resumeToken 能力令牌**：gateway 在 stash 时生成（`approvalStash`），随 announce 传 serve-api → 存 ack pending → `/ack` 回灌 `/decide` 时回传校验（`claim` 拒错 token 且不删，防 grief）。防同机进程伪造 `toolCallId` 越权 resume。
> - **guard TTL**：island agent 开时 ApprovalGuard TTL 5min→30min（与 stash/ack TTL 同步，给用户离岛后回来点的窗口）。
> - **鉴权**：`/agent/announce` 挂 `verify_local_token`（仅本地 token，拒 CF JWT）；`/ack` 沿用 Part A 能力令牌；`/decide` loopback-trusted + resumeToken（serve-api 上游已验 ack_token）。
> - **flag-off 字节级**：默认关 → chatRun stash/announce block inert（cfg hooks undefined）+ `/decide` 404 + 写工具无 consume + guard 5min TTL，与 Part-B 前完全一致。

---

## 1. 目标与非目标

**目标**：把 harness agent（前端 chat 多轮 agent，引擎 = AI SDK Gateway，v0.20.0 cutover 后）的 **session 状态 + 工具审批（HITL）** 搬上灵动岛，做成「类似 Claude Code」的体验：
- session 卡上岛，映射 `status.kind` 生命周期：`notification`（运行/thinking）→ `waitingForInput`（工具待审批，带 Approve/Reject 按钮）→ `completed`/`error`。
- 岛上点 **Approve → 服务端 resume → 工具真正执行**；**用户完全离开 app 也成立**。

**非目标**（守灵动岛轻量 PRD，与既有 mail 上岛一致）：
- ❌ 岛上做多轮对话 / textarea / 流式富文本编辑（V1 Electron chat 承担）。
- ❌ 岛上做 edit-tier 富文本改稿（岛空间小，Edit 引导回 app）。
- ❌ 取代前端审批卡（两者并存，任一侧先到先赢）。

---

## 2. 现状与 gap（代码核实）

### 2.1 harness HITL 是「两次调用」模型
引擎 = `frontend/src/ai-gateway/`（embedded 在 Electron main，Node，端口 8300，flag `MAILAGENT_AI_SDK_GATEWAY`）。

1. **第一次** `POST /api/ai/chat`：工具 `needsApproval` 回调（`tools/types.ts:246-250`）→ `guard.register(toolCallId, name, risk, input, editableFields)`（`security/approval.ts`）→ AI SDK 以 `tool-approval-request` part 结束 run → `pipeUIMessageStreamToResponse` SSE 推给 renderer → renderer 渲染审批卡。
2. 用户点批准/编辑/拒绝（编辑档先 `POST /api/ai/approval/resolve` 落编辑）。
3. **第二次** `POST /api/ai/chat`（消息带 `tool-approval-response`）→ 工具 `execute`（`tools/types.ts:251-279`）→ `guard.verify(toolCallId, input)`（存在/未过期/sha256 hash 匹配）→ 跑写操作 → `onFinish: persistTurn` 落 `ai_chat.db`。

**ApprovalGuard**：per-gateway-start 单例，域内唯一写闸，TTL **5min**，hash 防调包。gateway 重启 → record 丢 → fail-closed。

### 2.2 核心难点：resume 由 renderer 驱动
第二次调用带**完整 history + tool-approval-response**，由 renderer 的 assistant-ui runtime（`useMailAgentAiSdkRuntime.ts`）发起。gateway 本身不「阻塞等待」——它**结束第一次 run**，然后**等 renderer 回来发第二次**。

→ 这与 Claude Code 单进程阻塞 hook 不同。**renderer 未挂载（用户离开 app）就没人发第二次调用**，工具永远 resume 不了。这正是「完全离岛」要攻克的点。

### 2.3 现成可复用的通路
- **Part A 解耦 ack 通道**：`island_ack`（SQLite 跨进程 pending 登记）+ serve-api `POST /api/island/ack` + fork 出站 POST。ingress 已预留 `kind` 命名空间（mail 已实现，`agent` 留给本设计）。
- **Node↔Python↔renderer 事件通路**：`events_bridge.ts`（Electron main）持久连 Python mail-sync 进程内 SSE（`127.0.0.1:9200/api/events/stream`）→ IPC `events:received` broadcast renderer；Python 侧有进程内事件总线（redis 缺席兜底 `safe_publish→bus→sse_server`）。
- **Python island 基础设施**：envelope builder（`island_envelope`）+ reconnect + i18n + dedup（Part A 已加固）。

### 2.4 gap
**Node gateway ↔ island 零连接**（grep 确认）。三处要新增：审批请求上岛、岛决定回灌、session 生命周期镜像。

---

## 3. 目标架构（Python 作 island broker，Node gateway 作审批大脑）

```
┌─ Electron main ────────────────────────────────────────────────┐
│  AI SDK Gateway (Node, :8300)                                    │
│   needsApproval → guard.register                                 │
│      │  ①announce (HTTP loopback → serve-api)                    │
│      ▼                                                            │
│   pendingApprovalRuns[toolCallId] = {messages, model, sessionId} │ ← ③stash（服务端 resume 前提）
│   POST /api/ai/approval/decide  ← ④Python 调它 → 服务端 resume    │
└──────────────────────────────────────────────────────────────────┘
        │ ①                                          ▲ ④
        ▼                                            │
┌─ serve-api (Python, :8200) ─────────────────────────────────────┐
│  /api/island/agent/announce → island_ack.register(kind=agent)    │
│      + island_envelope 发 /tmp/island.sock (status=waitingForInput)│
│  /api/island/ack (Part A) → kind=agent 分支 → 调 gateway decide ──┘
└──────────────────────────────────────────────────────────────────┘
        │ ②发 envelope                               ▲ ③岛按钮 POST
        ▼                                            │
┌─ ping-island (Swift) ───────────────────────────────────────────┐
│  waitingForInput 卡 + Approve/Reject 按钮                         │
│  点击 → fire-and-forget POST /api/island/ack {ack_token, choice}  │ ← 复用 Part A fork 出站
└──────────────────────────────────────────────────────────────────┘
```

**为什么 Python broker**：复用 Python island 全套基础设施（envelope/reconnect/i18n/dedup/ack ingress）最 DRY；Node gateway 只管审批语义（register/verify/resume）。Node↔Python 走 loopback HTTP（与 `ai_gateway_proxy` 反代同款、已验证的机制）。

### 3.1 数据流（完全离岛路径，端到端）
1. **announce**：gateway `needsApproval`（`guard.register` 之后）→ `POST http://127.0.0.1:8200/api/island/agent/announce`，body `{sessionId, toolCallId, toolName, inputPreview, risk, expiresAt}`。
2. **上岛**：serve-api 端 `island_ack.register(kind="agent", session_key=f"mailagent:agent:{sessionId}", event_type=toolName, metadata={...}, choices={"approve","reject"})` 拿 `ack_token` → 组 `waitingForInput` + intervention envelope（注入 `ack_token`/`ack_url`）发 `/tmp/island.sock`。
3. **点击**：用户在岛上点 Approve → fork **复用 Part A 出站** `POST /api/island/ack {ack_token, choice="approve"}`。
4. **回灌**：serve-api `/api/island/ack` 的 `kind=="agent"` 分支 → `POST http://127.0.0.1:8300/api/ai/approval/decide {toolCallId, decision:"approve"}`。
5. **服务端 resume**（§4）：gateway 用 stash 的 in-flight run 重建 messages + append `tool-approval-response` → `streamText` 跑到完成 → `persistTurn` 落库 → 发进程内事件（SSE 9200 → events_bridge → 若 renderer 在则实时更新岛/前端）。

---

## 4. 完全离岛的关键：gateway 服务端 resume（B2 核心）

现状 resume 由 renderer 驱动 → 离岛必须让 gateway **自持** resume。

### 4.1 stash in-flight run
`needsApproval` 发 `tool-approval-request` 时，gateway 把当前 run 上下文存进服务端 `pendingApprovalRuns` map：
```ts
pendingApprovalRuns[toolCallId] = { messages, model, sessionId, systemPrompt, createdAt, expiresAt }
```
键 `toolCallId`，与 ApprovalGuard record 同 TTL（当前 5min → 见 §6 需评估延长）。

> 🔴 **待核实的开放项**：run 在 `tool-approval-request` 结束时 `onFinish: persistTurn` 是否落库？
> - **若落**：可从 `ai_chat.db` 的 `ui_message_json` 重建 history，`pendingApprovalRuns` 只需存 `{sessionId, toolCallId, model}`（轻）。
> - **若不落**（run「中断」而非「完成」）：**必须** stash 完整 `messages`（in-flight，尚未 persist）。
> 实现前先在 `frontend/src/ai-gateway/server.ts` 的 `makePersistOnFinish` + `chatRun.ts:responseMessageAwaitsApproval` 处打点确认。本设计按「必须 stash」保守设计（两种情况都安全）。

### 4.2 新端点 `POST /api/ai/approval/decide`
```
body: { toolCallId, decision: "approve"|"reject", editedInput? }
```
1. **单一 resolver 守卫**（防 renderer + 岛双重执行）：标记该 approval 已决（推广现有 blocking-send `guard.consume` 一次性闸到**所有**岛驱动 resume）。先到先赢，另一方拿 `E_APPROVAL_USED` / no-op。
2. **approve**：取 `pendingApprovalRuns[toolCallId]` → 重建 messages + append `tool-approval-response{toolCallId, approved:true}` → `streamText`（复用 `prepareChatRun`）跑到完成 → `onFinish: persistTurn` 落库。
3. **reject**：记录拒绝（append `tool-approval-response{approved:false}` 走同样 resume，让模型自然响应「已拒绝」）。
4. **事件**：resume 完成后发 `agent:turn_updated{sessionId}` 事件 → SSE 9200 → events_bridge → renderer（若挂载）实时刷新；岛上发 `MailCompleted`（同 `sessionKey`）清卡。

### 4.3 renderer 路径共存
用户在 app 内点审批卡仍走**现有**第二次 `/api/ai/chat`（不改）。单一 resolver 守卫保证与岛决定不双跑。两条路由 → 同一个 `guard.verify` + 同一个 `pendingApprovalRuns` 消费点。

---

## 5. session 生命周期镜像

gateway 流式过程 → 相应 envelope（`sessionKey=mailagent:agent:{sessionId}`，`metadata.client_kind=mailagent` 走 mail brand UI）：

| gateway 事件 | envelope | 岛表现 |
|---|---|---|
| run 开始（首个 text-delta / tool-call） | `status=notification`，`mailagent.eventType=AgentRunning` | session 卡出现（thinking） |
| `needsApproval` | `status=waitingForInput` + intervention（Approve/Reject） | 卡转待审批 + 按钮（弹一次） |
| resume 完成 / run finish | `status=completed`，同 sessionKey 的 `MailCompleted` | 清卡 |
| run error | `status=error` | 错误态 |

镜像的 envelope 走 Part A 已加固的确定性 id + dedup + reconnect（`sessionKey`/`event_type` 唯一 → 幂等，不重弹）。announce 由 gateway 主动发；生命周期镜像可由 gateway 在关键节点各发一条 announce-lite（无 intervention 的 notification/completed）。

---

## 6. 约束 / 风险（实现前必读）

- **ApprovalGuard TTL 仅 5min**：离岛场景用户可能超 5min 才点 → `E_APPROVAL_EXPIRED`。需评估：① 为 agent 审批延长 TTL（如 30min，与 `pendingApprovalRuns` 同步）；② 岛卡显式显示过期倒计时；③ 过期后岛点击回 ack 明确告知「已失效，请回 app 重发」。
- **gateway 重启 → record + pendingRun 全丢 → fail-closed**：岛点击 `/decide` 找不到 pending → 返回明确错误 → serve-api ack 回执告知岛「已失效」。（可选增强：`pendingApprovalRuns` 落 SQLite 跨重启，但审批语义上 fail-closed 更安全，倾向不持久化。）
- **编辑档（edit-tier）**：岛空间小，v1 岛上**只给 Approve/Reject**，不做富文本编辑；需要改稿 → 岛卡提供「回 app 编辑」引导（deeplink `mailagent://` 聚焦该 chat session）。
- **安全**：`/api/island/agent/announce` + `/api/ai/approval/decide` 均 loopback；ack 沿用 Part A 的 `ack_token` 能力令牌（不可猜、只经本地 socket 发出、单次消费）；`decide` 端点靠 `toolCallId` + 单一 resolver + hash 校验，防同机进程伪造审批越权执行**写/发**工具。send 类工具（`email_prepare_send`）保留现有 blocking 一次性 `consume`，岛路径也必须过它。
- **双写竞态**：announce/decide 与 renderer 路径都可能并发 → 单一 resolver 是唯一真源，务必让**两条路都过同一个消费点**（`guard` + `pendingApprovalRuns` 原子取）。
- **flag 门控**：全程 flag-off 字节级可回退（镜像 `MAILAGENT_AI_SDK_GATEWAY` 纪律）。新增建议 `MAILAGENT_ISLAND_AGENT_ENABLED`（Node gateway env 读，off 时 gateway 不 announce、serve-api `kind=agent` 分支返 not-implemented，与今日一致）。

---

## 7. 分期路线（B1 → B2）

架构以 B2（完全离岛）为最终目标**一次设计到位**，但落地分两步降风险：

### B1（stepping stone）— renderer 驱动 resume，面板开着即可
- announce 上岛 + 岛按钮 → ack ingress（`kind=agent`）→ **Python 发进程内事件** → SSE 9200 → events_bridge → IPC → renderer；若该 session 的 chat runtime **已挂载**，runtime 提交 `tool-approval-response` → 走**现有**第二次 `/api/ai/chat`。
- **复用现有全部通路，零 gateway 服务端 resume 改动**，改动最小。
- 约束：chat 面板需开着（用户「扫一眼岛 → 点批准」不切窗口，仍有价值）。
- 价值：验证 announce/ack/生命周期镜像/单一 resolver 全链路，为 B2 铺路。

### B2（硬需求）— gateway 服务端 resume，完全离岛
- 落地 §4：`pendingApprovalRuns` stash + `POST /api/ai/approval/decide` + 单一 resolver 推广 + 服务端 stream-to-persist。
- ack ingress `kind=agent` 分支从「转发 renderer」切到「调 gateway `/decide`」。
- 完成「用户完全离开 app 也能岛上审批执行」。

> 注：用户硬需求是 B2。B1 作为**中间验证里程碑**（可选，若想快速 dogfood 全链路）；若要求一步到位，可直接实现 B2（工作量更大，但架构已 ready）。

---

## 8. 关键文件锚点（实现时）

**Node gateway**（`frontend/src/ai-gateway/`）：
- `tools/types.ts:246-250`（`needsApproval`）→ announce 上岛的注入点。
- `tools/types.ts:251-279`（`execute`）+ `security/approval.ts`（`register`/`verify`/`consume`）→ 单一 resolver 守卫。
- `server.ts`（端点表）→ 新增 `POST /api/ai/approval/decide`；`chatRun.ts:prepareChatRun`/`responseMessageAwaitsApproval` → stash + 服务端 resume。
- `frontend/src/electron/main/ai_gateway_lifecycle.ts`（config 注入 / persistTurn）→ `pendingApprovalRuns` 生命周期 + 事件发射接线。
- `frontend/src/electron/main/events_bridge.ts`（Main→renderer IPC）→ B1 回灌 renderer。

**Python serve-api**（`src/api/`, `src/notify/`）：
- `src/api/routers/island.py`（Part A）→ 扩 `kind=="agent"` 分支 + 新增 `/api/island/agent/announce`。
- `src/notify/island_ack.py`（Part A）→ 直接复用（`kind="agent"`）。
- `src/notify/island_envelope.py` / `island_dispatch.py`（Part A）→ agent 版 envelope builder（`sessionKey=mailagent:agent:{id}`）。

---

## 9. 验证（实现后）
- flag-on 启一个 harness chat → 触发需审批写工具（如 `email_draft_reply`）→ 岛出审批卡。
- **完全离岛**：关闭/隐藏 chat 面板 → 岛上点 Approve → 确认 `guard.verify` 通过、写操作**真执行**、岛卡转 completed、`ai_chat.db` 落库。
- **双写不双跑**：岛点 Approve 同时 app 内点卡 → 只执行一次（另一方 `E_APPROVAL_USED`）。
- **过期/重启**：>TTL 后岛点击 → 明确失效回执，不误执行；gateway 重启后岛点击 → fail-closed。
- 回归网 `venv/bin/python -m pytest tests/agent_eval -q` 不得低于 baseline（改 agent 引擎/prompt/工具后必跑）。
- flag-off 字节级回退验证。

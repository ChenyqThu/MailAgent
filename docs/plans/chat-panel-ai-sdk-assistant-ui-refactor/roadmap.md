# Roadmap — Chat Panel AI SDK / assistant-ui 重构专项路线图

> status: planning
> last-verified: 2026-06-23
> scope: phase breakdown, feature flags, rollout, rollback, PR sequencing
> **Phase 00 spike：✅ 完成（2026-06-23），裁决 = GO。结论见 [§10](#10-phase-00-spike-结论--go2026-06-23) + [architecture.md §13](./architecture.md#13-phase-00-spike-实测结论2026-06-23go)。**

## 1. 总体路线

本专项分 7 个 phase：

```txt
Phase 00  Research & Spike
Phase 01  assistant-ui Shell
Phase 02  AI SDK Gateway
Phase 03  Tool Registry Migration
Phase 04  Generative UI & HITL
Phase 05  AG-UI Interop
Phase 06  Cutover & Cleanup
```

关键原则：

1. 先替换视图层，再切编排层。
2. 先新会话走 AI SDK，旧会话兼容读取。
3. 先 read tools，再 write tools，再 high-risk approval。
4. 每个 phase 都有 feature flag 和 rollback path。
5. Python domain services 保持业务权威，不被 AI SDK Gateway 绕过。
6. **每个 phase 验收叠加 eval 闸**：read/write tools 迁移后跑通 [`tests/agent_eval`](../../../tests/agent_eval/) 27-task baseline 不回退（golden fixtures 防 parity 漂移）。本专项 = [agent-experience-epic](../agent-experience-epic/README.md) 的 P4。

## 2. Feature Flags

| Flag | 默认 | 用途 |
|---|---:|---|
| `MAILAGENT_ASSISTANT_UI_PANEL` | `false` | 启用 assistant-ui 面板 shell |
| `MAILAGENT_CHAT_RUNTIME` | `legacy` | `legacy` / `external-store` / `ai-sdk` / `ag-ui` |
| `MAILAGENT_AI_SDK_GATEWAY` | `false` | 启动 Node AI SDK Gateway |
| `MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT` | `false` | 新会话默认走 AI SDK Gateway |
| `MAILAGENT_A2UI_TOOL_CARDS` | `false` | 启用 A2UI ComponentRegistry |
| `MAILAGENT_AI_SDK_WRITE_TOOLS` | `false` | AI SDK Gateway 暴露 write tools |
| `MAILAGENT_AI_SDK_HIGH_RISK_APPROVAL` | `false` | 启用 needsApproval + domain approval guard |
| `MAILAGENT_AG_UI_MIRROR` | `false` | 输出 AG-UI mirror endpoint |

## 3. Phase 依赖图

```txt
00 Research & Spike
  ├─ 01 assistant-ui Shell
  │    └─ 04 A2UI Cards can start with legacy events
  └─ 02 AI SDK Gateway
       ├─ 03 Tool Registry Migration
       │    └─ 04 HITL Approval
       └─ 05 AG-UI Interop
            └─ 06 Cutover & Cleanup
```

## 4. PR 拆分建议

### PR-00a 文档和调研落档

- 新增本目录文档。
- 记录 AI SDK / assistant-ui / AG-UI 决策。
- 不改代码。

### PR-00b 依赖与 spike scaffold

- 加 `@assistant-ui/react`。
- 加 AI SDK Gateway package scaffold，但不启动。
- 增加 feature flags。

### PR-01a assistant-ui provider + theme shell

- 新建 `frontend/src/shared/assistant/components`。
- assistant-ui Thread / Composer 在 flag 下渲染。
- 仍走 legacy `useEmailChat` ExternalStore adapter。

### PR-01b message mapper / legacy compatibility

- `ChatMessage` / `ChatStreamEvent` → UIMessage adapter。
- 旧 session 可在新 shell 中展示。

### PR-02a AI SDK Gateway HTTP server

- 新增本地 Node Gateway。
- Electron lifecycle 启停。
- `/health` / `/api/ai/config`。

### PR-02b AI SDK basic chat

- `/api/ai/chat` 支持纯文本 streaming。
- 前端新会话可选择 AI SDK runtime。
- UIMessage 持久化双写。

### PR-03a read tools

- email_search / email_get / email_body / attachment_list / kos_query。
- 只读工具经 Python domain client 执行。

### PR-03b write tools preview

- email_flag / email_archive / email_draft_reply / sync_to_notion preview。
- 默认仍需要 approval，不允许 silent write。

### PR-04a A2UI ComponentRegistry

- Tool UI cards：generic trace、NotionSyncCard、DraftReplyCard。
- 未注册工具 fallback。

### PR-04b high-risk approval

- SendApprovalCard。
- approval id / hash / expiry。
- Python domain guard。

### PR-05a AG-UI mirror

- UIMessage → AG-UI event adapter。
- `/api/ai/agui/chat`。
- interrupt / state snapshot smoke test。

### PR-06a default cutover

- 新会话默认 `ai-sdk`。
- legacy 只读 / fallback。

### PR-06b cleanup

- 删除旧 `MessageList` / `Composer` 主路径。
- 保留最小 legacy adapter。

## 5. Rollout 策略

### Stage 1: developer-only

```txt
MAILAGENT_ASSISTANT_UI_PANEL=1
MAILAGENT_CHAT_RUNTIME=external-store
```

目的：验证 assistant-ui 视图层，不碰 AI SDK Gateway。

### Stage 2: local dogfood AI SDK read-only

```txt
MAILAGENT_AI_SDK_GATEWAY=1
MAILAGENT_CHAT_RUNTIME=ai-sdk
MAILAGENT_AI_SDK_WRITE_TOOLS=0
```

目的：验证纯文本、多轮、read tools、UIMessage persistence。

### Stage 3: write tools with approval

```txt
MAILAGENT_AI_SDK_WRITE_TOOLS=1
MAILAGENT_AI_SDK_HIGH_RISK_APPROVAL=1
MAILAGENT_A2UI_TOOL_CARDS=1
```

目的：验证 Notion / draft / outbound approval。

### Stage 4: new session default

```txt
MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT=1
```

旧会话仍按 `backend_kind` 路由到 legacy。

### Stage 5: cleanup

删除旧 UI 主路径，保留 legacy session reader。

## 6. 回滚策略

### UI 回滚

```txt
MAILAGENT_ASSISTANT_UI_PANEL=0
MAILAGENT_CHAT_RUNTIME=legacy
```

影响：回到旧 `AIChatPanel` / `MessageList` / `Composer`。

### Gateway 回滚

```txt
MAILAGENT_AI_SDK_GATEWAY=0
MAILAGENT_AI_SDK_NEW_SESSION_DEFAULT=0
```

影响：新会话回到 legacy `custom-api` runtime。

### Tool 回滚

```txt
MAILAGENT_AI_SDK_WRITE_TOOLS=0
MAILAGENT_A2UI_TOOL_CARDS=0
```

影响：只保留 read tools / generic trace，不执行写操作。

### Approval 回滚

高风险审批不可简单关闭；如果 approval 出问题，应禁用相关高风险工具，而不是允许静默执行：

```txt
MAILAGENT_AI_SDK_HIGH_RISK_APPROVAL=0
MAILAGENT_AI_SDK_WRITE_TOOLS=0
```

## 7. 验收门槛

| Phase | 验收门槛 |
|---|---|
| 00 | 文档、PoC、技术 spike 完成；无代码默认行为变化 |
| 01 | assistant-ui shell 与 legacy parity；视觉一致；streaming 正常 |
| 02 | AI SDK Gateway 纯文本 streaming；UIMessage persistence；Electron/Web 均可用 |
| 03 | read tools parity；write tools preview；审计表写入 |
| 04 | A2UI cards；外发 approval hash guard；无 silent high-risk action |
| 05 | AG-UI mirror sequence test；不影响主 runtime |
| 06 | 默认切流；legacy fallback；旧 UI 主路径删除 |

## 8. 推荐执行顺序

最小可用路径：

```txt
00 → 01 → 02 → 03a → 04a → 04b → 03b → 06
```

AG-UI 可并行但不阻塞主线：

```txt
05 after 02b, before or after 04
```

## 9. 每周里程碑建议

| 周期 | 目标 |
|---|---|
| Week 1 | Phase 00 + Phase 01a/b |
| Week 2 | Phase 02a/b，AI SDK 纯文本端到端 |
| Week 3 | Phase 03a read tools + UIMessage persistence 稳定 |
| Week 4 | Phase 04a A2UI cards + Phase 03b write preview |
| Week 5 | Phase 04b outbound approval + dogfood |
| Week 6 | Phase 05 AG-UI mirror + Phase 06 cutover prep |

实际进度以 dogfood 和安全验收为准，高风险工具不赶进度。

---

## 10. Phase 00 Spike 结论 + GO（2026-06-23）

详细实测结论与证据见 [architecture.md §13](./architecture.md#13-phase-00-spike-实测结论2026-06-23go)。摘要：

- **裁决 = GO**。三项核心技术风险全部以 flag-off PoC 打通：
  - assistant-ui Thread/Composer 在 MailAgent token + 主题三态 + 6 accent 下渲染 parity（4 组截图）；
  - Node AI SDK Gateway 嵌入 Electron main，`/health` + echo-stream + 真实 `streamText`（经 CRS）+ abort，harness **4/4 PASS**；
  - approval 两次调用语义差异写清，eval R5 重对齐落点 = recorder 适配层（规则逻辑零改）。
- **第三进程成本**：PoC 采**嵌入 main**形态（不新增 OS 进程，≈几 MB 堆 + 1 loopback 端口），把「第三常驻进程」成本降到近零；独立 Node 进程留作 Phase 06+ 后置选项。
- **本专项 = [agent-experience-epic](../agent-experience-epic/README.md) 的 P4**；门控 P1（`tests/agent_eval` 85 passed）/ P2 / P3（commit `13bab74b`）已绿。

### 10.1 Phase 00 产出状态（对照 §4 PR 拆分）

| §4 PR | 状态 | 说明 |
|---|---|---|
| PR-00a 文档与调研落档 | ✅ 本 spike 完成 | architecture.md §13 + roadmap §10 + 本目录文档；research-sources / protocol-contracts 已对齐 ai-sdk-v6 |
| PR-00b 依赖与 spike scaffold | ◐ 部分预置 | 已装 5 个 devDeps（ai@6 / @ai-sdk/anthropic / @assistant-ui/react(+ai-sdk) / zod）+ flag-gated gateway（`ai_gateway_poc.ts`）/ assistant-ui（`renderer/poc/`）scaffold + 8 个 feature flag（phase-00 §3）**全 flag-off**。正式 PR-00b 把 scaffold 收编进 `frontend/src/shared/assistant/` + `frontend/src/ai-gateway/` 规范目录 |

### 10.2 进度

- **Phase 00 spike ✅ GO**（`bc5c1e80`）。
- **Phase 01 assistant-ui Shell ✅**（2026-06-23，commit `b82ee24e`，全程 flag-off）：`frontend/src/shared/assistant/` headless primitives + MailAgent token；legacy ExternalStore adapter（`useExternalStoreRuntime`，**非** AI SDK）喂 `useEmailChat`；`legacyMessageMapper` ChatMessage→ThreadMessageLike；AIChatPanel `lazy()` flag 分流（flag-off 字节级一致）；删 Phase 00 PoC。验收 typecheck 0 / vitest 1700·0fail（+22）/ agent_eval 85（≥baseline）/ 4 组 parity 截图 / 不新增 provider 路径；reviewer(opus) APPROVE。落地结论 [phase-01 §9](./phase-01-assistant-ui-shell.md)。
- **Phase 02 AI SDK Gateway ✅**（2026-06-24，全程 flag-off）：嵌入式 Gateway（`frontend/src/ai-gateway/` 纯 Node 核 + `electron/main/ai_gateway_lifecycle.ts` wrapper）`/health`+`/api/ai/config`+`/api/ai/chat`（streamText→`pipeUIMessageStreamToResponse` UIMessage 流 + abort）；provider key 路径 **(A) Gateway 直连**（key 仅 main，renderer 经 `?aiGatewayPort=` 只拿端口）；前端 `getChatRuntimeMode→'ai-sdk'` + `AiSdkRuntimeProvider`(useChatRuntime)；持久化 v1 chat_db **v9** 加 `ui_message_json` 双写 + 重载转换。验收：harness 4/4（含真实 streamText 端到端）· ai-gateway 测试 24 · typecheck 0 · vitest 1725 · agent_eval 85（≥baseline）。落地见 [phase-02 §13](./phase-02-ai-sdk-gateway.md#13-实现落地2026-06-24) + [architecture §13.8](./architecture.md#138-phase-02-落地2026-06-24embedded-ai-sdk-gateway)。
- **Phase 03a read tools ✅**（2026-06-24，全程 flag-off）：9 read 工具（email_search/_fulltext/get/body/list_thread/search_attachments + kos_query + report_list/get）迁 AI SDK Gateway `tool({inputSchema:zod, execute})`，经 `MailAgentDomainClient`（typed HTTP + `X-MailAgent-Local-Token`）→ serve-api read 端点；`cfg.buildTools(collector)`（闭包绑 audit collector）+ `streamText({tools, stopWhen})` 多步循环 → chat_tool_call（字段 ≥ legacy）；schema/massage 镜像 legacy（parity 测试钉死）。read 绝不 needsApproval；write 留 03b。验收：typecheck 0 · vitest 1756（+32，含 parity）· agent_eval 85（≥baseline）。落地见 [phase-03 §12](./phase-03-tool-registry.md#12-实现落地03a2026-06-24) + [architecture §13.9](./architecture.md#139-phase-03a-落地2026-06-24read-tools-migration)。
- **Phase 03b write tools + HITL approval ✅**（2026-06-24，commit `ae268c67`，全程 flag-off）：5 写工具（email_flag/archive/pin preview + email_draft_reply edit + **email_resync** preview = `sync_to_notion` 的「重推 Notion」语义；dry-run-diff 富卡片留 04a）迁 AI SDK Gateway，gated `MAILAGENT_AI_SDK_WRITE_TOOLS`（默认 off → `buildGatewayTools` 仅 writeToolsEnabled+guard 加，等同 03a）。**HITL 两次调用**：`auditedWriteTool` needsApproval 恒 true + 注册 `ApprovalGuard`（keyed toolCallId，keep-first），execute 仅二调（已批准 + 验签）verify→domain 写→审计。**两层 guard**：(a) ai@6 `experimental_toolApprovalSecret` HMAC **绑 input**（换料即 InvalidToolApprovalSignatureError）+ (b) domain `ApprovalGuard`（id/hash/expiry，独有 = expiry + 审计 id）。🔴 契约差：ai@6 `ToolApprovalResponse` 无 `editedInput`（signed = 严格 approve/reject，edit 改料 → 04a 重签）；`sync_to_notion`→`email_resync`（catalog/parity 一致）。chat_tool_call 加 approval_status/approval_hash → `CHAT_DB_VERSION 9→10`。**eval R5 重对齐**（rules.py 零改）：recorder 适配层 `tests/agent_eval/recorder/ai_sdk_adapter.ts` 把 ai@6 tool parts → trace events（write→pending_confirmation、首调未决→needs_confirmation），fixture `runs/ai-sdk-approval.jsonl` hard_pass。验收：typecheck 0 · vitest **1786**（+30）· agent_eval **87**（+2，≥baseline）· `run_baseline --compare` 29==29 rc=0 · reviewer(opus) APPROVE（7 不变式全 PASS，0 BLOCKER/HIGH）。落地见 [phase-03 §13](./phase-03-tool-registry.md#13-实现落地03b2026-06-24) + [architecture §13.10](./architecture.md#1310-phase-03b-落地2026-06-24write-tools-preview--hitl-approval)。
- **下一步 = Phase 04a（A2UI ComponentRegistry + 富工具卡片）**：DraftReplyCard/NotionSyncCard + generic fallback 接 03b 写工具的 approval-request/tool-result part，gated `MAILAGENT_A2UI_TOOL_CARDS`；**核心 = 03b 留的 edit→re-sign approval gap**（architecture §13.10.2(1)：ai@6 signed approval 绑 input → DraftReplyCard 编辑正文须重签）。view-layer 为主，goal-prompts P4-Phase04a。

执行顺序复用 §8：`00 → 01 → 02 → 03a → 04a → 04b → 03b → 06`；每个 phase 验收叠加 `tests/agent_eval` baseline 不回退闸（§2 原则 6）。
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

### 10.2 下一步

GO → 按 §4 + §8 最小路径开 **Phase 01（assistant-ui Shell + ExternalStore adapter）** 实现 task：

```
task.py create "chat-panel Phase 01 assistant-ui shell" --parent 06-23-agent-eval-memory-skill-assistant-ui-ai-sdk
```

执行顺序复用 §8：`00 → 01 → 02 → 03a → 04a → 04b → 03b → 06`；每个 phase 验收叠加 `tests/agent_eval` baseline 不回退闸（§2 原则 6）。
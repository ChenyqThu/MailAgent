# E2 — 减法 Sprint（删 legacy harness / outbox 收口 / fork CLI 退役 / 写路径归一）

> 所属：[架构 Review 2026-07](./README.md) 路线图 Next 阶段。
> 性质：纯减法——四场「做了一半的迁移」收口。预期净删 ~12-15k LOC，不新增功能。

## 1. 背景

四个子系统都处于「新路径已是生产事实，旧路径仍完整在线」的半程状态：

| # | 半程迁移 | 新（生产实际） | 旧（仍在线） |
|---|---|---|---|
| A | chat 引擎 | embedded AI SDK Gateway（v0.20.0 cutover，默认 on） | `frontend/src/shared/chat/` legacy harness ~9.4k LOC |
| B | 反向写 | outbox + FanoutWorker（生产 `MAILAGENT_OUTBOX_ENABLED=on`） | handlers/reverse_sync 里的 AppleScript 直调分支（代码默认 off 才走） |
| C | 前端写通道 | in-process 服务层（`MailWriteService`） | 4 处 fork CLI subprocess 残留 |
| D | 写路径 | 正向用户写收敛 `MailWriteService` | Notion 反向写在 `events/handlers.py` 另有一份 flag→outbox 实现 |

## 2. 子包 A — 删 legacy chat harness（原「任务B」，含前置）

> **⚠️ 归属移交（2026-07-03）**：本子包与 **Agent 开放性 epic 的 S3**（trellis `07-02-agent-openness-epic-review-and-plan`，worktree `harness-epic-plan`）是**同一件工作**（S3 = 删 legacy harness = 既定任务B）。归 S3 执行，**主线不做**，理由：① S3 排在 S2（执行工具 + skill 自装）之后有真依赖——S2 的 recon 已发现 `prompt_fragment` 在 post-cutover gateway 不达模型（`systemPrompt.ts:61` skillFragments=null 有意），删 legacy 前的「legacy-only 能力清单」（含 document-only skill 引导处置）在那边持续积累；② 两边同时动 `shared/chat`/gateway 必撞。本节的 A1→A2→A3 步骤与回滚决策点**作为 S3 开工时的实施输入**合流使用。子包 B/C/D（纯 Python 同步域）不受影响，仍归主线。

- **新引擎反向依赖旧引擎**：`frontend/src/ai-gateway/systemPrompt.ts:19` `import { buildStableSystemPrompt } from '@shared/chat/backends/custom_api'`（:20 还有 `ChatModelConfig` 类型）。**直接删 `shared/chat` 会炸掉活引擎——任务B 不是 rm -rf**。
- 新 UI 层仍寄生旧传输：`shared/assistant/AssistantUIChatPanel.tsx:214` 以 `useEmailChat` 为传输 SSoT，经 `runtime/useLegacyExternalStoreRuntime.ts` 桥接。
- 工具双源：gateway `frontend/src/ai-gateway/tools/`（~1.7k）与 legacy `shared/chat/tools/builtin/`（~2.7k）各一套 zod schema，靠人肉镜像 + 冻结 fixture 保 parity。
- legacy 注入防线弱于新引擎：`shared/chat/backends/custom_api.ts:355` 邮件正文明文拼接（无 `UNTRUSTED_EMAIL_BODY` 围栏）——`MAILAGENT_CHAT_RUNTIME=legacy` 回退即退回弱防线，**删除本身就是安全修复**。
- 一批 gateway 子 flag 已 derive-on 恒真（`shared/assistant/runtime/flags.ts:184/195/207` `return getChatRuntimeMode()==='ai-sdk'`），可随删除塌缩。

### 2.2 实施步骤

**Step A1 — prompt 装配抽中立层（前置，1-2 天）**
- 新建 `frontend/src/shared/prompt/`（或 `shared/assistant/prompt/`），迁入 `buildStableSystemPrompt` 及其依赖（safety floor / soul / standing-context 组装、`ChatModelConfig` 等共享类型）。
- gateway 与 legacy 双方改 import 新位置（此时 legacy 还在，两边行为不变）。
- 验收：`pnpm typecheck` 双 target 过；gateway↔legacy prompt parity 测试保持绿；`venv/bin/python -m pytest tests/agent_eval -q` 不回退。

**Step A2 — 传输 SSoT 迁移（2-4 天，技术核心）**
- `AssistantUIChatPanel` 从 `useEmailChat`（legacy 状态桥）切到 ai-sdk 原生传输（gateway 已是实际执行引擎，本步是把「会话状态/流式/审批恢复」的前端 SSoT 从 legacy hook 迁出）。
- 迁移面盘点先行：grep `useEmailChat` / `useLegacyExternalStoreRuntime` 全部消费点，逐个列表。
- 验收：chat 全功能 dogfood 清单（多轮、工具流、HITL 审批暂停/恢复、A2UI 卡片、历史会话加载、island resume 回推）+ `tests/agent_eval` 全绿 + baseline compare 不回退。

**Step A3 — 删除（1-2 天）**
- 删 `frontend/src/shared/chat/`（保留 A1 已迁出的中立层）；删 legacy 工具注册面（gateway tools 成唯一注册源）；删 `useLegacyExternalStoreRuntime` 桥。
- Python 侧：盘点 `src/chat/`（~1.7k LOC）哪些端点仅服务 legacy 传输，随删（serve-api `/chat/config` 等配置面是新引擎依赖，**保留**）。
- 塌缩 derive-on flags（GATEWAY / A2UI / CONTEXT_INJECTION / WRITE_TOOLS 等 `flags.ts` 中恒真项）与 `MAILAGENT_CHAT_RUNTIME` 开关本身。
- 验收：`pnpm test`（vitest electron-as-node）+ typecheck 双 target + agent_eval + 打包 dogfood 一轮。

### 2.3 回滚决策点（需用户拍板）

删除后 `CHAT_RUNTIME=legacy` 回退通道不复存在，回滚 = 回退 app 版本。两个选项：
- **直接删**（推荐，符合项目一贯节奏）：cutover 已稳跑多版本 + agent_eval 网在，legacy 本身反而是弱防线；
- **观察一版**：先出一版只删入口保代码（`CHAT_RUNTIME=legacy` 拒绝启动），下一版再物理删除。

## 3. 子包 B — outbox 灰度收口 + B1 退役

- 现状：`src/config.py:530` `mailagent_outbox_enabled` 默认 False，而 `src/mail/reverse_sync.py:22` 明注「生产 outbox=on 不可达, 仅代码默认 outbox=off 时才走」——每个 mutating handler（`src/events/handlers.py` handle_flag_changed / ai_reviewed / completed）+ reverse_sync 都背着生产不可达的老 AppleScript 直调分支。
- 步骤：① 默认翻 True（`.env.example` + CLAUDE.md 开关表同步）；② 发一版观察；③ 删 handlers/reverse_sync 老分支 + `outbox_repo=None` 兼容路径；④ 按 `docs/reference/architecture/davmail-write-path-trace.md` 执行 B1（Notion 反向链路）退役与 outbox 灰度死分支清理（该文档已备好决策依据）。
- 验收：`grep -n "outbox_repo=None\|outbox=off" src/mail/reverse_sync.py src/events/handlers.py` 死分支清零；反向 flag 同步 dogfood（Notion 改 flag → Outlook 生效 ≤30s）。

## 4. 子包 C — fork CLI 残留退役

- 现状（`src/api/cli_runner.py:4` 自注「The FastAPI write endpoints do NOT …」的例外清单）：
  - `src/api/routers/admin.py`（文件头注释）：dead-letter retry / cleanup 写端点经 `cli_runner.run_cli`；
  - `src/api/routers/email.py:35`：legacy notion update-flag 仍经 run_cli；
  - `src/api/routers/llm.py:9`：selftest 经 run_cli。
- **latent 缺陷（2026-07-03 E0 CI 首跑发现，强化退役必要性）**：`cli_runner.py:62` 默认 project root 是硬编码开发机绝对路径、发现链有意不查 PATH（:58-60）；打包态 `backend_lifecycle.ts:489` 只注入 `MAILAGENT_PROJECT_ROOT=dataRoot`（其下无 `venv/bin`）且全 repo 无 `MAILAGENT_BIN` 注入 → **打包 app 里这 4 个 run_cli 路由现状就是 E_NO_BIN 必挂**——退役它们不只是清理，是修复。
- 步骤：dead-letter retry/cleanup 迁 `src/services/`（或挂 async_jobs，批量语义天然匹配）；legacy update-flag 端点直接评估删除（前端已走 in-process 写路径）；selftest 迁服务层直调。全部迁完后收缩 `cli_runner.py` 的存在理由（若归零则删）。
- 验收：`grep -rn "cli_runner" src/api/routers/` 零命中；fork 路径专用的 CLI token 鉴权面同步收缩。

## 5. 子包 D — 反向写收编 MailWriteService

- 现状：`src/services/mail_write.py:544` 与 `src/events/handlers.py:216` 各有一份 flag→outbox 入队逻辑（语义应当一致，靠人肉保持）。
- 步骤：抽共享 intent 函数（或 handlers 直接调 MailWriteService 的对应方法），handler 退化为「Notion 意图通知 → 调服务层」。与子包 B 的死分支删除同批做，避免两次触碰 handlers。
- 验收：flag 双向同步回归（Mail.app→Notion、Notion→Mail.app、前端→双端）+ 单测断言两路径共用同一入队函数。

## 6. 顺序与量级

```
E0 CI 闸就位（前置，见 e0）
   └→ A1 prompt 抽层 → A2 传输迁移 → A3 删除     （5-8 天）
   └→ B 翻默认 →(隔一版)→ B 删分支 + D 收编 handlers（2-3 天，同批）
   └→ C fork CLI 退役                              （1-2 天）
```
子包间无互相依赖，B/C 可与 A 并行（不同 worktree）。总量级 ~2 周。

## 7. 风险

| 风险 | 缓解 |
|---|---|
| A2 传输迁移破坏审批恢复/island resume 等细语义 | dogfood 清单显式覆盖（含 #36 面板 live-refresh 场景）；agent_eval baseline compare 做闸 |
| B 翻默认影响 applescript fallback 用户 | outbox 与 backend 正交（outbox→FanoutWorker→arm），applescript 模式同样走 outbox；翻默认前在 applescript 模式跑一轮回归 |
| 删代码误伤共享 util | A1/A3 分 commit；每步 `pnpm typecheck` 双 target + pytest 全量 |

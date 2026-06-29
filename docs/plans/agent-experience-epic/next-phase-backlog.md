# Agent Experience Epic — 下一 Phase Backlog（v0.20.0 cutover 之后）

> status: backlog（待启动）· owner: chenyqThu · created: 2026-06-27
> 上游：本 epic master plan = [`README.md`](./README.md) / [`roadmap.md`](./roadmap.md)
> 触发点：**v0.20.0 已 cutover**（Chunk H：桌面端 master + AGENT_VIEW + ASSISTANT_MODAL 默认开）。
> 本文件登记 cutover 之后、最后一个收尾大 session 要做的事——按用户 2026-06-27 指示整理成代办。

---

## 0. 本次 release 已落（v0.20.0）

- **Chunk H cutover（桌面端）**：`electron.vite.config.ts` 翻 `AI_SDK_NEW_SESSION_DEFAULT`（master，含 main gateway-start + renderer master + context-injection 派生）+ `MAILAGENT_AGENT_VIEW` + `MAILAGENT_ASSISTANT_MODAL` 默认 `'1'`。
- **回滚仍在**：`MAILAGENT_CHAT_RUNTIME=legacy` 一键回 legacy runtime；各 surface flag `MAILAGENT_AGENT_VIEW=0` / `MAILAGENT_ASSISTANT_MODAL=0` env 显式覆盖。
- **🔴 web 故意没翻**：`vite.web.config.ts` 三个 flag 仍 `?? ''`（OFF）。远程 web SPA（`mail.chenge.ink/app`）没有 embedded gateway，翻了也会因 `resolveAiGatewayBaseUrl()` 取不到 `?aiGatewayPort=` 而退回 legacy。web→ai-sdk 是下面 **任务 A** 的独立工作。

---

## 1. 下一 phase 代办（按优先级）

### 任务 A — 远程 Web 切 AI SDK ✅ 已落地（2026-06-30，随 v1.0.1）

> ✅ **实测 scope 大坍缩**：后端 `ai_gateway_proxy.py`（httpx SSE 反代 + verify_cf_access）/ 端口注入 / `resolveAiGatewayBaseUrl` web 同源 branch **早在 6/27 就位** → 任务A 仅 = 翻 `vite.web.config.ts` 3 个 define（master+AGENT_VIEW+ASSISTANT_MODAL）+ CI 加 `build:web` 步 + web dogfood。详见 [`remote-chat-report-architecture.md`](../../reference/remote-chat-report/remote-chat-report-architecture.md) 顶部。下方原始设想保留作背景。
**目标**：让 `mail.chenge.ink/app`（serve-api 单 origin serve SPA + API，CF Access 墙后）也走 ai-sdk runtime，而非 legacy。
**已知约束**：
- embedded AI SDK Gateway 现在只活在 **electron main 进程**（loopback `?aiGatewayPort=`）。web 没有这个进程。
- 所以 web 切 ai-sdk = **serve-api 要承载 `/api/ai/chat`（+ `/api/ai/agui/chat` mirror + title/followups）**，复用同一 `streamText`+tools+双 guard（chatRun.ts 已是 pure-ish，依赖 `ai` + config + tools，不依赖 node:http/electron）。
- 鉴权：本地 loopback 是无墙 token；远程是 CF Access cookie（见 [`remote-chat-report`](../../reference/remote-chat-report/remote-chat-report-architecture.md) 的 token/cookie 分流）。
- flag：翻 `vite.web.config.ts` 的三个 define + `resolveAiGatewayBaseUrl()` 要能在 web 下解析到 serve-api 的 gateway 端点（而非 loopback port）。
**门控**：跑通 `tests/agent_eval` 不回退 + web dogfood（CF Access 墙后实测流式/工具/HITL）。

### 任务 B — Harness Agent epic 收尾（删 legacy）
- **06b 7 天观察窗**：cutover 后稳定观察，无回滚信号 → **删 legacy harness**（自研 TS 单 loop `harness.ts` + ExternalStore 编排 + 旧 `AssistantUIChatPanel` 死路径）。删前确认 `MAILAGENT_CHAT_RUNTIME=legacy` 回滚路径是否要保留（删了就没有一键回退了——需用户拍板）。
- **flag 清理**：cutover 稳定后，把已 GA 的 flag（master / AGENT_VIEW / ASSISTANT_MODAL / A2UI / context-injection / send-tool）从 define + flags.ts resolver 收敛/移除，减少分支。
- **文档收敛**：chat-panel + 06-22 + 本 epic 的过程文档归档到 `docs/archive/`，常青结论沉淀到 `docs/reference/llm-agent/`。

### 任务 C — 最后一个 session：完整 Epic Review + Harness Agent 架构 Review
两件事一起做：
1. **Epic 工作 review**：把整个 agent 体验大版本（P0→P4 + redesign + assistant-modal + dogfood 1-7）从头梳一遍，确认无遗留债 / 回归 / 半成品 flag。
2. **Harness Agent 架构 review**：按用户给的"核心调度层重构"框架（下面 §2）做架构级评审——**重点是把愿景映射到现有 infra，识别真正的 gap，而不是重造已有件**。

> ✅ **任务 C 第 2 件已落地（2026-06-27）** → [`memory-skill-core-refactor.md`](./memory-skill-core-refactor.md)：架构 review 报告（4 findings：cutover 丢 memory 工具 / 读侧静态 dump / mem0 greenfield / gateway 工具不受 skill 门控）+ 4 步×infra 对账 + **3 blocker 已锁定**（Step 2=query 召回注入 · Mem0=长成自有内核不引三方 · 写 hook=Node onFinish→Python 单一 capture）+ **M0→M4 分阶段计划**（全 flag-gated + 过 eval 闸 + flag-off 字节级不变）。代码待用户 go 后按「每步一 diff」开（先 M0）。

---

## 2. 用户框架：Harness Agent 核心调度层代码级重构（待架构 review）

> 用户 2026-06-27 给的方向（原文整理）。**这是愿景/方向，不是即刻执行清单**——架构 review 时先与现有 infra 对账。

**用户设定的技术栈认知**：前端 (assistant-ui + Vercel AI SDK + A2UI)、后端 (含 SSE 流式)、数据层 (SQLite 双后端 + gbrain 外脑)。
**用户要求的工作方式**：每完成一步提交一次 diff 供 review。

### Step 1（CRITICAL）— AI SDK 流式 与 Mem0 异步解耦
- **红线**：Mem0 写入绝不阻塞 TTFT / SSE 流。
- 任务：找到流式输出入口函数 → 引入 mem0 → 异步回调：**完整回复生成完毕、SSE 关闭之后** 才触发后台任务写 Mem0（用户举例 FastAPI BackgroundTasks）。

### Step 2 — 🔴 仍缺失（用户两次 paste 都从 Step 1 跳到 Step 3）
- 推测是 **Mem0 检索/注入**（每轮把相关记忆召回并注入 context，与 Step 1 的"写"对称的"读"）。**需用户补全 Step 2 的确切内容**再动手。

### Step 3 — 动态 `user.md` 编译闭环
- 独立脚本/路由 `scripts/compile_user_md.py`（或 .ts）。
- 逻辑：`mem0.get_all(user_id)` 取图谱全部用户事实 → LLM 重排为结构化 Markdown → **安全覆写**根目录 `user.md`。
- （可选）init 阶段 / 定时任务触发。

### Step 4 — 技能注册表（Skill Registry）与自我挂载
- 工具目录下建 `SkillRegistry` 替代硬编码 Tools 数组。
- 现有工具（`search_emails` / `read_email` 即接 gbrain 的接口）重构为统一接口规范，默认向 LLM 暴露。
- 核心 Tool `update_system_md`：Agent 对话中调用，传 `file_name`(soul/agents) + `patch_content` 直接改自身设定文件，**改前做结构校验**。
- 核心 Tool `discover_skills`：Agent 查询 Registry 里还有哪些**未激活**的扩展能力（自我发现 → 再挂载/激活）。配合 SkillRegistry 的"自我挂载"语义闭环：discover → mount/activate → 暴露给 LLM。

### 🔴 三层概念先分清（用户 2026-06-27 纠正）

**Mem0 ≠ gbrain/KOS**，是互补的不同层，重构时别误并：
- **Mem0 = 大脑记忆**：agent 记住"你是谁 / 你的偏好 / 你的事实"，类人脑的长期+情景记忆，随对话演进、自动学习。
- **gbrain / KOS = 外挂知识库**：类人类笔记本，是 agent **查阅**的外部资料源（检索），不是 agent 的身份记忆。
- **standing context（SOUL/AGENT/RULES/USER）= 身份设定**：agent 是谁 + 规则；USER 文档是 Mem0 的"已编译人类可读投影"。

三层关系：Mem0（学到的）→ 编译进 USER 文档（身份层的"关于用户"段）；KOS 是平行的外部检索源；三者都可被工具/prompt 消费，但来源与生命周期不同。

### 🔴 架构 review 必须先回答的对账问题（现有 infra 重叠）

| 用户愿景 | 现有 MailAgent infra（已存在） | review 要决策的 gap |
|---|---|---|
| **Mem0（大脑记忆）** | `src/agent_config/` USER standing-context 文档 + 06-22 P2 memory auto-capture/冲突内核（**雏形**，非完整记忆库） | **引入三方 Mem0 库**，还是把 06-22 P2 memory 长成完整记忆库？**与 KOS 无关**——KOS 是外挂知识库不是大脑记忆，别误并 |
| **gbrain / KOS（外挂知识库）** | `src/kos/`（client/producer/bulk_ingest）+ gateway `kos_query` 工具 + bulk ingest 6693 存量 | **保持独立、基本不动**——它是检索源，与 Mem0 互补不替代。Mem0 重构时不要把 KOS 卷进去 |
| `user.md` 编译 | `src/agent_config/`：USER standing-context 文档 + `projections.py` 的 MEMORY 投影 + history/rollback | 投影/覆写基础设施大部分已存在。真 gap = "从 Mem0 取全部用户事实 → LLM 重排 → 覆写 USER 文档"这个**编译闭环** + 触发时机；`user.md` 本质 = USER standing-context 文档的别名 |
| `update_system_md` 工具 | `src/agent_config/`：SOUL/AGENT/RULES/USER 文档 + `validator.py`(RULES deny-list, negation-aware) + history/rollback + `/api/agent/*` | 后端能力已在；真 gap = **把它暴露成对话内 tool**（Agent 自改设定）+ 安全边界（PRODUCT_SAFETY_FLOOR 不可弱化、RULES 校验、改 SOUL 的人审？） |
| SkillRegistry | `src/skills/registry.py` + `installed.py` + `invoke.py` + `builtin/`（**已是注册表**）+ gateway `src/ai-gateway/tools/` 工具集 | 真 gap = **统一** gateway tools（Node）↔ src/skills（Python）↔ KOS 接口三套，+ "自我挂载"语义 |

### 🔴 最大架构张力（review 必须解）

用户框架假设流式入口是 **Python `POST /chat` + FastAPI BackgroundTasks**。但 **v0.20.0 cutover 后，桌面端流式入口是 embedded AI SDK Gateway（Node，electron main）的 `streamText`**，Python serve-api 只承载 legacy/远程路径。

→ **"Mem0 异步写 hook 挂在哪"取决于哪条后端**：
- 桌面主路径（Node gateway）：异步写 hook 应挂在 gateway 的 `onFinish`（`chatRun.ts` 已有 `makePersistOnFinish`，是天然的"流关闭后"钩子点）。
- 远程/legacy（Python）：才是 FastAPI BackgroundTasks。
- **统一记忆写入面**应该在哪一层（gateway onFinish？Python 服务层？还是两者都调一个共享 ingest API）= review 的核心拓扑决策，关系到"业务权威在 Python"这条 epic 铁律。

### epic 铁律（重构不可破）
单 loop · 业务权威在 Python · 安全底线（`PRODUCT_SAFETY_FLOOR` 不可弱化）· view-agnostic · 改 agent prompt/工具/编排必跑 `tests/agent_eval` 不回退（rules.py 零改纪律）。

---

## 3. 启动前要用户补的输入
1. **Step 2 的确切内容**（Mem0 检索/注入？）。
2. **Step 4 第 4 个核心工具名 + 语义**（截断了）。
3. **Mem0（大脑记忆）取舍**：引入三方 Mem0 库，还是把 06-22 P2 memory 内核长成完整记忆库？（**与 KOS 无关**——KOS 是外挂知识库，保持独立互补，不并入。）
4. **删 legacy 后是否保留 `MAILAGENT_CHAT_RUNTIME=legacy` 一键回退**。

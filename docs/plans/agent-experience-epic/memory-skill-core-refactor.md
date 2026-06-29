# Harness Agent 核心调度层重构 — 架构 Review + 分阶段计划

> status: **M1 全落地 ✅（M1a–M1f 6 commits `3aa91a2b`→`b906eee1`）** · **M2 全落地 ✅（2026-06-28，M2a–M2d 4 commits `dde91f6a`→`8343479c`，main 未 push，每步独立 code-reviewer APPROVE）** · **M3 next** · M5 新增 · owner: chenyqThu · created: 2026-06-27
> 上游：epic master = [`README.md`](./README.md) · 触发交接 = [`next-phase-backlog.md`](./next-phase-backlog.md) §2（用户「核心调度层重构」框架）
> 本档 = backlog §2 框架的**架构级 review 落地** + **可执行分阶段计划**。代码等本计划经用户确认后按「每步一 diff」开。
>
> **🔴 更新（2026-06-27，用户拍板后的范围调整）**：**M0（记忆面 parity 恢复）从本 enhance 计划「毕业」到 agent-experience-epic 的收尾任务** —— 它本质是 v0.20.0 cutover 的 **post-cutover bug 修复**（§2 finding 1：cutover 丢了 gateway 的 memory 工具，桌面默认 runtime 现在无法经工具写记忆），且是删 legacy harness 的**前置**。故 **M0 在 epic 收尾 session 实现**（与 web→ai-sdk 任务 A 同批，见 `.trellis/tasks/` 的收尾任务）。**本 enhance epic 的实质范围 = M1 → M4。** 删 legacy harness 仍延后到 M0 落地 **+ 7 天观察窗满**（cutover = 2026-06-27）。下文 M0 一节保留作实现参照。

---

## 0. TL;DR + 已锁定决策

把用户的 4 步愿景（Mem0 写/读解耦 + user.md 编译 + SkillRegistry 自我挂载）映射到 v0.20.0 cutover 后的真实 infra，识别真 gap，产出 **M0→M4 五阶段**计划。**重点不是从零造，而是统一 + 暴露成对话内能力 + 安全边界。**

**本 session 锁定的 3 个 blocker（用户 2026-06-27 拍板，全采纳推荐）：**
1. **Step 2 = query 相关性召回注入** —— 每轮用当前 query 向记忆内核召回 top-k 相关，注入 context，替代现在 `/chat/config` 的静态 top-20 dump。
2. **Mem0 = 引入 `mem0ai` 库**（2026-06-27 二次讨论后改，详见下「决策更新」）—— 跑在 Python serve-api（进程内，仍守业务权威在 Python）；带来 自动抽取 + hybrid 检索 + get_all + ADD/UPDATE/DELETE/NOOP 冲突，M1-M3 大幅简化。**与 KOS 无关，KOS 保持独立检索源不并入。** ~~（原方案：长成自有内核不引三方；经 Mem0 vs EverOS 调研 + 隐私/体积权衡后改为直接引 Mem0）~~
3. **异步写 hook = Node onFinish 触发 fire-and-forget → 单一 Python capture 端点**（抽取+落库逻辑在 Python）；远程/legacy 的 Python 流式路径用 `BackgroundTasks` 触发同一端点。统一记忆写入面不分叉。

**M1 自动写姿态决策（用户拍板）：** 自动抽取 = **写入 + `auto_capture` provenance + 用户可见「已记住 X」+ 一键撤销**，默认关，**只抽持久偏好、绝不抽一次性任务态**。不全静默（调和 RULES「绝不静默写」+ 安全底线）。

### 🔴 决策更新（2026-06-27 二次讨论后）—— 记忆引擎改为「引入 Mem0」

调研 Mem0 vs EverOS（EverMind-AI/EverOS）后，**EverOS 排除**（sidecar HTTP 服务 + 强制 embedding + 无 get_all + 无同步冲突解析 + 较新，与嵌入式 Python-SQLite 栈不合）。用户拍板 **直接引 `mem0ai`** 换开发速度，**锁定栈：**

- **库**：`mem0ai`（进程内 Python，跑在 serve-api；业务权威仍在 Python ✓）。
- **embedder**：**本地 bge-small**（FastEmbed/ONNX，on-device）—— 用户选「小本地 embedder」而非云 GPT/Voyage embedding，**守"邮件衍生数据不出第三方 SaaS"红线**（Claude 不提供 embedding，云 embedding 必引第二 provider 看衍生记忆 + query）。
- **向量库**：FAISS（嵌入式 on-disk，无 server）。
- **抽取 LLM**：复用现有 Claude/CRS（不引新 LLM provider；抽取在既有 chat 信任边界内）。
- **`MEM0_TELEMETRY=False`**（Mem0 默认开 PostHog 遥测，必关）。
- **副产品**：embedding 本地化 → 记忆**读（检索）完全离线可用**；只有**写（抽取）**需 LLM（与 chat 同一网络依赖）。

**对计划的影响（M1-M3 简化，M4 不变）：**
- **M0（已发 `734129bd`）**：gateway memory 工具面**不变**，但后端 `/chat/memory*` 由 `agent_memory_kv` **改接 Mem0**（M1 phase 做）；`agent_memory_kv` 迁移/退役（或保留作「显式 pinned」层，与 Mem0「学到的」层并存 —— M1 phase 定）。
- **M1**：`mem0.add(turn, user_id)` 自带 LLM 抽取 + dedup + 冲突 → 不再自写抽取逻辑；我们只做 Node onFinish fire-and-forget → Python capture → `mem0.add`（红线 + auto_capture 姿态不变）。
- **M2**：`mem0.search(query, user_id)` 自带 hybrid（bge-small 向量 + BM25）→ **取代原"FTS5 先行/向量后置 M2b"分阶段**（Mem0 第一天就有向量检索）。
- **M3**：`mem0.get_all(user_id)` → LLM 重排 → 覆写 USER 文档（安全覆写基建已有）。
- **M4**：不变（skills，与记忆无关）。
- **🔴 新增 packaging 成本（build 时核实）**：venv 加 `mem0ai` + `faiss-cpu` + `fastembed`(+`onnxruntime`) + bge-small 权重 ≈ **+150-250MB**（bge-small 本身 ~30-90MB，runtime 占大头）。若超预算再回头议（云 embedding / 更轻向量）。`build-python-venv.sh` 须加这些依赖。
- **离线降级**：bge-small 本地 → 检索离线可用；capture 的抽取 LLM 不可达 → fire-and-forget 静默失败（chat 不受影响，红线不破）。

### 🔴 框架收敛（2026-06-28，M1 定稿讨论 + 3 路 agent 实测核实）—— 统一记忆地图

把「mem0 引擎」与用户拍板的「记忆既有少量可编辑偏好、又有大量可检索事实」整合成 **单写入口、读侧按用途分流**：

- **写侧（单一）**：`onFinish` fire-and-forget → `mem0.add(turn)` 自动抽取，不分叉；preference/fact 分类**不在 M1 做**（留 M3 读侧）。
- **读侧分流（=「两者都要」）**：① 事实层（大量）经 `mem0.search(query)` 按 query 召回 top-k（M2）；② 偏好层（少量）经 **独立 `user.md`** 恒定全量注入 standing-context（M3），不依赖向量召回（防漏），人可读可编辑可 git diff。
- **🔴 偏好层 SSoT = 独立 `.md`（user.md）**（拍板）：可校验，亦可经 **`AGENT.md` WAL「先写后答」约束**让 AI 自行识别+维护；**不**走 mem0 投影（免双向同步）。仅影响 M3。
- **🔴 触发点修正（实测纠 §5/§3 旧「BackgroundTasks」说法）**：serve-api **无**持久化型 `/chat` 流式端点（`/llm-proxy`、`/notion-agent` 只转发不落库，`chat.py` 未 import `BackgroundTasks`）；远程 web 经任务 A 已代理到**同一 Node gateway**（复用 `chatRun.ts`）→ **`onFinish` 一处覆盖桌面 + 远程 web**，不需 Python 第二触发；legacy（待删 + M1 默认关）不接。
- **🔴 CRS 抽取 provider**（实测）：mem0 **anthropic provider 不支持自定义 base_url**（官方文档证），故用 **openai provider + `openai_base_url={LLM_API_BASE}/v1`** 走 CRS 的 OpenAI 腿（`/v1/chat/completions`，`config.py:295-302` 证 CRS 双协议）+ 复用 `LLM_API_KEY`，抽取 model 可配（mem0 死依赖 openai 库，不算额外 provider）。
- **🔴 `agent_memory_kv` 去留 → 独立 phase（M5）**：M1 **暂留并行**（M0 显式工具层照常，mem0 独立 store，M1 不碰 `chat_db` schema → 不 bump `CHAT_DB_VERSION`）；退役收尾梳理见 §5 M5。
- **体积（拍板）**：**接受全量、先不瘦身**；但 fastembed 离线修复 + 遥测 monkeypatch 仍做（功能正确 + 隐私红线，非瘦身）。

---

## 1. 现状拓扑（v0.20.0 cutover 后，实测代码）

**双 runtime 并存，桌面默认走 Node 网关：**

| 路径 | 入口 | 流式 | 工具 | 状态 |
|---|---|---|---|---|
| **桌面主路径** | embedded AI SDK Gateway（Node，electron main） | `ai-gateway/chatRun.ts` `streamText` → `server.ts` `pipeUIMessageStreamToResponse` | `ai-gateway/tools/index.ts` `buildGatewayTools`（硬编码） | cutover 主路径 |
| **远程/legacy** | Python serve-api `POST /chat` | `src/api/routers/chat.py` | legacy harness `createBuiltinTools` | `MAILAGENT_CHAT_RUNTIME=legacy` / web |

**记忆（memory）落点 —— 三处但 SSoT 唯一：**
- **存储 SSoT** = `agent_memory_kv` 表 ∈ `ai_chat.db`（schema 归前端 `chat_db.ts`，CHAT_DB_VERSION 15；v8 加 provenance + priority 列）。
- **业务逻辑在 Python** = `src/chat/db.py`：`upsert_memory_entry`（UPSERT + COALESCE 保 priority）+ `memory_summary_meta`（相关性选择 `priority DESC, updated_at DESC` + 限长 + 可观测 meta）。Python 开**同一个** `ai_chat.db` 文件读写，只写既有表、**不建表**。
- **身份层投影** = `src/agent_config/` USER 文档 + `projections.py` 的 MEMORY 投影（复用 `ChatDb.memory_summary()`）。

**三套 tool/skill 注册表：**
1. Python `src/skills/registry.py`（`BoundSkill`/`BoundTool`，builtin + installed，manifest + invoke）→ 供 `/api/skills` + MCP（外部 scoped agent）。
2. Node `ai-gateway/tools/index.ts`（`buildGatewayTools`）→ cutover runtime **实际**暴露给 LLM 的工具（硬编码 email/kos/report/write/send）。
3. legacy `shared/chat/tools/builtin/index.ts`（`createBuiltinTools`，含 memory）→ 仅 `RUNTIME=legacy` 可达。

---

## 2. 4 个非显然核心发现（决定路线）

**🔴 发现 1 — cutover 把 memory 工具丢了。** legacy harness 有 `memory_list/get/write/delete`（`shared/chat/tools/builtin/memory.ts`），但 gateway `tools/index.ts` **零 memory 工具**（已 grep 坐实）。桌面默认 runtime **现在不能经工具写记忆**；06-22 P2 记忆内核被搁在只有 `RUNTIME=legacy` 才可达的旧路径。→ Step 1 不只是「加异步写」，是**恢复 + 自动化**。

**🔴 发现 2 — 记忆读侧是「每轮静态 top-20 dump」，非检索。** gateway 经 `ai_gateway_lifecycle.ts` `getSystemPromptConfig` 拉 `/chat/config` 的 `memorySummary`（TTL 缓存，按 session 不带 query），注入 `systemPrompt.ts` 稳定前缀。与当前 query 无关。→ Step 2 要解。

**🔴 发现 3 — 全仓 0 处 `mem0` 引用；现有「auto-capture」非后台抽取。** Mem0 是 greenfield。06-22 P2b 的「auto-capture」实为**模型主动提议 `memory_write` + preview 确认**（AGENT 模板措辞 + memory.ts preview tier），**不是**后台 LLM 抽取。Mem0 招牌能力（流后自动抽取事实）确为新工。

**🔴 发现 4 — gateway 工具注册不受 skill 启用态门控。** `buildGatewayTools` 只受 `writeToolsEnabled/sendToolEnabled` 两 flag 控制，**不读** agent_config 的 skill 启用覆盖（`skill_overrides_map`）。模型经 capabilities 块被「告知」某 skill 关了，但工具仍可调 —— 与 legacy 的 skill→tools 真门控不同。→ Step 4「统一 + 自我挂载」要收口。

---

## 3. 框架 4 步 × 现有 infra 对账表

| 框架步骤 | 已存在（可复用） | 真 gap（要做的） | 难度 |
|---|---|---|---|
| **Step 1** 流式/Mem0 写解耦 | onFinish 钩子 `chatRun.ts makePersistOnFinish` + `lifecycle persistTurn`（已是流后）；Python `upsert_memory_entry` 落库 | ① gateway 加 fire-and-forget 调用；② Python 新 capture 端点（**抽取**逻辑=新）；③ 红线永不 await | 中 |
| **Step 2** Mem0 检索/注入（读侧） | 注入点已在（systemPrompt + contextSnapshot）；`memory_summary_meta` 选择逻辑 | 「静态 top-20」→「按 query 召回 top-k」= 需检索（先 FTS5，向量后置）+ 注入改造 | 中-高 |
| **Step 3** `user.md` 编译闭环 | USER 文档 + history/rollback + `set_profile_doc` 安全覆写 + `/api/agent/profile/docs/user` 写端点 | `get_all → LLM 重排 → 覆写 USER 文档`这个**编译器** + 触发时机；`user.md` ≡ USER standing-context 文档别名 | 低-中 |
| **Step 4** SkillRegistry + 自我挂载 | Python `src/skills/registry.py`（已是注册表）+ `/api/agent/skills*`（enable/install）+ `validator.py`（RULES deny-list）+ history/rollback | ① gateway 工具集**由 resolved skill 启用态驱动**（收发现 4）；② `update_system_md` 工具（包 `set_profile_doc` + validator + 审批）；③ `discover_skills` 工具（包 `resolved_skills` + set_enabled） | 高 |

---

## 4. 最大架构张力的解（拓扑决策，已锁定 blocker 3）

「Mem0 写 hook 挂哪」—— 与 backlog §2 判断一致，已验证可行：
- **触发**在 Node gateway `onFinish`（流后钩子，桌面唯一的「SSE 关闭后」点）；
- **写逻辑**在 **Python 单一 capture 端点**（守「业务权威在 Python」+ 复用 `upsert_memory_entry`）；
- **两条后端共用**：远程/legacy 的 Python 流式路径用 `BackgroundTasks` 触发**同一端点** → 统一记忆写入面；
- **红线满足**：`persistTurn` 里 **fire-and-forget（不 await）** 调 Python，TTFT/SSE 早已完成，零阻塞。

---

## 5. 分阶段计划

### M0 — 记忆面 parity 恢复（收发现 1，地基）
> flag `MAILAGENT_AI_SDK_MEMORY_TOOLS`（default off）· 难度低 · 风险低

- **做**：`memory_get`/`memory_list`（silent read）+ `memory_write`/`memory_delete`（approval 经现有 `ApprovalGuard`）加入 `buildGatewayTools`，handler 经 `MailAgentDomainClient` → 已存在 Python `/chat/memory*` 端点（`chat.py:972-1042`，零改）。
- **flag-off 不变量**：gateway 工具集 == 当前 cutover 集，字节级。
- **eval**：`tool_catalog.json` += 4 工具（`gateway_only:true`）；recorder 适配；baseline 不回退。
- **可与 M1 合并**，拆开更易 review。

### M1 — Step 1：异步自动抽取写（CRITICAL，定稿 2026-06-28）
> flag `MAILAGENT_MEM0_CAPTURE`（default off）· 难度中 · 红线=永不阻塞 TTFT/SSE
> 本节取代原方案（Mem0 前写的「自写小 LLM 抽取 + `upsert_memory_entry` 落 `agent_memory_kv`」）：引擎换 `mem0ai` 后抽取/dedup/冲突全在库内，落点改 mem0 独立 store。
>
> **✅ 已落地（2026-06-28，6 commits）— 实测偏差（覆盖下文旧描述，详见 memory `project_mem0_m1_enhance_epic`）**：① 抽取 LLM = **anthropic provider 经 CRS anthropic 腿**（**非 openai**：CRS openai 腿强制 `stream=true` + 把 claude 转成 mem0 解析不了的 list；anthropic 腿返回标准 text 走通）；② telemetry 仅 **`MEM0_TELEMETRY=False` env**（import 前设，PostHog 从不实例化；monkeypatch 无效已删）；③ `max_tokens=8192`（anthropic SDK 非流式 >10min 硬限，不能用全局 64k）；④ `MAILAGENT_MEM0_CAPTURE` **只用 main 进程 env，不加 vite define/flags.ts**（capture 纯后端 renderer 无感，**偏离铁律 1 的"两 define"**——那条只针对 renderer 直读 gate UI 的 flag，reviewer 确认对）；⑤ M1d 撤销前端走**统一 `createChatRuntime` 直 `request` 无 IPC**（cutover 3c-3 后双 surface 共享 runtime，非 HttpApi/ElectronApi 双 block）；⑥ M1f **无新 eval task**（capture 是 onFinish 后台 side-effect、无 agent 行为可测，agent_eval 89 passed 零回退 + 9 端点/6 引擎单测覆盖契约）；⑦ pre-bake 权重后置（首次 flag-on 联网下载 bge）。

- **落点 = mem0 独立 store**（`<DATA_ROOT>/mem0/`：FAISS index + mem0 自管 SQLite history），**不经 `agent_memory_kv`、不碰 `chat_db` schema → 不 bump `CHAT_DB_VERSION`**。`agent_memory_kv`（M0 显式层）M1 暂留并行（退役 = M5）。
- **Python（写逻辑权威）**：新 `POST /chat/memory/capture`（接 turn：user+assistant 文本 + sessionId + provenance）→ `mem0.add(messages, user_id, metadata)`；抽取+dedup+ADD/UPDATE/DELETE/NOOP 冲突全在 mem0 内，不自写。**只抽持久偏好/事实，绝不抽一次性任务态**：`custom_fact_extraction_prompt` + RULES floor 双重约束。`metadata.source='auto_capture'` + provenance。
- **mem0 本地栈**：抽取 LLM = **openai provider + `openai_base_url={LLM_API_BASE}/v1`**（CRS OpenAI 腿，复用 `LLM_API_KEY`，model 可配；anthropic provider 不支持 base_url 故不用）+ fastembed bge-small（离线）+ FAISS（on-disk，pin DATA_ROOT）+ `MEM0_TELEMETRY=False`（env）+ PostHog monkeypatch（#3729 不干净）+ pre-bake 权重 + pin `cache_dir`（fastembed #615 离线 bug）。mem0 **同步库** → capture 端点用 `run_in_executor` 跑，不阻塞 event loop。
- **Node 触发**：`makePersistOnFinish`（`chatRun.ts`）在 `cfg.persistTurn(turn)` 之后 `void cfg.captureTurnMemory(turn).catch(...)` —— fire-and-forget，绝不 await。
- **自动写姿态（锁定）**：写入 + `auto_capture` provenance + 用户可见「已记住 X」（`memory.captured` SSE → toast）+ 一键撤销（mem0 delete by id）；默认关；durable-only。
- **flag-off 不变量**：`captureTurnMemory` undefined → `persistTurn` 字节级同 M0；mem0 懒加载（flag-off 不 import 重依赖）。
- **子步骤（每步一 diff）**：M1a 引擎封装（`src/memory/`，懒加载 + openai/CRS + fastembed + FAISS + telemetry + pyproject `[memory]` extra）→ M1b `/chat/memory/capture`（mem0.add + 抽取 prompt + run_in_executor）→ M1c Node 触发 + `MAILAGENT_MEM0_CAPTURE` flag（electron.vite + vite.web 两 define + flags.ts）→ M1d 姿态（SSE「已记住」+ 撤销端点 + 按钮）→ M1e 打包（build-python-venv.sh 纳入 memory extra + 离线/遥测修复，瘦身后置）→ M1f eval（capture task + baseline，rules.py 零改）。

### M2 — Step 2：query 相关性召回注入（读侧）
> flag `MAILAGENT_MEM0_RETRIEVAL`（default off）· 难度中-高
>
> **✅ 已落地（2026-06-28，M2a–M2d 4 commits `dde91f6a`→`8343479c`，main 未 push，每步独立 code-reviewer APPROVE）— 实测偏差（覆盖下文旧描述）**：① **eval 零回退不重录**（用户拍板）—— `AGT-MEMORY-*` 测的是 `memory_get`/`agent_memory_kv` 工具调用（**不同 store**），mem0 召回是 system-prompt 注入、**不在 zero-LLM rules 评分路径**（rules 看工具序列/证据，不看 prompt 字节）→ 与 M1f 同理 `agent_eval 89 passed` 零回退，**不重录 baseline**（推翻下文「按 recorder-contract 重录」的保守预判）；② **flag 只 main env 不加 vite define**（仿 M1c —— 召回纯后端注入 renderer 无感，区别于 AGENT_VIEW 等 renderer 直读 gate UI 的 flag）；③ **top-k=10**（引擎默认，用户拍板）+ `buildRetrievedMemoryBlock` 独立 re-cap 10 + 每条 clamp 500 code-point（defense-in-depth，Node 侧自保护不靠 wire）；④ **🔴 召回在 TTFT 关键路径**（区别于 M1 capture 的 fire-and-forget）→ 契约 **never-throw** + **5s 超时兜底** fastembed 冷加载（失败/超时 → context-light，绝不阻断已开始的 turn；reviewer traced `_req` 全 throw site = 全 reject → 全被 catch，airtight）；⑤ 注入结构 = floor(stable cacheable) → recalled memory(背景，untrusted-fenced + `sanitizeUntrusted` 防越界) → context(当前 view)，**与 `agent_memory_kv` 的 `memorySummary` 并存**（M5 才退役 kv）；⑥ M2 召回在 `prepareChatRun` 的 `if (cfg.systemPromptProvider)` 分支内（context injection on 时；cutover 默认 on），用 `lastUserMessage(rawMessages)` 原始 user 文本（不被 injectedContext 邮件正文污染）；⑦ M2a Python `/chat/memory/search`（best-effort 读，仿 capture）→ M2b Node 机制（`RetrievedMemory`/`buildRetrievedMemoryBlock`/`searchMemory`/契约/prepareChatRun）→ M2c lifecycle 注入 + flag → M2d eval + 文档。

- **Python**：新 `POST /chat/memory/search`（query → 相关性召回 top-k）= `get_mem0_engine().search(query, user_id=DEFAULT_USER_ID, limit=k)`（**M1a 引擎已封装 `search` 方法**：`mem0.search(query, filters={"user_id"}, top_k)`，bge-small 向量 hybrid，本地离线）。~~（§0 决策更新已覆盖原"先 FTS5 词法/向量后置 M2b"分阶段——Mem0 第一天就有向量检索，M1e 已把 fastembed/FAISS 打进 venv，无需 FTS5 过渡）~~ 注意 faiss 不支持 keyword/BM25（M1 集成坑），纯语义召回。
- **Node**：`prepareChatRun` 在 `streamText` 前用末条 user 文本调 search → 召回注入 context block（取代静态 `memorySummary` 全量 dump）。
- **flag-off 不变量**：不调 search，仍走 `/chat/config` 静态 top-20，字节级不变。
- **eval 注意**：改注入内容会动依赖 memory 的 task → 按 recorder-contract 重录 baseline；**真 gate 看迭代质量，不靠改任务凑绿**。

### M3 — Step 3：`user.md` 偏好编译闭环（含偏好层 SSoT 决策）✅
> flag `MAILAGENT_USER_MD_COMPILE`（default off）· 难度低-中 · 无 hot-path
>
> **✅ 已落地（2026-06-29，M3a–M3d 4 commits `67d6d868`→`82e81a72`，main 未 push，每步独立 code-reviewer APPROVE）— 实测/决策（覆盖下文设计）**：① **维护形态 = 编译器式合并式**（§8 开放决策经 AskUserQuestion 拍板）：读现有 user.md（含手编 SSoT）+ mem0 偏好候选 → LLM forced-tool 合并（保留手编/并入新发现/去重）→ 覆写；**WAL 自维护归 M4**（与 `update_system_md` 合并，避免两条写 user.md 路径）。② **引擎不落库 + 不 import mem0**（端点传 `get_all` 的 list 进来）→ `src/memory/user_md_compiler.py` 纯逻辑易测。③ 校验兜底（空 / 缺 `# USER` / 超 20000 字符 → raise，绝不写坏恒注入身份文档）+ **候选折叠内部空白 / 剥前导 `#` 防 `\n` 伪造 section 注入**（reviewer MEDIUM-1）。④ 端点 `POST /chat/memory/compile-user-md` **自检 flag**（区别 capture/search Node 触发不自检 —— M3 手动 HTTP 直达 → flag-off `E_DISABLED` 403）+ 用户主动操作失败 raise（区别 search best-effort）+ 返回 `{before, beforeHash, after, changed, itemCount}`。⑤ flag = **config.py pydantic**（区别 M1/M2 Node env）+ `/chat/config` 暴露 `userMdCompileEnabled` 控按钮显隐（仿 useLlmModels，非 vite define，运行时一致；singleton 读 → 翻 flag 需重启）。⑥ 前端 `UserMdCompileSection`（before/after diff + rollback `toHash=beforeHash` → `/agent/profile/docs/user/rollback`）+ i18n 双 locale。⑦ **agent_eval 89 零回退**（/config 加字段不改 agent 行为，仿 M2d）。子步 M3a 引擎+单测 → M3b 端点+flag+config → M3c 前端+i18n → M3d eval+文档。
>
> **🔴 偏好层 SSoT = 独立 `user.md`（2026-06-28 拍板）**：偏好恒定全量注入、人可读可编辑可 git diff；维护走校验或经 `AGENT.md` WAL「先写后答」约束让 AI 自行识别+维护；**不**走 mem0 投影（免双向同步）。

- **Python**：路由/脚本 → `mem0.get_all(user_id)` → LLM **判定偏好类 + 重排**为结构化 Markdown → `set_profile_doc('user', updated_by='agent_proposed')`（安全覆写基建全在：history + rollback + hash）。`user.md` ≡ USER standing-context 文档别名。**preference/fact 分类在此读侧做**（M1 写侧不分类）。
- **事实层不进 user.md**：事实经 M2 `mem0.search` 按 query 召回，不恒注入。
- **触发**：手动路由（先）+ 可选定时（后）。
- **flag-off 不变量**：不触发，USER 文档不动。

### M4 — Step 4：SkillRegistry 统一 + 自我挂载（最大，建议拆 a/b/c）
> flag `MAILAGENT_SKILL_SELF_MOUNT`（default off）· 难度高

- **M4a 工具注册受 skill 启用态门控**（收发现 4）✅ **已落地**（4 commits，main 未 push：M3c base fix `0c683496` → M4a Python `02c7265b` → Node 门控 `495bf286` → Node 接线 `d4281b15`）。**数据所有权拆分（决策 1）**：哪些 skill 对模型可见 = 业务态 = Python `/chat/config.advertisedSkills`（`advertised_skill_names` = `resolved_skills` 里 enabled(override ?? default) && available）；gateway-工具→skill 映射 + 过滤 = 工具集结构 = Node（`ai-gateway/tools/skill_gating.ts` 的 `GATEWAY_SKILL_TOOLS` + `applySkillGating`，复刻 legacy `computeSkillEnablement` 的 advertised-owner-wins 分区）。关掉的 skill 其读工具不注册给 LLM。**双独立 review（opus+codex）精炼**：① 漂移守护 = 双向**完整性**分类测试（每个 gateway 工具必 ∈ `GATEWAY_SKILL_TOOLS` ∪ collision-exempt ∪ core 白名单，防「新读工具漏门控」复发，非仅 subset）；② **fail-OPEN**（advertisedSkills=null=Python hiccup → 不门控，门控范围只读工具，write/send 另有 flag+审批）；③ flag-off 字节级范围 = **gateway ToolSet**（`/chat/config` 恒发 advertisedSkills 字段、值可 null，by design 无 flag，非字节恒等）。门控范围 = email/search/report 读工具；`email_search`(collision-exempt) + kos/memory/write/send(core) 永不门控。
- **M4b `update_system_md` 工具**：包 `set_profile_doc` + `validator`（RULES deny-list）+ 审批。**SOUL/RULES 改 = 高危人审 tier**，USER/AGENT 较低；`PRODUCT_SAFETY_FLOOR` 结构上已不可弱化。
- **M4c `discover_skills` 工具**：包 `resolved_skills`（查未激活能力）+ `set_enabled`（自我挂载 discover→mount→暴露闭环）。
- **flag-off 不变量**：gateway 仍用硬编码工具集，字节级不变。
- **KOS 不动**：`src/kos/` 保持独立检索源（`kos_query` 工具），不并入记忆。

### M5 — `agent_memory_kv` 退役 / 记忆存储统一收尾（独立 phase，2026-06-28 新增）
> flag `MAILAGENT_MEMORY_KV_RETIRE`（default off）· 难度中 · **前置 = M1+M2+M3 落地且 mem0 读侧稳定**
> 用户拍板：kv 退役接受，但**必须独立成 phase**，先把涉及面/影响点/移除收尾全梳理清楚再动，不夹带进 M1。

- **背景**：用户质疑 `agent_memory_kv`（KV 表）作身份/偏好主记忆的设计（top-N dump 注入、key 易碎、人不可读）。统一方向 = 偏好 → `user.md`（M3）、事实 → mem0（M1/M2），kv 显式工具层退役或改接 mem0。
- **phase 启动先产出影响面清单，再动代码**：
  - **读侧消费点**：`memory_summary`/`memory_summary_meta` 注入（`/chat/config`）、`src/agent_config` MEMORY 投影、standing-context。
  - **写侧/工具**：M0 的 `memory_list/get/write/delete`（gateway `createMemoryTools` + DomainClient + Python `/chat/memory*`）、legacy harness memory 工具。
  - **schema**：`agent_memory_kv` 表 + `CHAT_DB_VERSION`（删表/只读冻结/数据迁移 mem0+user.md 三选一）。
  - **eval**：AGT-MEMORY-* task + `tool_catalog`（4 工具去留）+ baseline 重录。
  - **provenance/priority**：v8 列去向（迁 mem0 metadata / user.md 标注）。
- **候选路径**（phase 内定）：(A) M0 工具改接 mem0（`memory_write`→`add(infer=False)`，`get/list`→mem0）+ kv 表只读冻结；(B) 偏好迁 user.md、事实迁 mem0 后 kv 数据迁移 + 表退役。
- **flag-off 不变量**：不翻则 kv + M0 工具字节级照旧。

---

## 6. 贯穿铁律（每阶段都钉）

1. flag-gated，**flag-off 字节级不变**（新 flag = `MAILAGENT_*` env + renderer 可见的同步 electron.vite + vite.web 两处 define）。
2. 过 `tests/agent_eval` 不回退：**`rules.py` 零改**；新工具进 `tool_catalog.json` 标 `gateway_only:true`；新 task 配 baseline trace（否则 `run_baseline` 拒分）；真 gate 看迭代，不凑绿。
3. **业务权威在 Python**（抽取/检索/编译逻辑全在 Python，Node 只触发 + 注入）。
4. `PRODUCT_SAFETY_FLOOR` 不可弱化；RULES 写经 `validator`；自动写 durable-only。
5. view-agnostic（不写邮件态专属措辞）。
6. 动 `agent_memory_kv` schema → bump **`CHAT_DB_VERSION`**（非 `EXPECTED_DB_VERSION`）+ `src/chat/db.py` 头注释 + test_chat seed + 终态断言。
7. 每阶段 = 一个（或少数几个）可 review diff（用户工作方式）。

### flag 清单（新增，全 default off 直到各自 cutover）
| flag | 阶段 | 控什么 |
|---|---|---|
| `MAILAGENT_AI_SDK_MEMORY_TOOLS` | M0 | gateway 记忆工具注册 |
| `MAILAGENT_MEM0_CAPTURE` | M1 | onFinish 异步抽取写 |
| `MAILAGENT_MEM0_RETRIEVAL` | M2 | per-turn query 召回注入 |
| `MAILAGENT_USER_MD_COMPILE` | M3 | user.md 编译触发 |
| `MAILAGENT_SKILL_SELF_MOUNT` | M4 | 工具门控 + update_system_md + discover_skills |
| `MAILAGENT_MEMORY_KV_RETIRE` | M5 | agent_memory_kv 退役 / 记忆存储统一 |

---

## 7. 依赖图 + 版本排期

```
M0 ──→ M1(CRITICAL) ──→ M2 ──┬─→ M4(a/b/c)
  └──────────────────────────┘
M3 接 M1/M2（mem0.get_all → 偏好编译 user.md）
M5（agent_memory_kv 退役）前置 = M1+M2+M3 稳定后
```

版本：post-cutover 新子-epic。建议 M0-M1 = v0.21、M2 = v0.22、M3/M4 分 release。与 backlog 任务 A（web→ai-sdk）/ 任务 B（删 legacy）互不阻塞。**注意**：任务 B 删 legacy harness 前，M0 须确认 gateway 记忆面已 parity（否则删了 legacy = 记忆工具彻底消失）。

---

## 8. 开放决策（后续 phase 内定）

- ~~**M2b 向量召回**~~ **已定（2026-06-28）**：mem0 第一天就有 fastembed bge-small 向量检索，无「FTS5 先行/向量后置」分阶段。
- ~~**capture 抽取模型/provider**~~ **已定**：openai provider 经 CRS `/v1`（复用 `LLM_API_KEY`，model 可配）；频率 = 每轮 onFinish fire-and-forget；遵守「LLM 调用 1M+64k」全局指令（facts 输出实际短）。
- ~~**偏好层 SSoT**~~ **已定**：独立 `user.md` + `AGENT.md` WAL 约束（见 §0 框架收敛 / M3）。
- ~~**打包体积**~~ **已定**：接受全量不瘦身，离线/遥测修复仍做（见 §0）。
- **M3 user.md 自动维护形态**：校验式 vs `AGENT.md` WAL「先写后答」自维护——M3 phase 内定。
- **M4b 审批 tier 细则**：SOUL/RULES 改的人审形态（ConfirmDialog vs 独立审计面）。
- **M5 kv 退役路径**：候选 A（工具改接 mem0 + 表只读冻结）vs B（数据迁移 + 表退役）——M5 phase 内定（见 §5 M5）。
- **记忆 GC/衰减**：mem0 store 长大后的过期/合并策略。

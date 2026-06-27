# Harness Agent 核心调度层重构 — 架构 Review + 分阶段计划

> status: planning（review ✅ + 3 blocker 已锁定；代码未开）· owner: chenyqThu · created: 2026-06-27
> 上游：epic master = [`README.md`](./README.md) · 触发交接 = [`next-phase-backlog.md`](./next-phase-backlog.md) §2（用户「核心调度层重构」框架）
> 本档 = backlog §2 框架的**架构级 review 落地** + **可执行分阶段计划**。代码等本计划经用户确认后按「每步一 diff」开。
>
> **🔴 更新（2026-06-27，用户拍板后的范围调整）**：**M0（记忆面 parity 恢复）从本 enhance 计划「毕业」到 agent-experience-epic 的收尾任务** —— 它本质是 v0.20.0 cutover 的 **post-cutover bug 修复**（§2 finding 1：cutover 丢了 gateway 的 memory 工具，桌面默认 runtime 现在无法经工具写记忆），且是删 legacy harness 的**前置**。故 **M0 在 epic 收尾 session 实现**（与 web→ai-sdk 任务 A 同批，见 `.trellis/tasks/` 的收尾任务）。**本 enhance epic 的实质范围 = M1 → M4。** 删 legacy harness 仍延后到 M0 落地 **+ 7 天观察窗满**（cutover = 2026-06-27）。下文 M0 一节保留作实现参照。

---

## 0. TL;DR + 已锁定决策

把用户的 4 步愿景（Mem0 写/读解耦 + user.md 编译 + SkillRegistry 自我挂载）映射到 v0.20.0 cutover 后的真实 infra，识别真 gap，产出 **M0→M4 五阶段**计划。**重点不是从零造，而是统一 + 暴露成对话内能力 + 安全边界。**

**本 session 锁定的 3 个 blocker（用户 2026-06-27 拍板，全采纳推荐）：**
1. **Step 2 = query 相关性召回注入** —— 每轮用当前 query 向记忆内核召回 top-k 相关，注入 context，替代现在 `/chat/config` 的静态 top-20 dump。
2. **Mem0 = 长成自有内核（Mem0-shaped API，不引三方库）** —— 在现有 `agent_memory_kv` + Python 逻辑上补「自动抽取 + 相关性检索 + get_all」。守业务权威在 Python + flag-off 字节级不变 + 打包体积可控 + 复用已有 provenance/priority/USER 投影。**与 KOS 无关，KOS 保持独立检索源不并入。**
3. **异步写 hook = Node onFinish 触发 fire-and-forget → 单一 Python capture 端点**（抽取+落库逻辑在 Python）；远程/legacy 的 Python 流式路径用 `BackgroundTasks` 触发同一端点。统一记忆写入面不分叉。

**M1 自动写姿态决策（用户拍板）：** 自动抽取 = **写入 + `auto_capture` provenance + 用户可见「已记住 X」+ 一键撤销**，默认关，**只抽持久偏好、绝不抽一次性任务态**。不全静默（调和 RULES「绝不静默写」+ 安全底线）。

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

### M1 — Step 1：异步自动抽取写（CRITICAL）
> flag `MAILAGENT_MEM0_CAPTURE`（default off）· 难度中 · 红线=永不阻塞 TTFT/SSE

- **Python（写逻辑权威）**：新 `POST /chat/memory/capture`（接 turn：user+assistant+anchor）→ 小 LLM 抽取「持久事实」→ 对既有 key `memory_get` 冲突检查 → `upsert_memory_entry`（source 标 `auto_capture`，复用 v8 provenance 列）。**只抽持久偏好，绝不抽一次性任务态**（抽取 prompt + RULES floor 双重约束）。
- **Node 触发**：`persistTurn` 末尾 **fire-and-forget**（不 await）调该端点。
- **远程/legacy 对称**：Python `/chat` 流式路径用 `BackgroundTasks` 触发同一端点。
- **自动写姿态（已锁定）**：写入 + `auto_capture` provenance + 用户可见「已记住 X」+ 一键撤销；默认关；durable-only。
- **flag-off 不变量**：`persistTurn` 不调 capture，字节级同 M0。

### M2 — Step 2：query 相关性召回注入（读侧）
> flag `MAILAGENT_MEM0_RETRIEVAL`（default off）· 难度中-高

- **Python**：新 `POST /chat/memory/search`（query → 相关性召回 top-k）。**先 FTS5 词法**（复用仓内 FTS5 基建，零新依赖、打包零增重）；**向量语义召回 = M2b 后置**（避免现在给 .app 塞 embedding 模型）。
- **Node**：`prepareChatRun` 在 `streamText` 前用末条 user 文本调 search → 召回注入 context block（取代静态 `memorySummary` 全量 dump）。
- **flag-off 不变量**：不调 search，仍走 `/chat/config` 静态 top-20，字节级不变。
- **eval 注意**：改注入内容会动依赖 memory 的 task → 按 recorder-contract 重录 baseline；**真 gate 看迭代质量，不靠改任务凑绿**。

### M3 — Step 3：`user.md` 编译闭环
> flag `MAILAGENT_USER_MD_COMPILE`（default off）· 难度低-中 · 无 hot-path

- **Python**：`scripts/compile_user_md.py` / 路由 → kernel `get_all(user_id)`（= `list_memory_entries('user')`）→ LLM 重排为结构化 Markdown → `set_profile_doc('user', updated_by='agent_proposed')`（安全覆写基建已全在：history + rollback + hash）。`user.md` ≡ USER standing-context 文档别名。
- **触发**：手动路由（先）+ 可选定时（后）。
- **flag-off 不变量**：不触发，USER 文档不动。

### M4 — Step 4：SkillRegistry 统一 + 自我挂载（最大，建议拆 a/b/c）
> flag `MAILAGENT_SKILL_SELF_MOUNT`（default off）· 难度高

- **M4a 工具注册受 skill 启用态门控**（收发现 4）：`buildGatewayTools` 读 resolved skill 启用态（`skill_overrides_map`/`resolved_skills` 经 domain client），关掉的 skill 其工具**不注册**给 LLM —— 恢复 legacy 的 skill→tools 真门控。
- **M4b `update_system_md` 工具**：包 `set_profile_doc` + `validator`（RULES deny-list）+ 审批。**SOUL/RULES 改 = 高危人审 tier**，USER/AGENT 较低；`PRODUCT_SAFETY_FLOOR` 结构上已不可弱化。
- **M4c `discover_skills` 工具**：包 `resolved_skills`（查未激活能力）+ `set_enabled`（自我挂载 discover→mount→暴露闭环）。
- **flag-off 不变量**：gateway 仍用硬编码工具集，字节级不变。
- **KOS 不动**：`src/kos/` 保持独立检索源（`kos_query` 工具），不并入记忆。

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

---

## 7. 依赖图 + 版本排期

```
M0 ──→ M1(CRITICAL) ──→ M2 ──┐
  └──────────────────────────┴─→ M4(a/b/c)
M3 可与 M1/M2 并行（独立 get_all，无 hot-path）
```

版本：post-cutover 新子-epic。建议 M0-M1 = v0.21、M2 = v0.22、M3/M4 分 release。与 backlog 任务 A（web→ai-sdk）/ 任务 B（删 legacy）互不阻塞。**注意**：任务 B 删 legacy harness 前，M0 须确认 gateway 记忆面已 parity（否则删了 legacy = 记忆工具彻底消失）。

---

## 8. 开放决策（后续 phase 内定）

- **M2b 向量召回**：何时引入语义检索（embedding 来源 = LLM provider embedding 端点 vs 本地小模型 vs sqlite-vec），打包体积权衡。
- **M4b 审批 tier 细则**：SOUL/RULES 改的人审形态（ConfirmDialog vs 独立审计面）。
- **capture 抽取模型**：用哪个小模型 + 频率（每轮 vs 批量），成本权衡（遵守「LLM 调用 1M+64k」全局指令，但抽取是小结构化调用，maxOutputTokens 应小）。
- **记忆 GC/衰减**：自有内核长大后的过期/合并策略（Mem0 有，自有内核需补）。

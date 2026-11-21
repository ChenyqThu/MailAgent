# 对话体验、会话工作台浮窗与本地搜索索引升级规划

> **规划定稿日期**：2026-11-20 · **Trellis Epic**：[`11-20-chat-search-harness-upgrade-epic`](../../.trellis/tasks/11-20-chat-search-harness-upgrade-epic/prd.md)
> **规划真源**：本文档（`docs/plans/chat-search-harness-upgrade/README.md`）与 `.trellis/tasks/11-20-chat-search-harness-upgrade-epic/{prd,design,implement}.md`。
> **并发卫生说明**：为避免与并行开发线冲突，本规划暂未改动 `CLAUDE.md` 文档地图与任何源码；待 Wave 1 启动或合入时在 `CLAUDE.md` 文档地图补加索引行。

---

## 0. Owner 拍板决策

1. **全量分批推进顺序**：
   **Wave 1（搜索 P0 止血与下载体验）→ Wave 2（对话动态状态与过程自动收起）→ Wave 3（右侧会话工作台浮窗）→ Wave 4（统一本地索引 Provider 与邮件轻量语义检索）**。
2. **Wave 2 动态状态（Thinking Verbs）分层混合架构**：
   对标 Claude Code / OpenAI Codex / Notion AI / Antigravity（AGY），按「是否需要语义理解」拆为三层，避免将确定性状态浪费给高延迟模型请求：
   - **Layer 1（静态趣味 / 自然等待词）**：纯程序本地词库数组（0 Token、0 延迟），仅用于 TTFT 首字连接期（`connecting`）或无有效信号的空等兜底。
   - **Layer 2（纯程序工具参数模板映射）**：纯程序解析 `tool-call` 工具名、语义入参（`query` / `path` / `subject` / `toolSummary`）与执行结果，生成可读进行时/完成态文案与同类聚合组头（0 Token、0 延迟）。
   - **Layer 3（语义级思考 / 进度摘要）**：主路径零成本从模型流式 `reasoning` 增量提取原生摘要/粗体小标题驱动状态行；同时在网关协议预留非阻塞的异步旁路快模型 `data-turn-status` 接口，供无原生摘要的模型按需启用。
3. **Wave 3 右侧会话工作台浮窗（Session Workspace Inspector）**：
   **零新增数据库表**，由纯函数从 `UIMessage.parts` 与现有缓存实时派生 5 大分区：**产物（Artifacts）/ 引用资料（Context & Sources）/ 链接（Links）/ 技能（Skills）/ 连接器与上下文预算（Connectors & Budget）**。宽屏主会话采用「300px 概览 ↔ 520px Artifact 分屏预览」双态可收起停靠（预览拓宽且视口不足时自动收起左栏以保 `44rem` 对话阅读区），窄侧栏与浮窗通过头部计数胶囊打开 Overlay 抽屉。
4. **Wave 4 本地索引模型与邮件轻量语义检索**：
   抽象统一 `EmbeddingProvider`（支持**内置端侧小模型** + **复用本机 Ollama / LM Studio / MLX Server**），优先做 Apple Silicon 真机 PoC 实测 `EmbeddingGemma-300M`（ONNX + CoreML/ANE + MRL 256d/512d）对比 `Qwen3-Embedding-0.6B`（MLX / Metal 备选）。引入 MRL + Binary Quantization（BQ）二段重打分，并将轻量语义索引落盘至独立非关键库 `<data>/semantic_index.db`（不碰 `sync_store.db::DB_VERSION`），将本地毫秒级语义检索扩展到邮件与事项，逐步统一 `mem0` 嵌入引擎。

---

## 1. Wave 状态与子任务看板

| Wave | 子任务目录 | 主题 | 状态 | 核心交付物与关键收益 |
|---|---|---|---|---|
| **Wave 1** | [`11-20-search-p0-perf-and-download`](../../.trellis/tasks/11-20-search-p0-perf-and-download/prd.md) | 搜索 P0 止血与模型下载体验升级 | 📋 规划中 | `LibraryService.search()` 脱离 `BEGIN IMMEDIATE` 排他锁 + Query LRU 缓存；资料库页 200ms 防抖与 IME 保护；三端（资料库 / ⌘K / `/search`）渐进式 FTS→Hybrid 两段搜索；1.7 GB 邮件库 2 字中文 CJK 2-gram FTS5 倒排索引（285–1679ms → `< 10ms`）；HF 镜像自动回退 + HTTP Range 断点续传 + 可取消 + 速度/ETA 显示 |
| **Wave 2** | [`11-20-chat-ux-thinking-timeline`](../../.trellis/tasks/11-20-chat-ux-thinking-timeline/prd.md) | 对话体验升级（三层动态状态、语义工具叙述与统一过程折叠） | 📋 规划中 | 解除 `chatRun.ts` 对 `reasoning-delta` 的 7ms/字无追赶节流 + 自适应追赶流；三层动态状态（`spinnerVerbs` + `toolNarration` + `reasoningSummary` + 预留 `data-turn-status`）；跨 part `TurnProcessGroup` 自动收起单工具/思考混合段（硬守审批/错误/产物不折叠）；工具可读预览视图；⌘K AI 搜索真实步骤状态 + 后台 run 阶段透传 |
| **Wave 3** | [`11-20-session-workspace-inspector`](../../.trellis/tasks/11-20-session-workspace-inspector/prd.md) | 右侧会话工作台浮窗（Session Workspace Inspector） | 📋 规划中 | `deriveSessionWorkspace()` 零新表实时派生 5 分区；`SessionInspectorPane` 支持概览聚合、快速过滤与 Artifact 原地分屏预览（Markdown/HTML/图片/草稿/Plan）；`/sessions`、`team`、邮件侧栏 `AiChatPanel`、浮窗 `AssistantChatModal` 全场地响应式接入与 `⌘.` 快捷键 |
| **Wave 4** | [`11-20-local-embedding-provider-and-email-rag`](../../.trellis/tasks/11-20-local-embedding-provider-and-email-rag/prd.md) | 统一本地索引 Provider 与邮件轻量语义检索 | 📋 规划中 | Step-0 Apple Silicon 真机 PoC 基准报告；`src/embedding/` 统一懒加载引擎（`builtin_onnx` 带 CoreML 安全探针 / `openai_compat` 直连 Ollama·LM Studio·MLX / 空闲自动卸载）；MRL + Binary Quantization 二段重打分；独立 `<data>/semantic_index.db` 承接邮件/事项单块轻量语义向量；统一 `mem0` 本地中文嵌入能力 |

---

## 2. 各 Wave 规格摘要与验收门禁

### Wave 1：搜索 P0 止血与模型下载体验升级
- **核心改动面**：
  - Python：`src/library/service.py`、`src/library/embed.py`、`src/api/routers/library.py`、`src/repository/email_repository.py`、`src/mail/sync_store.py`（或独立轻量 2-gram 辅助索引/后台回填，见 `design.md §1.3` 权衡与最终方案）。
  - Frontend：`frontend/src/shared/components/library/{LibraryWorkspace,LibrarySearchPanel,hooks}.tsx`、`useProgressiveLibrarySearch.ts`、`frontend/src/shared/components/command/CommandPalette.tsx`、`frontend/src/shared/components/search/SearchTabPage.tsx`、`frontend/src/shared/components/settings/LibrarySection.tsx`、`frontend/src/shared/api/library.ts`、`zh-CN`/`en-US` `common.json`。
- **关键验收门禁**：
  - `LibraryService.search()` 并发只读不持写锁、同 query 二次调用命中 LRU 缓存（0 次模型前向）。
  - `sync_store.db` 2 字中文查询（`合同`、`周报`、`立项`、`评审`）走 CJK 2-gram FTS5 `MATCH` 耗时 `< 15ms`（回填未完前优雅回落 `LIKE`），且不影响现有 `tests/repository/test_search_query_behavior.py` 全部夹具。
  - 模型下载支持 `hf-mirror` 自动切源、断点续传、取消按钮及速度/ETA 展示；全量单测与 `typecheck` / `lint` 全绿。

### Wave 2：对话体验升级（三层动态状态、语义工具叙述与统一过程折叠）
- **核心改动面**：
  - AI Gateway：`frontend/src/ai-gateway/{chatRun,adaptiveSmoothStream,activeRuns,server,searchAgentRun}.ts`。
  - Shared Assistant UI：`frontend/src/shared/assistant/runtime/{spinnerVerbs,reasoningSummary,useTurnStage}.ts`、`frontend/src/shared/assistant/tools/{toolNarration,generic/ToolGroupCard,generic/ToolTraceCard,generic/TurnProcessGroup}.tsx`、`frontend/src/shared/assistant/components/{TurnPresence,markdown-text,message}.tsx`、`frontend/src/shared/components/agents/AgentMessage.tsx`、`frontend/src/shared/components/command/PaletteThinkingPhrases.tsx`、`zh-CN`/`en-US` `common.json`。
- **关键验收门禁**：
  - 长段中文 `reasoning` 流不再拖慢首工具/正文首字输出；组头不再暴露裸英文下划线标识符与 `Object.values()[0]` 盲目预览。
  - `TurnProcessGroup` 自动折叠混合的思考与只读工具步（含单工具交替），且**审批卡 / 错误卡 / 写产物卡 100% 保持外露**（回归测试钉死）。
  - `agent_eval` 全量行为门禁与 `run_baseline --compare` 总分不低于 baseline；`typecheck` / `lint` / `test` 全绿。

### Wave 3：右侧会话工作台浮窗（Session Workspace Inspector）
- **核心改动面**：
  - Core & UI：`frontend/src/shared/assistant/inspector/{deriveSessionWorkspace,InspectorContext,SessionInspectorPane,InspectorArtifactPreview}.tsx`。
  - Host Integration：`frontend/src/shared/components/agents/AgentViewLayout.tsx`、`TeamChatHost.tsx`、`frontend/src/shared/assistant/AiChatPanel.tsx`、`frontend/src/shared/assistant/modal/AssistantChatModal.tsx`、`zh-CN`/`en-US` `common.json`。
- **关键验收门禁**：
  - `deriveSessionWorkspace()` 纯函数覆盖全部 5 分区去重、资源键归一、历史会话回放零副作用与安全围栏（不泄露绝对路径、不经 `innerHTML`）。
  - 宽屏与窄屏各断点无横向溢出与对话列坍缩，打开/关闭满足 Design v3 token、CJK 字号 ≥ 14px 与 `reduced-motion` 规范。

### Wave 4：统一本地索引 Provider 与邮件轻量语义检索
- **核心改动面**：
  - Embedding Runtime：`src/embedding/`（新包：Provider 协议、ONNX + CoreML 安全探针、Ollama/LM Studio 本地适配器、MRL + BQ 量化与两段重打分、空闲卸载定时器）。
  - Semantic Storage & Mail RAG：`src/semantic/`（新包：独立 `<data>/semantic_index.db` 独立版本梯）、`src/library/{embed,service,constants}.py`、`src/repository/email_repository.py`（渐进式本地语义融合）、`src/memory/mem0_engine.py`、`src/api/routers/library.py`（或统一 `/api/embedding/*`）、设置页 Provider 配置区。
- **关键验收门禁**：
  - Step-0 真机 PoC 报告落盘，验证默认端侧模型 CoreML/Metal 零崩溃且单 query p50 `< 40ms`。
  - `semantic_index.db` 与 `sync_store.db` 完全物理隔离，不触发 `DB_VERSION` 迁移门控；1 万封邮件单向量索引增量内存 `< 10 MB`、检索 `< 20ms`；旧库/无模型/Ollama 离线全场景降级纯 FTS 零异常。

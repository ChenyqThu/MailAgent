# MailAgent AI 工作台与网关体验升级（借鉴 `yetone/magpie`）

> **规划定稿日期**：2026-11-17 · **Trellis Epic**：`11-17-ai-workbench-magpie-epic`
> **规划真源**：本文档（`docs/plans/ai-workbench-upgrade/README.md`）与 `.trellis/tasks/11-17-ai-workbench-magpie-epic/prd.md`。

## 0. Owner 拍板决策

1. **推进顺序**：`Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 3b → Phase 4 → Phase 5` 分阶段实施并逐批验证。
2. **灵动岛去留**：在 **Phase 3** 原生 Menu Bar 微面板与 macOS 原生通知全闭环验收后，**Phase 3b 立即移除 Ping Island**（执行 `docs/plans/remove-ping-island/README.md` 清单）。
3. **运行形态与 Gateway 收口**：日常以 **桌面 App（`MailAgent.app`）** 为主，无头 PM2 裸跑场景几乎不存在；因此在 **Phase 4** 直接让 Python 后台任务（分类 / 报告 / 记忆）经本机 loopback 统一复用内嵌 Node AI SDK Gateway（解决 `google` 协议、`reasoning_content` / `thinking` 多轮透传与 `cache_tokens` 统计分裂）。

---

## 1. 阶段状态看板

| 阶段 | 主题 | 状态 | 核心交付物 |
|---|---|---|---|
| **Phase 0** | 多 Agent 开发对齐 + 安全/重启急修 | ✅ 已完成 | 升级 `AGENTS.md` + `site/AGENTS.md`；补齐 `.agents/skills/` 4 个缺失 Skill + 一致性测试闸；修 `streamError.ts` 与 Python Anthropic 腿报错密钥脱敏；修 `RestartBanner` / `services.ts` 漏重启 `serve-api` |
| **Phase 1** | AI Provider 工作台重构 + 图标全覆盖 + 目录增强 | ✅ 已完成 | 后端多 Key 池（429 冷却轮换）、单键 `headerPatch`、模型批量操作、未保存探活 `/probe`、拖拽重排；`models.dev` jsDelivr 镜像兜底 + 豆包本地覆盖 + 手动刷新入口；左列表右详情主从 Provider 工作台 + 向导弹窗 + 全站富 `ModelSelect`（含品牌 SVG 图标、能力徽标、上下文窗口与搜索） |
| **Phase 2** | 全局设置（Settings）信息架构重塑与导航减负 | ✅ 已完成 | 13 Tab 收敛为 8+1 组清晰导航（兼容旧 `?tab=` 重定向）；消除 Connectors 四栏双侧边栏挤压；合并 `Accounts+Sync`、`Notifications+Updates`、`Storage+Remote`、`Connectors+MCP`、`AiTab` 分段与全局设置搜索（`⌘F`） |
| **Phase 3** | macOS Menu Bar 常驻微面板 + 原生通知全闭环 | ✅ 已完成 | `electron.Tray` + v3 原生感 Popover 微面板（同步/DavMail 健康、`/today` 待拍板、运行中 Agent 与今日消耗、快捷唤起）；`NotifyCenter` 接入紧急邮件与日历会前提醒；可配置类目通知矩阵；修 `Cmd+W` 关窗点通知唤起窗口；权限诊断与测试通知按钮 |
| **Phase 3b** | 灵动岛（Ping Island）完整退役 | ✅ 已完成 | 按 `docs/plans/remove-ping-island/README.md` 批 1–3 移除 Python 岛模块/DailyDigest/`recommended_actions`、Electron/frontend 岛 UI 与 IPC、Gateway `announceApprovalToIsland`、`MAILAGENT_ISLAND_AGENT_ENABLED` 与跨端配置白名单（保留 historic `island_dispatch` DDL 与 `deeplink`） |
| **Phase 4** | Gateway 协议收口 + 全链路 Usage 与缓存命中监控 | ✅ 已完成 | Python 后台任务接入内嵌 `ai-gateway` loopback 内部端点；流式 `<tool_call>` 脏文本修复 middleware；TS `RetryError` 429 解包修复；`chatRun` 补全 `cacheReadTokens/cacheWriteTokens`；`modelCost.ts` 四档真实计价；补全所有暗消耗与 `report`/`matter_run` 成本落库；Usage & Token 加权 Cache Hit Rate 监控面板 + `probelog` |
| **Phase 5** | 出站隐私占位符脱敏 + MCP 双向细粒度控制 | ✅ 已完成 | 本地双向占位符脱敏（API Key / 证件 / 手机 / 邮箱 + 自定义正则）及 `503` Fail-Closed 硬闸；MCP Client 写/破坏性工具默认收紧为 `ask`、per-agent 工具白名单、自定义 HTTP & 按需懒启停 `stdio` 连接器；MCP Server 拆解只读 scope、per-key 工具开关/TTL/限流，及 Claude Desktop/Code/Cursor/Antigravity 外科手术式一键写配置 |

---

## 2. 各阶段设计规格与验收门禁

### Phase 0：多 Agent 开发底座对齐 + 急修
- **改动面**：`AGENTS.md`、`site/AGENTS.md`、`.agents/skills/{agent-eval,db-migration,release,sprint-handoff}/SKILL.md`、`tests/config/test_agent_skills_parity.py`、`frontend/src/ai-gateway/streamError.ts`、`src/llm_agent/client.py`、`frontend/src/electron/main/handlers/services.ts`、`frontend/src/shared/components/settings/RestartBanner.tsx`。
- **验收门禁**：`pytest tests/config` 含 `test_agent_skills_parity.py` 全绿；`stream_error.test.ts` 与 Python Anthropic 报错脱敏测试全绿；`RestartBanner` 能一并触发 `serve-api` 重启。

### Phase 1：AI Provider 工作台 + 图标全覆盖 + 目录更新增强
- **后端（`src/agent_config/llm_providers.py` + `src/api/routers/llm_providers.py` + `provider_routing.py`）**：
  - `llm_provider` 幂等补列：`extra_api_keys_cipher BLOB`、`custom_icon TEXT`。
  - 路由：新增 `POST /api/llm/providers/probe`（免落库直测 + 按模型测试）、`PUT /api/llm/providers/reorder`、`POST /api/llm/providers/{id}/models/batch`；`PATCH /{id}` 支持 `headerPatch` 增量改删与 `extraApiKeys`；列表投影回传 `enabledModelCount`/`totalModelCount`/`keyCount`/`extraKeyLast4s`/`customIcon`。
  - 多 Key 429 冷却轮换：`keyPool.ts`（Gateway）+ `provider_routing.py`（Python）在 429 + `Retry-After` 时自动切换池内备用 Key，健康时维持主 Key 粘滞以保 Prompt Cache。
- **目录与图标（`frontend/src/shared/modelCatalog/` + `frontend/src/shared/components/icons/providers/`）**：
  - 补齐 Ollama、LM Studio/vLLM、OpenCode、Azure、Bedrock、GitHub、NVIDIA 图标，支持 `customIcon` 覆盖与 emoji/缩写徽章。
  - `lookup.ts` 补齐 `LOCAL_CATALOG_OVERRIDES['doubao']` 与 `:free`/`:thinking`/`-latest` ID 归一化。
  - `remote.ts` 增加 jsDelivr CDN 镜像回退（同步更新 Electron & Web CSP `connect-src`）与 `forceRefresh()` 手动更新接口，`useModelCatalogStatus()` 暴露版本日期与刷新状态。
- **前端 UI（`frontend/src/shared/components/settings/providers/` + `frontend/src/shared/components/providers/` + `ModelSelectItems.tsx` + `AiTab.tsx`）**：
  - `ModelSelect` + `ModelSelectItems` 统一升级：Settings、Onboarding、`/agents`、`/groups`、`/matters` 全部展示彩色品牌图标 + 人类 `displayName` + 能力徽标 + 上下文长度 + 搜索。
  - `ModelServicesSection` 改造为左列表（拖拽排序 + 图标 + Key 状态 + `已启用/总数` + `--sel-wash` 选中条）右详情（显式保存、多 Key 池、单 Header 增删改、模型搜索/筛选/分组/批量操作/清晰双列头）主从工作台；新增 `AddProviderDialog` 向导弹窗（先测再存 + 自动拉取）。
  - 遵循 `frontend/DESIGN.md` v3：中文文本 ≥ `text-aux`（14px），`zh-CN`/`en-US` 双语同源，零硬编码 hex。

### Phase 2：全局设置（Settings）信息架构重塑
- 收敛 13 个 Tab 为分组清晰的 8 个 Tab（保留旧 `?tab=` 路由参数向后兼容重定向）：`模型与用量` / `Agent 与记忆` / `工具与 MCP` / `邮箱与同步` / `通知与常驻` / `通用与外观` / `存储与远程` / `实验室`。
- 修复 `ConnectorsConsolePage` 四栏挤压问题：进入左右主从子页时紧凑化/折叠一级设置导轨或采用页内分段。
- 新增 Settings 全局搜索（`⌘F`）直达设置项。

### Phase 3 & 3b：Menu Bar 常驻微面板 + macOS 通知闭环 + 移除灵动岛
- 新建 `frontend/src/electron/main/tray.ts`（`Tray` + 自适应 Template 图标 + Popover 面板 + Dock 未读角标）。
- `new_watcher.py`（紧急/重要新邮件）与 `calendar_sync/reminder.py`（会前提醒）正式接入 `NotifyCenter`。
- 升级 `notification_fanout.ts`：类目级通知偏好控制（横幅 / 仅铃铛 / 关）、`Cmd+W` 关窗状态下点击通知自动恢复/重建窗口并深跳；`NotificationsTab` 增加权限状态与测试通知。
- Phase 3 验收通过后，按 `docs/plans/remove-ping-island/README.md` 批 0–4 执行灵动岛彻底退役。

### Phase 4：Gateway 协议收口 + Usage 与 Prompt Cache 命中率监控
- 内嵌 `ai-gateway` 暴露本机 `verify_local_token` 内部代理供 Python 后台（分类/报告/记忆）调用；补齐流式 `<tool_call>` 脏文本修复与 `RetryError` 429 解包。
- `chatRun.ts` 完整落库 `cacheReadTokens`/`cacheWriteTokens`；`modelCost.ts` 改为四档阶梯定价；补齐 `report`、`matter_run`、自动标题、压缩、搜索、翻译的用量与成本记录。
- 上线「模型与用量」看板（24h/7d/30d 消耗分布、Token 加权 Cache Hit Rate 曲线、最近 50 条 `probelog` 探测与异常诊断）。

### Phase 5：出站隐私占位符脱敏 + MCP 双向细粒度控制
- 本地双向占位符脱敏中间件（per-provider 开关 + 内置高准规则 + 自定义正则 + `503` Fail-Closed + 本地命中计数审计）。
- MCP Client 默认 `write`/`destructive` 工具收紧为 `ask`；per-agent 工具白名单；会话级临时连接器开关；支持自定义 HTTP 与按需懒启停 `stdio` MCP。
- MCP Server 拆解 `readonly` 8-scope 捆绑，支持细粒度工具开关、Key TTL、写工具限流；借鉴 `internal/edit` 提供 Claude Desktop / Claude Code / Cursor / Antigravity 外科手术式一键配置写入。

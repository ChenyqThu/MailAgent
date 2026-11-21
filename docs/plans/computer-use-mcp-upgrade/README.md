# Computer Use 接入与双向 MCP 演进规划

> **规划定稿日期**：2026-11-19 · **Trellis Epic**：`11-19-computer-use-mcp-epic`
> **规划真源**：本文档（`docs/plans/computer-use-mcp-upgrade/README.md`）与 `.trellis/tasks/11-19-computer-use-mcp-epic/prd.md`。

## 0. Owner 拍板决策

1. **双场景覆盖**：同时支持**原生桌面操控**（Microsoft Teams、Notion 桌面端等）与**网页自动化**（企业内网 OA / ERP 表单），不引入 VM / Docker 桌面沙盒（`cua` / `bytebot`），并严格遵循「既有 MailAgent 原生确定性工具或直连 Notion MCP 可完成的事，绝不降级走 GUI 自动化」。
2. **分发形态**：在 `/connectors` 配置台新增 `managed_local` 第三轨，提供「一键安装并启用」——按需下载并校验受管本地运行时到 `<userData>/mcp-runtimes/`，全程零 `sudo`、零全局环境污染，卸载即干净清理。
3. **浏览器登录态**：`browser_use`（`@playwright/mcp`）支持直接接管日常在用的已登录 Chrome，提供三档可切模式：原生 `--cdp-endpoint=chrome`（配合 `chrome://inspect/#remote-debugging`）、`--extension` 桥接扩展、以及独立受管 Profile。
4. **双层懒加载硬约束**：
   - **LLM Schema 层**：基于 AI SDK v7（`ai@^7`）`prepareStep` + `activeTools` + `tool_search`，仅向模型暴露核心工具，长尾内建工具与 `mcp__*` connector 工具Schema 按需**当轮动态激活**，同时保持 `stable_prompt.ts` 前缀可缓存性。
   - **运行时进程/连接层**：基于 `StdioSessionPool`（含可配置空闲 TTL 回收）与按需 HTTP/SSE 会话懒启停，目录展示与 `tool_search` 仅查询 SQLite，**启动期零子进程、零远端常驻连接**。
5. **MCP 双向传输补齐**：
   - **MailAgent 作为 MCP Server**：`/mcp` 升级为完整有状态 / 无状态兼容 Streamable HTTP（`Mcp-Session-Id`、GET SSE 流/心跳、DELETE 显式会话终止），并补齐 `/mcp/sse` + `/mcp/messages` 传统 HTTP+SSE 传输；`session_id` 强绑定创建时的 `Principal`，防跨 Key 会话劫持。
   - **MailAgent 作为 MCP Client**：`src/connectors/` 补齐 `sse` 传输与 `streamable_http` / `stdio` 全覆盖，并打通 MCP `ImageContent` → AI SDK v7 `toModelOutput` 多模态图像输出管道。

---

## 1. 阶段状态看板

| 阶段 | 主题 | 状态 | 核心交付物 |
|---|---|---|---|
| **Phase 1** | 双向 MCP 传输升级 | ✅ 已完成 | Server 端完整有状态/无状态 Streamable HTTP（`/mcp` POST/GET/DELETE）+ 传统 HTTP+SSE（`/mcp/sse` & `/mcp/messages`）+ `session_id ↔ Principal` 绑定（`src/mcp/http_sessions.py`）；Client 端新增 `sse` 传输 + 多模态 `ImageContent` → AI SDK v7 `toModelOutput` 管道 |
| **Phase 2** | MCP 与工具双层懒加载引擎 | ✅ 已完成 | AI SDK v7 `tool_search`（`frontend/src/ai-gateway/tools/tool_search.ts`）+ `prepareStep` `activeTools` 同轮动态挂载（尊重场地/审批门禁）；`stable_prompt.ts` L0 摘要稳态；SQLite 零进程目录检索与 `StdioSessionPool`（`src/connectors/stdio_pool.py`）空闲 TTL 回收配置 |
| **Phase 3** | `/connectors` 一键安装受管本地连接器 | ✅ 已完成 | `managed_local` 第三轨契约（跨 Python/TS parity 闸）；`browser_use`（`@playwright/mcp`）日常 Chrome 三模式接管；`desktop_use`（`vercel-labs/agent-desktop` `v1.3.1`）Mac/Win 二进制 SHA-256 校验、macOS ad-hoc 签名与 Electron/Python 双探针 TCC 权限面板（`src/connectors/local_installer.py`、`ManagedLocalSections.tsx`） |
| **Phase 4** | Computer Use 专职子 Agent 编排与安全围栏 | ✅ 已完成 | 主会话单入口 `computer_use_run`（`class: 'exec'`，`frontend/src/ai-gateway/tools/computer_use.ts`）；父子 Session 隔离；子循环滑动窗口裁剪历史截图（`<= 2` 步）；App/域名 Scope Guard；`stop_before_submit` 终态停靠；`ComputerUseApprovalCard.tsx` 与像素隐私诚实告知 |
| **Phase 5** | 业务场景深水区接线 | ✅ 已完成 | Teams / Notion 桌面端与原生工具/直连 MCP 优先级路由纪律（`stable_prompt.ts` Tier 1>2>3）；内网 OA/ERP 表单与 L4 `Matters` 行动项 `matter_item_run`（显式 `propose_only` + Gateway Belt 1/2 + Python DB 核验 Belt 3）→ `/today` 例外面闭环；`AGT-CU-001..004` 回归与 Mock/Replay E2E 套件 |
| **Wave 6** | 内置受管浏览器 + 授权简化 + Custom Agent 自动化 | ✅ 已完成 | `browser_use` 默认升级为 `isolated_profile`（Headless 后台静默 + 一键从已有 Chrome Keychain 解密导入 Cookie + 打开专属浏览器窗口）；新增 native TCC「请求系统授权」唤起、审批卡 `"computer_use"` 域/应用记忆白名单与 `/connectors` `auto` 选项；Custom Agent 解锁有界 `grant_computer_use`（`email_filter` / `calendar_before_start` 等触发自动操作内网审批或入会流） |

---

## 2. 各阶段设计规格与验收门禁

### Phase 1：双向 MCP 传输升级
- **改动模块**：
  - **MCP Server（Python）**：`src/api/routers/skills.py`（升级 `/mcp` `POST` / `GET` / `DELETE` 并新增 `/mcp/sse` 与 `/mcp/messages`）、`src/mcp/mailagent_mcp.py`、`src/mcp/http_sessions.py`（新建：`McpSessionManager` 进程内 MCP 会话表与 TTL/SSE 订阅队列）、`src/api/routers/mcp_service.py`、`src/mcp/client_config_writer.py`。
  - **MCP Client & 契约（Python + TS）**：`src/agent_config/store.py`（`CONNECTOR_TRANSPORTS` 新增 `"sse"`）、`src/connectors/client.py`（接入 `mcp.client.sse.sse_client` 并提取 `ImageContent`）、`src/connectors/service.py`、`src/api/routers/connector.py`、`frontend/src/shared/api/types/connector.ts`、`frontend/src/ai-gateway/python/domainClient.ts`、`frontend/src/ai-gateway/tools/connector.ts`、`frontend/src/ai-gateway/tools/types.ts`、`tests/config/test_connector_contract_parity.py`。
- **核心契约**：
  - **双向兼容与会话隔离**：`/mcp` 响应 `initialize` 时下发 `Mcp-Session-Id`（同时也兼容无 header 的无状态调用）；`GET /mcp` 与 `DELETE /mcp` 及 `/mcp/messages` 必须校验 `session_id` 所属 `Principal`（owner 身份或同 `key_id`），跨 Key / 未知会话一律返回 403/404 且不泄露存在性。
  - **多模态输出隔离**：`ConnectorClient` 将 MCP `CallToolResult` 中的文本与 `ImageContent`（`data` + `mimeType`）结构化分离；文本保持 `CALL_RESULT_MAX_CHARS = 50_000` 截断与 `UNTRUSTED_MCP_TOOL` 围栏，图像块由 AI SDK v7 `Tool.toModelOutput` 转为模型可读 image part，**不把巨型 base64 串拼进文本历史或未裁剪的 SQLite 工具记录**。
  - **Config Writer 升级**：`src/api/routers/mcp_service.py` 与 `src/mcp/client_config_writer.py` 同步暴露 `/mcp` 与 `/mcp/sse` 端点及一键写入格式。
- **验收门禁**：
  - `pytest` 覆盖 `/mcp` 有状态 POST/GET(SSE)/DELETE、无状态 POST、`/mcp/sse` + `/mcp/messages` 握手与调用、跨 Bearer Key `session_id` 劫持拒绝、以及 `sse` MCP Client 连接与 `ImageContent` 解析。
  - `./venv/bin/python -m pytest tests/config/test_connector_contract_parity.py -q`（验证 `CONNECTOR_TRANSPORTS` 跨端一致）与 `tests/skills` 全绿。
  - `pnpm --dir frontend typecheck && pnpm --dir frontend lint && pnpm --dir frontend test`（含 Gateway `toModelOutput` 多模态单元测试）全绿。

### Phase 2：MCP 与工具双层懒加载引擎
- **改动模块**：
  - **AI Gateway（TS）**：`frontend/src/ai-gateway/tools/tool_search.ts`（新建 `tool_search` 元工具）、`frontend/src/ai-gateway/tools/index.ts`、`frontend/src/ai-gateway/tools/connector.ts`、`frontend/src/ai-gateway/tools/policy.ts`、`frontend/src/ai-gateway/chatRun.ts`、`frontend/src/ai-gateway/agentRun.ts`、`frontend/src/ai-gateway/prompts/stable_prompt.ts`。
  - **Python 运行时 & 目录（Python + Electron）**：`src/agent_config/store.py`（SQLite 纯库检索 `connector_tool` / 目录投影）、`src/connectors/stdio_pool.py`（可配置 `STDIO_IDLE_TTL_SECONDS` 与空闲回收观测）、`src/connectors/service.py`、`src/api/routers/connector.py`、`frontend/src/electron/main/ai_gateway_lifecycle.ts`、`src/agent_config/tool_prefs.py`、`tests/agent_eval/tool_catalog.json`。
- **核心契约**：
  - **LLM Schema 层（Plane 1）**：首步 `prepareStep` 通过 `activeTools` 仅下发核心固定工具 + `tool_search`；当模型调用 `tool_search` 命中某个已授权且未禁用的内建长尾工具或 `mcp__<connector>__<slug>` 工具时，激活集记录该工具名并在**同一回合下一步 `prepareStep`** 动态注入 `activeTools`，无需跨轮重问。
  - **门禁不退让**：`tool_search` **只可检索并激活**已通过 `applyContextModePolicy`、`stripOwnerDeniedTools`、`admitDynamicTools` 及 `per-tool mode !== 'off'` 过滤的工具集合；被场地禁止、owner 设为 `deny`/`off`、或超出 `grant_connectors` 天花板的工具对 `tool_search` 不可见且不可激活。
  - **Prompt Cache 稳定**：`stable_prompt.ts` 仅保留 L0 connector/skill 摘要（不随 `activeTools` 变化改写系统提示词前缀），保证 Anthropic/OpenAI Prompt Cache 命中率不回退。
  - **运行时连接层（Plane 2）**：Electron 启动期与 `ai_gateway_lifecycle.ts` 预热只拉取 SQLite 缓存的已同步清单，**绝不提前 spawn `stdio` 子进程或建远端 SSE/HTTP 长连接**；`StdioSessionPool` 按首次 `list_tools` / `call_tool` 懒启动，超时自动回收。
- **验收门禁**：
  - AI Gateway 单测验证：首步 `activeTools` 仅含核心工具集 + `tool_search`；同轮调用 `tool_search` 后下一步即可调用目标 `mcp__*` 工具；`deny` / `off` / 越权工具无法通过 `tool_search` 激活。
  - Python 单测验证：`StdioSessionPool` 启动期 worker 数为 0，首次调用起进程，超过 idle TTL 自动清理；目录查询零子进程拉起。
  - `./venv/bin/python -m pytest tests/config tests/agent_eval -q` 与 `cd tests/agent_eval && ../../venv/bin/python -m runner.run_baseline --compare` 总分不低于 baseline。

### Phase 3：`/connectors` 一键安装受管本地连接器
- **改动模块**：
  - **目录与三轨契约**：`src/connectors/catalog.py`（`CONNECTOR_TRACKS` 扩为 `("direct", "composio", "managed_local")` 与 `TRACK_TO_SOURCE` 映射）、`src/agent_config/store.py`（`CONNECTOR_SOURCES` 同步扩展）、`src/connectors/registry.py`、`frontend/src/shared/api/types/connector.ts`、`tests/config/test_connector_contract_parity.py`。
  - **受管运行时安装器与内置定义**：`src/connectors/local_installer.py`（新建：版本固定、SHA-256 校验、`.tmp-<id>-<uuid>/` 原子暂存切换进 `<userData>/mcp-runtimes/<id>/`、macOS `xattr -d com.apple.quarantine` + `/usr/bin/codesign --sign - --force`、零 `sudo`）、`src/connectors/catalog.py`（新增 `MANAGED_LOCAL_CATALOG` 定义 `browser_use` / `desktop_use` 受管连接器）、`src/api/routers/connector.py`（`verify_local_token` 门控安装/卸载/状态/Chrome 模式切换/TCC 诊断端点）。
  - **Electron & `/connectors` 配置台**：`frontend/src/electron/main/handlers/system_permissions.ts`（macOS Accessibility / Screen Recording TCC 权限自检与系统设置深跳，配合 Python fallback）、`frontend/src/shared/components/connectors/ManagedLocalSections.tsx`、`frontend/src/shared/components/connectors/ConnectorsConsolePage.tsx`、`frontend/src/shared/components/connectors/ConnectorDetailPane.tsx`、`frontend/src/shared/api/connector_api.ts`、`frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json`。
- **核心契约**：
  - **零全局污染目录**：所有受管二进制与 npm 运行时严格落盘于 `<userData>/mcp-runtimes/`（单测内部隔离覆写），绝不写入 `/usr/local`、全局 `npm` 或调用 `sudo`；`/connectors` 与 `MAILAGENT_MCP_CONNECTORS` 随 2026-11-20 cutover 默认直接启用（不进设置「实验室」，无需额外 `.env` 配置）。
  - **`browser_use`（`@playwright/mcp`）日常 Chrome 三模式**：支持在配置台一键切换 `cdp_chrome`（`--cdp-endpoint=chrome` 并展示 `chrome://inspect/#remote-debugging` 开启引导）、`extension`（`--extension` Playwright MCP Bridge）与 `isolated_profile`（独立受管 Chromium Profile），切档后仅重启对应 `StdioSessionPool` worker。
  - **`desktop_use`（`vercel-labs/agent-desktop`）Mac/Win 分发与 TCC 自检**：下载固定版本 release 并强制校验 SHA-256（失败即删除残片、不落配置）；macOS 自动移除隔离属性并做 ad-hoc 签名；启用前检测 Accessibility 与 Screen Recording 权限，缺失时在 `/connectors` 详情页给出清晰授权引导而非静默卡死。
- **验收门禁**：
  - `./venv/bin/python -m pytest tests/config/test_connector_contract_parity.py -q`（确认 `managed_local` 在 `CONNECTOR_TRACKS` / `TRACK_TO_SOURCE` / `CONNECTOR_SOURCES` / TS 类型联合间双射闭合）。
  - Python 单测覆盖下载校验失败 fail-closed、`<userData>/mcp-runtimes/` 隔离路径、`browser_use` 三模式启动参数生成与 `desktop_use` 权限探针返回。
  - `pnpm --dir frontend typecheck && pnpm --dir frontend lint && pnpm --dir frontend test`（校验中英双语 i18n 对齐与 `mailagent/no-cjk-in-mono-size` / Design v3 token 规范）。

### Phase 4：Computer Use 专职子 Agent 编排与安全围栏
- **改动模块**：
  - **Gateway 子 Agent 与策略**：`frontend/src/ai-gateway/tools/computer_use.ts`（新建 `computer_use_run` 工具与专职子循环）、`frontend/src/ai-gateway/tools/index.ts`、`frontend/src/ai-gateway/tools/schemas.ts`、`frontend/src/ai-gateway/tools/policy.ts`（`GATEWAY_TOOL_CLASSES['computer_use_run'] = 'exec'`）、`frontend/src/ai-gateway/agentRun.ts`、`frontend/src/ai-gateway/chatRun.ts`。
  - **审批注册表与隐私/作用域护栏**：`src/agent_config/tool_prefs.py`（注册 `computer_use_run` 进 `"exec"` 组，出厂默认 `"ask"`）、`tests/agent_eval/tool_catalog.json`、`tests/config/test_tool_prefs_catalog_parity.py`、`src/connectors/service.py` / `frontend/src/ai-gateway/tools/computer_use.ts`（App/域名 Scope Guard）。
- **核心契约**：
  - **主会话单入口与父子 Session 隔离**：主会话仅暴露 `computer_use_run(goal, target_hint?, allowed_apps?, allowed_domains?, stop_before_submit?, max_steps?)`，不把高频 `desktop_*` / `browser_*` 原子操作塞进主对话上下文；子 Agent 在独立子 Session 内执行感知-决策-操作循环，结束后仅向主会话回传结构化结果与终态证据。
  - **滑动窗口裁剪历史截图**：子 Agent 的 `prepareStep` 仅保留最近 1–2 步截图作为视觉输入，早先步骤的截图自动折叠为文字动作摘要，防止多轮高分辨率截图撑爆上下文与 Token 预算。
  - **Scope Guard 与 `stop_before_submit`**：每次点击/输入/导航校验当前前台 App（`desktop_use`）或 URL 域名（`browser_use`）是否在 `allowed_apps` / `allowed_domains` 内，越界即阻断；遇到提交、发送、审批通过、支付等不可逆动作或 `stop_before_submit=true` 到达终态时，强制停靠并返回预览，交由主会话/owner 确认。
  - **AX/DOM 优先 + 窗口级截图 + 像素隐私诚实告知**：优先读取 Accessibility Tree / DOM Accessibility Snapshot；仅在视觉定位必要时退回**窗口级**（window-scoped / bounding-box）截图；文档与 UI 明确告知：`privacyMaskMiddleware` 仅对出站文本做占位符脱敏，**无法对图像原始像素进行遮罩**。
- **验收门禁**：
  - `policy.test.ts` 验证 `computer_use_run` 在 `im_chat`、`untrusted_trigger`、`cron_headless`（无明确授权通道）、`contact_governance` 下结构性不可注册与不可执行；在 `manual_chat` 下严格命中审批阶梯。
  - 子 Agent 单测覆盖：滑动窗口截图裁剪（历史步图像被剥离）、App/域名越界拦截、`stop_before_submit` 在最终提交前强制停靠并带回结构化摘要。
  - `./venv/bin/python -m pytest tests/config/test_tool_prefs_catalog_parity.py tests/agent_eval -q` 与 `pnpm --dir frontend typecheck && pnpm --dir frontend lint && pnpm --dir frontend test` 全绿。

### Phase 5：业务场景深水区接线
- **改动模块**：
  - **路由纪律与 Prompt / Eval**：`frontend/src/ai-gateway/prompts/stable_prompt.ts`（`TOOL_ROUTING_DISCIPLINE` Tier 1 > Tier 2 > Tier 3 优先级纪律，按 `computerUseAvailable` 门控以保 Prompt Cache 稳态）、`frontend/src/ai-gateway/prompts/systemPrompt.ts`、`frontend/src/ai-gateway/chatRun.ts`。
  - **Matters 行动项、`matter_item_run` 三道安全带与 `/today` 闭环**：`src/matters/models.py`（`normalize_computer_use_draft`）、`src/matters/service.py`（`dispatch_item` / `answer_dispatch`）、`src/api/routers/matters.py`、`src/matters/run_spec.py`（`computerUsePolicy` 投影与 fail-closed）、`frontend/src/shared/api/types/{chat,matter}.ts`、`frontend/src/ai-gateway/agentRun.ts`（Belt 1 `itemReadFace`）、`frontend/src/ai-gateway/tools/{policy,types,computer_use,connector}.ts`（Belt 2 `isToolAllowedInContext` + `createComputerUseChildConnectorTools`）、`src/connectors/service.py` & `src/api/routers/connector.py`（Belt 3 `is_matter_computer_use_child_authorized` DB 联表核验）。
  - **E2E 与回归**：`tests/agent_eval/tasks/AGT-CU-001.json`..`004.json`、`tests/agent_eval/baselines/computer_use.jsonl`、`tests/agent_eval/runner/tests/test_computer_use_coverage.py`、`frontend/tests/ai-gateway/{computer_use_e2e,matter_item_computer_use}.test.ts`、`tests/matters/test_matter_item_computer_use.py`、`tests/connectors/test_matter_computer_use_gate.py`。
- **核心契约**：
  - **确定性工具优先纪律**：涉及邮件读写/搜索/发送、日历、通讯录、资料库、Matters 的操作恒走 MailAgent 原生工具；Notion 数据库/页面结构化读写恒走直连 Notion MCP；仅当原生工具与直连 MCP 均无法覆盖（如 Microsoft Teams 消息/频道桌面交互、Notion 桌面端特有界面操作、企业内网 OA/ERP 网页表单）时才路由到 `computer_use_run`。
  - **L4 `Matters` 行动项 → `/today` 例外面闭环**：仅当 owner **显式发起** `matter_item_run` 的既有 `propose_only` 执行档（`src/matters/models.py::MatterItemExecProfile.PROPOSE_ONLY`，非 `autonomous`，不新增 `"draft"` 枚举；配合 `stop_before_submit=true`）且经服务端构造的 `AgentRunSpec` 明确授权时，才允许调用 `computer_use_run` 完成「打开内网 OA/ERP 表单 → 填好草稿 → 终态停靠截图/字段核对」；最终提交前必须产出 `matter_item_report` 与 `action_required` 待拍板项进入 `/today` 例外面及 `NotifyCenter`，由 owner 亲自审核收口；`im_chat`、`untrusted_trigger`、`contact_governance` 保持结构性封禁不变。
- **验收门禁**：
  - 集成测试验证 `matter_item_run` 显式 `propose_only` 授权路径跑通「表单填报停靠 → `/today` 例外面呈现 → owner 审核确认」闭环，且 `autonomous`、未显式授权或非 owner 触发路径被服务端与 `policy.ts` 双层拒绝。
  - Mock/Replay E2E 跑通 Microsoft Teams / Notion 桌面端 / 内网 OA 表单三类典型剧本，且 `agent_eval` 确认「已有原生工具/Notion MCP 时不误调 `computer_use_run`」。
  - 全量闸门：`./venv/bin/python -m pytest tests/config tests/skills tests/connectors tests/agent_eval -q`、`cd tests/agent_eval && ../../venv/bin/python -m runner.run_baseline --compare`、`pnpm --dir frontend typecheck && pnpm --dir frontend lint && pnpm --dir frontend test`。

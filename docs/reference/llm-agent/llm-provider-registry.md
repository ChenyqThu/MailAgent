# LLM Provider Registry（上游多 Provider 体系）

> 何时读：动 provider 配置（`llm_provider`/`llm_model` 表、`/api/llm/providers*`）· gateway 模型层
> （`providers.ts`/`providerRef.ts`/`chatRun.resolveModelFactory`）· Python 协议路由
> （`provider_routing.py`/`client.py` 双腿）· 各功能位模型选择链 · `MAILAGENT_LLM_PROVIDER_REGISTRY` 前。
>
> 状态：批 1（P0-P2 后端能力）+ 批 2（P3 Settings UI / P3b Onboarding+Notion 可选化 / P4 收编）已全部
> 合 main（2026-07-13，commit `1e4b8be8`→`341f7091`），**flag 默认 off 灰度中**，待 dogfood 后 cutover。
> 方案 SSoT = `.trellis/tasks/07-12-llm-provider-registry-ai-sdk/prd.md`（含 research/01-04）。
> 本文是**运行语义**常青参考，以代码实态为准。

## 1. 一句话

上游 LLM 从「单一 CRS anthropic 网关 + 模型名前缀隐式判协议」升级为**多 provider 并存**：配置权威
落 `agent_config.db` 双表（Fernet 加密 key），Node gateway 经 AI SDK `createProviderRegistry` 按
protocol 分发 create 函数，Python 消费者（分类/报告/mem0/岛 digest 等）经 `provider_routing` 按
同一份数据做 protocol 路由——**双端共享「配置数据」不共享代码**（AI SDK 是 TS-only）。模型引用
全链路统一 `providerId:modelId`（providerRef）。

```
Settings「模型服务」区 / onboarding AI 步（可跳过）
  └─ /api/llm/providers* REST（写面仅本地 token）
      └─ agent_config.db: llm_provider + llm_model + llm_provider_meta(version)
          ├─ GET /api/llm/providers/snapshot（解密 key，仅本地 token）
          │    └─ Node gateway providers.ts → createProviderRegistry（30s TTL / version 缓存）
          │         ├─ chat / headless agent / title / followups / agentic ⌘K 搜索
          │         └─ Electron main llm_provider_resolver → translate / nl_search（P4 收编）
          └─ Python provider_routing（30s TTL 快照热读，不进 pydantic）
               └─ client.py 双协议腿（classify + run_tool_loop）/ mem0_engine / 岛 digest…
```

## 2. 配置存储（`agent_config.db`，backend-owned，不进 DB_VERSION）

模块：`src/agent_config/llm_providers.py`（`LlmProviderStore`，幂等 DDL、per-call 短连接、
`get_llm_provider_store()` lru 单例——镜像 `store.py`/api_keys 纪律）。三张表：

| 表 | 关键列 | 语义 |
|---|---|---|
| `llm_provider` | `id`(PK, slug `^[a-z][a-z0-9_-]{0,40}$`，禁 `:`) · `protocol` · `display_name` · `base_url`(**原样存**用户输入) · `api_key_cipher`(Fernet BLOB，NULL=无 key) · `headers_json` · `enabled` · `sort_order` | 一行 = 一个上游（官方家/中转）。`protocol` ∈ `anthropic / openai / openai-compatible / google / deepseek / openrouter`，决定消费端用哪条协议腿/哪个 create 函数 |
| `llm_model` | `(provider_id, model_id)` 复合 PK · `display_name` / `group_name` · `enabled` · `capabilities_json`(NULL=未标注，不臆造) · `max_output`(NULL=不 clamp) · `source`(`fetched`/`manual`) · `fetched_at` | `enabled` 驱动各功能位选择器可选集（**不**拦截直填的 ref）；`max_output` = per-model clamp 依据 |
| `llm_provider_meta` | `snapshot_version` 单行计数 | 任何 provider/model CRUD 写后同事务 +1；gateway 按 version 缓存 registry 实例 |

- `default` 行**禁删**（legacy 无冒号 ref 解析到它，删了 = 老配置引用悬空）。
- 模型发现 merge 语义（`merge_fetched_models`）：新 id → INSERT `source='fetched', enabled=0`；
  已有行（含 manual）→ 只刷 `fetched_at`，**不覆盖** source/enabled/元数据。

## 3. providerRef 与 legacy 兼容

**解析规则（双端单源锚点）**：按**第一个** `:` 切分 → `(providerId, modelId)`；无 `:` →
`('default', 整串)`。modelId 内含 `:` 合法（OpenRouter `openai/gpt-4o` 等含 `/` 的 id 也因此
不进 REST path 段，model 写面走 body）。实现：Python `parse_provider_ref`
（`src/agent_config/llm_providers.py`）+ TS `parseProviderRef`（`frontend/src/ai-gateway/providerRef.ts`）。

**legacy 零迁移**：`report_agent.model` 行、chat localStorage `CUSTOM_MODEL_PREF`、`.env` 老值
（`LLM_MODEL`/`LLM_FALLBACK_MODELS`/`MEMORY_CAPTURE_MODEL`…）都是无冒号裸 id → 天然解析为
`default:<id>`，行为归 default provider（= seed 出来的老网关），零强制迁移。

## 4. Seed 降级语义（env → 行权威）

`ensure_seeded_store()`（`src/api/routers/llm_providers.py`，读端点惰性触发 + chat.py /config
flag-on 投影同一入口）：`llm_provider` 表**空**时把现有 env 配置落成
`id='default', protocol='anthropic'` 行（base=`LLM_API_BASE`、key=`LLM_API_KEY` Fernet 加密、
models=`LLM_ENABLED_MODELS`∪`LLM_MODEL`，enabled=1/source='manual'）。

- **幂等**：表里已有任何行 → 直接跳过零副作用；并发首 seed 用 `INSERT OR IGNORE` 兜底最多落一次。
- **行落地后行权威**：这些 env 键从此仅作「首次 seed 默认」，UI 改的是表行——镜像项目周报
  trigger 配置的既有模式。version 自 seed 起 = 1，纯读不 bump。
- seed 失败（裸 worktree 缺 .env 等）不阻断读端点，空表照常返回。

## 5. REST 面与 snapshot 契约

路由 `src/api/routers/llm_providers.py`（prefix `/api/llm/providers`），鉴权分层 = 「远程只读」
落到 API 层：

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET ''` / `GET /{id}/models` | `verify_cf_access`（本地 token / CF JWT 双腿，远程可看） | 列表对 key 只回掩码（`hasKey` + `keyLast4`），**永不回明文**；`?refresh=true` 按 protocol 拉上游 `/models` merge 进表，拉取失败恒 200 + `error` 可读消息（中转不透传 /models → 手动添加兜底） |
| `POST ''` / `PATCH /{id}` / `DELETE /{id}` | `verify_local_token`（**仅**本地 token） | provider CRUD；PATCH 部分更新（`api_key` 传非空=重加密替换、传 None/空=清除） |
| `PUT /{id}/models` / `DELETE /{id}/models` | `verify_local_token` | model 行写面（P3）：PUT merge 语义——body 出现的键才动（防「勾启用」清掉 maxOutput）；model_id 走 body 防含 `/` 的 wire id 撞路由 |
| `POST /{id}/test` | `verify_local_token` | 连通性测试（拿解密 key 发极小上游请求，探测面不给远程会话驱动） |
| `GET /snapshot` | `verify_local_token` | **返回解密后 key**，仅供同机 loopback gateway 消费 |

**snapshot 形状**（envelope `data` 字段；gateway `daemonRequest` 自动 unwrap）：

```json
{ "version": 7, "providers": [{
    "id": "default", "protocol": "anthropic", "displayName": "…",
    "baseUrl": "<原样存储值>", "apiKey": "<解密明文，无 key 为空串>", "headers": {},
    "enabled": true,
    "models": [{ "id": "…", "displayName": null, "enabled": true,
                 "capabilities": null, "maxOutput": null, "source": "manual" }] }] }
```

只含 enabled provider；每 provider 含**全部**模型行（带 enabled，消费端自筛）；
`capabilities`/`maxOutput` 未标注 = `null`（TS 类型按 nullable 建模）。

旧 `GET /api/llm/models`（llm.py，main/translate 两 profile + 内存 TTL 缓存）**保留不动**——
flag off 的现状路径。

## 6. Node gateway（TS registry）

- **模块切分（惰性加载纪律）**：`providers.ts` = SDK-heavy 半边（顶层 import 六个 provider SDK
  包），**只能**经 flag-on 的 `await import()` 进入（`llm_provider_resolver.ts` /
  `ai_gateway_lifecycle.ts`）；SDK-free 的 providerRef 解析 / snapshot 类型 / URL canonical /
  `ProviderCredentialsError` 在 `providerRef.ts`，是 chatRun/thinking/config 的合法 import 面。
  静态源测试钉死这条切分（`tests/ai-gateway/provider_lazy_import.test.ts`）。
- **registry 构建**：`buildProviderRegistry(snapshot)` 按 protocol 分发 create 函数
  （anthropic→`createAnthropic`；openai→`createOpenAI`；openai-compatible→
  `createOpenAICompatible({name: providerId, includeUsage: true})`，无 baseUrl 跳过+warning；
  deepseek/google/openrouter→各官方包）→ `createProviderRegistry`。**恒传模型实例**，任何路径
  不把裸字符串交给 streamText（防打到 Vercel 云 gateway）。
- **缓存**：`createProviderModelResolver` 30s TTL + version 比对（version 不变续用已构建
  registry）；snapshot 拉取失败 → 有旧 registry 用旧的 + 单次 warning；冷启动无快照 →
  `createLegacyResolution`（env 老配置 anthropic 单例，fail-open 保 chat 可用——此腿 key 空
  则抛 typed `ProviderCredentialsError`，不发必 401 的裸请求）。
- **凭证门禁（HIGH-1）**：registry 路径 on 时全局 `LLM_API_KEY` 前置门跳过，**选中 provider 行
  的 key 是权威**；key 必需协议行无 key → typed error 映射回 503 `E_NO_LLM_KEY` wire 形状。
  唯一 key-optional 协议 = `openai-compatible`（本地无鉴权服务如 LAN Ollama）。
- **maxOutput clamp**：`min(64_000, llm_model.max_output)` 经 `wrapLanguageModel +
  defaultSettingsMiddleware` 预置；行值 NULL 不 clamp。
- **per-protocol thinking**：`thinking.ts` 的 `thinkingProviderOptions(model, enabled, protocol)`
  ——**仅 `protocol === 'anthropic'` 注入** `providerOptions.anthropic.*`（防换 provider 后
  anthropic 命名空间静默失效）；其他协议当前**不注入任何 providerOptions**
  （openai `reasoningEffort` 未实现，见 §11 已知限制）。
- **flag off 字节级等价**：`resolveModelFactory` 无 resolver 时走老 `createAnthropic` 单例
  （vitest 断言）。
- **裸 fetch 收编（P4）**：`translate.ts` / `nl_search.ts` 删手写 anthropic wire + SSE 解析，
  改经 `llm_provider_resolver` + `generateText`。**translate 例外**：显式配置了
  `LLM_TRANSLATE_BASE_URL/_API_KEY` 独立 profile 时优先走该 profile（registry on 也不夺权）。

## 7. Python protocol 路由

- **`src/llm_agent/provider_routing.py`**（路由单源）：`resolve_route(model_ref)` → flag off 恒
  None（消费端走 legacy 前缀路由 `("gpt-","gemini-","codex-")` + 全局 env，字节级不变）；on 时
  parse ref → 查 30s TTL 快照（直读 store，**不进 pydantic 冻结单例**）→ `ProviderRoute`
  （protocol + per-provider base/key/headers 解密值 + per-model max_output）。
- **fail-open 仅两种情形**（其余必须可见）：①快照整体不可读（配置面挂了不挡 LLM）②无冒号
  legacy id 查不到 default 行。**显式带冒号的 ref** 在 provider 缺失/禁用时抛
  `ProviderRouteError` → 调用方按「该模型失败」走 fallback 链，**绝不静默降级**到全局网关
  （数据边界/费用/模型偏差）。
- **client.py 双腿**：`_leg_for` = route 无 → 前缀路由；有 → `openai / openai-compatible /
  deepseek / openrouter` 走 httpx OpenAI Chat Completions 腿，`anthropic` 走 AsyncAnthropic 腿，
  `google` = `unsupported`（跳过+warning）。per-provider client 按 route 签名缓存构造。
- **`run_tool_loop` 双协议**（P2 决策 3，报告 Agent 因此可选 openai-protocol 模型）：flag off =
  现状（链里过滤 OpenAI 前缀模型，anthropic-only）；on = 按协议分发——openai 系走
  `_run_loop_openai`（assistant `tool_calls` 重放 + `role:"tool"` 结果回传 + 流式 delta 聚合），
  google 协议模型从链里过滤 + warning。cache_control：anthropic 腿复用 caller 断点，openai 腿
  system 打平自然丢弃。
- **mem0 映射**（`mem0_engine.py`）：route 为 openai 家族 → mem0 openai provider +
  `openai_base_url`；anthropic → `anthropic_base_url`（canonical_root，SDK 自补 /v1）。8192
  非流式 clamp 两面都保持（`clamp_max_tokens(CAPTURE_MAX_TOKENS, route)`）。
- **max_tokens clamp**：`clamp_max_tokens(requested, route)` = 行值非 NULL →
  `min(requested, max_output)`，classify 与 tool loop 均过。

## 8. URL canonical 规则表（HIGH-2 双端契约）

DB 行存**用户原始输入**（写入仅 trim + 去尾 `/`）；归一化由消费端按协议做，**单源** = Python
`provider_routing.normalize_*` + TS `providerRef.ts` 的 `canonicalRoot`/`canonicalApiBase`
（探测面 llm_providers.py 与 runtime 面必须推导出同一 wire URL，禁止各处复制实现）：

| 协议 | canonical 规则 | runtime 拼接 | probe 拼接 |
|---|---|---|---|
| anthropic | **canonical_root** = 去尾 `/` 再剥尾部 `/v<N>`；空 → None（SDK 官方默认） | Python AsyncAnthropic / mem0 直接吃 root（SDK 自补 `/v1/messages`）；TS `anthropicBaseUrl(canonicalRoot(raw))` 补回 `/v1`（@ai-sdk/anthropic 只追加 `/messages`） | `root + '/v1/models'` |
| openai 家族（openai / openai-compatible / deepseek / openrouter） | **canonical_api_base** = 已以 `/v<N>` 结尾 → 原样（dashscope `.../compatible-mode/v1`）；否则补 `/v1`（裸域名 / CRS `.../api`）；空 → 按 protocol 官方默认（openai-compatible 无默认 = 配置错误） | `base + '/chat/completions'` | `base + '/models'` |
| google | **非空值原样透传**（@ai-sdk/google 默认路径习惯 `/v1beta` 非 `/v1`，套 canonical 会拼出不存在的路径）——用户按其网关文档原样填 | SDK 自管 | openai 兼容面 `/v1beta/openai` |

效果：用户从厂商文档抄来含 `/v1` 的地址不会叠成 `/v1/v1`；同一行值在 Python/TS/probe 三面命中
同一 wire URL（「测试通过但另一端 404」被结构性消灭）。

## 9. 凭证面（Fernet + 掩码 + redaction）

- **加密**：`api_key_cipher` = Fernet 密文，master key 复用 S2 per-skill secret 机制
  （`src/agent_config/secrets.py`，Keychain 单条 + keyfile fallback，**不造第二套**）。解密失败
  （master key 轮换/密文损坏）→ 当无 key 处理 + warning，值任何形态不进日志。
- **明文只在两处离开 store**：`GET /snapshot`（仅本地 token，gateway 消费）+ 连通性测试的上游
  请求。CRUD 读面只回 `hasKey` + `keyLast4`。
- **redaction（HIGH-3）**：上游错误正文可能回显请求头（自建中转/调试代理/恶意 provider）——
  任何要进 `LLMCallError` / API 响应 / 日志的上游正文摘要必须**先过**
  `provider_routing.redact_secrets`（当前 provider 的 api_key + 全部自定义 header 值 → `***`，
  按值长度降序替换）**再截断**（顺序反了会让被截断的 key 前缀漏网）。

## 10. Flag、fail-open 与 Settings/远程面

- **`MAILAGENT_LLM_PROVIDER_REGISTRY`（默认 off）**：Python = pydantic
  `llm_provider_registry_enabled`（`validation_alias`，翻转需重启 serve-api）；Node = main env
  直读 `isLlmProviderRegistryEnabled()`（不加 vite define，重启 app 生效）。off = gateway 老
  `createAnthropic` 单例 + Python 前缀路由 + Settings 旧 LLM 网关区，字节级现状（双端有测试断言）。
- **/chat/config**：`enabledModels` flag on 改为聚合双表（default provider 输出裸 id 保持兼容、
  其余 `providerId:modelId`、default 恒排最前；聚合失败回退 env 值 never-fail）+
  `providerRegistryEnabled` 字段驱动前端显隐（UI 门控与投影同源同语义，永不劈叉）。
- **Settings「模型服务」区**（`settings/providers/ModelServicesSection.tsx`，flag on 替换旧
  LLM 网关区）：内置模板（Anthropic 官方 / OpenAI / Google / DeepSeek / Qwen / GLM / Kimi /
  MiniMax / 豆包 / SiliconFlow / OpenRouter / 自定义 OpenAI-compat / 自定义 Anthropic-compat，
  只预填 protocol+baseURL）+ provider 增删启停 + key 掩码编辑 + 模型拉取/勾选/手动添加/
  maxOutput + 连通性测试。四个功能位选择器（`LLM_MODEL`/fallback/翻译/记忆抽取）+ Agents 各
  抽屉选择器升级为 provider 分组（`ModelSelectItems.tsx`；值仍存完整 providerRef，写入面不变）。
- **远程 web 只读**：不靠前端隐藏——写面/snapshot/test 端点 `verify_local_token` 硬拒 CF 会话
  （403），远程 Settings 自然只读渲染。
- **Onboarding（P3b）**：AI 模型步（provider 配置，**可跳过**）+ NOTION_TOKEN 改可选
  （空 = 本地-only，`notion_enabled()` 四面守卫，见 `.env.example` 头部注释）。

## 11. 运维

### 常用 SQL（`agent_config.db`，默认在 sync_store 同目录）

```bash
DB=$(dirname "$(sqlite3 data/sync_store.db 'PRAGMA database_list' | cut -d'|' -f3)")/agent_config.db
# 打包态 DB 在 userData：~/Library/Application Support/mailagent-frontend/data/agent_config.db

sqlite3 "$DB" "SELECT id, protocol, base_url, enabled, api_key_cipher IS NOT NULL AS has_key FROM llm_provider ORDER BY sort_order"
sqlite3 "$DB" "SELECT provider_id, model_id, enabled, max_output, source FROM llm_model ORDER BY provider_id, model_id"
sqlite3 "$DB" "SELECT value FROM llm_provider_meta WHERE key='snapshot_version'"
# seed 是否已发生 = llm_provider 有无行；重置 seed（慎！丢所有 provider 配置）：
# sqlite3 "$DB" "DELETE FROM llm_model; DELETE FROM llm_provider; DELETE FROM llm_provider_meta"
```

### flag 翻转步骤

1. `.env` 加 `MAILAGENT_LLM_PROVIDER_REGISTRY=true` → **重启 app**（打包态；dev 另重启
   serve-api——Python pydantic 与 Node main env 都是启动读）。
2. 首次任一 provider 读端点触发 seed → Settings「模型服务」区应显示 `default` 行 = 老
   `LLM_API_BASE`/key/启用模型（验收标准 6：老值正确显示）。
3. 验证等价性：chat 发一条（default provider 模型，请求应与 flag off 逐字节等价）+
   `mailagent llm run <id> --dry-run`。
4. 新增 provider：Settings 添加 → 连通性测试 → 拉取模型 → 勾选启用 → 各功能位选择器出现
   `providerId:modelId` 分组项。

### 应急回退

- `.env` 置 `MAILAGENT_LLM_PROVIDER_REGISTRY=false`（或删键）+ 重启 → 双端字节级回老路径。
  表行原样留存无行为（additive，回退不丢数据）；再翻回 on 时行权威立即恢复。
- 只回退某一 provider：Settings 停用该行（enabled=0）→ 其模型从选择器消失；引用它的显式 ref
  按「该模型失败」走 fallback 链（不静默改道）。
- 配置面挂了（agent_config.db 损坏）：双端 fail-open——gateway 用旧快照/冷启回 env legacy 腿，
  Python 回前缀路由；chat 不死，修库后 ≤30s 自愈。

### 已知限制（v1 有意不做 / 未实现）

- **google 协议 Python 腿不支持**：`client.py` 对 google-protocol 模型跳过（classify 走
  fallback 链下一个；`run_tool_loop` 链里过滤 + warning）。gateway（TS）侧可用。
- **Kimi k2-thinking 多轮 reasoning 回传未实现**：openai 腿 `_run_loop_openai` 不回传
  reasoning 内容（Kimi 要求多轮 tool loop 回传 reasoning——thinking 系模型多步工具链可能降质，
  接入时选非 thinking 模型或走其 anthropic-compat 端点）。
- **openai 系 `reasoningEffort` 未注入**：per-protocol thinking 当前 = anthropic-only 注入，
  其他协议无 providerOptions（防静默失效的保守面；按需再补）。
- **chat 面板模型选择器无分组**：跨 provider 聚合后仍是扁平列表（Agents 抽屉已分组）；
  mid-conversation 跨 provider 切换也无「建议新开会话」提示（tool-use 历史跨家续接可能被 id
  校验拒，遇到即新开会话）。
- 不做 per-model 计费/成本核算、多 key 轮询/负载均衡（PRD 非目标）。
- usage 统计的 cache tokens 列在 openai 面恒 0（`llm_processing` 列语义不变）。

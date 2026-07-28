# Skill Delivery API（对外 agent 交付面 · Phase 1）

> 系统「现在如何」把 MailAgent-native 能力交给第三方 agent（OpenClaw / Claude Code / 其他
> MCP client）。来源 = task `06-18-custom-ai-harness-agent` Phase 1（External Skill Delivery）。
> 设计/决策真源见该 task 的 `prd.md` / `architecture.md` / `phase1-external-skill-delivery.md`。

## 1. 形态总览

```
外部 agent（自带 loop）
  → MCP stdio (mailagent-mcp)  ─┐
  → REST  /api/skills(+invoke) ─┼─ scoped Bearer key → src/skills registry
                                │     → handler 调 services / EmailRepository /
                                │       ReportStore / run_report_once / notion_agent
                                └─ （主路径无 run_cli，BASE-1）
```

MailAgent 只维护自己的 TS/UI Custom AI loop（V2.1，不反转）；对外只交付 **Skill 层**。Skill
manifest 是 **Python 权威单一真源**（`src/skills/`），REST / MCP / pack 三面都从它派生。

## 2. 鉴权：scoped Bearer key（第四条腿）

`src/api/auth.py` 三态不变（dev bypass → local token → CF Access JWT）。Phase 1 在
**Skill 路由**（`src/api/routers/skills.py`）加第四腿 `authenticate_principal`
（`src/api/agent_auth.py`），顺序 **dev → local → bearer → CF**：

- Bearer 只在 `/api/skills*` 认；其余写端点对 agent key 天然 401 → 越权 by construction 不可达。
- key 存 `api_auth.db`（backend-owned，**非** `ai_chat.db`；默认 sync_store 同目录，env
  `MAILAGENT_API_AUTH_DB_PATH` 覆盖）。表：`agent_api_keys` + `agent_api_key_audit`
  （`CREATE TABLE IF NOT EXISTS` 幂等，不进 sync_store `DB_VERSION` 体系）。
- 只存 sha256 hash，明文仅 create/rotate 返回一次；支持 revoke/rotate/expire/audit；
  present-but-invalid（坏/撤销/过期）→ **403 fail-closed**，不回落 CF。
- scope 默认最小（`READ_ONLY_SCOPES`）；`report:run` / `email:draft` / `email:write` /
  `notion_agent:invoke` 单独授权。CLI：`mailagent api-key create|list|revoke|rotate`（写需 CLI auth）。
- 🔴 **可发放 ⟺ 有消费者**（2026-07-28 审计）：`KNOWN_SCOPES` 与 builtin ToolDef 的
  `auth_scopes` 并集**逐字相等**，闸 = `tests/skills/test_tooldef_contract.py`。悬空 scope
  （在册、零消费者）不是无害占位 —— 它当场就能 `--scopes <它>` 发出去并存进 `agent_api_keys`，
  而 `verify()` 读回时**不**校验值域，于是未来第一个消费它的 ToolDef 一上线即**静默武装所有
  历史 key**。`calendar:write`（为 calendar P1 写能力预留）就是这样一个，**已删**。将来真加
  日历写能力：ToolDef 与 scope 放**同一个 commit**。
- **起草 ≠ 发信**（issue #50）：`email:draft`（可逆，存草稿）与 `email:write`（不可逆，SMTP 发出）
  是两个独立能力，`has_scopes` 是**精确 AND 判定，不做层级/OR** —— 授了 `email:write`
  **不隐含** `email:draft`。「能发信也该能起草」在 preset 层显式兜住（`--preset writer`），
  手工 `--scopes` 按字面来，不做隐式扩权。preset：`readonly` / `handoff` /
  `drafter`（read + attachment:read + email:draft）/ `writer`（drafter + email:write）。

## 3. Skill manifest + invoke

- `GET /api/skills` → manifest v1，按 principal scopes 过滤可见 tool（agent 只见 scope 内的）。
- `POST /api/skills/invoke` → `{skill, tool, input?, confirm?}`，统一 envelope。
  - scope gate（缺 scope → 403）→ confirmation gate（`confirmation_tier='edit'` 必须
    `confirm:true`，发信/草稿永远 edit）→ 输入校验 → 配额**判定**（429）→ dispatch handler
    → 成功后才**计**一次配额。
  - agent 调用写 `agent_api_key_audit` + 刷 `last_used_at`。

manifest tool 字段：`name / input_schema / output_schema / confirmation_tier / side_effect
(read|write|external_call|send) / auth_scopes / mcp_exposed / handler{kind,target} / timeout_ms
/ rate_limit`。

**配额闸**（`src/skills/rate_limit.py`）：只对**显式声明** `rate_limit` 的 tool 生效（当前唯一
= `email_draft`，20 次/小时/key），超限 → `E_RATE_LIMITED` / HTTP 429。计数是 invoke chokepoint
上的**进程内内存滑窗**（serve-api 单 worker → 对外调用同进程计数；重启清零），目的是挡「跑飞的
agent 刷屏草稿箱」，**不是**安全边界 —— 安全边界是 scope。未声明的 tool 零行为变化。

🔴 **只有真正跑完的调用计数**：`check`（判定，不计数）→ dispatch → `record`（成功才计）。参数非法
（如 `mode` 拼错）/ 后端异常这类**没有草稿落库**的调用不吃额度 —— 否则 20 次拼错的 `mode` 就能把
一把合法 key 锁死一小时。代价是并发下可能轻微超发（两个并发请求同时通过 `check`），可接受。

### 首批 skills / tools（`src/skills/builtin/`）

| skill | tools | scope |
|---|---|---|
| email | email_get / email_body / email_thread（读）· email_draft（write, edit, MCP 可见）· email_send（send, edit, 不投 MCP, 默认不授） | email:read / email:draft / email:write |
| search | email_search / attachment_search | email:read / attachment:read |
| report | report_list / report_get / report_run | report:read / report:run |
| calendar | calendar_events / calendar_event_get（**只读**；写留 P1，故无 `calendar:write` scope） | calendar:read |
| notion_agent | notion_agent_chat（subprocess, mcp_exposed=false, 默认关） | notion_agent:invoke |

**读面的两条硬边界**（2026-07-28 审计后）：

- `email_body` 的 `format` 只有 `markdown` / `html`。**没有 `raw`** —— v4 SSoT 存的是 raw MIME 的
  *sha256*，MIME 本身算完哈希就丢（`storage_payload_builder`），改动前那个分支把 64 字符哈希
  当 `content` 返回（还配 `size_bytes:64`）。要那个摘要用 `email_get(include=body)` 的
  `body.raw_mime_sha256`（如实命名的字段）。
- 所有带 `limit` 的读都封顶且**越界拒**（`E_INVALID_ARG`，不静默 clamp）：`email_search` ≤200 /
  `attachment_search` ≤50 / `calendar_events` ≤5000 / `report_list` ≤200（本批补，此前唯一未封顶；
  且 SQLite 的 `LIMIT -1` 意为不限 → 负数还能一次拉全表）。

handoff 推荐 key（`--preset handoff`）= `email:read, attachment:read, report:read, report:run`。
起草 agent（`--preset drafter`）= `email:read, attachment:read, email:draft` —— 能建草稿、
**看不到** `email_send`（manifest 与 MCP 投影都被 scope 过滤掉），直调得 `403 E_AUTH_FAILED`。

**写面的四种 mode**：`email_draft` 与 `email_send` 共用一个 handler（`_compose_request`），
都支持 `reply` / `reply-all` / `forward` / `new`。`mode='new'`（写全新邮件）**不传 `internalId`**
—— 服务层的哨兵 `-1` 是内部约定，两个 tool 的对外 schema 都不要求它、返回里也都不出现它
（`internal_id: null`）。省略 `mode` = `reply-all`。
> 2026-07-28 修正：此前 `email_send` 的 schema 是 `required:["internalId"]` 却又在 `mode` 枚举里
> 宣传 `new` —— 按文档发一封全新邮件必吃 400，唯一通路是猜那个注释里写明「对外不暴露」的哨兵；
> 且 `new` 模式的返回会把 `-1` 泄出去。两处都已修，`mode` 仍非必填（既有 `{internalId: N}`
> 调用向后兼容）。

### 🔴 `confirm:true` 是意图标记，不是人审闸

`email_draft` 是第一个 `mcp_exposed=true` 的写工具。MCP 桥（`src/mcp/mailagent_mcp.py`）把
`arguments.confirm` **pop 出来**当调用参数 → 这个值是**模型自己填的**，是「我确实想写」的显式
意图标记（防止把 confirm 当默认值蒙混过去），**不等于人审**。真正的人审在 MCP 客户端自己的
工具审批 UI（Claude Desktop / Claude Code 的 approve 弹窗）。运营者的安全性来自 **scope 隔离**：
给 drafter key 就永远发不出信。也因此 `email_draft` 的 `input_schema` **必须**显式含 `confirm`
布尔字段（否则 MCP 客户端填不上 → 工具投出去却恒 403），但**不进** `required`（REST 路径 confirm
在 body 顶层、MCP 路径已被 pop 走，两条路的 `input` 里都不会有它）。

> 对照：前端 chat agent 自己的 `email_draft_reply`（`frontend/src/ai-gateway/tools/write.ts`）
> 是**另一条链路**（Electron 内 gateway，reply-all 单模式，走 HITL 审批卡），与本节的对外
> `email_draft` 同名不同物、互不影响。

## 4. MCP + skill pack

- `mailagent-mcp`（`src/mcp/mailagent_mcp.py`）：MCP stdio JSON-RPC（initialize / tools/list /
  tools/call）。tools 从 manifest 的 `mcp_exposed` 生成，名 `mailagent_<skill>_<tool>`；经
  Bearer key 打 serve-api。`MAILAGENT_API_BASE` + `MAILAGENT_AGENT_KEY`。
- `scripts/export_skill_pack.py` → `dist/mailagent-skill-pack/`（gitignored）：README /
  mcp-config.example.json / manifest.json / openapi.json / selftest.sh / skills/<skill>/SKILL.md。
  `selftest.sh` 只跑安全动作（health / manifest / search / report_list；report.run 为 opt-in）。

## 5. 快速接入（外部 agent）

三步把 MailAgent 能力接进外部 agent（Claude Code / OpenClaw / 任意 MCP client）。`$BASE` 本机 = `http://127.0.0.1:8200`，远程 = `https://mail.chenge.ink`。

1. **申请 scoped key**（本机，需 CLI auth）：
   ```bash
   mailagent api-key create --preset handoff   # email:read+attachment:read+report:read+report:run
   # 明文 key（mak_…）仅此一次显示, 存好。纯读用 --preset readonly;
   # 只起草不发信用 --preset drafter; 起草+发信用 --preset writer; 细粒度用 --scopes
   ```
2. **REST 直调**（自带 loop 的 agent）：
   ```bash
   curl -H "Authorization: Bearer mak_…" $BASE/api/skills           # manifest（只见 scope 内 tool）
   curl -H "Authorization: Bearer mak_…" -H 'Content-Type: application/json' \
     -X POST $BASE/api/skills/invoke \
     -d '{"skill":"search","tool":"email_search","input":{"q":"redis timeout"}}'
   # 写/发类 tool（confirmation_tier='edit'）须带 {"confirm": true}
   ```
3. **MCP stdio**（Claude Desktop / Claude Code 等 MCP client）：
   ```bash
   MAILAGENT_API_BASE=$BASE MAILAGENT_AGENT_KEY=mak_… mailagent-mcp
   ```
   或导出 skill pack 拿现成 client 配置 + 自检：
   ```bash
   python scripts/export_skill_pack.py     # → dist/mailagent-skill-pack/（含 mcp-config.example.json）
   MAILAGENT_API_BASE=$BASE MAILAGENT_AGENT_KEY=mak_… bash dist/mailagent-skill-pack/selftest.sh
   ```

key 管理 `mailagent api-key list|revoke|rotate`；坏/撤销/过期 key → 403 fail-closed。

## 6. 不变式（每次动本面复跑）

- **ToolDef 契约闸**（`tests/skills/test_tooldef_contract.py`，2026-07-28 建）——
  动 `src/skills/**` 的任何 ToolDef 必跑。它锁六件事，每条都对应一次真实事故：
  ① schema 结构自洽（`required ⊆ properties`、属性有 `type`）；
  ② compose 家族每个宣称的 `mode` 都真能过 `_validate_input`（= schema 不得比 handler 更严）；
  ③ `KNOWN_SCOPES` ↔ ToolDef `auth_scopes` **双向**相等（既有的 manifest 闸只钉了 ⊆ 的一半），
    且 `READ_ONLY_SCOPES` 名副其实（挂在只读 scope 上的 tool 必须 `side_effect=read`）；
  ④ `ConfirmationTier` 声明的每一档都真在 invoke chokepoint 被强制（**从 `invoke.py` 源码抽**
    强制集 —— 这是 P0「preview 档无门」的病根形态：多了一档没人管的 tier）；
  ⑤ 有副作用的 tool（write/send/external_call）不得 `tier=none`；
  ⑥ 声明的 `rate_limit` 必须能被 `rate_limit._parse` 认下（形状不合法会**静默放行**），
    且每个带 `limit` 的读都真有上界（行为断言：拿荒谬 limit 打 handler，用「炸 ctx」证明它在
    碰数据之前就被拦住）。
  闸本身遵台账「三种失效形态」纪律：不持任何一侧的期望值副本、抽取器抽不到必红、每条断言配
  合成反向用例。改 ToolDef 写法（枚举挪位置 / tier 判定改写法 / `limit` 改名）时它会红并指名
  「回来更新抽取器」——那是设计意图，不是噪音。
- BASE-1：`grep -RIn "run_cli(" src/api/routers` 业务残留 = 4（不新增）；skills/mcp/invoke 主
  路径无 `run_cli`。
- BASE-3：`grep "from src.cli\|import src.cli" src/services/` 为空。
- 不碰 `frontend/src/shared/chat/`（Custom AI loop / chat schema / Cmd+O）—— 那是 Phase 2/3。

## 7. 已知缺口（不在本面、有意留）

**草稿配额只罩得住外部 key，罩不住模型自己那条路**（issue #66 第 5 条，2026-07-28 复核后**未修**）。
`email_draft` 的 20/h 配额挂在 `invoke_skill` 上，只对 `/api/skills/invoke` + MCP 生效。前端 chat
agent 的三个草稿工具（`email_draft_reply` / `email_draft_compose` / `email_draft_update`）走的是
**另一条链路**：Electron gateway → serve-api `POST /api/email/draft`，那里没有任何配额。

结构障碍：那个端点只有 `verify_cf_access` 一腿，**人类 composer 与 gateway 工具带的是同一个
`X-MailAgent-Local-Token`、同一个 owner 身份**（`domainClient._req` 与 `handlers/draft.ts` 的
`daemonRequest` 注入的是同一个 header），Python 侧拿不到任何可区分的信号。在这种情况下加配额只能
连用户手动写信一起罩住 —— 宁可不做。真要做，前置条件是让 gateway 在这条路上自报来源（比如一个
只由 gateway 注入的 caller 标记，配额按它分桶）；配额本就不是安全边界（安全边界是 scope），
自报来源对「挡住跑飞的 agent」这个目的足够。

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
| calendar | calendar_events / calendar_event_get | calendar:read |
| notion_agent | notion_agent_chat（subprocess, mcp_exposed=false, 默认关） | notion_agent:invoke |

handoff 推荐 key（`--preset handoff`）= `email:read, attachment:read, report:read, report:run`。
起草 agent（`--preset drafter`）= `email:read, attachment:read, email:draft` —— 能建草稿、
**看不到** `email_send`（manifest 与 MCP 投影都被 scope 过滤掉），直调得 `403 E_AUTH_FAILED`。

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

- BASE-1：`grep -RIn "run_cli(" src/api/routers` 业务残留 = 4（不新增）；skills/mcp/invoke 主
  路径无 `run_cli`。
- BASE-3：`grep "from src.cli\|import src.cli" src/services/` 为空。
- 不碰 `frontend/src/shared/chat/`（Custom AI loop / chat schema / Cmd+O）—— 那是 Phase 2/3。

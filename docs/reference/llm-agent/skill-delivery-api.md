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
- scope 默认最小（`READ_ONLY_SCOPES`）；`report:run` / `email:write` / `notion_agent:invoke`
  单独授权。CLI：`mailagent api-key create|list|revoke|rotate`（写需 CLI auth）。

## 3. Skill manifest + invoke

- `GET /api/skills` → manifest v1，按 principal scopes 过滤可见 tool（agent 只见 scope 内的）。
- `POST /api/skills/invoke` → `{skill, tool, input?, confirm?}`，统一 envelope。
  - scope gate（缺 scope → 403）→ confirmation gate（`confirmation_tier='edit'` 必须
    `confirm:true`，发信/草稿永远 edit）→ 输入校验 → dispatch handler。
  - agent 调用写 `agent_api_key_audit` + 刷 `last_used_at`。

manifest tool 字段：`name / input_schema / output_schema / confirmation_tier / side_effect
(read|write|external_call|send) / auth_scopes / mcp_exposed / handler{kind,target} / timeout_ms`。

### 首批 skills / tools（`src/skills/builtin/`）

| skill | tools | scope |
|---|---|---|
| email | email_get / email_body / email_thread（读）· email_send（send, edit, 默认不授） | email:read / email:write |
| search | email_search / attachment_search | email:read / attachment:read |
| report | report_list / report_get / report_run | report:read / report:run |
| calendar | calendar_events / calendar_event_get | calendar:read |
| notion_agent | notion_agent_chat（subprocess, mcp_exposed=false, 默认关） | notion_agent:invoke |

handoff 推荐 key（`--preset handoff`）= `email:read, attachment:read, report:read, report:run`。

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
   # 明文 key（mak_…）仅此一次显示, 存好。纯读用 --preset readonly; 细粒度用 --scopes
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

# Skill Delivery API（对外 agent 交付面 · Phase 1）

> 系统「现在如何」把 MailAgent-native 能力交给第三方 agent（OpenClaw / Claude Code / 其他
> MCP client）。来源 = task `06-18-custom-ai-harness-agent` Phase 1（External Skill Delivery）。
> 设计/决策真源见该 task 的 `prd.md` / `architecture.md` / `phase1-external-skill-delivery.md`。

## 1. 形态总览

```
外部 agent（自带 loop）
  → MCP stdio (mailagent-mcp)  ─┐
  → MCP HTTP  POST /mcp        ─┤
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

- Bearer 只在 `/api/skills*` 与 `/mcp` 认；其余写端点对 agent key 天然 401 → 越权 by construction 不可达。
- key 存 `api_auth.db`（backend-owned，**非** `ai_chat.db`；默认 sync_store 同目录，env
  `MAILAGENT_API_AUTH_DB_PATH` 覆盖）。表：`agent_api_keys` + `agent_api_key_audit`
  （`CREATE TABLE IF NOT EXISTS` 幂等，不进 sync_store `DB_VERSION` 体系）。
- 只存 sha256 hash，明文仅 create/rotate 返回一次；支持 revoke/rotate/expire/audit；
  present-but-invalid（坏/撤销/过期）→ **403 fail-closed**，不回落 CF。
- scope 默认最小（`READ_ONLY_SCOPES` = `email:read` / `attachment:read` / `report:read` /
  `calendar:read` / `contacts:read` / `library:read` / `matters:read` / `agents:read`）；
  `report:run` / `agents:run` / `email:draft` / `email:write` / `notion_agent:invoke` /
  `email:organize` / `calendar:write` / `matters:write` 单独授权。
  CLI：`mailagent api-key create|list|revoke|rotate`（写需 CLI auth）。
- 写 scope 一览（`email:organize` / `matters:write` / `calendar:write` 不在任何预设里；`email:draft` 只在 CLI 的 drafter / writer 预设里，`email:write` 只在 writer 预设里）：

  | scope | 能做什么 | 能否撤回 |
  |---|---|---|
  | `email:draft` | 存草稿，不发出 | 可删草稿 |
  | `email:organize` | 旗标、置顶、归档 | 可撤回 |
  | `matters:write` | 建事项、加备注、增改行动项 | 可在应用里撤销 |
  | `calendar:write` | 回复邀请、改期、删除事件 | 会通知参会人；删除不可撤回 |
  | `email:write` | 真实发信 | 不可撤回 |
- 🔴 存量 key 的 scope 是**建 key 时展开存进 `scopes_json` 的字面列表**：往 `READ_ONLY_SCOPES`
  加新 scope 不会让已发出的 key 获得新能力。要用后加的工具，须新建 key，或在设置页「修改权限」
  （`PATCH /api/mcp-service/keys/{id}/scopes`，明文不变，下一次请求即生效，写一行审计）。
- 🔴 **可发放 ⟺ 有消费者**（2026-07-28 审计）：`KNOWN_SCOPES` 与 builtin ToolDef 的
  `auth_scopes` 并集**逐字相等**，闸 = `tests/skills/test_tooldef_contract.py`。悬空 scope
  （在册、零消费者）不是无害占位 —— 它当场就能 `--scopes <它>` 发出去并存进 `agent_api_keys`，
  而 `verify()` 读回时**不**校验值域，于是未来第一个消费它的 ToolDef 一上线即**静默武装所有
  历史 key**。`calendar:write` 曾经就是这样一个（为日历写能力预留、零消费者），2026-07-28 删除；
  2026-10 与消费它的三个日历写工具放在**同一个提交**里加回。以后新增 scope 同样处理。
- **起草 ≠ 发信**（issue #50）：`email:draft`（可逆，存草稿）与 `email:write`（不可逆，SMTP 发出）
  是两个独立能力，`has_scopes` 是**精确 AND 判定，不做层级/OR** —— 授了 `email:write`
  **不隐含** `email:draft`。「能发信也该能起草」在 preset 层显式兜住（`--preset writer`），
  手工 `--scopes` 按字面来，不做隐式扩权。preset：`readonly`（全部八个读 scope）/
  `handoff`（readonly + `report:run` + `agents:run`）/
  `drafter`（email:read + attachment:read + email:draft）/ `writer`（drafter + email:write）。

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

**配额闸**（`src/skills/rate_limit.py`）：只对**显式声明** `rate_limit` 的 tool 生效（当前两个：
`email_draft` 20 次/小时/key、`custom_agent_run_now` 10 次/小时/key，以及 §3「对外写工具」里的
11 个写工具：发信 10、日历写 20、其余 60 次/小时/key；按「key × 工具」分别计数，同组三个日历写工具
各有 20 次），超限 → `E_RATE_LIMITED` / HTTP 429。计数是 invoke chokepoint
上的**进程内内存滑窗**（serve-api 单 worker → 对外调用同进程计数；重启清零），目的是挡「跑飞的
agent 刷屏草稿箱」，**不是**安全边界 —— 安全边界是 scope。未声明的 tool 零行为变化。

🔴 **只有真正跑完的调用计数**：`check`（判定，不计数）→ dispatch → `record`（成功才计）。参数非法
（如 `mode` 拼错）/ 后端异常这类**没有草稿落库**的调用不吃额度 —— 否则 20 次拼错的 `mode` 就能把
一把合法 key 锁死一小时。代价是并发下可能轻微超发（两个并发请求同时通过 `check`），可接受。

### skills / tools（`src/skills/builtin/`）

| skill | tools | scope |
|---|---|---|
| email | email_get / email_body / email_thread（读）· email_draft（write, edit）· email_send（send, edit, 默认不授） | email:read / email:draft / email:write |
| email_organize | email_flag / email_pin / email_archive（write, preview, 默认不授） | email:organize |
| search | email_search / attachment_search | email:read / attachment:read |
| report | report_list / report_get / report_run | report:read / report:run |
| calendar | calendar_events / calendar_event_get（读）· calendar_event_rsvp（send, edit）· calendar_event_reschedule / calendar_event_delete（external_call, edit）（写默认不授） | calendar:read / calendar:write |
| notion_agent | notion_agent_chat（subprocess, mcp_exposed=false, 默认关） | notion_agent:invoke |
| contacts | contact_search / contact_get / contact_list_mails（只读） | contacts:read |
| library | library_list / library_search / library_read（只读） | library:read |
| matter_lookup | matter_find / matter_get / matter_attention_list（只读） | matters:read |
| agents | custom_agent_list / custom_agent_get（读）· custom_agent_run_now（external_call, edit, 10 次/小时/key） | agents:read / agents:run |
| matter_write | matter_create / matter_add_note / matter_item_add / matter_item_update（write, preview, 默认不授） | matters:write |

另有三个零工具 skill（`custom_agent` / `skill_creator` / `matters`）只带方法论 prompt 片段与
SKILL.md。`matter_lookup` / `agents` 不叫 `matters` / `custom_agent`，正是因为这两个名字已被零工具
skill 占用（其测试与 SKILL.md 都把「零工具」当契约）。

**四块域读面（2026-10-26）的共同规则**：

- **返回字段对照应用内助手的同名 gateway 工具**（`frontend/src/ai-gateway/tools/{contacts,library,
  matters,agents}.ts`），每个 handler 末尾是显式白名单投影，不透出 REST 原始返回。两边字段语义
  不同源，不建跨语言闸 —— 改 gateway 投影时回来对一遍 Python 那份。对外比 gateway **更严**的地方：
  - `contact_get` 不出 `notes` / `contact_info` 整块 / `gender`（与 gateway 一致）；
  - `matter_get` 的 `matter` 去掉跟进 agent 的配置与指令（`matter_instructions` / `schedule_json` /
    `agent_profile_id` / `agent_enabled`）和操作者列，`include` 不开放 `followup`，`timeline` 去掉
    `agent_binding_changed` 事件（它的 payload 带跟进指令的前后值）；gateway 原样透传；
  - `custom_agent_list` / `custom_agent_get` 不出 `prompt` / `model` / 六档能力 / `allowed_tools` /
    `grant_*` / `skills` / `grant_connectors`；gateway 的 `trigger_summary`（TS 派生的一行字）换成结构化
    `trigger`；
  - `library_read` 对回收站里的文件返回 `E_NOT_FOUND`（gateway 回元数据 + 提示）。
- **不可信文本围栏**：联系人 AI 画像包 `UNTRUSTED_CONTACT_PROFILE`，资料库正文 / 命中片段包
  `UNTRUSTED_LIBRARY_FILE`（`src/agents/fence.py`，与 TS 同格式、有 parity 闸）。
- **子列表也封顶**：`contact_get` 的 emails / reports / name_variants 与 `matter_get` 的每个子列表各 50 条，
  `truncated` 标出被裁的；`matter_attention_list` / `custom_agent_list` 按 `limit` 截并回 `truncated`。
- **资料库**：复用 `routers/library.get_library_service` 进程级单例（`SkillContext.library_service()`），
  不新建 `LibraryService`；`.trash` 不可列（根目录清单也去掉它）、不可搜、不可读；挂载目录照常可读，
  `.env/.pem/.key/.db` 与 `.git` 拦截不变。读会顺带填派生索引（就地抽取 / 踢后台索引），不改文件正文。
  注意 REST `/api/library/*` 只认本机 token（远程 CF 网页读不到资料库），持 `library:read` 的外部 key
  经本 skill 反而读得到 —— 这是 owner 2026-10-26 的有意开放，发 key 时按此权衡。
- **取数复用**：通讯录列表 SQL 下沉为 `routers/contacts.query_contact_list`（路由与 skill 共用），详情用
  同模块 `_load_detail`；手动触发下沉为 `src/agents/run_queue.enqueue_manual_agent_run`（路由的 custom
  分支与 skill 共用）。skill handler 经 `builtin/_common.api_router` lazy 取路由模块（先加载 app，
  避开路由 ↔ app 的循环 import）。

**对外写工具（2026-10-27）的共同规则**：

- 与应用内同名操作调同一个 service 方法、同样的参数，不经 HTTP 绕一圈、不复制业务逻辑：

  | 工具 | 服务方法 | 对应的应用内入口 |
  |---|---|---|
  | `email_send` | `MailWriteService.send` | `POST /api/email/send` |
  | `email_flag` | `MailWriteService.set_flags([id], is_flagged, allow_concurrent=True)` | `POST /api/email/{id}/flag` |
  | `email_pin` | `MailWriteService.set_pin` | `POST /api/email/{id}/pin` |
  | `email_archive` | `MailWriteService.archive`（davmail-only） | `POST /api/email/{id}/archive` |
  | `calendar_event_rsvp` | `CalendarService.send_rsvp` | `POST /api/calendar/events/{id}/rsvp` |
  | `calendar_event_reschedule` | 带 `recurrence_id` → `update_occurrence`，否则 `update_event`；只传起止时间 | `PATCH /api/calendar/events/{id}`（不开放 splitFuture） |
  | `calendar_event_delete` | `CalendarService.delete_event`（不支持按 occurrence 删） | `DELETE /api/calendar/events/{id}` |
  | `matter_create` | `MatterService.create_matter` | `POST /api/matters` |
  | `matter_add_note` | `MatterService.add_note` | `POST /api/matters/{id}/notes` |
  | `matter_item_add` | `MatterService.create_item`（kind 固定 action） | `POST /api/matters/{id}/items` |
  | `matter_item_update` | `MatterService.update_item`（只开放 title / status / due_at） | `PATCH /api/matters/{id}/items/{item_id}` |

- 参数名对齐应用内 gateway 的同名工具（`internal_id` / `event_id` / `recurrence_id` / `public_id` /
  `item_id` / `expected_version` / epoch 毫秒 `due_at`）。改期的 `new_start` / `new_end` 必须带时区偏移
  （与 PATCH 端点同一个解析函数）。
- confirm：发信与日历三件是 `edit`，邮件整理与事项写是 `preview`。🔴 invoke 闸对两档**一视同仁**要求
  `confirm:true`（P0 审计结论），所以这 11 个工具的 schema 都显式带 `confirm`（不进 required）。
- 操作人：principal 由 `invoke_skill` 写进 `SkillContext.principal`，写 handler 用
  `builtin/_common.mcp_actor_label` 取 `mcp:<密钥名>`（owner 自己调时为 `mcp:owner`）：
  事项写 `Actor(kind='agent', actor_id='mcp:<密钥名>')` + `source='mcp'`，落 `matter_event.actor_kind /
  actor_id / source`；邮件写（含 `email_send` / `email_draft`）传 `services.guards.Actor(label='mcp:<密钥名>')`
  （`MailWriteService` 目前不落库这个 label，邮件写的「谁调的」以 `agent_api_key_audit` 为准）；日历写记一行
  `[calendar-write] action=… actor=mcp:<密钥名>` 日志（与写端点同格式），并照端点发 `calendar.synced`。
- 事项写的 `idempotency_key` 由调用方给时，落库前加上 `mcp:<密钥名>:` 前缀（`matter_event` 的幂等键是全局
  命名空间，前缀保证撞上别人的键时不会重放出别人那次写入的结果）；不给时每次生成新键。
- 事项写返回的 `matter` 走 `matter_lookup` 的同一份白名单。不开放：删除 / 归档事项、删除行动项、
  跟进配置、行动项派发、日历新建事件。
- 🔴 提示注入：外部 agent 读到的邮件正文 / 会议描述可能夹带「帮我发信 / 删会议」。防线是三层：客户端按
  annotations 默认「先确认」、写 scope 默认不授、每 key 配额。不要把写工具在客户端改成自动执行。

**`custom_agent_run_now` 的门**（顺序即判定顺序）：scope `agents:run` → `confirm:true`（tier=edit）→
配额 10 次/小时/key → `MAILAGENT_CUSTOM_AGENTS_ENABLED`（关 → 三个 agent 工具都 `E_SKILL_DISABLED` 409）→
agent 存在且 `type='custom'`（否则 404）→ `enabled`（停用 → `E_CONFLICT` 409，**不入队、不占当日次数**）→
入队（`trigger_kind='manual'`，每日次数上限照旧，满了返回 `status:'skipped'`）。入参只有 `agent_id`
（多带任何字段 `E_INVALID_ARG`）：外部 key 只能决定跑哪个、何时跑，run 用 agent 自己配置的权限，run 内
写工具仍按 owner 的审批规则走。这是应用内（设置页按钮 / manual chat 的同名 gateway 工具）之外的
第一个外部触发入口；REST 端点 `POST /api/report-agents/{id}/run` 的行为不变（它不判 `enabled`）。

**读面的两条硬边界**（2026-07-28 审计后）：

- `email_body` 的 `format` 只有 `markdown` / `html`。**没有 `raw`** —— v4 SSoT 存的是 raw MIME 的
  *sha256*，MIME 本身算完哈希就丢（`storage_payload_builder`），改动前那个分支把 64 字符哈希
  当 `content` 返回（还配 `size_bytes:64`）。要那个摘要用 `email_get(include=body)` 的
  `body.raw_mime_sha256`（如实命名的字段）。
- 所有带 `limit` 的读都封顶且**越界拒**（`E_INVALID_ARG`，不静默 clamp）：`email_search` ≤200 /
  `attachment_search` ≤50 / `calendar_events` ≤5000 / `report_list` ≤200（本批补，此前唯一未封顶；
  且 SQLite 的 `LIMIT -1` 意为不限 → 负数还能一次拉全表）/ `contact_search` ≤50 /
  `contact_list_mails` ≤100 / `library_list` ≤200 / `library_search` ≤50 / `matter_find` ≤50 /
  `matter_attention_list` ≤100 / `custom_agent_list` ≤100（上界取 gateway 同名工具的 schema）。

handoff 推荐 key（`--preset handoff`）= 全部八个读 scope + `report:run` + `agents:run`。
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

- `mailagent-mcp`（`src/mcp/mailagent_mcp.py`）：MCP stdio JSON-RPC（initialize / ping /
  tools/list / tools/call）。tools 从 manifest 的 `mcp_exposed` 生成；经 Bearer key 打
  serve-api。`MAILAGENT_API_BASE` + `MAILAGENT_AGENT_KEY`。
- **工具名**：`mailagent_<tool>`（如 `mailagent_email_draft`、`mailagent_email_search`）。同一次投影里
  工具名重复时，重复的那几个退回 `mailagent_<skill>_<tool>`。2026-10 之前是一律
  `mailagent_<skill>_<tool>`，改名后客户端里按工具名记的开关要重新设置。
- **title 与 annotations**：每个工具都返回顶层 `title` 和 `annotations`（`annotations.title` 同值），
  四个 hint 一律显式输出，不依赖客户端默认值（规范默认 `destructiveHint` 和 `openWorldHint` 为 true）。
  annotations 由 `ToolDef.side_effect` 在 `tool_annotations()` 一处推导；`ToolDef.destructive` /
  `ToolDef.idempotent` 非 None 时覆盖推导值（readOnly / openWorld 不可覆盖）：

  | side_effect | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
  |---|---|---|---|---|
  | read | true | false | true | false |
  | write | false | false | false | false |
  | external_call | false | false | false | true |
  | send | false | true | false | true |

  有覆盖的工具：`email_flag` / `email_pin` / `email_archive` / `calendar_event_reschedule` /
  `matter_item_update` 为 idempotent；`calendar_event_rsvp` 为 idempotent 且**非** destructive（能再
  回复一次改掉）；`calendar_event_delete` 为 destructive + idempotent。逐行由
  `tests/skills/test_write_tools.py::test_annotations_match_design_table` 锁住。

  Notion 等客户端据此把读工具归入「自动执行」，写工具默认「先确认」。🔴 annotations 只是提示，
  不是安全边界：真正的权限仍是 scope + confirm 闸 + 配额。builtin ToolDef 缺 `title` 会让
  `tests/skills/test_tooldef_contract.py` 变红。
- **MCP over HTTP**：serve-api 的 `POST /mcp`（`src/api/routers/skills.py::mcp_router`），给只能填
  「URL + 请求头」的远程 MCP 客户端（Notion Custom Agent 等）用。无状态 Streamable HTTP：
  - 一个 JSON-RPC 消息（或批量数组）一次请求；含 request → `200 application/json`，只有
    notification / response → `202` 无 body；body 不是合法 JSON → JSON-RPC `-32700`。
  - 不发 `Mcp-Session-Id`、不提供 SSE 流：`GET /mcp` / `DELETE /mcp` → `405`。
  - 分派复用 `mailagent_mcp.handle_request`（与 stdio 同一份），client 是 in-process 的
    `PrincipalSkillClient`：按已鉴权的 principal 调 `build_manifest` / `invoke_skill`，
    scope / confirm / 配额 / 输入校验与 REST 完全同一条 chokepoint。
  - 鉴权同 `/api/skills`（`authenticate_principal`）：无凭据 401，坏 / 撤销 / 过期 key 403。
    key scope 外的工具在 `tools/list` 里看不到，`tools/call` 返回 JSON-RPC `-32602 unknown tool`；
    scope 内但被 confirm 闸等拒绝的调用返回 `isError` 文本 `[<code>] <message>`。
  - 每次 `tools/call` 落到 invoke 的调用写一行 `agent_api_key_audit`，`route='/mcp'`。
  - `initialize` 做版本协商（stdio 同）：请求的 `protocolVersion` 在
    `2024-11-05` / `2025-03-26` / `2025-06-18` 内则回显，否则回 `2025-06-18`；不带版本回
    `2024-11-05`。
  - 测试：`tests/api/test_mcp_http.py`。
- `scripts/export_skill_pack.py` → `dist/mailagent-skill-pack/`（gitignored）：README /
  mcp-config.example.json / manifest.json / openapi.json / selftest.sh / skills/<skill>/SKILL.md。
  `selftest.sh` 只跑安全动作（health / manifest / search / report_list；report.run 为 opt-in）。

## 5. 快速接入（外部 agent）

三步把 MailAgent 能力接进外部 agent（Claude Code / OpenClaw / 任意 MCP client）。`$BASE` 本机 = `http://127.0.0.1:8200`。

> 🔴 **`https://mail.chenge.ink` 不能用于 Bearer key**：整站在 Cloudflare Access 后，带 Bearer key
> 的请求在到达 serve-api 之前就被 302 到 Access 登录页（2026-10-26 实测）。远程的外部 agent 走一个
> **不挂 Access** 的独立主机名，且隧道只放行 `/mcp`（见下方「Notion Custom Agent 接入」）。

1. **申请 scoped key**：主路径是 App 的「设置 → MCP 服务 → 访问密钥 → 新建密钥」：基础权限二选一
   （只读 / 只读 + 运行），额外写权限多选（起草回复 / 邮件整理 / 事项写 / 日历写 / 发信），生成后的
   弹窗里可以直接复制 Notion 配置和 HTTP 客户端配置。同一页还能修改权限、轮换、撤销、看最近调用、
   检测公网地址。管理接口是 `/api/mcp-service/*`（`src/api/routers/mcp_service.py`，owner 鉴权，
   agent key 调用 401）：
   - `GET /scope-options` → `{bases:[{id,scopes}], extras:[{scope, risk}]}`（extras 顺序固定，
     `calendar:write` / `email:write` 为 `risk:'high'`）；
   - `POST /keys` body `{label, base, extra}` / `PATCH /keys/{id}/scopes` body `{base, extra}`
     （extra 只接受上述五个写 scope，白名单外 / 重复 → 400；已撤销 / 不存在 → 404）；
   - 密钥对象带 `base` / `extra` / `custom`：base 取 handoff、readonly 中最大的、是 scopes 子集的那一档，
     剩余部分必须全在 extras 白名单内，否则 `custom:true`（如 CLI drafter 预设、手工 `--scopes`），
     设置页对 custom 密钥只显示原始 scope、不提供编辑入口。
   CLI 作为备用（本机，需 CLI auth；打包 App 场景注意下方 `MAILAGENT_API_AUTH_DB_PATH`）：
   ```bash
   mailagent api-key create --preset handoff   # 全部读 scope + report:run + agents:run
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

### Notion Custom Agent 接入

Notion Custom Agent 的「Custom MCP server」只接受公网 HTTPS URL + 请求头鉴权，所以走 `POST /mcp`。
前提：**这台 Mac 开着、MailAgent 在运行**（serve-api 与 cloudflared 隧道都在本机）；Mac 合盖或
App 退出时 Notion 那边的工具调用会失败。

1. **Cloudflare 公网主机名**（owner 在后台操作，一次性）：Cloudflare Zero Trust → Networks →
   Tunnels → 选跑 `mail.chenge.ink` 的那条隧道 → Public Hostname → 新增：
   - Subdomain `mcp`，Domain `chenge.ink`（即 `mcp.chenge.ink`）
   - Path `^/mcp$`（只放行这一个路径，其余 serve-api 路由不经这个主机名暴露）
   - Service `http://localhost:8200`
   - 🔴 **不要**给 `mcp.chenge.ink` 建 Access 应用 —— 鉴权由 Bearer key 承担，挂了 Access
     就会像 `mail.chenge.ink` 一样把请求 302 掉。
2. **申请 key**：在 App「设置 → MCP 服务」新建密钥（Notion 一般选「只读 + 运行」，需要写能力时再勾
   对应的额外写权限），生成弹窗里点「复制 Notion 配置」。之后调整权限用「修改权限」，Notion 里的请求头
   不用换。公网地址填 `https://mcp.chenge.ink/mcp` 后可点
   「检测」：可达 = `/mcp` 返回 405；被 Access 拦截 = 302 到 `cloudflareaccess.com`。
   不用 App 时的 CLI 备用写法（本机，在仓库目录下跑）：
   ```bash
   MAILAGENT_CLI_API_KEY="$(grep '^MAILAGENT_CLI_API_KEY=' .env | cut -d= -f2- | tr -d '"'\'' ')" \
   MAILAGENT_API_AUTH_DB_PATH="$HOME/Library/Application Support/mailagent-frontend/data/api_auth.db" \
   venv/bin/mailagent api-key create --label notion-agent --preset handoff   # 全部只读 + 生成报告 + 手动跑自定义 agent
   # 只要读：--preset readonly；需要让 Notion 起草回复：--preset drafter（只有邮件读 + email_draft，仍发不出信）
   ```
   - 🔴 `MAILAGENT_API_AUTH_DB_PATH` 必须指向 App 的 userData：仓库 venv 的 CLI 默认写仓库 `data/api_auth.db`，
     打包 App 的 serve-api 读不到那份，key 建了也是 403。
   - CLI 写命令的 token 只从 `.env` 读**期望值**，**提供值**要来自 `--api-key` 或 shell 环境变量，
     不 export 会报 `E_AUTH_FAILED: Invalid or missing API key`。
3. **Notion 配置**：Custom Agent → Tools & Access → Add connection → Custom MCP server：
   - URL `https://mcp.chenge.ink/mcp`
   - Header `Authorization: Bearer mak_…`
4. **确认读写分组**：工具带 annotations（§4），Notion 默认把读工具设为自动执行，把
   `mailagent_custom_agent_run_now`、`mailagent_report_run`、`mailagent_email_draft`、
   `mailagent_email_send`、`mailagent_calendar_event_*`、`mailagent_matter_*` 写工具等设为
   调用前需确认，一般不用手动调整。🔴 不要把写工具改成自动执行：`confirm:true` 是模型自己填的意图标记
   （见 §3），人审只能靠 Notion 这一侧的确认设置。

自检（在任何机器上）：
```bash
curl -s -X POST https://mcp.chenge.ink/mcp -H "Authorization: Bearer mak_…" \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

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

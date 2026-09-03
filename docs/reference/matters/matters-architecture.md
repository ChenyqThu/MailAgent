# Matters（事项）架构内核

> 常青参考。描述事项系统**现在如何工作**，不记录它是怎么演进到这里的（过程档在
> `.trellis/tasks/08-09-mailagent-matters-mvp-p0-p7/` 与 `docs/archive/`）。
> 改动事项的运行语义后，同步改这里。

**一句话**：事项把「一件要推进的事」变成第一类对象 —— 邮件/会议/文档作为**资料**挂在它下面，
干系人、行动项、当前状态摘要围绕它组织，一个跟进 Agent 定期观察并**提出**更新，由 owner 决定接受。

---

## 1. 结构红线（改任何东西前先读这条）

三条入口共用「事项 Agent」这一张脸，但**安全姿态不同，代码上不许合成一条路径**：

| 入口 | 运行形态 | owner 在环 | 天花板 |
|---|---|---|---|
| 创建带调研 | **纯读端点**（`POST /api/matters/create-draft`，`create_research.py`）| ✅ 在（产的是草案，用户按下创建才落库）| 无 LLM run：确定性推导 + 邮件/Notion 检索，**一个字不写库** |
| 定时跟进 / 手动重跑 | **headless run**（`runKind='matter_followup'`）| ❌ 不在 | 服务端按 **class** 强制 Observe+Assist：只读工具面 + 唯一提案通道，产出必过人工评审 |
| 事项对话（含详情头「立即跟进」）| **交互式** | ✅ 在 | 与普通 chat 同级 |

合并的结果只有两种：要么对话被无谓砍成只读，要么无人值守的 run 拿到本不该有的写能力。

🔴 **「立即跟进」是对话入口，不是 run 入口**（0813 起）：详情头按钮走
`startMatterChatWithPrompt`（唤出 dock 并带本事项身份 chip，指令走既有 `pendingPrompt` 面，
不新造注入路径）。发起 headless run 的入口只剩定时触发与失效提案上的「重新跑一轮」
（`POST /api/matters/{id}/runs`）—— 那颗按钮要的是一份**新提案**，换成对话会把审阅闭环断掉。
事项对话的 composer 只挂一颗 `MAT-xxxx · 标题` chip；随单 chip 化，「本轮临时排除某份置顶
资料」的入口（G-21）已移除 —— `excludedResourceIds` 恒空集，注入模型的快照仍是置顶资料
全量；若要找回排除能力，落点是事项页的置顶开关（backlog），不是 composer。

### 1.1 跟进 run 的天花板：**按 class，不按名单**

0812 owner 拍板前，天花板是 Python 侧手抄的 5 个工具名（`MATTER_FOLLOWUP_ALLOWED_TOOLS`）。
那份常量**已退役**（全仓 grep 为空）。现在的判据是工具的 **policy class**：

| class | 跟进 run | 说明 |
|---|---|---|
| `read` | ✅ **全部放行** | run 的全部意义就是发现**新**证据，所以它读整个库，不受事项已关联的资料范围限制。connector 只读工具（运行时注册、class 同为 `read`）也走这条，但注册期另有场地档：per-tool `auto` 且非 destructive 才进（0813 批 P，见下方 connector 段） |
| `artifact` | ⚠️ **只放行一个名字** | `MATTER_RUN_PROPOSE_TOOL`（`matter_update_propose`）。🔴 按名不按类 —— `report_write` 同属 artifact 但它是本地写，整类放行是个洞 |
| `web` | ⚠️ 由 spec 的 `grantWeb` + owner 的三档共同决定 | 见 §1.2 |
| `domain_write` / `connector_write` / `exec` / `capability_change` / `outbound` | ❌ 一律拒 | 🔴 **grant 与场地开关一概不查**：把事项绑到一个授了 `grant_exec` / connector 写权的 Agent Profile 上，也**永远**放不宽这张脸 —— profile 只贡献 model / persona（D2）|

**两道彼此独立的腰带**（改动必须同时看，最终 ToolSet 是两者的**交集**）：

1. `frontend/src/ai-gateway/tools/policy.ts` — `matter_followup` 矩阵行，
   **必须排在通用放行分支之前**（下一行 `read || domain_write || artifact → true` 会放过域写）；
2. `frontend/src/ai-gateway/agentRun.ts` — `wrapCfgForAgentRun` 的 read-face 豁免。

**spec 侧**（`src/matters/run_spec.py`）配套三条纪律：

- `allowedTools` **恒 `[]`** —— 名单交集已被 read-face 豁免取代；置空同时把
  「`chat_session_list ∈ allowedTools` = 全史 / `agent_catalog` grant 的代理」这类**旁路语义**一并关死
  （跟进 run 只看得到自己 agent 的会话历史）。
- `grantWeb` = `'open'`、`grantConnectors` 仅在配置了 connector 时投影且值恒 `'read'` ——
  这两个是**本函数唯一的授权来源**，绑定 profile 的 grants 一个键都不抄。
- 🔴 `grantExec` **永不写**。

**实际拿得到的工具面 = 31 件**（说明书单源 `frontend/src/shared/lib/matterToolFace.ts`，
按分组渲染在全局配置弹窗里）：28 件只读 + 1 件提案 artifact + 2 件网页（受三档约束），
另加 connector 只读工具（`mcp__*`，运行时按已连接的家动态注册，不在任何静态清单里）。

🔴 **connector 面的进入档（0813 批 P）= crud-read × per-tool `auto` × 非 destructive**
（判据单源 `matterVenueAdmitsEntry`，`frontend/src/ai-gateway/tools/connector.ts` —— 注册与
prompt catalog 的 `matterReadToolCount` 共用，防「宣传比工具面宽」）：`ask` 在这个无审批
宿主的无人值守场地 ≙ **不注册**（镜像邮件预处理 `only_auto_tools` 先例，不是弹卡；普通
headless custom agent 的「ask/auto 无差别、grant 内免卡」语义**字节不动**）、`off` 恒不注册、
`destructive` 恒排除（`derive_crud_type` 裁决③ 已让 read+destructive 在 sync 期结构性不可能，
场地不依赖那个远处不变量）。写类共三道：spec 只授 `'read'` 天花板（注册期 rank 过滤）→
矩阵行拒 `connector_write` → 服务端 `resolve_caller_ceiling` 对该 venue **钉死 `'read'`**
（不读任何 agent 行）；invoke 端点还给 matter caller 传 `deny_ask_mode` + `deny_destructive`
（判定与执行同侧，单源 `is_matter_followup_caller`，`src/connectors/service.py`）。
needs_reauth（status ≠ connected）与 orphan 工具行天然进不来（spec 的
`connected_connector_ids` 与 manifest 拉取都只认 connected+enabled）；off-track
（`row_is_off_track`）**有意不排除** —— 它只是换轨迁移提示、连接与授权仍健康，任何场地都
不按它裁工具，排除它等于砍掉 owner 点名要的 Notion/Jira/Confluence 检索。

🔴 read class 共 31 件，但有 **3 件结构上到不了**跟进 run，说明书**有意不列**（列了闸就红）：
`suggest_followups`（另有 manual_chat 场地门）、`agent_catalog_list` / `agent_catalog_get`
（注册条件是 `allowedTools` 含 `chat_session_list`，而 matter spec 恒 `[]`）。

### 1.2 网页三档 `matter_run_web_face`

无人值守 + 能出网 = 无审批的数据外传通道，所以单给了一档 owner 可配的收窄旋钮
（`owner_settings`，非 env；`GET/PUT /api/agent/matter-web-face`）：

| 档 | 效果 |
|---|---|
| `keep`（默认）| 矩阵放行的 `web_search` + `web_fetch` 都活 |
| `search_only` | 腰带砍掉 `web_fetch`（URL 编码外传通道），只留检索 |
| `off` | 不管 spec 写没写 `grantWeb`，整个 web class 都不给 |

🔴 **fail-safe 是 `keep` 不是 `off`**：一次瞬时的 DB / loopback 读失败不该静默砍掉无人值守
run 的上网能力 —— owner 永远看不见这件事发生。反过来，**越域值一律 400 不静默回落**：
静默回落会让「UI 显示的档」与「实际生效的档」劈叉，在一个安全档上这比报错危险得多。
run 起始解析一次并冻进 run context，pause / resume 复用同值。

### 1.3 matter 工具家族本身（20 件，成员单源 = `matters.ts` 的五个导出数组）

事项工具家族恒注册（仍要求 mixed-family `ApprovalGuard`）：5 读（`matter_find` / `matter_get` /
`matter_attention_list` / `matter_runs_list` / `matter_tags_list`）+ 12 写（`matter_create` /
`matter_update` / 四个 `*_mutate` / **`matter_progress_mutate`（0825，curated 进展写面）** /
`matter_add_note` / `matter_run_control` / `matter_review_update` / `matter_attention_triage` /
`matter_suggestion_resolve`）+ 2 提案 artifact（`matter_update_propose` **只在 matter-run
语境注册**；`matter_item_report` **只在行动项派发 run 语境注册**，L4 批次 3，见 §4.3）+
1 `matter_followup_mutate`（class `capability_change`）。
本节旧版写的「13 件」自 0813 批 R 起就欠账 —— 数成员以代码五数组为准，本节只记结构。

`matter_suggest_related_resources`（曾经的 manual-chat 供给型特例，有意不在
`GATEWAY_TOOL_CLASSES`）已于 **2026-08-25 随「关键词命中推荐退役」删除**（见 §5）——
那条「class 闸覆盖不到它」的债随之消失，家族现在全员在 class 表里。

**全家族都带 `headless_excluded`**：普通 custom-agent 的 headless run（`untrusted_trigger` /
`cron_headless`）**一件 matter 工具都拿不到**，连读面也没有 —— 不出现在能力勾选面上 =
结构性不可达。全家族**在 `im_chat` 里照常注册**（owner 在场），所以给它们标
`manual_only` 是语义错的（suggest 退役后家族里已无真 manual-only 成员）。

🔴 `headless_excluded` 说的是「不出现在 custom-agent 的能力勾选面上」，**与跟进 run 的工具面
无关** —— 后者按 class 推导（§1.1），从不看 `HEADLESS_TOOL_OPTIONS`。

### 1.4 context mode 的源码形状

`frontend/src/ai-gateway/agentRun.ts` 的 `deriveContextMode` 在 `runKind` 上短路，
🔴 **必须保持块写法**：`tests/api/test_context_mode_consistency.py` 是**源码正则闸**，
改成单行 return 会让另一张 trigger-kind 表的抽取器误红。

「事项 Agent」只能是**身份 / 品牌层**，套在现有 run kind 之上。

---

## 2. 数据模型

主表 `matter`（`src/mail/sync_store.py` 的 `MATTER_TABLE_DDLS`），围绕它的从表。
迁移占用 `DB_VERSION` **v44–v50、v52、v56–v57 与 v70**（v44/v45 基表与资源域 · v46 run 账本 ·
v47 attention · v48 email/thread external_key 归一 · v49 拒绝记忆 · v50 标签定义表 + 完成标志 ·
v52 全局干系人库 · v56 资料摘要三列（`resource.sum`/`sum_src`/`sum_at`）·
v57 资料版本轨迹表 `resource_version`，两者详见 §2.5 ·
v70 curated 进展表 `matter_progress`（0825，纯 DDL 零回填——历史事件**有意不**转进展；
🔴 DDL 独立常量组 `MATTER_PROGRESS_TABLE_DDLS` **不进**老库重放的 `MATTER_*_DDLS`，
v52 教训，有专门闸）；v51/v53–v55 是其它域的迁移
（邮件 `ingest_reason` / outlook_com backend / 通讯录 Contact Directory），与事项无关）：

| 表 | 作用 | 关键约束 |
|---|---|---|
| `matter` | 事项本体 | `public_id` 形如 `MAT-0001`；`version` 是乐观锁基准（写并发语义见 §2.1）|
| `matter_item` | 行动项 / 决策 / 问题 / 里程碑 / 阻塞 / 笔记 | `checklist_json` 只允许 `kind='action'` 非空 |
| `matter_resource` | 事项 ↔ 资料的多对多 | 身份归一走 `resource_identity.normalize_resource_key`（**唯一写侧** `_upsert_resource`）|
| `resource_version` | 资料版本轨迹（v57）| 挂全局 `resource` 而非 per-matter，故无 `matter_` 前缀；**只存历史**，当前版本就是 `resource` 行自己，见 §2.5 |
| `matter_stakeholder` | 干系人（per-matter 行）| `is_waiting_on` 会产生等待信号；`contact_id` 关联全局通讯录 `contact`（v54 起，`ON DELETE SET NULL`，写穿语义见 §2.4）|
| ~~`matter_contact`~~ | 全局干系人库（v52）——**v54 已整体迁入通讯录 `contact` 三表后 DROP**（id 保持，见 §2.4）| 身份 = 归一 email 纪律由 `contact_email` 锚点继承；**无 email 的干系人不入库** 不变 |
| `matter_relation` | 事项之间的关系 | |
| `matter_event` | 时间线 / 审计 | 🔴 `ON DELETE CASCADE` —— 事项被永久删除时事件**一起没**，所以永久删除的审计落**日志**不落事件 |
| `matter_progress` | curated 进展（v70）：事情发展脉络的叙事条目，与操作日志分家 | kind 五类（goal/milestone/progress/signal/decision，Python `MATTER_PROGRESS_KINDS` 是 canonical，TS 镜像唯一一份在 `api/types/matter.ts`，parity 闸锁死）；软删可编辑；每次写 append `progress_*` 审计事件；`happened_at` 同样 epoch 毫秒；跟进 run 只能经提案 `progress` change 落行 |
| `matter_update` | Agent 的更新提案 | `review_status` 四态 |
| `matter_attention` | 关注信号（episode 语义）| 判据单源 `attention.py::_collect_facts`；「解决」语义见 §2.3 |
| `matter_tag` | 标签定义（名 / 颜色 / 形状）| `matter.tags_json` 仍是**字符串数组**引用 name |
| `matter_resource_rejection` | 资料建议的拒绝记忆 | 见 §5 |
| `matter_search_document` | 搜索投影 | `matter` 表本身**没有** `search_` 前缀列 |

**`kind='file'` 的两个前缀**（09-03 资料库 epic）：`external_key` 现在有两族 —— 邮件附件
`attachment:{id}` 与资料库文件 `library:{file_id}`，同一命名空间靠**前缀**区分。
🔴 `uq_resource_provider_key` 是 `(provider, external_key)`、**不含 kind**，所以前缀必须互斥：
去掉前缀 `attachment:7` 与 `library:7` 就会折成一份资料。identity 落点在
`resource_identity.py`（`library_resource_key()` / `is_library_resource_key()` /
`parse_library_resource_key()`，前缀取 `src.library.constants.RESOURCE_KEY_PREFIX`，不手抄字面量）。
存在性判定（`repository.resource_available` 的 `library:` 分支）走一个**注入的回调** ——
matters **不直接 import 资料库存储层**，回调实现在 library 侧（`src/library/resource_resolver.py`），
serve-api 与主服务各注册一次。🔴 **没注册回调时 fail-closed**（`library:` 键恒判不可用）：那道判定
唯一的作用是挡住模型编造的 file id，「读不到就放行」等于把它整条关掉；代价是漏注册 = 已关联的库
文件在列表里显示不可用（显示降级，不崩、不放行）。跟进 run 可以**提议**挂库文件：提案白名单吃的是
`MAILAGENT_PROPOSAL_KINDS`（= `MAILAGENT_IDENTITY_KINDS ∪ {file}`），与提议邮件同待遇，进「未确认的
agent 建议」由人确认。🔴 `file` **有意不进** `MAILAGENT_IDENTITY_KINDS`：那个集合的成员会被
`normalize_resource_key` 规范、被 `parse_resource_key` 认领，而 `file` 的 `external_key` 恒原样透传 ——
两个集合分开，跟进 run 能提议挂库文件而 normalize / parse 的行为一个字节不变。

**标签的两个维度**：颜色与形状彼此独立（同色靠形状区分，同形靠颜色区分）。
`tags_json` 里出现、但定义表没有的名字**不是孤儿** —— 读取时回退默认样式并照常可选可改；
过滤掉它们会让存量标签变成「看不见但还挂在事项上」。

**背景与目标** `background` / `goal`：**两个独立字段**（DB v61，2026-08-19）。owner 推翻了
08-18 那版「合存单个 `description`、靠 `## 背景` / `## 目标` 小标题分段」的方案，理由是避开解析
的异常面 —— 一个字段两段语义，读态 / 编辑态 / 保存 / 导出 / Agent 写入五处都得同意同一套正则，
任何一处不同意就是静默串段。🔴 **不要再往任何一侧加分段解析**：拆两列的全部意义就是没有解析
这回事。UI 展示仍统称「背景与目标」（一张卡两个分区），导出写 `## 背景` / `## 目标` 两个平级小节。

- 迁移（v61）：存量 `description` 原样搬进 `background`、`goal` 留空；例外是那一版短命 UI
  写出的行首整行小标题，按段拆开落两列（单源 `sync_store.split_legacy_matter_description`）。
- 🔴 `matter_search_document` / `matter_fts` 的 `description` 列**有意不改名** —— 它是检索文本桶
  不是 matter 行的镜像，改名要重建 fts5 虚表并打断 `matched_fields` 这层对外契约；投影侧
  （`repository.refresh_search_projection`）改喂 background + goal 两段合成的文本。
- 🔴 时间线里 v61 **之前**写下的事件行 `field='description'` 还在库里，`matters.eventField.description`
  这条 i18n key 不能删（闸：`frontend/tests/shared/matterEventLocale.test.ts`）。

**完成标志** `goal_checks_json`：`[{"t": str, "done": bool}]`。权限与 `background` / `goal`
完全同形（D7，0813 轮 3 微调）：**create 时 agent 可写**（gateway `matter_create` / REST create
都收 `goal_checks` —— agent 建事项时就该把「怎样算做完」一起立起来），**创建之后仍 user-only**
（`patch_matter` 对这三个字段的 actor 闸不动，agent patch → `E_INVALID_ARG`；gateway
`matter_update` 的 patch schema **含**它们但恒弹审批卡），三者都进 `context_snapshot`
投影（跟进 run 与事项对话都看得见「怎样算做完」）。勾满只提示可以推进到「已完成」，
**不自动改状态**：状态推进恒是用户的动作。

### 2.1 写并发：matter 级严格 CAS，子实体 bounded auto-rebase

所有写操作都带 `expected_version`（乐观锁），但两类路径的冲突判定**不同**（0813 A2）：

- **matter 级字段写**（patch / 归档 / accept / reject / permanently_delete）—— **严格 CAS**：
  `expected ≠ current` 即 `E_VERSION_CONFLICT`。「两处同时改 state / goal 必须被挡」是拍板过的语义。
- **子实体路径**（item / stakeholder / resource / relation 等 8 条 mutate）—— 服务层
  **bounded auto-rebase**：stale 时查版本账本，`(expected, current]` 区间内每一笔 bump 的
  scope 都与本次写不重叠才放行；账本盖不住整个 gap、或任一笔 scope 重叠（含 wildcard）→
  仍 `E_VERSION_CONFLICT`。根因是追加与独立行编辑没有「可失去的更新」，matter 级 CAS 对它们
  是钝化代理（9 连写 8 失败被迫串行）。scope 词表 / 序列化单源 `src/matters/proposal_scope.py`；
  附带修正：干系人 / 关系写的 scope 曾缺省 wildcard（一次加人作废全部待审提案的预存钝化），
  现在追加 = `SCOPE_NOTHING`、行编辑 = 行级 scope。

**版本账本** = `sync_state` 键 `matter_version_scopes:{matter_id}`（每事项保留最近
`VERSION_SCOPE_RETENTION=64` 笔 bump 的 scope；沿用 `alert.*` / `davmail.*` 先例，
**不 bump DB_VERSION**）。🔴 账本是**可丢**的簿记：丢失 / 损坏 / 形状不对 = 回严格 CAS
（fail closed，绝不放过真冲突），写账失败只降级不阻断业务写。

前端侧：`matterMutation.ts` 仍是带乐观锁写操作的唯一出口（冲突 ⇒ 强制刷新焊在包装里）——
auto-rebase 之后它收到的 `E_VERSION_CONFLICT` 都是**真冲突**，处置不变。
回归：`tests/matters/test_matter_version_rebase.py`。

### 2.2 时间戳单位：matter 域全部 epoch **毫秒**

所有时间戳字段（`due_at` / `completed_at` / `last_contact_at` / snooze…）一律 epoch 毫秒。
服务端 `service._require_epoch_ms`（合法区间 `[10^12, 10^15)`）在**三道门**上强制：
直写 mutate / propose（越界字段 fail-closed 剔除，不落进提案）/ accept backstop。

🔴 **有意拒绝、不静默 ×1000**：秒值静默换算会把上游单位错（0813 A3 实证：agent 经工具写
epoch 秒 ⇒ UI 恒显示 1970）永久藏住。工具 schema 各时间字段已标注 "epoch MILLISECONDS (UTC)"。
回归：`tests/matters/test_matter_timestamp_units.py`。

### 2.3 关注信号的「解决」：判据翻转前不再报

判据型信号（逾期 / 等待超期…）上 owner 点「解决」或「忽略」= **直到判据翻转前不再报**
（与 alert episode 语义对称；临时静默归 snooze）。实现在 `attention._open_episode_in_conn`：
`cleared_at IS NULL`（判据自上次人工处置后从未消失）时，resolved 与 dismissed 都抑制重开；
reconcile 观察到判据翻转才落 `cleared_at`，之后同一事实再成立才是新 episode（`recurrence_no`+1）。
此前只抑制 dismissed，「解决」在判据仍为真时下一个 tick 就被 60s 重算原样打开 —— 按不灭。

🔴 **`run_failed` / `context_gap` 豁免**（单源 `attention.py::EVENT_DRIVEN_ATTENTION_KINDS`）：
它们是事件驱动型、没有清账循环，resolved 也豁免会把「同一 run 再次失败」永久静默。

🔴 **抑制期内 severity 升级同样静默**（有意的衍生行为，不是漏洞）：抑制期里该 subject_key
没有 open/snoozed 行，于是 reconcile 那条「新事实 severity 更高 → 提级 + 清
`last_notified_at` 重新通知」的分支（只遍历 open/snoozed 行）根本够不着它，
`_open_episode_in_conn` 也在建行之前就返回了 —— 即 owner 点过「解决」之后，同一判据从
warn 恶化到 critical 也不会重新冒头，要等判据翻转（`cleared_at` 落）后再成立才开新
episode（那时按新 severity 开）。这是「判据翻转前不再报」的**直接推论**：既然承诺了不再报，
就不能留一条"变严重了就破例"的旁路 —— 否则逾期天数一跨阈值，被解决掉的信号就自己回来了。
要立刻重新看见，路径是 owner 侧的重开（或让判据先翻转），不是让系统自作主张。

### 2.4 干系人与全局通讯录（v52 `matter_contact` → **v54 起已并入通讯录 `contact` 三表**）

- **演进**：v52 建全局干系人库 `matter_contact`（身份 = 归一 email）；通讯录 epic
  （task 08-13，方案 A）的 **v54 迁移把它整体升级成通讯录三表**
  `contact` / `contact_email` / `contact_email_link` —— 迁移动作序：迁行 **id 保持**
  （`matter_stakeholder.contact_id` 的值因此不用改写）+ 每行生成主邮箱锚点 →
  rebuild `matter_stakeholder` 把 FK 目标从 `matter_contact(id)` 换成 `contact(id)`
  （SQLite 改不了 FK 目标，整表重建镜像 v45 先例）→ `DROP matter_contact`。
  🔴 **梯子冻结**：`MATTER_TABLE_DDLS` 里 `matter_contact` / `matter_stakeholder`
  的旧形状 CREATE **原样保留**（append-only）—— v52 块靠它们建表 + seed，新库满
  梯子先建旧形状再在 v54 换形；多做一次 rebuild 是幂等成本，换来梯子对 v44..v53
  全部中间版本成立。
- **身份纪律不变**：身份判据只有归一 email；无 email 的干系人**不入全局库**
  （`contact_id` 恒 NULL）——没有可靠身份键，按名字合并必然误并同名人。
- **写侧**（`service._mutate_stakeholder`，matters 域唯一写面）：create/update 带
  email → `_upsert_contact` —— v54 起它是**薄包装**，底层调通讯录写面单源
  `src/contacts/service.py::upsert_contact_for_email`（升级点：按 `contact_email`
  锚点找人 ⇒ 一人多邮箱下也命中同一人）。语义逐条继承 v52：非空姓名/组织 =
  最后写者赢、None 不动既有值、🔴 `fallback_*` 只填**新建**行的空位（改到别人已在
  库里的邮箱不许把那个人改名）。姓名/组织显式修改 → `_propagate_contact_identity`
  **写穿**到该联系人的其它事项行 + 刷搜索投影，🔴 不 bump 那些事项的 version、
  不发事件（联系人层的事实不是那些事项的业务动作，撞别人乐观锁才是 bug，有测试
  钉住）。代价写实不变：其它事项前端缓存不被动失效、写穿在那些事项时间线上无痕。
- **读侧已退役（通讯录 WP3）**：`GET /api/matters/contacts` +
  `/api/matters/contacts/email-candidates` 两端点、matters service 的
  `list_contacts` / `extract_contact_candidates` / `CONTACT_SCAN_WINDOW` 全部删除
  —— 干系人 picker（`MatterStakeholderPicker` 单页化）直接读 `/api/contacts`
  （服务端 q + 往来密度排序），库外邮箱经「以这个邮箱新建联系人并添加」入库；
  「从邮件提取」tab 退役（联系人由通讯录扫描器后台建成，无需事项侧现场扫）。
  通讯录本体（列表/档案/合并/组织关系/flag 语义）见
  [`../contacts/contact-directory.md`](../contacts/contact-directory.md)。
- 🔴 **关联索引红字照旧**：`MATTER_STAKEHOLDER_CONTACT_INDEX_DDL` 独立常量不进
  `MATTER_INDEX_DDLS`（那组会在 v44–v50 各迁移块对老库整组重放，而 `contact_id`
  到 v52 才存在，放进组里炸梯子）；同理通讯录三表 DDL 是独立常量组
  `CONTACT_TABLE_DDLS` / `CONTACT_INDEX_DDLS`，只从 v54 块执行。
  回归：`tests/matters/test_matter_contacts.py`（WP3 按新径等价改写）+
  `test_matter_v52_migration.py` + `test_contact_v54_migration.py`。

### 2.5 资料摘要与版本轨迹（v56 / v57）

`resource` 表 v56 起带 `sum` / `sum_src` / `sum_at` 三**真列**（不塞 `metadata_json`——`sum_at`
要判过期、`sum_src` 要参与筛选，两者都得靠 `json_extract` 反而更贵）。唯一写侧仍是
`_upsert_resource`（service.py）→ `_resource_summary_fields`，三类来源：

- **邮件类**（`kind` 为 `email` / `thread`）：`sum_src='mail'`，恒复用邮件自己的摘要
  （`_mail_summary_fields` 读 `llm_processing.labels_json.$.ai_summary`；thread 取线程内
  最新一封带摘要的邮件），**不重新生成**——调用方传入的 `sum` 一律忽略，提示词不守规矩也
  编不进去。`ai_summary` 取不到（LLM 未开 / 失败 / 积压）→ 三列 `NULL`，**留空不合成**
  （不拿主题+正文拼一句充数）。
- **其余 provider**：吃调用方显式给出的 `sum`（Agent 发现资料的提案通道，字段契约见 §8
  跨语言一致性闸表 `matterProposalNewResource` 那一行）；`sum_src` 缺省 `'agent'`；手动关联
  不带 `sum` → 空态，等下次跟进 run 生成。
- `access_policy='metadata_only'` 一律不生成三列（无论来源）。
- `repository.upsert_resource` 命中已有 `(provider, external_key)` 行时是**白名单增量更新**、
  不是整行覆写（v56 前是 INSERT-ONLY，摘要对存量资料永远写不进去）：`title` / `canonical_url`
  只补空；`metadata_json` 浅合并、既有键绝不丢；三摘要列只在给出非空 `sum` 时一起写；身份三列、
  抓取产物（`revision` / `content_hash` / `last_checked_at`）、`access_policy`、`created_at`
  恒不覆盖——收进更新面等于用 `None` 冲掉抓取结果，或把「仅元数据」静默翻回 `allowed`。

`resource_version`（v57）记录**已被取代**的资料版本快照——挂全局 `resource` 而非
per-matter，故无 `matter_` 前缀。两条「不撒谎」的设计，改这块前必须记住：

- **当前版本有意不入表**：它就是 `resource` 行自己（`revision` / `content_hash` / `sum` 三组
  列）。写进 `resource_version` = 同一事实两处存，必然漂移；读侧把「`resource` 行 + 轨迹行」
  拼成完整轨迹，UI 给 `resource` 行标「当前」（有测试钉住 `current.content_hash ∉ trail`）。
- **老库升级后轨迹是空的，不拿现值回填**：那份资料确实检出过一次，但那一次不是「历史版本」，
  回填 = 把「只检出过一版」谎报成「有过一版历史」（v57 迁移纯 DDL，无 DML）。

唯一写者是 `MatterService.fetch_url_resource`（全仓也只有它写 `revision` / `content_hash` /
`last_checked_at`），归档点在它那条 `UPDATE resource ...` **之前**——写在之后轨迹里全是当前值
的复读，且只数行数的测试看不出来。首次检出（`content_hash` 此前为 `None`）与 hash 未变（重抓
同一份内容）都不留档：是「没有上一版」不是偷懒。`diff_text`（这一版被取代时变了什么，一句话）
由跟进 Agent 在提案里给、接受时经 `repository.fill_latest_version_diff` 回填进**最新那条轨迹
行**；`diff_text IS NULL` 是幂等闸，不覆盖已经给 owner 看过的那句；轨迹为空（没有上一版）就
静默丢弃，不新建行；没人给就留 `NULL`（不按字数差之类的机械指标编一句充数）。

空态判据单源在服务端 `_resource_tracks_versions`（`resource.kind == 'url'`——`revision` /
`content_hash` / `last_checked_at` 全仓唯一写者就是 URL 抓取路径），经 `tracks_versions` 字段
交给前端；前端**不按 `kind` 自己推**，那会是第二处真源。三档空态：不跟踪版本的资料类型（邮件 /
会话 / 文档 / 附件）说清「这一类没有」；跟踪但还没检出过，说「抓取之后才会开始记录」；服务端
没答上来（loading / 出错）整区不渲染，宁可少说不猜。

### 2.6 事项变更如何到达前端（S1，2026-08-18）

写完的事项**不会自己出现在屏幕上** —— 前端是 react-query 缓存，要么被显式失效，要么等
staleTime 过 + 组件重挂。两条链路都必须在场：

**后端 → 事件**。`MatterService._transaction()` 是事项域**唯一**的写事务出口
（闸：`tests/matters/test_transaction_gate.py` —— `service.py` / `run_service.py` 里不许再直接
用 `repository.transaction()`）。`_append_event()` 每落一条 `matter_event` 就登记该事项的
public_id，**事务提交后**统一发 `matter.changed`。

🔴 发布点在 commit 之后，不是之前。事件是 invalidation hint，前端收到就立刻 refetch，
而 refetch 走另一个连接 —— 早发一步前端就读到旧值，症状与修之前一样、只是更难查。
守这条的是 `test_publish_happens_after_commit`（在发事件的那一刻用独立连接读，必须已能看到新值）。

**事件 → 前端**。REST 写落在 `serve-api` 进程，而 SSE 由 `serve` 进程的 9200 提供 ——
`safe_publish` 在 serve-api 里曾经是 no-op。现在它会回落 loopback（POST 给 serve 的内部
publish 端点）。完整三条路与鉴权见
[`integrations/sse-events.md`](../integrations/sse-events.md) 的「跨进程投递」。

**前端失效**。清单单源 `matterMutation.ts::refreshMatter(client, matterId)`，
用户点击路径与 SSE 路径共用同一份（闸：`frontend/tests/components/matters/matterRefreshGate.test.ts`）。

🔴 那份清单里**必须**有跨事项的 `qk.matters.pendingUpdates()`：焦点页「待审阅 · Agent
更新提案」是跨事项聚合，结构上不可能被 `['matters','detail',id]` 前缀覆盖。0818 的
「已接受的提案还留在待审阅里」就是它被漏在手抄清单外。

---

---

## 3. 触发器（四种，`src/matters/triggers.py` 是解析单源）

`matter.schedule_json` 这一列的**内容**是 v2 envelope，列名不改：

```json
{"v": 2, "triggers": [{"id": "mtr_ab12cd", "kind": "schedule", "enabled": true, "...": "..."}]}
```

老形状（单个 schedule 对象）在**读侧**惰性映射成单 entry，**不改写库**。

| kind | 判据 | 幂等键里的证据 |
|---|---|---|
| `schedule` | 复用 `src/agents/schedule_rule` 求值器（该模块**零改动**）| occurrence 时间 |
| `event` | 按 `event_type` 分两族：`resource_linked_mail` / `resource_doc_updated` 判**新增的 `matter_event` 行**（新证据到达）；`calendar_event_ended` 判**本事项已确认的 `kind='event'` 资料有刚结束的 occurrence**（`worker._calendar_ended_evidence`，判据不在 `matter_event` 表）| event id；日历那族是 `{ical_uid}\|{recurrence_id}\|{occurrence_end}` |
| `condition` | **open 状态**的 `matter_attention` 信号 | 信号 id + subject_key |
| `manual` | 不自动触发；由失效提案上的「重新跑一轮」等手动 run 入口（`POST /{id}/runs`）驱动 —— 详情头「立即跟进」已是**对话**入口，不产生 run（§1）| — |

🔴 **两条硬约束**：

1. **per-trigger marker**：marker 键是 `matter.trigger.last_fire.{matter_id}.{trigger_id}`。
   两条 trigger 共用一个键时，先 fire 的会把 marker 推到未来，另一条**永远**被判成已跑过。
   **v1 单 trigger 行沿用旧键** `matter.schedule.last_fire.{id}` —— 换键等于「从没 fire 过」，
   升级瞬间会立刻补跑一次。
2. **单条 entry 坏掉只跳过它自己**，不牵连同一事项的其它 trigger。

**EVENT/CONDITION 的选项集刻意小于设计稿**：只收录能映射到既有判据的项。
「超过 5 天无进展」（后端无此判据）仍**不做** —— 与其给一个永不触发的选项，不如不给。
「会议结束」曾因日历与事项零接线被砍，**L4 批次 1 起由 `calendar_event_ended` 落地**：
判据源是 `calendar_event`（`CalendarEventRepository.list_ended_occurrences`），前提
`CALENDAR_CALDAV_SYNC_ENABLED`，关闭时静默不触发；迟到超过 30 分钟（`CALENDAR_ENDED_FIRE_WINDOW`）
不补跑。🔴 判定挂 agenda worker 的 60s tick，**绝不挂 5s radar poll**。
`wait_overdue` 的 UI 文案按**真实阈值 7 天**写（`attention.WAIT_OVERDUE_DAYS`），不按设计稿的 3 天。

🔴 **`enqueue_run` 的 `trigger_kind` 值域 = `MatterRunTrigger` 全集**（与 `matter_run` 列的
`CHECK` 同源）。P6-B 给 worker 加 event/condition 触发时漏改这道守卫，于是真实 run_service 下
event/condition 一 fire 就被拒、被 `_schedule_tick` 的 per-trigger 兜底吞成一条 warning ——
而测试用的 FakeRuns 不经过它，**全绿**。L4 批次 1 修复，回归闸在
`tests/matters/test_matter_calendar_ended.py::test_event_trigger_enqueues_through_real_run_service`
（跑真 `MatterRunService`，断言 `matter_run` 里真有那一行）。

**新建事项**默认 `agent_enabled=1` 且带一条默认排程（每 3 天 · 09:00）——
开关开着而没有排程 = 永远不跑 = 一个说谎的开关，两者必须一起给。
🔴 **存量事项不回填**：迁移只改建表默认，不 `UPDATE` 既有行。

> 改存储形状时，**「谁在读它」必须和「谁在写它」一起清点**。升 v2 那次，前端两处解析仍只认
> v1，会把 v2 行读成「没有排程」而新建事项默认就是 v2 —— 没有任何闸会红，只能靠 recon 发现。
> 现在解析收口在 `frontend/src/shared/components/matters/matterSchedule.ts`。

---

## 4. 跟进 run：任务契约与终态

`run_spec._task_contract()`：owner 在全局配置面写过就用他的，否则**逐字回落**代码里的
`_TASK_CONTRACT`。是**替换不是拼接**（拼接会让同一份准则出现两遍）。

- 存储 = `agent_config.db` 的 profile doc，doc name `matter_agent`。
- 🔴 **不进 `PROFILE_DOC_NAMES`** —— 那 4 份是恒注入每次对话的可信身份，把跟进任务契约塞进去
  会污染所有普通对话。镜像 `memory.md` 的既有先例。
- 🔴 **不进 `SEED_TEMPLATES`** —— 没有 seed 模板，「行内容为空」才能作为「跟随代码默认」的信号。
  于是「恢复默认」就是清空，以后默认文案升级能自动惠及没自定义过的用户，而不是被一份历史快照冻住。
- 事项级 `matter_instructions` 是在这份基底**之后追加**，不替换。

每轮 task prompt 的拼装顺序（`run_spec.py`）：任务契约 → 本轮可做的动作（由 `schedule_json` 推）
→ 上下文快照 → 变更清单（watermark diff）→【补充指引】（profile persona + 事项级指引，套
`PERSONA_PREFIX` 围栏）。

**curated 进展（0825）**：快照含近 10 条 live 进展（owner 与 Agent 共同维护的事情脉络）；
任务契约末尾三条进展职责——run 没有进展写工具，要记就在提案里写 `progress` change
（`{kind,title,body?,happened_at?,refs?}`，纯追加、owner 接受才落行）；何时记 / 纯抄送不记 /
与行动项的分界都写在契约原文里（`run_spec._TASK_CONTRACT`）。事项对话侧的对应职责在
`src/skills/builtin/matters.py` 的恒注入方法论段（工具 `matter_progress_mutate`）。

### 4.0 事项级模型覆盖（model / effort / fallback）

三项跟着 `schedule_json` 的 v2 envelope 走 —— 新增 `agent` 块，**零 DB 迁移**（与 `actions`
同一条纪律：它们和触发方式同属「跟进规则」那一张卡、同一次 PATCH）。归一化单源 =
`src/matters/triggers.py::normalize_agent_overrides`（写侧值域外**入库即拒**）/
`parse_agent_overrides`（读侧宽容，认不出的字段丢掉、剩下的照用）。前端镜像
`matterSchedule.ts`，形状由 `tests/fixtures/matter_trigger_envelope.json` 跨语言钉死。

```json
{"v":2,"triggers":[…],"actions":[…],
 "agent":{"model":"default:claude-x","effort":"medium","fallback_models":["default:claude-y"]}}
```

- 三项都是**覆盖**：键缺席 = 跟随现状（model/fallback 跟绑定 profile、再跟全局默认）。
  🔴 唯一例外 `fallback_models: []` = **显式不设兜底**，与「没配过」不是一回事，必须能表达
  （否则绑定 profile 的兜底链会偷偷跑回来）。
- 🔴 **`normalize_trigger_json` 的空折叠判据随之改**：「一条 trigger 都没有」不再无条件写
  NULL，只有**模型覆盖也空**才写。否则把触发方式全删掉（改成纯手动跟进）会把刚配好的三项
  一起抹掉，而界面上看不出任何异常。
- 🔴 覆盖只碰 `spec` 的 model / effort / fallbackModels **三个键**；D2「profile 只贡献
  model/persona」与工具面红线（`allowedTools` 恒 `[]`、`grantExec` 永不写、budget 恒 1800s）
  一个字节不动。
- **effort 只在选定模型后可选**，且该模型要有 reasoning 能力：档位阶梯按模型家族给
  （`effortOptionsForModel`），而对无 reasoning 能力的模型下发 effort 参数，openai/deepseek
  协议会往 wire 上塞一个多余参数（16b 契约）。「跟随默认」时根本不知道最终跑哪个模型，也就
  无从判断 —— 与其发一个可能让整个 run 400 的参数，不如把「先选模型」说出来。
- 消费端：gateway `runHeadlessAgent` 把 `spec.effort` 投成 `body.effort`（`prepareChatRun`
  既有通道，`effortTierFromBody` 对未知档位 fail-closed），并按 `spec.fallbackModels` 走模型链。
  🔴 **重试只在「这次尝试什么都没产出」时允许**（没吐字 / 没完成 step / 没停在待确认 / 没被
  预算或停止打断）—— 已经产出的 turn 重跑就是双计费 + 双落库 + 可能重复调用工具。
  🔴 `fallbackModels` 在此之前是**投了但没人读**的死键（链只活在 Python 的
  `llm_agent/client.py`，而 gateway 驱动的 headless run 根本不走那条路）；加配置面必须同时
  加消费端，「保存了但不生效」比没有更糟。

### 4.1 全局配置面呈现什么

入口有两个，指向**同一个弹窗**（`MatterGlobalAgentModal`）：设置 → 事项（深链）、
事项详情 → Agent 配置 →「全局配置」。🔴 设置页**只做深链不复制表单** —— 同一份数据画两个可写面
就是第二处真相（`/connectors` 收编内置工具审批档时踩过同一条线）。

弹窗自上而下三块：

1. **Prompt 装配说明**（只读）—— 每轮 prompt 由哪几段拼成、你改的是哪一段；
2. **任务契约编辑框** —— 唯一可改的那一段（库里空 = 跟随代码默认，见上）；
3. **工具面板** —— 31 件逐项列出 + 唯一可改的网页三档。

设计稿画的「8 个可用工具勾选」**不做**：那 31 件是服务端按 class 强制推导的（§1.1），
勾选框勾不掉也勾不上 —— 画出来就是假开关。改为**列出来 + 标明哪些固定**；真正可配的只有
网页那一档（`matter_run_web_face`，服务端确实读它），它才做成真开关。

🔴 **`fixed` ≠「一定拿得到」**：带 `skill` 的分组（email / search / report）受 skill 门控 ——
owner 在 设置 → Custom AI → Skills 关掉某个 skill，跟进 run 真的一件都拿不到。`fixed` 说的是
「**事项级**不可改」，不是「全局关不掉」。界面必须按 `advertisedSkills` 把关掉的那组标出来，
否则又是一句谎；🔴 投影没回来时 **fail-open 判可用** —— 把「不知道」说成「关了」同样是撒谎。

### 4.2 run 终态：已交出提案的 run 不记 `fail`

matter run 终态四值 `ok / noop / warn / fail`（+ `canceled`），映射单点
`src/agents/run_worker.py::_map_matter_response`。0813 #17 起的判据：

- gateway outcome ≠ completed 但**提案已交出**（propose 端点暂存成功）→ 记 **`warn`** 不记
  `fail`。提案是这条 run 的唯一产出通道、每 run 至多一个（`E_PROPOSAL_EXISTS`），交出之后
  剩下的只是收尾叙述；错误码与原文照旧留在 `error_json`。**没有提案时一字未动，仍是 `fail`**
  （真失败判据没有放宽）。假 fail 的害处不止 UI 显示「失败」：`matters/worker.py::_retry_tick`
  会对 manual fail 开一条 **critical** 关注信号，假失败还污染提醒面。
- transport failure（poke 超时 / 非 2xx）同判据记 `warn`，但 🔴 **不写 `output_watermark`** ——
  连响应都没拿到，无从断言这轮看完了当前指纹，留给下一轮重新比对；stream-error 分支的
  watermark 与 completed 分支同写（那份提案覆盖的就是这个指纹）。
- **async job 侧仍记 `failed`** —— 它记的是「这次 gateway 调用出错了」，与「这轮产出了什么」
  是两件事，各自如实。
- 配套可诊断性：`toAgentRunWire` 额外发 `errorMessage`（additive，`error` 字符串码原样不动），
  Python `_matter_error_payload` 落 `{"code","message"}`（截 500 字符）—— RunOverlay 的
  `run.error?.message` 此前是永远取不到值的死读法，就此接通。gateway 的 `console.error` 在
  打包 app 里仍然哪儿都不去，错误原文进 run 行是目前唯一的落点。
  回归：`tests/agents/test_run_worker_matter.py`。

### 4.3 行动项执行契约（`matter_item_run` 派发，L4 批次 3，DB v71）

把 `kind='action'` 的行动项变成**可派发最小单元**。账本 = 新表 `matter_item_dispatch`
（独立常量组 `MATTER_ITEM_DISPATCH_TABLE_DDLS`，🔴 不进 `MATTER_*_DDLS` 老库重放；
每条行动项至多一条活跃派发，partial unique `uq_item_dispatch_one_active`）。
**不写 `matter_run` 行** —— 单活跃约束、终态词表都与跟进 run 无关。

- **状态机七值**（Python canonical `MatterItemDispatchState`，TS 单镜像 + parity 闸）：
  `queued → running → awaiting_input | proposed → done / failed / canceled`。🔴 全部迁移由
  **服务端 CAS** 强制（条件 UPDATE + rowcount），不信 agent 自述——执行态与 `matter_item.status`
  （业务标签）**两列并存不合一**（Notion 手搓状态机的教训）。终态判据 = `ended_at IS NOT NULL`。
- **执行链**：`dispatch_item`（REST，用户动作）→ enqueue `matter_item_run`（🔴 事务外，失败收敛
  failed）→ `AgentRunWorker._execute_item_dispatch` → gateway headless（contextMode **复用
  `matter_followup` 档**，隔离由锚保证；`allowedTools` 恒 `[]` 三处强制照旧）。
  executor 可选内建 `matter_followup` 或 custom agent，后者**只取 model/effort 段**——工具面
  挂行动项不挂 agent。孤儿收敛 `recover_orphaned_dispatches`（JOIN async_jobs，镜像
  `recover_orphaned_runs`）；**无 lease 列**（单进程 worker 下预算超时 + 孤儿收敛已等价，
  外部执行器时代再上）。
- **交付恰一次**：run 末尾调 `matter_item_report`（artifact 级，镜像 `matter_update_propose`
  形状，内部端点 `POST /api/matters/{id}/item-dispatches/{did}/report`，本地 token + 服务端盖章）。
  载荷 `changes` XOR `needs_input`（🔴 分支约束下沉 Python，schema 恒 flat）：
  - `changes` → 防幻觉剔除（action target 限本行动项；🔴 **`kind=field` 恒拒**——owner 自己的话
    不进无人值守写半径）→ 建 `matter_update`（带 `item_dispatch_id`）→ `proposed`；
    owner accept → `done`，reject → `canceled`；🔴 **同事项别的提案被采纳把这份 supersede 掉时
    同样回钩 `canceled`（code `proposal_superseded`）**——否则派发停在 `proposed` 两边面都
    看不见、还占着单活跃锁（check 抓的黑洞）。终态后可重派。
  - `needs_input` → `awaiting_input`（问题落 `question_json`）。🔴 **反问是 run 终止式不是
    mid-run 暂停**（审批 stash 是进程内存，headless 反问靠它重启即丢）：owner 回答 →
    answers_json 追加 + 回 `queued` + 新一轮 run 带问答史。
- **执行档 `exec_profile`** 挂行动项（`matter_item` v71 新列，同一 agent 不同行动项可不同档）：
  `propose_only`（默认）/ `autonomous`（report 落提案后同事务自动采纳，actor=system，走既有
  undo 面）/ `edit_with_approval`（词表预留，**不上 UI**，B4 动态审批再启用）。
- **可见性挂行动项**：会话锚 `ai_chat_sessions.item_id`（CHAT_DB v28）反查 + `/today` 第四源
  直读派发行（`awaiting_input` → 等我处理、`failed` → 需要留意；`proposed` 有意不进面——由
  提案源覆盖，同 `needs_review` 去重取向）。派发失败**不发通知**，例外面是唯一提醒面。

---

## 5. 智能关联

🔴 **关键词命中式推荐已整条退役（2026-08-25 owner 拍板：置信度太低，徒增烦恼）**：
`discover_resource_suggestions`（跟进 run 起跑扫描 + REST discover 端点 + gateway
`matter_suggest_related_resources` + chat 缺口卡「外扩检索」）与关键词召回那一趟
（`RESOURCE_TERM_WEIGHTS` / 准入线 / `expand_reason` 三档）全部删除。资料推荐现在**只有
两条 LLM 路径**：① 跟进 run 在提案里带 `resource` change（owner 评审后落地）；② 事项
对话里 agent 自己检索（全库只读工具面）后经 `matter_resource_mutate` 建 link（审批卡）。
缺口卡的 CTA 改为经 `startMatterChatWithPrompt` 让事项 agent 检索并关联。
仍会产生 unconfirmed 建议行的信源只剩**会议结束→出席者身份匹配**（见下，身份锚定非关键词）。

- **拒绝记忆**：建议被拒后，同证据不再重现。「实质新证据」= 持久锚点集（线程 id / 干系人
  邮箱等）变化；指纹**显式排除**时间戳、随机 id、置信度，所以重复出现的同一事实绕不过
  拒绝，而真有新锚点时能重新建议。
- **会议结束 → 关联提案**（L4 批次 1 #3）：agenda worker 的 `_calendar_proposal_tick` 扫刚结束的
  occurrence，与会者 email 走**双腿**匹配（`contact_email` 锚点 → `matter_stakeholder.contact_id`；
  兜底 `matter_stakeholder.email_normalized` 直匹）到 open matter，命中就写一条
  `kind='event'` 的**未确认** link（`resource_key = event:{ical_uid}`，**系列级**：拒一次管整个
  系列，否则周会每周重来一遍 = 审批疲劳）。🔴 **零自动写** —— `confirmed_at` 恒 NULL，确认/拒绝
  全在 owner 手里；幂等、拒绝记忆、backlog cap 与下面的建议家族逐条复用。
  全局 watermark 存 `sync_state['matters.calendar_ended.watermark']`，离线超过 2h 不补提案。
- **重复候选**：四信号加权可解释（资料重叠 / 干系人重叠 / 语义 Jaccard / 30 天内邻近），
  每条带理由与证据。时间邻近**只在已有其它信号时**才加分 —— 否则「同期创建」会把无关事项凑成候选。
- **URL 抓取**：零自研 SSRF 防护，直接复用 `src/api/routers/web.py::_do_fetch`（有测试钉死调的就是它）。
- **创建带调研**：纯读端点产草案，**不写库**（有测试钉死）；标题走确定性推导，无 LLM 依赖。
- **手动关联的候选**（`GET /{id}/resource-candidates`，只读）：候选引擎
  `_email_resource_candidates` 现在**只剩 local 档**（线程 / 干系人硬锚；关键词召回随
  0825 退役一并剪除，`query` / `expand_reason` 参数位已不存在）。一个字都不写
  （不建 link、不发事件、不推版本），**打开弹窗本身没有副作用**。用户在弹窗里想按
  关键词找邮件走的是另一条路 —— 前端的全局邮件搜索（FTS5）。
- **本事项邮件附件**（`GET /{id}/resource-attachments`，只读）：🔴 **一条 SQL 拿全部** ——
  逐封扇出 `attachment/list/{internal_id}` 在挂了几十封邮件的事项上就是几十个请求
  （`frontend/ARCHITECTURE.md` §7.1 列表性能铁律）。`is_inline=0`：正文里的 cid 图片不是「资料」。
- 🔴 **干系人「往来候选」依赖 email resource 的 `sender` / `to_addr` / `cc_addr` metadata**，
  这三个键 0812 起才在两条生产路径上产出 —— **存量 `matter_resource` 行结构性为空**，
  那些事项的往来候选是空的，不回填。0813 起 Picker 第一步是三组池（纯函数
  `buildStakeholderPickerPools`）：**本事项往来**（即上述 metadata 推导，零请求）→
  **联系人库** → **从邮件提取**（一键显式触发，不在每次开弹窗白跑）——存量空洞由后两组
  与手输兜底。

---

## 6. 启用与控制面

**2026-08-19 cutover**：事项域与事项跟进 Agent 的 venue env 总闸及全部载体已退役；
router、gateway 工具、run spec、worker 与通知链恒接线。`/chat/config.mattersEnabled` 和
`matterAgentEnabled` 作为兼容投影保留并恒为 `true`。

自动运行的安全控制不变：事项跟进仍由每条 Matter 的 `agent_enabled`、触发器与排程控制；
工具 class 腰带、connector 档位与 headless 写入限制继续生效。

**owner 设置两项**（`agent_config.db` 的 `owner_settings`，**不是 env**，保存即生效）：

| 键 | 默认 | 值域 | 端点 |
|---|---|---|---|
| `matter_run_web_face` | `keep` | `keep` \| `search_only` \| `off` | `GET/PUT /api/agent/matter-web-face`，语义见 §1.2 |
| `matter_notify_level` | `high` | `high` \| `all` \| `off` | `GET/PUT /api/matters/notify-level`；越域 400，worker 侧再归一一次 |

---

## 7. 运维

```bash
# 事项与信号的分布
sqlite3 "$DB" "SELECT status, COUNT(*) FROM matter WHERE deleted_at IS NULL GROUP BY status"
sqlite3 "$DB" "SELECT kind, state, COUNT(*) FROM matter_attention GROUP BY kind, state"

# 待评审提案
sqlite3 "$DB" "SELECT matter_id, COUNT(*) FROM matter_update WHERE review_status='pending' GROUP BY matter_id"

# 某事项的触发器配置（v1 单对象 / v2 envelope 都可能）
sqlite3 "$DB" "SELECT public_id, agent_enabled, schedule_json FROM matter WHERE public_id='MAT-0001'"

# 触发器的 last-fire marker
sqlite3 "$DB" "SELECT key, value FROM sync_state WHERE key LIKE 'matter.%last_fire%'"
```

🔴 **活库在 userData 不在仓库 `data/`**：
`~/Library/Application Support/mailagent-frontend/data/sync_store.db`。

---

## 8. 跨语言一致性闸

| 闸 | 管什么 |
|---|---|
| `tests/matters/test_matters_contract_parity.py` | 枚举常量数组（TS `as const` vs Python canonical values）+ SQL CHECK 值集 + chat_config flag 投影。**不管** `MattersApi` 这个纯前端接口的方法列表 |
| `frontend/tests/ai-gateway/matter_tool_face_leaf.test.ts` | **工具面说明书 ↔ 真实 ToolSet 双向**：(a) 表里每个名字都真的在工具面里（无幽灵条目）；(b) 工具面里每个名字都落在某个分组里（无藏起来的能力）；(c) 关掉一个 skill 后真实消失的那批 == 叶子里标了该 skill 的那批。跑的是真实 `runHeadlessAgent` + `buildGatewayTools`，不是另一份手抄名单 |
| `tests/config/test_matter_web_face_parity.py` | 网页三档词表 + 缺省值的**三份手抄**（Python 端点 / gateway policy.ts / renderer hook）。🔴 renderer 那份漂了 **typecheck 不会红**（`readonly MatterRunWebFace[]` 装子集合法），只能靠这道闸 |
| `frontend/tests/shared/matterEventLocale.test.ts` | 两份 locale 覆盖 `MATTER_EVENT_KINDS` 全集。kind 数量会随功能增长，所以判据是**从 events.py 抽全集**，不是写死的数字；闸自身也断言「抽不到就红」。同文件另盖 `matters.trigger.event.*` / `.condition.*`：locale 是 trigger 词表的**第三份手抄**（Python → TS 有 parity 闸，locale 没有），少一条 key 时下拉直出裸标识符而两侧词表仍一致、其它闸全绿 |
| `tests/matters/test_matters_contract_parity.py::test_every_resource_kind_has_an_identity_landing_or_explicit_exemption` | 资料 kind 词表 ↔ identity 层落点。病根：`MatterResourceKind.EVENT` 在词表里躺了数月却没有 `event_resource_key`、`normalize_resource_key` 不认、存在性判定不查 —— 值域校验全绿而这个 kind 结构上用不起来。闸要求每个成员**要么**有真实 identity 落点（probe 直接调真函数 + parse/normalize 双向认领 + 收编进 `_KINDS_BY_PROVIDER['mailagent']`），**要么**进显式豁免清单（`doc`/`url`，key 由 connector / URL 自身发号）|
| `tests/matters/test_matter_trigger_envelope_parity.py` | trigger v2 envelope 的跨语言形状（含 §4.0 的 `agent` 覆盖块）|
| `tests/matters/test_matters_contract_parity.py::test_effort_tier_value_set_matches_the_typescript_canonical_ladder` | effort 档位值域**与顺序**（canonical = TS `effortTiers.ts::EFFORT_TIERS`，Python 手抄在 `triggers.MATTER_AGENT_EFFORT_TIERS`）。顺序也算：档位是有序阶梯，漂了「向下取最近可选档」就选错档 |
| `tests/matters/test_matters_contract_parity.py::test_new_resource_proposal_shape_agrees_across_every_hand_copy` | `matterProposalNewResource` 提案契约的**五份手抄**（zod schema / 工具描述 / pydantic DTO / `normalize_new_resource` 返回键 / TS 读类型）互相一致。抽取器 `ts_zod_object_field_names()` 定位源码里的 `const <name> = z.object({...})` 前先把字符串 / 模板串 / 正则字面量与两种注释（`//` 与 `/* */`）整段抹成空格——不做的话，把字段**注释掉**闸依然绿。抽取失败（锚点找不到 / 花括号未配平 / 抽出空集 / 丢了 `.strict()`）必须红，不许静默放行当通过 |
| `tests/api/test_context_mode_consistency.py` | `deriveContextMode` 的源码形状（正则闸，见 §1.4）|
| `frontend/tests/components/matters/matterSchedule.test.ts` | 排程解析两种形状都认 |

---

## 9. 列表信息架构

清单页只有两个 42px tab（`list` / `board`）；176px 的「视图列」（12 档 + 标签区）与
`MatterView` / `MATTER_VIEWS` / `filterView` 一整套已退役。查询模型单源 =
`frontend/src/shared/components/matters/matterListQuery.ts`：tab / **四范围**
（`open` / `done` / `archived` / `trash`，`MATTER_SCOPES`）/ 可叠加的快捷筛选
（`MATTER_QUICK_FILTERS`：关注中 / 等待 / 到期 / P0-P1 / 有提案 / 缺下一步）/ 状态组
（六个语义组，`MATTER_STATUS_GROUP_MEMBERS`）/ 优先级 / 标签多选（类别间 AND、标签间 OR）/
分组维度（`MATTER_GROUP_MODES`：`status` / `due` / `priority` / `tag` / `none`）/ 排序四档
（`MATTER_SORTS`：关注度 / 最近更新 / 到期 / 优先级）全部从这里取，组件里不再各自现算。
筛选面收成一个 `Popmenu`（本仓既有原语，未移植设计原型 `nested-menu.jsx`——两者同上游）；
🔴 **标签已回到筛选菜单**（`MatterList` 的筛选下拉），这是对轮 3「标签作为导航入口」退役
决定的**有意反转**（owner 拍板）——两条决定不矛盾，反向闸已重写而非删除，现在钉的是
「标签只在筛选菜单里、不在左轨」。

四个范围映射服务端 `view` 查询参数（`matterScopeParams`）：🔴 顺带修了一个既存 bug——
「已归档」「回收站」两个范围此前恒为空（客户端按 `archived_at` / `deleted_at` 过滤，但请求
从不带 `view` 参数，服务端默认子句 `deleted_at IS NULL AND archived_at IS NULL` 早把这两类
行排除，两个 pip 从来没有机会显示）。

列表主体按分组维度渲染 29px 粘性组头（chevron + 维度符号 + 组名 + 计数；点击折叠；空组不
渲染；`none` 维度不出组头）；分组产物 `groupMatters()` 同时驱动详情页的上/下条导航序
（`orderedMatterIds()`）——分组重排视觉序后若仍用旧的扁平序，「下一条」会跳到屏幕上别处，
两个调用点共享同一份三入参（含 `now`，从工作台统一传下，避免 `MatterList` 自己挂载时冻结
一份、跨零点或 tab 切换重挂时与工作台劈叉）。冷启动记住选中：`matters:lastSelId`
（localStorage，独立模块 `matterLastSelected.ts`）存 `public_id`；有记录且在默认 `open`
范围内可见 → 落 list tab 并选中，否则退化为选第一条；恢复只在默认范围里找，不为了恢复选中
擅自改用户的范围/筛选。

🔴 **能力边界**（改分组 / 筛选 / 排序前先读，判据单源住在 `matterListQuery.ts` 文件头注释）：
清单是**服务端游标分页**（`GET /matters`，`limit` 硬上限 100，前端只取一页）；筛选 / 状态组 /
优先级 / 标签多选 / 分组 / 派生排序（关注度 / 到期 / 优先级三档；「最近更新」是唯一有服务端
等价物的排序）全部在**当前一页（≤100 行）**上运算，服务端没有对应参数。事项量超过一页时，
被筛掉的行可能根本没被取回来——这是已知边界，不是 bug。头部「命中数 / 范围总数」中的范围
总数只在 `open` / `done` 的活跃行 ≤100 时精确（服务端 `meta.total` 是「全部活跃行」而非该
scope 总数）；截断时返回 `null`，头部只显示命中数，不显示可能算错的范围总数。

**到期口径**统一为「7 天内到期，含已逾期」，单源 `frontend/src/shared/lib/matterDerive.ts`
的 `isMatterDueSoon` / `matterDueDayDiff` / `MATTER_DUE_SOON_WINDOW_DAYS`（= 7）——看板 tile
计数、看板「临近到期」列表、清单 `due` 快捷筛选三处直接调用同一个判据（此前各自独立算，两处
14 天不含逾期 + 一处 7 天含逾期，三者互不一致）。看板第四 tile 是「缺少下一步」
（`nextAction(matter).kind === 'missing'`，按 kind 判、不按文案），`healthyRate` 字段与其
i18n key 已删除（零消费的遗留计算）。

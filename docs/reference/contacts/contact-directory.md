# 通讯录 Contact Directory（task 08-13，WP1–WP5）

> 常青参考：描述通讯录子系统「现在如何」。过程产物（handoff / recon / 验收）在
> `.trellis/tasks/08-13-contact-directory/`（local-only）。设计权威 = 该 task 下的
> `contacts/HANDOFF-通讯录设计规格.md` + 原型 `Contacts.html`（`c*.jsx`）。

## 1. 定位与启用语义

把「和我有邮件往来的人」变成第一类对象：零人工录入，由后台扫描器从
`email_metadata` 确定性建库（人物档案 = 多邮箱锚点 + 往来账本 + 身份字段 +
组织关系），一级导航「通讯录」（VIEW 组）双栏工作台消费。

- **2026-08-19 cutover**：通讯录成为默认能力，旧 venue env 总闸与全部载体已退役。
- `new_watcher` 恒挂扫描独立低频节拍（`MAILAGENT_CONTACT_EXTRACT_INTERVAL_SEC`
  默认 120s，🔴 绝不挂 5s radar poll；日历第三源是**另一条**节拍，见 §3.1）+
  `/api/contacts/*` 恒激活 + 导航恒渲染。
  `/chat/config.contactsEnabled` 作为旧前端兼容投影保留并恒为 `true`。
- **v54/v55 表结构恒在**；画像/治理自动运行仍由 Agents 页对应行的 `enabled` 控制。
- 配套 env：`MAILAGENT_SELF_EMAILS`（逗号分隔 owner 历史自有地址，**兜底级**）。
  自有地址集 `resolve_self_addresses` = `USER_EMAIL` + 本键 + 库内 `is_self=1`
  联系人名下**全部锚点**（task 08-14 WP-3 起第三源是权威源，见 §4.1）；它决定
  出向 `sent_to_count`、关联邮件方向三分、compose 收件人补全的排除。改后
  `mailagent contact backfill --rescan` 收敛。

## 2. 数据模型（SyncStore v54 + v55 + v59 + v67 + v69）

DDL 单源 = `src/mail/sync_store.py::CONTACT_TABLE_DDLS` / `CONTACT_INDEX_DDLS`
（🔴 独立常量组只从 v54 块执行，**不进 `MATTER_*_DDLS`** —— 那组会对老库在
v44–v50 各块整组重放，新表混进去炸梯子）。

| 表 | 作用 | 关键约束 |
|---|---|---|
| `contact` | 人级代理主键（身份字段 / kind / is_self / hidden / 聚合缓存 / 墓碑 `merged_into` / 组织关系两列） | `kind` / `function` / `seniority` / `manager_src` 的 CHECK 值域经 `sql_check_clause` 引用 `src/contacts/taxonomy.py`（**唯一权威**，TS 镜像闸 `tests/config/test_contact_enum_parity.py`）|
| `contact_email` | 邮箱锚点（一人多邮箱；`is_primary` + `former_at` 曾用；锚点级聚合缓存） | `email_normalized` UNIQUE + CHECK 强制 lower+trim；**身份判据只有归一 email，名字永不作自动合并判据** |
| `contact_email_link` | 人-邮件账本（`email_id` × `internal_id` × `role∈sender/to/cc`） | `INSERT OR IGNORE` 幂等；挂锚点不挂人 ⇒ 合并零搬账本 |

- **v54**（WP1，方案 A）：建三表 + 迁 `matter_contact` → `contact`（id 保持 ⇒
  `matter_stakeholder.contact_id` 值不用改写）+ rebuild `matter_stakeholder` 换
  FK 目标 + DROP `matter_contact`。账本 backfill 🔴 **不进 migration**（万封级 IO
  卡 app 首启 waitReady），由扫描器从 watermark=0 增量消化。
- **v55**（WP2）：`contact` + `identity_locks_json`（**字段级**锁真源，键域 =
  `CONTACT_LOCKABLE_FIELDS` 8 字段；`identity_locked_at` 降级为聚合派生 = 锁映射
  MAX，唯一写径 `_write_identity_locks`）。
- **v59**（WP-6 A）：`contact.name_en` → `contact.formal_name`
  （`ALTER … RENAME COLUMN`），语义见 §2.1。🔴 **两段迁移缺一不可**：列改名之外
  还必须把 `identity_locks_json` 里的**键** `name_en` → `formal_name` ——
  锁映射是 `{字段名: epoch_ms}`，列改名不动 JSON 键，而 `parse_identity_locks`
  对词表外的键是**静默丢弃**（不报错）⇒ 少了这段 = owner 锁住的正式名无声解锁、
  下一轮扫描就可能被自动提取覆盖。回退代价见 `DB_VERSION` 注记（不能只降版本号，
  旧代码读 `c.name_en` 会 `no such column`）。
- 组织关系两列（`manager_contact_id` FK `ON DELETE SET NULL` + `manager_src`
  CHECK `manual|auto`）随 v54 一次建齐。
- **v67**（2026-08-20 读路径性能批）：`contact` 表本体从「一条索引都没有」补到三条
  —— `idx_contact_known(kind, is_self, hidden_at, sent_to_count DESC)`（默认视图那组
  等值/IS NULL 条件 + 密度序首列）、`idx_contact_manager(manager_contact_id)`（详情
  reports 腿）、`idx_contact_org(organization)`（详情 peers 腿）。此前列表主查询是
  `SCAN c` + TEMP B-TREE、一次详情三次全表扫；v54 那条「不为 manager 索引 bump
  DB_VERSION」的取舍**已作废**（列表加 keyset 分页后，LIMIT 要能提前收工就必须有
  可用于排序的索引）。DDL 单源 `CONTACT_V67_INDEXES`，🔴 **不进
  `CONTACT_INDEX_DDLS`**（那组由 v54 块执行，老库整组重放会炸 —— v52 教训）。
- **v69**（2026-08-24，L4 批次 1 接线批）：`contact` + `meeting_count` /
  `last_met_at` / `next_meeting_at` 三列 —— 日历第三源的**聚合缓存**（写者唯一 =
  `src/contacts/calendar_scan.py`，全量重算可自愈，不是第二真源，同 `mail_count`
  纪律）。🔴 两个时间列与本表其余时间列同单位 = epoch **毫秒**，而来源
  `calendar_event.dtstart_utc` 是 epoch **秒**（REAL）—— 换算钉在扫描器边界，
  表内不留两种单位。回退（降回 v68）只降版本号是安全的：旧代码不认识这三列。
- 迁移回归：`tests/matters/test_contact_v54_migration.py` +
  `test_contact_v55_locks.py` + `test_contact_v59_formal_name.py` +
  `test_contact_v67_indexes.py` + `test_contact_v69_calendar_fields.py`。

### 2.1 三个「名字」字段的分工（WP-6 A 厘清）

owner 的二分是**正式名**（系统 / 合同上的那个，中文或英文皆可）与**常用名**
（同事口头怎么叫 —— 可能是英文名，也可能是「x 工」「x 哥」）。现有三字段与它的
对应关系如下：

| 列 | 是什么 | 谁写 | 消费面 |
|---|---|---|---|
| `display_name` | **常用名**（UI 标签早就叫「常用名」） | scanner 自动刷（最近一封的 sender display name，带单调闸）；owner 一改即落锁 | 列表主名 / chip / 搜索 |
| `formal_name` | **正式名**（不限语言） | **纯手填** —— 自动提取从不写它 | 档案页副标题（与 display_name 不同才显示）/ 搜索 / 姓名兜底 |
| `name_variants_json` | 邮件头里见过的历史显示名集合（有上限） | scanner 自动收集 | **只喂搜索**，不展示为身份字段 |

⇒ 二分**对得上**：`display_name`=常用名、`formal_name`=正式名；
`name_variants_json` 不属这个二分，它是搜索召回的辅助集，故也**不在**
`CONTACT_LOCKABLE_FIELDS` 里（没有「人的决定」需要保护）。

🔴 曾名 `name_en` 是**不诚实的命名**：这个字段与「英语」无关，叫它 `name_en` 会
诱导后来者写出「非 ASCII 就跳过 / 只在英文界面显示」之类的逻辑 —— 与 v58
`sender` 那条线（同一列被不同消费者按不同假设读）是同一个病，所以连列名一起改，
不只改 UI 文案。i18n 键同步 `contacts.field.nameEn` → `contacts.field.formalName`
（zh「正式名」/ en「Formal name」）。

## 3. 扫描器（`src/contacts/scanner.py`，L0+L1 确定性，零 LLM 零网络）

- watermark = `sync_state['contact_extract.watermark']`，键值 = 已消化的最大
  `email_metadata.internal_id`（该表插入序单调；对账补抓行拿新分配 id 必落
  watermark 之后 —— 换 `date_received` 游标反而永久漏补抓行）。backfill = 同一段
  代码从 0 起步（`mailagent contact backfill`；`--rescan` 清 watermark 全量重扫，
  全程幂等 byte-stable）。已知边界（issue #34 marker 同族，有意接受）：
  davmail→applescript 应急回切后新行 id 落在 watermark 之下，兜底 = `--rescan`。
- 每 tick 有界批（batch 500 + 墙钟预算 20s），`asyncio.to_thread` 跑不冻 loop。
- L0 = 地址/姓名变体/账本/聚合（`mail_count` / `sent_to_count` / 首末时间）；
  L1 = kind 启发式打标（robot pattern 集 / list 弱前缀，保守、owner 可改判且
  `kind_locked_at` 后不再翻转）。草稿箱行不入账本（`DRAFT_MAILBOX_LABELS`）。
- 已锁字段自动提取**绕开**（`identity_locks_json`；scanner 读锁映射）。
- 🔴 **自有地址照常建档记账**（task 08-14 WP-3）：此前 scanner 对自有地址直接
  `continue`，于是 owner 换邮箱后新地址一封关联都没有（活库实测 `mail_count=0`、
  账本 0 条）。现在它和别人一样进 `contact` / `contact_email_link`。
- 引导：`run_scan` 自解析自有集时，先 `service.ensure_self_bootstrap` 再
  `resolve_self_addresses`（顺序不可换，见 §4.1）。

### 3.1 日历第三源（`src/contacts/calendar_scan.py`，L4 批次 1 #4）

邮件两源（sender / to+cc）之外的第三源：`calendar_event` 的与会者 → L0 建档 +
`contact` 三列聚合缓存（v69）。

- 节拍：`new_watcher._scan_calendar_contacts`，独立 env
  `MAILAGENT_CONTACT_CALENDAR_INTERVAL_SEC`（默认 900s，下限 60s；🔴 **绝不挂 5s
  radar poll**）。运行前提 `CALENDAR_CALDAV_SYNC_ENABLED`，关掉时整段跳过（日历表
  是陈旧快照，重算出来的「下一场会议」只会是过时事实）。纯本地 SQLite，零 CalDAV 调用。
- 🔴 **全量重算，不用 watermark**：`email_metadata` 能用水位是因为它 insert-only；
  `calendar_event` 是**可变表**（改期 / 取消 / 软删回写既有行），且 `next_meeting_at`
  本身就是随时间流逝会变的量。窗口 = 过去 180d / 未来 60d，**窗口是语义的一部分**
  （`meeting_count` 读作「最近半年见了几次」而不是历史总次数）。
- 口径三分（按 RRULE 展开后的 occurrence 算，不是一行事件算一次）：已结束的进
  `meeting_count` / `last_met_at`；尚未开始的取最早进 `next_meeting_at`；**正在进行中
  的两边都不算**。CANCELLED 与软删事件不计；会议取消/改期出窗后三列退回默认值
  （0 / NULL / NULL）—— 少了这一步三列就成了「只增不减」的谎。
- 参与者 = ATTENDEE ∪ ORGANIZER（活库实测 163 个事件里有 7 个 organizer 不在
  ATTENDEE 列表里）。身份判据仍**只有归一 email**：与会者 CN 只在**新建**那一行当
  种子，不覆盖既有联系人的姓名；**无邮箱的与会者不产生任何 contact 行**。已有联系人
  只被写这三列 + `updated_at`。
- 幂等：同一份数据重跑零写（`updated_at` 也不动），只在真有行变化时广播
  `contact.changed`（`scope='calendar_scan'`，不带 `contact_ids` ⇒ 只失效列表前缀）。
- 读面：`/api/contacts` 列表行与 `/api/contacts/{id}` 详情都透出三列；**UI 展示尚未做**
  （数据先行），`frontend/src/shared/api/types/contact.ts` 的 DTO 也还没跟进这三个字段。

## 4. 治理写面（`src/contacts/service.py`，唯一写侧）

matters 的 `_upsert_contact` 是它的薄包装（写穿语义见
[`../matters/matters-architecture.md`](../matters/matters-architecture.md) §2.4）；
REST / 未来 agent 工具全走同一组函数，**不许各写一份 UPDATE**。

- `upsert_contact_for_email`：按锚点找人→写人；非空 = 最后写者赢、None 不动、
  `fallback_*` 只填新建行（不许悄悄把别人改名）。

### 4.1 「我」的身份语义（task 08-14 WP-3 引入，WP-6 B 收窄）

`is_self` 从**排除开关**降级为**身份标签**。此前它一次关掉四件事，其中三件是误伤
（owner：「标成自己也要正常记账」「上下级也无法关联我」）。现状：

| 面 | 现在 |
|---|---|
| 扫描建档记账 | 照常（§3） |
| 默认 known 视图（「往来的人」） | 🔒 **排除**（`is_self = 0` 与 `kind='person' AND sent_to_count>0` 并列）。WP-3 曾给它开 carve-out，是把 owner 的「我不希望自己从通讯录消失」误读成「每个视图都要能看到自己」；WP-6 B 撤回 —— 这个 tab 叫「往来的人」，自己不是往来对象 |
| 「全部」视图 | **收**（只过滤 `merged_into IS NULL`）—— owner 找自己去这边，前端把它摘成置顶的单独一组 |
| 同事推荐 / 指定上级的选人池 | 不过滤（「我」能挂进汇报线、也能被选成别人的上级） |
| 画像卡 / 组织关系区 | 照常渲染（不再对 self 特判） |
| compose 收件人补全 | 🔒 **仍排除** —— 唯一该排除的一处（`email_repository._CONTACT_DIRECTORY_SQL` 的 `excluded` 标位 + Electron main `handlers/contacts.ts` 的镜像 SQL，两侧同步改） |

**两段式认定**（`service.ensure_self_bootstrap`）：

1. **引导，只跑一次** —— 按 `USER_EMAIL` **精确匹配**锚点，命中哪条就标
   `is_self=1`。🔴 判据只有账号邮箱这一个：不用名字、也不用
   `MAILAGENT_SELF_EMAILS`（owner：「不然同名就会被误标」）。记号
   `sync_state['contact_self.bootstrap_at']`（KV 表，**不 bump `DB_VERSION`**）。
   ⚠️ **只在真的落定后才写记号** —— 引导跑在扫描之前，全新库里那条联系人还没建
   出来，此时写记号 = 永远标不上「我」（有回归测试钉死）。库里已有 `is_self=1`
   则只写记号不动行；owner 事后手动取消也**不会**被标回来（恢复走手动 UI）。
2. **之后一切以「我」那条为准** —— 自有地址集 = 它名下**全部锚点**，合并进来的
   旧邮箱自动算「我的地址」。`set_is_self` 是**单选**（标新的自动清旧的），所以
   库里恒最多一条，自有集不会被第二个「我」撑大。
   🔴 **合并时身份跟着人走**：`merge_contacts` 里若被并方（loser）是「我」，标签
   转给 winner（复用 `set_is_self`，单选语义不抄第二份）。不转移会**静默丢掉
   「我」** —— 锚点已搬到 winner，墓碑上那面旗子名下再无锚点 ⇒ 自有地址集塌成空
   集、出向判据/方向三分/置顶徽章一起失效，而引导记号已烧掉不会重标；而「换邮箱」
   正是合并功能的主场景，owner 完全可能把「我」选成被并方。

该规则同时消掉了「`resolve_self_addresses` 与自动置位互相喂给需收敛循环」的隐患：
引导只读 `USER_EMAIL` 一个确定值、不读自有地址集，两者不构成回路。

调用点：`scanner.run_scan` 第一个事务（自解析自有集时）+ `mailagent contact
backfill`（扫描前后各一次 —— 全新库里「我」那条是本次扫描才建出来的，跑一次
backfill 就收敛，不必等下个 tick）。
- 字段级锁：`update_identity_fields` 保存即落锁（含清空）；`role_title` 变更对
  未锁且未显式提供的 `function` / `seniority` 做词表派生（派生是自动来源不落锁）。
- 🔒 曾用邮箱不变量收在**一个守卫** `_email_status_guard`：`set_primary` 顺带清
  目标 `former_at`；`mark_former` 对主邮箱直接拒绝（`E_PRIMARY_EMAIL_CANNOT_BE_FORMER`）。
- `merge_contacts`（WP3）：账本零搬（只改 `contact_email.contact_id`）→
  stakeholder / manager 引用改指 winner（自指清 NULL）→ loser 墓碑
  `merged_into`（数据保留可审计）→ 主邮箱/曾用**按预览页勾选入参**写（默认值
  推导 = 前端 `mergeModel.ts` 纯函数：`last_seen` 最新者做主 + 非主且早 60 天默认
  勾曾用，与「谁是保留方」无关）→ 聚合从账本重算。失败 = 单事务回滚「两条记录
  都未改动」。
- `set_manager`（WP5）：见 §6。

## 5. REST 面（`src/api/routers/contacts.py`）

门卫 `require_contacts_enabled`（off 全 403）+ `verify_cf_access`；错误经
`ContactError` → `_call` → `APIError`（码表在 `src/api/app.py::ERROR_CODE_TO_HTTP`）。
🔴 列表是**一条 SQL 出齐一行**（主邮箱/邮箱数走相关子查询，manager self-join，
禁逐行取数）；`/backfill/progress` 与 `/resolve` 字面路径声明在 `/{contact_id}`
之前。写 schema 刻意无 CAS / 幂等信封（治理写全幂等且低频）。

🔴 **读 handler 一律 `await asyncio.to_thread(_query)`**（2026-08-20 起）：uvicorn 单
worker 单事件循环，裸阻塞 sqlite3 留在循环上就是 head-of-line。写 handler 有意不动
（持 `BEGIN IMMEDIATE` 写锁，串行是想要的行为）。

| 端点 | 语义 |
|---|---|
| `GET ""` | 列表（view `known`[= 双向往来的人，排 robot/单向/hidden/**「我」**] / `all`[只排墓碑] + q + sort 三值 + **keyset 分页**）|
| `GET /backfill/progress` | watermark 覆盖行数 / 总行数 |
| `POST /resolve` | 批量精确解析（WP4 互链 chip；键 = 原输入串，null = 不在库；上限 100）|
| `GET /{id}` · `GET /{id}/mails` · `GET /{id}/matters` | 详情（含 §6 组织关系投影）· 人-邮件账本分页（§5.1 方向三分）· 关联事项反查 |
| `PATCH /{id}` · `POST /{id}/locks` | 身份字段编辑（保存即落锁）· 显式锁切换 |
| `POST /{id}/hide` / `kind` / `self` / `manager` / `merge` / `emails/primary` / `emails/former` | 治理写（全部薄端点进 service 守卫）|
| `GET /suggestions` · `POST /suggestions/{id}/adopt|ignore` | WP7 owner 待审队列；blocked 先落状态/原因再返回 4xx；merge adopt 只返预览 pair |
| `POST /agent/run` · `GET /agent/status` | WP7 手动 enqueue（事务外、活跃 run 合并、幂等键）· flag/pending/最近扫描摘要 |

### 5.0 列表分页契约（2026-08-20，additive）

`GET /api/contacts` 的 `limit` / `cursor` 都是**可选**；不传 `limit` = 一次返回全量
（老行为逐字节不变，远程 web 与 gateway 工具照旧）。传 `limit` 则：

- 服务端 `LIMIT limit+1` 探下一页，返回体多一个 `next_cursor`（`null` = 到底了）；
- `total` 恒是**全量命中数**（独立 `SELECT COUNT(*) FROM contact c WHERE <同一 WHERE>`，
  不受 limit/cursor 影响）—— 头部计数与「+n more」都读它；
- 游标是 **base64url(JSON 数组)** 的不透明串，值 = 该 sort 的排序键在末行的取值。
  🔴 不用 matters 的 `"<a>:<b>"`：`name` 档的键是用户姓名，里面可能带冒号。

排序键单源 `_LIST_SORT_KEYS`，三档 arity 各不相同（density 4 / recent 3 / name 2）⇒
换了 sort 还拿旧游标必被 arity 校验挡下（400），不会静默按错的键翻页。三条纪律：
末位恒 `c.id`（keyset 必须全序，否则并列行翻页会重复/丢失）、键表达式恒非 NULL
（`COALESCE(last_seen_at,-1)`，`x < NULL` 是 NULL 不是真）、游标值从 SELECT 出来的
**同一份表达式**取（列名前缀 `_ks`，投影时剔除，不进对外行形状）。

`profile_json` 不再整块搬进 Python：SQL 只取 `json_extract(…,'$.summary')`，归一与
120 字符截断留在 `profile_summary_from_text`（空白折叠后再截 N 这件事 SQL 的 substr
复刻不出来，而截断长度是对外可见的文案语义）。

### 5.2 WP7 治理 Agent

- schema v64 独立建 `contact_suggestion`；type/status 值域来自
  `src/contacts/taxonomy.py`，所有 JSON 列带 `json_valid`，证据指纹按排序后的
  message_id 集合计算；同 type + 归一 contact ids + 指纹在 pending/ignored/blocked
  已存在时不复现。
- `src/contacts/governance.py` 是提示词、证据/锁守卫、队列 service 与
  `contact_governance` run spec 单源。每条建议至少一条真实 `email_metadata.message_id`
  证据；引文非空并截到 500 字。identity 锁只接受锁后更新且与现值矛盾的证据，
  relation 的 `manager_src='manual'` 恒拒。
- owner 面是 `verify_cf_access`；Agent 落库腿
  `POST /api/contacts/agent/proposals` 单独挂 `verify_local_token`，不接受 CF JWT。
  两腿恒接线；治理自动运行由 `contact_governance_agent.enabled` 行级控制。
- `new_watcher` 在联系人提取后做每日 due 判定，marker =
  `contact_governance.last_fire_day`；只 enqueue 到现有 `AgentRunWorker`，不另起 worker。
  spec 的 `toolPolicy` 恒为 `{"allowedTools": []}`，不下发任何 grant 键。

### 5.1 关联邮件的方向三分（task 08-14 WP-5）

`GET /{id}/mails` 的 tab 轴从 `role`（`all|from|to|cc`）换成 `direction`
（`all|from_them|from_me|from_third`）。**breaking change**，前端同步改
（`MAIL_ROLE_MAP` 已删）。

```
对方 role 含 'sender'            → from_them   （🔴 sender 优先：自己抄送自己也算它）
否则 sender_email ∈ 自有地址集    → from_me
否则                             → from_third  （含 sender_email IS NULL）
```

- 收的是「对方是 to/cc ⇒ 我发出的」这个错判：活库实测 **178,046** 条第三方邮件被
  打上「发至」，而真正 owner 发的只有 3,667 条 ⇒ 老「发至」里 98% 是错的。
- 三类**互斥**（一封邮件对一个联系人只有一个方向），比老 role 轴下同一封邮件同时
  出现在 to 与 cc 两个 tab 更干净。
- 🔴 判据在**后端**算（`_direction_expr`）：自有地址集的权威是
  `resolve_self_addresses`，前端复制一份就是第二个真源。
- **cc 退出 tab 轴**（owner 拍板 A 方案：方向与 to/cc 是正交两维），降级为行内次要
  标记 —— 响应仍带 `roles`，前端只在「非 TA 发的且只在 cc 里」时加一个「抄送」尾注。
- SQL 形状：分组子查询产出 `direction` 派生列，过滤与分页在**外层 WHERE**（不塞
  HAVING 重复整段表达式），`total` 直接 `COUNT(*)` 同一个子查询。

## 6. 组织关系（WP5，设计 §2.2.1）

- 🔒 **只存一侧**：`contact.manager_contact_id` + `manager_src`；下级用
  `WHERE manager_contact_id = ?` 反查，不双写、不建中间表。「添加下级」= 对下级
  那行调同一函数/端点。不做组织树 CRUD（不是 HR 系统）。
- `service.set_manager(conn, contact_id, manager_contact_id, *, src, now_ms)`
  守卫：① 自指拒（`E_MANAGER_SELF` 400）② **完整链路环检测**——沿新上级 manager
  链上溯撞到本人即拒（`E_MANAGER_CYCLE` 409；hop 上限 1000 防库内脏环死循环，
  走不到链头同样保守拒）③ 两侧 `_require_live_contact` ④ src ∈
  `CONTACT_MANAGER_SRC_VALUES`。`None` = 解除（`manager_src` 一并清）。manager
  **不进锁词表**：`manager_src='manual'` 即锁语义。
- `POST /{id}/manager` **恒写 `src='manual'`**（`auto` 是 WP6/WP7 建议采纳链路，
  REST 面不暴露；detail 投影带 `manager_src` 让 UI 的「从邮件推断」标记结构就位）。
- detail 投影：`manager`（单行）/ `reports[]`（反查，排墓碑/隐藏，`mail_count`
  降序）/ `peers[]`（同 organization；**双方都有 department 才要求相同**——原型
  `cdata.jsx` 语义；排本人/非 person/hidden/墓碑，🔴 08-14 WP-3 起**不再排
  `is_self`**；`mail_count` 降序前 6；无组织恒空）。行集 = id/姓名/组织/职务/kind/mail_count/**primary_email**
  （Monogram 色相锚点 = 主邮箱 D10 + 「写邮件并抄送上级」要上级主邮箱）。
- list 面：`manager_contact_id` + self-join `manager_display_name`（汇报线分组
  label 与行菜单可用性）。
- 合并语义：**上级取保留方的值**（winner 的 manager 原样不动）；指向 loser 的
  manager 引用改指 winner、自指清 NULL（`merge_contacts` ③ 步 + 显式断言测试）。
- **合规回归**: `tests/contacts/test_org_relations.py`（守卫全套/反查/peers 派生/
  投影/merge 语义）+ `test_contacts_api.py` 组织关系节。

## 7. 前端面（`frontend/src/shared/components/contacts/`）

- **工作台**：`ContactsWorkspace`（双栏 280–560 可拖宽，860px 单列折叠推拉）→
  `ContactListPane`（视图/搜索/分组/排序/密度 + 虚拟滚动 react-window 定高 +
  多选条 + 滚到 ~70% 续拉下一页）→ `ContactDetail`（档案头 / 画像卡引导态 / 身份信息与锁 / **组织关系
  `ContactOrgSection`**[person，08-14 起 self 也渲染] / 关联邮件[方向四 tab，
  §5.1] / 关联事项）。
- **分组**：`contactListModel.ts` 纯模型（组 = 成员数降序、`未分组` 恒末尾、组头
  可折叠；模型层不 import i18n，label 全由调用方闭包注入）。**「我」置顶单独一
  组**（`SELF_GROUP_KEY`，🔴 **只在「全部」视图**[WP-6 B]，该视图任意分组档都先摘
  出去；known 分支输出与 WP-3 之前逐字相同，两侧都有回归闸）+ 行上「这是我」徽章
  `SelfPip`（徽章不分视图）。`'manager'` 档 =
  按汇报线：组 key `mgr:{id}`，label `contacts.group.reportsOf` 插值行上的
  `manager_display_name`（无名上级照原型 `m.name || m.id` 用 id 兜底）；未设上级
  走 ungrouped 通道置底、label 特判 `contacts.group.noManager`。菜单 label 对
  manager 档特判 `contacts.group.byManager`（不动 `contacts.groupBy.*` 模板）。
- **组织关系区**（原型 `cdetail.jsx::OrgSection`）：上级人物卡（点击经
  `useContactNavigation` 跳人物页 / hover 出「解除关系」/ 未设时虚线引导）+
  下级反查列表 +「添加下级」+ 同组织同事前 6 pills（peers 空整块不渲染）+
  `manager_src='auto'` 时「从邮件推断」AI 标记（结构位）。指定上级/添加下级 =
  轻量选人弹层（`PersonPicker` 单选复用；环判据在服务端，前端 taken 只做明显项）。
- **compose 抄送**：档案页分区头 + 列表行菜单「写邮件并抄送上级」→
  `openNewCompose(TA 主邮箱, [上级主邮箱])`；`compose-new.ts` 的
  `prefillCc` → `ComposeNewModal` → `ComposePanelInner.initialCc`（isNew 预填分支
  setCc + `setCcVisible(true)`，在 `setPlanApplied(true)` 之前 ⇒ **不标脏**）。
- **互链（WP4）**：`PersonChip` 挂邮件详情头与 `MatterDetail` 干系人行（在库才可
  跳、不在库不建 stub，判据 = `POST /resolve`）；全局搜索/⌘K「人」组（
  `PersonHitRow`，list limit 截断）+「打开通讯录」导航命令。
- **picker（WP3）**：`MatterStakeholderPicker` 单页化读 `/api/contacts`；
  `PersonPicker` 纯展示（数据调用方自取），merge 步骤 1 / 干系人多选 / WP5 指定
  上级三处共用。
- **列表数据供给（2026-08-20）**：主列表走 `useContactListPaged`（`useInfiniteQuery`，
  首屏 `CONTACT_LIST_PAGE_SIZE=200` + keyset 续页，key `qk.contacts.listPaged`，前缀仍是
  `['contacts','list']` ⇒ 写侧那一次 invalidate 照旧同时命中单页版）。单页版
  `useContactList` 留给弹层，🔴 **调用方必须自己传 `limit`** —— 不传 = 服务端返回全表
  （活库「全部」视图 1.17MB）。唯一有意不传的是 `ContactAgentDrawer` 的目录查表源
  （要按任意 id 反查名字，按密度截断会正好丢掉建议指向的冷门行）。
  头部计数 = 「本地有没有把已加载的行藏起来（chips/折叠）」二选一：藏了报实际列出数，
  没藏报服务端 `total` —— 全部加载完时两者恒相等。
- i18n：`contacts.*` 子树两 locale 逐 key 相等闸
  `frontend/tests/shared/contactsLocaleParity.test.ts`；🔴 本仓 i18next-icu，
  插值是 **ICU 单花括号**（`{name}`），勿改 `{{name}}`。

## 8. 测试与闸

- Python：`tests/contacts/`（taxonomy / scanner / **日历第三源三列口径与幂等** /
  service / identity locks / org relations / **self identity** / REST 面 /
  **keyset 分页三档等价 + 并列不重不漏 + 游标 arity 校验 + 行形状不漏内部列**）+ 迁移
  `tests/matters/test_contact_v54_migration.py`、`test_contact_v55_locks.py`、
  `test_contact_v67_indexes.py`、`test_contact_v69_calendar_fields.py`。
- 跨语言闸：`tests/config/test_contact_enum_parity.py`（taxonomy 枚举/可锁字段 ↔
  TS `types/contact.ts`）。
- 前端：`frontend/tests/components/contacts/`（列表多选条 / merge 模型 /
  manager 分组 / **「我」置顶组** / 组织关系区 / PersonChip / PersonHitRow）+
  `contactsLocaleParity` + `contactsNavigation` + compose 预填回归
  `ComposePanelNewPrefill`。

## 9. 边界（现状之外，勿当既有能力引用）

治理台三批已全部落地（2026-08-19）：Python 队列/扫描执行链/双腿 REST/提示词配置面（批①）、
gateway 9 工具 + 第六 context mode `contact_governance`（批②，工具定义 `frontend/src/ai-gateway/tools/contacts.ts`、
三道 belt 与审批档见 `feature-flags-rationale.md` 的退役记录）、
列表头 ✨Agent 胶囊 + 抽屉两 tab（批③，工具清单走零依赖叶子
`frontend/src/shared/lib/contactToolFace.ts`，三向闸 `contact_tool_face_leaf.test.ts`）。
仍未做：手动创建无 email 联系人 / KOS person 实体页（已移交
[L4 个人 Agent 节点 epic](../../plans/l4-personal-agent-node/README.md) 规划）等，在 PRD §9
TODO 表登记。compose 收件人补全切读通讯录已落地（commit `04e21cfe`）：通讯录 lane（15s TTL，
策展身份优先）与邮件头聚合 lane（10min cache，兜底）双 lane 合流。`contact_list_mails`
行投影已带 `message_id`（task 08-24 A），propose 取证据不再需要经 `email_get` 换一跳。

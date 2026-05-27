# 项目周报同步（外挂模块，从 CLAUDE.md 下沉）

独立于主同步的可选外挂模块，消费每周一定期发出的 **《【项目进度】研发项目deadline汇报_市场产品采购》** 邮件，抽取 xlsx 附件中三个 sheet 的项目，过滤 `BU==TPS-ENBU` upsert 到 Notion 项目进度库。

**信源演进**：
- v1（2026-04 之前）：消费某转发版，xlsx 仅 1 个 sheet（`Project  Ongoing`，15 列），项目"完成 / 终止"靠 diff 推断
- v2（2026-04 起）：消费直接发件人版，xlsx 4 个 sheet（多 19/50 列 + 已出货 + 已暂停），状态靠 Sheet 2/3 权威信号
- v3（2026-05 起）：实际发件人会换人（zhouwangfang → liuxiangjiang → …），`PROJECT_PROGRESS_SENDER` 改为可选；默认仅按标题正则匹配，需要严格双判定再显式配置 sender。

## 模块结构

```
src/project_progress/
  detector.py          (可选发件人) + 标题正则匹配（sender 留空仅看 subject；两者全空则永不匹配）
  xlsx_parser.py       4 sheet 解析 + 双行表头检测 + ENBU 过滤 + 1:1 行级 ProjectRow + 母子关系（仅 Ongoing 内）
  slug.py              external_id 生成（英文 slug；含中文加短 sha1 后缀；碰撞后加后缀）
  progress_parser.py   解析 [MM/DD] / [M/D] / [MM/DD/YYYY] / （MM.DD） 等日期头
  priority.py          Project Priority 语义映射（Y-Pledge→军令状项目, Y/是→高优先级, N/否→低优先级, TBD/R&D project 原样）
  sync_store.py        project_progress_sync 表（旧 evelyn_project_sync 自动 ALTER RENAME）
  notion_sync.py       Notion 客户端 + Status 三态路由 + 7 个新字段写入 + Markdown API
  notion_schema.py     启动时 schema bootstrap（5min 缓存，自动建 7 个 property，Suspended status 仅 log）
  runner.py            端到端 runner（sync_from_email）

src/cli/commands/project_progress.py CLI（`mailagent project-progress sync ...`；PR-6 起取代旧 scripts/sync_project_progress.py）
tests/project_progress/             pytest
docs/notion_markdown_api.md         Notion Markdown API 探测记录
```

## xlsx 结构（v2 / 4-sheet 版）

| Sheet | 用途 | 行数（典型）| 列数 | 表头 | ENBU 行（典型）|
|---|---|---|---|---|---|
| `Project  Ongoing`（双空格）| 在研项目 | ~2900 | 34 | 双行（行 1 英文 + 行 2 中文标签）| ~1015 |
| `2026-Project Shipped` | 已出货 → Status=Done | ~1290 | 65 | 双行 | ~457 |
| `Project Suspended` | 已暂停 → Status=Suspended | ~890 | 65 | 双行 | ~119 |
| `Filling-in & Reading Guide` | 字段说明文档 | 52 | - | - | 解析时跳过 |

**双行表头检测**（`_read_sheet_with_dual_header`）：扫描前 5 行找含 `BU` + `Project Name` 的英文 header；下一行如果是中文标签（含'事业部'/'课组'/'研发'等关键词）则跳过，数据从 header+2 起；否则数据紧随 header（兼容 v1 单行表头 fixture）。

## Notion Markdown API

使用 `Notion-Version: 2025-09-03` + `ntn_` token 才可用（参见 `docs/notion_markdown_api.md`）：
- `GET  /v1/pages/{id}/markdown` 读扩展 markdown
- `PATCH /v1/pages/{id}/markdown` 写，支持 `replace_content / insert_content / update_content / replace_content_range`
- Prepend 通过 read-modify-write：GET markdown → 客户端拼 → `replace_content` 写回

## 粒度：行级（一行 = 一个 Notion 页）+ 母子任务

xlsx 每行是一个 `(Project Name, Product Model)` 对。**每行独立一个 Notion 页**，不再按 Project Name 聚合。同一 Project Name 下的多行建立**母子任务关系**（Notion 自带的 `母任务 / 子任务` dual_property）：

- 母任务：同 Project Name 多行中，`earliest_progress_date`（progress_blocks 里最老块的实际日期）最早的那行。平局按 Product Model 字母序
- 子任务：同 Project Name 其余行，`母任务` relation 指向母任务 page_id
- 独立任务：同 Project Name 只有一行的项目，既不是母也不是子

**Dual-property 策略**：脚本只写子任务一侧的 `母任务` relation；`子任务` 字段由 Notion 自动反填。母任务的 properties 永远不含母子字段，避免 update 时误动 relation。

**Upsert 两阶段**（保证 relation 不 dangling）：
1. Phase 1：并发 upsert 所有"母 + 独立"（parent_external_id 为 None），收集 external_id→page_id 映射
2. Phase 2：并发 upsert 所有"子任务"，用 Phase 1 的映射取 parent_page_id 写 `母任务` relation

## 字段映射（xlsx → Notion）

| Notion property | 类型 | xlsx 列 / 规则 |
|---|---|---|
| `项目名称` (title) | title | **Product Model**（每行自己的 SKU 名） |
| `external_id` | rich_text | slug(`Project Name + "__" + Product Model`)；碰撞按 (name, model) hash 后缀 |
| `母任务` | relation (dual) | 子任务指向母任务 page_id（**仅 Ongoing 内**）；Shipped/Suspended 全独立任务 |
| `本周数据期` | rich_text | xlsx 文件名日期 YYYYMMDD → ISO 周 `YYYY-WXX` |
| `优先级` | select | Project Priority **映射后写入**（Y-Pledge→军令状项目, Y/是→高优先级, N/否→低优先级, TBD/R&D project 保留原样）|
| `Product Models` | multi_select | 本行 Product Model 单值 |
| `BU` | select | 固定 `TPS-ENBU` |
| `研发分部` | select | R&D Division |
| `PM` / `协助 PM` / `接口人` | rich_text | Project Manager / Assist PM / Contact Window |
| `参考 DDL` | date | Reference Date for the Business（Terminated / NO MPS 等非日期写入风险项） |
| `美国发货` | checkbox | Shipped to the United States（`Y`→True） |
| `风险项` | rich_text | Project Risk |
| `Status` | status | **Sheet 路由**：Ongoing+create → `In progress`，Ongoing+update → 不覆盖；Shipped → 强制 `Done`；Suspended → 强制 `Suspended` |
| `项目开始时间` | date | create 时写 xlsx 的 `Product Establishment Date`（更准），无则用 `earliest_progress_date`；update 不覆盖 |
| `立项时间` | date | xlsx `Product Establishment Date`（v2 新增） |
| `期望交期` | date | xlsx `Desired shipping Date`（v2 新增） |
| `预计出货` | date | xlsx `Estimated Shipping Date`（v2 新增） |
| `实际出货` | date | xlsx `Actual Shipped Date`（v2 新增，仅 Sheet 2 有值） |
| `暂停时间` | date | xlsx `Suspension Date`（v2 新增，仅 Sheet 3 有值） |
| `进度异常` | rich_text | xlsx `Reasons for the Delay`（v2 新增） |
| `当前状态` | select | xlsx `Current Status`（v2 新增，仅 Sheet 2/3 有值，如 Delivery / Suspended / R&D in progress） |
| `Evelyn 原邮件` | url | 邮件 Notion 页 URL（Notion 历史 property 名，不能改否则丢历史数据） |
| `产品线` | multi_select | xlsx Product Line 直写（Notion 自动创建 option） |
| `出现在会议` | relation | 留空，手动挂 |
| `最后同步` | last_edited_time | 自动 |

## Status 三态语义

```
Sheet Ongoing   → create: 写 In progress  | update: 不写（保留手改）
Sheet Shipped   → 强制 Status=Done       （xlsx 是权威信号，覆盖手改）
Sheet Suspended → 强制 Status=Suspended  （xlsx 是权威信号，覆盖手改）
```

**Mark-missing 兜底**：xlsx 三个 sheet 全部消失的项目（罕见，通常是项目改名）→ 仍标 Done。

## Schema Bootstrap（启动时一次）

`runner._upsert_all` 启动时调 `ProjectProgressSchemaBootstrapper.ensure_schema()`（5min 缓存）：
- `GET /v1/databases/:id` 拉当前 schema
- 缺失的 7 个 property（立项时间 / 期望交期 / 预计出货 / 实际出货 / 暂停时间 / 进度异常 / 当前状态）通过 `PATCH /v1/databases/:id` 自动建
- Notion API **不允许**修改 status 类型 options，所以 `Suspended` option 必须用户**手动**在 Notion 后台加（"已入库"组下）；缺失则 schema bootstrap log warning，但不阻塞 Ongoing/Shipped 同步

## 正文（进度日志）写入

- 采用 Notion **Markdown API**（需 `ntn_` token + `Notion-Version: 2025-09-03`），详见 `docs/notion_markdown_api.md`
- 首次创建：`POST /v1/pages` 建空页 → `PATCH /markdown` `replace_content` 一次性写入全量历史 markdown
- 增量 prepend：`GET /markdown` → 找页面首个 heading 做 anchor → `PATCH /markdown` `update_content` 把 anchor 替换为 "本周块 + anchor"（Notion 内部只重建首个 block，不是整页 rebuild）
- 找不到安全 anchor 或空页 → 降级 `replace_content`
- **幂等 guard**：prepend 前 GET markdown，首段已含 `### {week_tag} ` → skip（一周内多次跑不重复写入）

## Progress 日期 / 年份推断

xlsx 的 `Project Progress` 里日期头格式多样（`[MM/DD]` / `[M/D]` / `[MM/DD/YYYY]` / `（MM.DD）`），很多缺年份。算法：
- 按 xlsx 出现顺序（最新在前）**单调递减**推断年份：每块推出的日期必须 ≤ 前一块日期，否则年份 -1 继续试
- 例：`(01/23/2026) → (3.1) → (11.17) → (11.10)` 被推断为 `2026-01-23 / 2025-03-01 / 2024-11-17 / 2024-11-10`

## 增量同步语义

- `project_progress_sync` 表以 `email_internal_id` 为主键记录每封邮件的处理状态
- 同 internal_id 已 `completed` → 跳过（`--force` 才重跑）
- 同 xlsx_md5 不同 internal_id（转发链）→ 默认跳过
- 行级 upsert：external_id 查 → 无则 create，有则 update properties + prepend 本周 markdown
- **Sheet 2/3 → 状态权威信号**：在 Shipped sheet 出现的项目自动标 `Status=Done`，在 Suspended sheet 出现的项目自动标 `Status=Suspended`，不再依赖"diff 推断"
- **mark-missing 兜底**：仅当项目从 xlsx **三个 sheet 全部消失**才标 Done（罕见，通常是项目改名）

## 数据库迁移（旧表 → 新表）

启动 `ProjectProgressSyncStore.__init__` 时透明执行（idempotent）：
1. 检测旧表 `evelyn_project_sync` → ALTER TABLE RENAME 到 `project_progress_sync`
2. ADD COLUMN：`sheet_ongoing_rows / sheet_shipped_rows / sheet_suspended_rows / projects_marked_done / projects_marked_suspended`（IF NOT EXIST 容错）

## 命令

```bash
# 自动扫最近一封未处理的（默认全 3 sheet）
mailagent project-progress sync

# 指定一封
mailagent project-progress sync --internal-id 52258

# **首次切换迁移 dry-run**（输出预估的 create / Done / Suspended 数量，不写 Notion）
mailagent project-progress sync --internal-id 52258 --first-migration-dry-run

# 仅解析 Ongoing sheet（兼容 v1 行为）
mailagent project-progress sync --internal-id 51793 --sheets ongoing

# 回填历史（按日期升序 N 封）
mailagent project-progress sync --all-history --limit 10

# 干跑（不写 Notion）
mailagent project-progress sync --internal-id 52258 --dry-run

# 强制重跑 (会用 xlsx 整页 replace 正文)
mailagent project-progress sync --internal-id 52258 --force

# 一次性回填"项目开始时间"到所有已入库项目页
mailagent project-progress sync --internal-id 52258 --backfill-project-start
```

## 自动触发（可选）

设置 `PROJECT_PROGRESS_AUTO_SYNC_ENABLED=true` 后，`main.py` 会在每次邮件同步 Notion 成功后检测，匹配到项目周报邮件即 `asyncio.create_task(runner.sync_from_email(...))` 后台触发。任何异常不会影响主同步流程。

## 配置（`.env`）

**默认全部关闭**：其他协作者拉取代码后 CLI 和钩子都不会运行。

**所有过滤条件都可配置**——其他 BU / 其他团队复用本模块：改发件人、标题、数据库 ID、BU 值即可。

```
# 总开关（必须）：CLI / 钩子都依赖它
PROJECT_PROGRESS_SYNC_ENABLED=true

# Notion 目标数据库 ID（必须）——每个人填自己的
PROJECT_PROGRESS_DATABASE_ID=6f528975839940ceaacaf545e47cf25d

# 过滤保留的 BU 值（精确匹配 xlsx 的 BU 列）
PROJECT_PROGRESS_FILTER_BU=TPS-ENBU   # HNBU 团队改成 TPS-HNBU 即可

# 可选：main.py 自动触发钩子（需同时打开上面的总开关）
PROJECT_PROGRESS_AUTO_SYNC_ENABLED=false

# 必填：识别邮件的标题正则
PROJECT_PROGRESS_SUBJECT_PATTERN=<标题正则，含【项目进度】等关键词>

# 可选：识别邮件的发件人（子串匹配，不区分大小写）
# 留空 → 仅按 subject 匹配（推荐，实际发件人会换人，例如 zhouwangfang → liuxiangjiang）
# 配置 → 双判定（sender + subject 都要匹配）
# PROJECT_PROGRESS_SENDER=<weekly-sender-email>
```

`PROJECT_PROGRESS_SYNC_ENABLED=false`（默认）时：
- CLI 直接报错退出（避免误跑）
- `new_watcher` 不初始化 detector（钩子不生效）

## 首次切换迁移操作清单（v1 → v2）

1. **Notion 后台**：在项目进度库的 Status 属性 → "已入库" 组下，**手动**添加 `Suspended` 选项（API 不能加）
2. **代码部署**：拉取最新代码（DB 表迁移会在首次启动 `ProjectProgressSyncStore` 时透明完成）
3. **dry-run 审查**：
   ```bash
   mailagent project-progress sync --internal-id <最新 zwf 邮件 id> --first-migration-dry-run
   ```
   输出形如：
   ```
   ongoing=1015  shipped=457  suspended=119
   Status changes (estimated): Done +457  Suspended +119
   ```
4. **正式执行**：移除 `--first-migration-dry-run` 重跑（预估 13~17 min，按 ~3 req/sec 限流）
5. **校验**：
   ```bash
   sqlite3 data/sync_store.db "
     SELECT sheet_ongoing_rows, sheet_shipped_rows, sheet_suspended_rows,
            projects_created, projects_updated,
            projects_marked_done, projects_marked_suspended
     FROM project_progress_sync ORDER BY completed_at DESC LIMIT 1"
   ```

## 监控

```bash
sqlite3 data/sync_store.db "
  SELECT email_internal_id, week_tag, status,
         sheet_ongoing_rows, sheet_shipped_rows, sheet_suspended_rows,
         projects_total, projects_created, projects_updated,
         projects_marked_done, projects_marked_suspended, projects_failed
  FROM project_progress_sync ORDER BY completed_at DESC LIMIT 5"
```

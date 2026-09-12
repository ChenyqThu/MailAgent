# 同步历史邮件（history_sync）

> 一次性把某段时间里**本地缺的**收件箱 / 已发送邮件补回来。用于补安装前的历史邮件，
> 以及故障期间漏掉的那一段。

它是**独立功能**：不改首次运行的基线、不改增量水位、不接进初始化流程。
（task `09-11-history-mail-sync`）

---

## 1. 入口与范围

- 设置 → 同步 → 「历史邮件」一节：起止日期 + 开始 + 进度 + 上次结果。
- 后端为 `davmail` 或 `outlook_com` 时可用；`applescript` 显示不支持（该模式用 `mailagent init`）。
- 默认范围：起 = 今天 − `SYNC_LOOKBACK_DAYS`（默认 14），止 = 今天；最长 **365 天**；
  起止均为**本地日期**，含两端。
- 覆盖收件箱 + 已发送。自定义文件夹、草稿箱不在范围内。

---

## 2. 执行模型：扫描 → 投喂

任务是 `async_jobs` 的 `history_sync` 维护任务，由 serve 进程内的 `JobWorker` 串行执行
（排队 / 终态 / SSE / 通知中心全部复用既有设施）。

| 阶段 | 做什么 |
|---|---|
| `scanning` | 按**天**切片（最新的一天先扫）调 `backend.scan_history_window`，拿到窗口内远端全部邮件的元数据；按 Message-ID 归并，再与本地 message_id 全集比对，得出「本地缺失」清单 |
| `syncing` | 把缺失的邮件每批 20 封以 `pending` + `ingest_reason='history_sync'` 写进 `email_metadata`，等这一批被 watcher 处理完再投下一批 |

🔴 **本模块不取正文、不推 Notion**，一行都不复制那两段逻辑 —— 历史邮件与实时邮件走
**同一条**入库流水线（`_process_pending_emails` → 取正文 / 附件 / 索引 / AI 分类 / Notion），
否则两条路径必然漂移。

### 窗口的两层筛选

服务端只能粗筛，精确边界一律在本地判：

| backend | 服务端粗筛 | 为什么要放宽 | 精确判据 |
|---|---|---|---|
| davmail | `UID SEARCH SINCE/BEFORE`，两头各**放宽一天** | IMAP 只能按日期比较，且判据是 INTERNALDATE | 行的 `date_received`（= 列表里显示的日期，来自 Date 头） |
| outlook_com | DASL `datereceived >= X AND < Y`，下界向下取整、上界**向上取整**到分钟 | DASL 字面量只到分钟；上界跟着向下取整会把最后不足一分钟的邮件从服务端就筛掉 | `ReceivedTime` |

放宽后不精确过滤，「范围外的不入库」就是假的；不放宽，边界那天/那分钟的邮件在服务端
就丢了，本地再怎么过滤也补不回来。**两件事都要做**。

读不出日期的邮件**保留**：只补不删的语义下，宁可多带一封（Message-ID 会去重），
不可因为日期读不出来就判它在范围外。

---

## 3. 与收新邮件并行（不暂停）

不暂停收新邮件。暂停有两个问题：历史同步可能跑几十分钟，期间新邮件全部延迟；
「暂停—恢复」要给 watcher 加外部控制的状态，正是本功能要避免的耦合。

两者只在四处可能相撞，规则如下：

| 相撞点 | 规则 |
|---|---|
| 同一封两边都拿到 | 扫描时按 Message-ID 比对本地；写入时 `save_email` 的 message_id merge guard 兜底（写入后新 `internal_id` 查不到 = 已被并进既有行，计「已存在」，**不是失败**） |
| 处理队列 | 每批最多 20 封进 `pending`；watcher 按收信时间**从新到旧**取 pending ⇒ 新邮件天然排在补录的老邮件前面 |
| 邮箱访问 | 按天切片，每片一次 backend 调用，片间让出；EWS 限流（`is_uid_backfill_paused`）期间整段暂停等待，解除后继续 |
| 增量水位 | 任务**从不**读写 `last_max_row_id` |

---

## 4. provenance 与钩子门控

补回来的行带 `ingest_reason='history_sync'`（`src/mail/ingest_provenance.py` 的
`INGEST_HISTORY`）。判定单源 `is_history_ingest()`，读取失败一律 fail-open（按普通邮件处理）。

| 去处 | 历史邮件 | 理由 |
|---|---|---|
| 飞书通知（三个入口） | **不触发** | 走共享判据 `should_suppress_reconcile_notify`。🔴 与对账补抓不同，历史补录**不看年龄**——用户可以补「今天」，年龄阈值拦不住 |
| 灵动岛 `MailReceived` | **不触发** | 实时性语义 |
| Custom Agent `email_filter` | **不触发** | 补一年前的邮件不该起 agent run |
| 项目周报钩子 | **不触发** | 同上 |
| LLM 分类 / KOS / 事项线程关联 | 照常 | 对邮件内容的加工，与「什么时候到的」无关 |

🔴 `_sync_single_email_v3` 的 **Notion 开 / 关是两条分支，两条都门掉** —— 只堵一条
= 换个配置就漏。

---

## 5. 状态存放（无 schema 变更）

任务终态 / 进度在 `async_jobs` 行；历史同步特有的阶段与分项计数落 `sync_state` 两个 KV：

| key | 内容 |
|---|---|
| `history_sync.live.<job_id>` | JSON：`phase` / `since` / `until` / `counts` / `complete` / `covered_from` / `last_error` / `progress_*` |
| `history_sync.cancel.<job_id>` | `'1'` = 已请求取消 |

一次性维护任务的过程量不值得建表：**不加表、不做迁移、不占 `DB_VERSION`**。

**进程重启**：`JobWorker.recover_orphaned` 把任务重新排队 → runner 重新扫描。已写入的
行此时已在本地，自然落进「已存在」而不会重复入库；累计计数从 live KV 读回继续累加。
🔴 runner **有意忽略 `resume_from`**：维护族的 checkpoint 语义是「跳过 internal_id 小于它的
unit」，而本任务每轮**新分配** internal_id，拿上一轮的 id 当水位会把这一轮的行整片跳掉。

---

## 6. 终态语义

| 情况 | 终态 | 界面 |
|---|---|---|
| 正常跑完 | `succeeded` + `complete=true` | 完成 + 摘要 |
| 截断视图没覆盖到起始日期 | `succeeded` + `complete=false` + `covered_from` | **「只覆盖到 X 日」**，不显示成完整成功 |
| 部分邮件失败 | `partial_failure` | 部分失败 + 失败计数 |
| 邮箱不可用 / 扫描失败 | `failed` + `last_error` | 显示真实原因，不显示成 0 封成功 |
| 用户取消 | `aborted` | 已取消（已入库的照常处理完） |
| 处理停滞（watcher 没在跑） | 计入失败 + live `last_error` | 明说「邮件处理停滞」。已写入的行**不回滚**，watcher 起来后自行处理 |

终态通知落通知中心，点进去回到**设置-同步页**（不是运维看板 —— 看板上没有这个任务的展示面）。

---

## 7. API

| 端点 | 说明 |
|---|---|
| `GET /api/history-sync` | 能力 / 默认范围 / `max_days` / `notion_floor` / 当前（或最近一次）任务。前端唯一状态源 |
| `POST /api/history-sync` | `{since, until}` → `{job_id, was_created}`。已有进行中的任务直接返回它（`was_created=false`） |
| `POST /api/history-sync/cancel` | 置取消标记；没有进行中的任务 → 404 `E_NOT_FOUND` |

- **跨度校验是日期差**：`until − since ≤ max_days`。`2025-09-11 → 2026-09-11` 合法，
  再往前一天不合法。后端唯一实现是 `src/sync/history_sync.py::validate_range`（router 直接
  调它）；前端 `HistorySyncSection.validateRange` 是同一条式子的**镜像**，只有 `max_days`
  由 GET 下发（常量不手抄）。两侧各有闸：`tests/api/test_history_sync_api.py::
  test_span_rule_matches_the_frontend` 与 `frontend/tests/shared/HistorySyncSection.test.tsx`。
- `notion_floor` 必须与 watcher 判 Notion 日期地板**同一个函数**
  （`src.config.parse_sync_start_date`），否则界面承诺的日期与实际入库行为会分裂。
- `SYNC_DATE_MODE=relative`（默认）下 `notion_floor` 是**滚动**日期（今天 −
  `SYNC_LOOKBACK_DAYS`），每天前移一天，界面上「早于 X 日只存本地」的 X 会跟着变；
  滚动只影响此后入库的邮件，已建好的 Notion 页不会被回收。`fixed` 下它是 `SYNC_START_DATE`。

---

## 8. 已知限制

- **处理速度受 watcher 节拍限制**：每轮 10 封、间隔 `RADAR_POLL_INTERVAL`。1000 封约需
  20–60 分钟。本期不改 watcher 节拍。
- **davmail 受 `DAVMAIL_FOLDER_SIZE_LIMIT` 截断视图限制**，只能覆盖视图内的邮件；
  覆盖不到时如实报 `complete=false`。
- 历史同步运行期间，其他维护任务（批量重推 Notion 等）会在 JobWorker 里排队。
- 无 Message-ID 的邮件跳过并计数（`empty_msgid`）——没有稳定标识就无法可靠去重。

---

## 9. 运维

```bash
# 最近几次任务
sqlite3 data/sync_store.db \
  "SELECT job_id, status, progress_done, progress_total, last_error
     FROM async_jobs WHERE job_type='history_sync' ORDER BY job_id DESC LIMIT 5"

# 某次任务的分项计数 / 阶段
sqlite3 data/sync_store.db \
  "SELECT value FROM sync_state WHERE key='history_sync.live.<job_id>'"

# 补录进来的行
sqlite3 data/sync_store.db \
  "SELECT sync_status, COUNT(*) FROM email_metadata
    WHERE ingest_reason='history_sync' GROUP BY sync_status"
```

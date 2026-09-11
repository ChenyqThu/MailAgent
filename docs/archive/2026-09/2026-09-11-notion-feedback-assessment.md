# Notion 用户反馈核查（2026-09-11，Windows 两条）

核查日期：2026-09-11。代码基线：`e732621b` / v3.1.0。本文是核查时点的过程快照，不是当前架构规范。

范围：用 ntn 读取反馈库全部 9 条记录（has_more=false），其中 7 条已标「已修复」，新增 2 条未处理，都来自同一位 Windows 用户（v3.1.0 · win32，outlook_com 后端）。两条各带一个诊断包，内容相同（间隔 2 分钟导出，sync.log 与配置快照逐字一致）。未改业务代码、生产数据或 Notion 状态。

来源数据库：https://app.notion.com/p/tp-link/f8455e24c3b1432aab206d23301f02b8

## 结论总表

| 反馈 | 核查结论 | 优先级 |
| --- | --- | --- |
| 升级 3.1.0 后只同步一封、那封没内容、后续新邮件不同步 | 两个独立缺陷叠加：①增量筛选的时间字面量写成本地时间，Outlook 按 UTC 解释，东八区一直查「8 小时之后」；②新邮件入库时丢了 entry_id，取正文只能靠 message_id 反查，反查也落空 | P0；所有东半球的 Windows 用户新邮件全丢 |
| Windows 上同步历史邮件 | 属实，Windows 目前没有任何历史邮件入口：首次运行把水位定在收件箱最新一封，`initial_sync` 对 outlook_com 也没有实现 | P1；依赖上一条修好 |
| （附）9-10 那条 Windows 反馈 | 已标「已修复」，但只修了一半（水位换算），筛选时区这一半还在，所以 3.1.0 仍然不收信 | 建议重开并更正处理结论 |

## A. 新邮件不同步（P0）

反馈：https://app.notion.com/p/3d815375830d817a8bfac36d4548d2ca

### 缺陷一：DASL 筛选按 UTC 比较，我们写的是本地时间

`src/mail/backend/com_client.py:352` `epoch_to_dasl_local()` 用 `datetime.fromtimestamp(epoch)` 生成本地墙钟字面量，注释称 DASL「按本地时区解释」。微软文档说法相反：DASL（`@SQL=` 前缀、按命名空间引用属性）的日期比较一律按 UTC，字面量必须先转成 UTC（https://learn.microsoft.com/en-us/office/vba/outlook/how-to/search-and-filter/filtering-items-using-a-date-time-comparison ，「Time Zones Used in Comparison」一节）。东八区下，`Restrict(datereceived >= 水位)` 实际查的是「水位 + 8 小时」之后的邮件。

日志与这个解释逐项吻合（水位已换算成北京时间）：

| 时刻 | 日志 | 解释 |
| --- | --- | --- |
| 11:20:57 | 首次运行，基线 = 02:04:56 | 字面量「02:04:56」被当成 UTC，等于北京 10:04:56 |
| 11:24:15 | 检测到 ~1 封，水位 → 11:19:38 | 11:19:38 这封 ≥ 10:04:56，数到 1 封，入库 |
| 11:29 起 | 水位一路前推（11:29:00 … 13:46:54），每次都是「~0 封」 | 字面量「11:19:38」当 UTC 等于北京 19:19:38，此后所有新邮件都不满足 |

水位能前推，说明收件箱最新一封的时间在变，也就是确实有新邮件。`get_new_emails` 用的是同一个筛选，返回空列表，watcher 把空列表当「合法空成功」照常推进水位（`src/mail/new_watcher.py:793`）。结果是这段时间的邮件被永久跳过，界面上没有任何报错。

9-10 的修复（`0b6095ce`）只处理了 `_to_epoch` 把本地时间当 UTC 的问题，水位从此是正确的 epoch；筛选字面量这一半没动。测试没拦住，是因为替身按同样的错误假设实现：`tests/mail/backend/com_fakes.py:230` 的 `Restrict` 把字面量当本地墙钟比较，注释写着「Outlook 自己就是按这个比的」。替身复刻了实现方的理解，而不是 Outlook 的真实行为。

影响面：UTC 以东的时区全部漏信（中国用户全在其中）。UTC 以西会多查一段，靠 message_id 去重，不丢信。

### 缺陷二：新邮件入库丢了 entry_id，取正文失败

第一封（internal_id=1000000000）连续 5 次 `entry_id miss + message_id search miss`，12:46 进死信。用户看到的「有一封但没内容」就是它：元数据入库了，正文一直没取回来。

- `OutlookComBackend.get_new_emails` 返回的行里带 `entry_id`，但 `new_watcher._poll_cycle` 组 payload 时只挑了固定几个字段，没有 `entry_id`（`new_watcher.py` 里全文没有 `entry_id`）。所以 watcher 入库的邮件 entry_id 一律为空，取正文的快路径从来没用上。
- 退回 message_id 反查（`outlook_com_backend.py:633`，用 `urn:schemas:mailheader:message-id` 做 `Items.Find`）也没命中。具体原因从日志判断不了，候选有：这个 DASL 属性名在该 Exchange 缓存库上不可用；入库时 message_id 就是空的；邮件被规则挪到了候选之外的文件夹。诊断包里没有数据库，无法区分，需要真机验证。

### 关于 Trae 的分析

「1000000000 是新库的哨兵假 ID」不成立：outlook_com 与 davmail 共用 ≥10^9 的独立编号空间，1000000000 就是给第一封真实邮件分配的编号。它观察到的「水位在涨、却一直 ~0 封」是对的，而且正是缺陷一的关键线索。

### 拟修复方案

1. 筛选字面量改成 UTC：`epoch_to_dasl_local` 改为按 UTC 格式化（改名，注释按微软文档改正）。文档还提到字面量带秒可能导致筛选异常；我们的字面量带秒，但日志里确实数到过 1 封，说明至少部分生效。是否去掉秒（按分钟向下取整，`>=` 包含边界，重复靠 message_id 去重）放到真机验证里一并确认。
2. 替身按 Outlook 的真实语义改：DASL 字面量按 UTC 比较。补一条东八区用例（显式切 `TZ=Asia/Shanghai`），先确认它在修复前失败。
3. watcher 入库透传 `entry_id`。
4. message_id 反查：真机上分别试 `urn:schemas:mailheader:message-id` 与 `http://schemas.microsoft.com/mapi/proptag/0x1035001F`，以实测结果为准。建议给 `scripts/poc_win/` 加一个只读探针，请这位用户跑一次，同时验证第 1 条和本条。
5. 补回漏掉的邮件：水位格式再升一版，升级时把水位回退到「首次运行时刻」与「现在 − SYNC_LOOKBACK_DAYS」中较晚的一个，重扫这段，靠 message_id UNIQUE 去重。
6. 回退重扫之前先修一个相关问题：`get_new_emails` 单轮最多取 200 封（`MAX_BATCH`），backend 注释说「水位只推进到已抓的最后一封」，但 watcher 实际把水位推到 `current_max`（收件箱最新一封），超过 200 封的部分会被跳过。平时 30 秒一轮很少超过 200 封，回退重扫第一轮就可能超过。
7. 死信里那一封在修复后手动重试一次。

验收：东八区与 UTC 以西各一组用例，修复前红、修复后绿；新邮件入库带 entry_id，取正文走快路径；回退重扫后漏掉的邮件补齐且无重复；单轮超 200 封时剩余部分下一轮继续取到；真机探针结果写进 `docs/reference/architecture/outlook-com-backend.md`。

## B. Windows 历史邮件同步（P1）

反馈：https://app.notion.com/p/3d815375830d81e282edcc20fd5be618

- 首次运行把基线定在收件箱最新一封（`new_watcher.py:564`），只同步之后新到的邮件。
- `mailagent init fetch-cache/all` 走的 `InitialSync._fetch_emails_from_applescript` 只拦了 davmail（`src/init/initial_sync.py:416`），outlook_com 会继续走到 AppleScript 专用的分页取信，必然出错。Windows 目前没有任何可用的历史入口。
- 用户配置是 `SYNC_DATE_MODE=relative`、`SYNC_LOOKBACK_DAYS=14`，按字面理解会以为最近 14 天会被同步，实际一封都没有。

建议：A 修好后，outlook_com 首次运行的基线改为「现在 − SYNC_LOOKBACK_DAYS」，与 A-5 的回退重扫是同一条路径，再加上 A-6 的分批续取。是否推到 Notion 仍按现有日期规则判断。暂不做任意起止时间的手动回填入口。

## 附带发现（低优先级）

- 内存守护在 Windows 上读不到内存：`src/utils/mem_guard.py:70` 调用 `ps -o rss=`，Windows 没有这个命令，每次启动 3 分钟后报「guard is effectively blind」，内存保护在 Windows 上实际没有生效。
- 灵动岛在 Windows 上也启用了（`socket=/tmp/island.sock`），`src/service.py:341` 不判断平台。两个 island worker 显示 stale 就是这个原因，只是噪音。
- 11:50 一次反向同步 `ConnectError`，属于网络瞬断，不处理。

## 本次执行边界

- 只读核查：未改代码、未跑测试、未回写 Notion、未联系用户。
- 缺陷一、缺陷二的 entry_id 部分，以及 MAX_BATCH 水位问题，都有代码与日志两方面证据；message_id 反查落空的具体原因、DASL 字面量带秒的影响，待真机验证。

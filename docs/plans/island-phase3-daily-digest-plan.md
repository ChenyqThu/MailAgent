# 灵动岛 Phase 3 — DailyDigest 实施 Plan（评审稿）

> 状态：**待评审，未动手**。本文是实施前的工程级 plan，函数签名 + 文件清单 + 决策点取舍齐备，不含完整实现。
> 作者视角：基于对 MailAgent plugin（Python）+ ping-island fork（Swift, branch `feat/mail-brand`）的代码实读。
> 目标读者：评审本 plan 的人（你），以及之后照此执行的 executor。

---

## 0. 一句话目标 & 范围边界

每天 9:00 / 18:00（北京时区）做一次**跨邮件巡检**：查最近 24h 的邮件 → LLM 跑一次 cross-email summary → push 一个新 `eventType='DailyDigest'` 到灵动岛，带 counts（未读 / 紧急数）+ 1-3 个 bulk action（如「归档 5 封 newsletter」「批量标完成」）。flag `MAILAGENT_DAILY_DIGEST_ENABLED` 默认 `false`。

**尊重的 PRD 非目标（硬约束，全程不破）**：

1. 灵动岛不做 AI 多轮对话 / textarea / tool_use —— digest 只是「一条带几个按钮的通知」，不是对话窗口。
2. fork 改动 minimal，目标 **< 800 行 diff**，对月度 rebase 友好 —— 复用现有 `MailAgentSessionView` switch 框架 + 现有 button click 回写路径，不引入新协议 / 新 socket。
3. **写操作（bulk action）必须用户在灵动岛 click confirm 才执行**，无 silent send —— digest envelope 只描述「可以做什么」，真正的批量写在用户点了按钮、`island_response` 收到 choice 之后才发生。

**明确不做（本期 scope 外）**：

- 不做 digest 内的逐封邮件展开 / 滚动列表（灵动岛空间有限，只给汇总 + bulk 按钮）。
- 不做「智能 snooze」（那是 PRD Phase 4）。
- 不做跨设备 / 远程 push（纯本机 unix socket，跟现有 dispatch 一致）。
- bulk action 不做「撤销」（执行后若用户后悔，走 Notion / Mail.app 各自的 UI 回滚）。

---

## 1. 现状事实地基（代码实读结论，executor 可直接信）

> 这些是 plan 所有决策的依据。括号内是实读到的文件:行。

**Plugin（Python）**

- **Dispatch 层** `src/notify/island_dispatch.py`：9 个 `dispatch_*` 同步函数，内部 `asyncio.create_task` fire-and-forget。`dispatch_dead_letter_accum`（353-381）是**最简模式**（无 intervention，metadata 手搓而非走 `_base_metadata`），`dispatch_llm_reviewed`（210-292）是带 intervention 的复杂模式。`_fire(env, internal_id=...)`（544-580）统一发送 + 记录 + 收到 response 后调 `island_response.handle_response`。
- **关键发现**：`_fire` 内 `internal_id` 是 `Optional[int]`，digest 没有单一 internal_id，传 `None` 即可（`dispatch_dead_letter_accum` 已是这么用的，`record_island_dispatch` 接受 `internal_id=None`）。
- **Envelope 层** `src/notify/island_envelope.py`：`BridgeEnvelope` dataclass（104-119）。`_WIRE_EVENT_MAP`（38-49）把所有 mail event 名映射成 wire `"Notification"`，原名透传 `metadata["mailagent.eventType"]`。`encode()`（170-202）64KiB 截断，超限按 metadata 值长度降序丢。`Intervention.to_dict`（92-101）/ `InterventionOption.to_dict`（74-78）。
- **关键发现（决策点 2 的命脉）**：`InterventionOption` 只有 `id` / `title` / `detail` 三个字段（envelope.py 67-78），**没有 payload 字段**。Swift 侧 `SessionInterventionOption` 同样只有 `id` / `title` / `detail`（`SessionProvider.swift:866-874`）。`_extract_choice`（dispatch.py 583-594）只回 option 的 **id 字符串**。→ **bulk action 要带的 internal_id 列表无法塞进 option，只能走 `envelope.metadata`**（metadata 会原样回流到 `handle_response` 的 `envelope_meta` 参数）。
- **Response 层** `src/notify/island_response.py`：`handle_response(response, envelope_meta)`（79-142）按 `choice` 派发。`internal_id` 从 `envelope_meta.get("mailagent.internalId")` 取（97-103）。`_mailagent_args`（210-225）构造 CLI argv，`--api-key` 必须前置。`_run`（315-335）fire-and-forget subprocess。**当前所有 handler 都是单封语义**（`_mark_done(internal_id)` 等）。
- **Whitelist 层** `src/notify/island_action_whitelist.py`：`KNOWN_ACTION_IDS`（48-50）= 5 static + 12 recommended = 17 个。`is_known_action_id`（53-55）做 defense-in-depth。dispatch 端 + response 端都按它过滤。→ 新增 bulk action id 必须在这里注册，否则 `handle_response` 入口直接 whitelist miss drop。
- **定时 loop 模式**：`main.py:_meeting_expansion_loop`（576-628）用 `sync_store.get_state("last_meeting_expansion_at")` 做 **last-run gate** + `set_state` 回写。`island_snooze.tick_loop`（177-199）每 60s tick + `asyncio.wait_for(shutdown_event.wait(), timeout=interval)` 可中断 sleep。**无现成通用 cron 工具**。`island_response._seconds_until_next_monday_9am`（281-300）是「算到下一个特定时刻的秒数」的好先例。
- **LLM 单次 tool_use 先例** `src/llm_agent/task_extractor.py`：`TASK_TOOL_SCHEMA`（47-108）+ `TaskFields` dataclass（111-124）+ `_build_system(now, ...)`（127-152, 注入当前时间 + 周几 + 时区）+ `extract_task_fields(...)`（185-217）调 `client.classify(system_blocks, user_content, tool_schema, tool_name)` + `_parse`（220-250）带 enum 校验兜底。**这是 digest summarizer 的直接模板**。
- **Classify 入口** `src/llm_agent/client.py:classify`（148+），签名 `classify(*, system_blocks, user_content, tool_schema, tool_name)`，claude 协议走 native tool_use + cache_control，OpenAI 协议 flatten。
- **Cache 模式** `processor._build_system`（154-212）：**单个 `cache_control` 放最后一个 stable block 末尾**，覆盖 tools + header + ctx + 规则。digest 若要 cache，同样在 system 末尾加单断点。
- **24h 邮件数据**：`EmailRepository.list_emails`（约 591-700）有 `date_from` / `date_to` 过滤（`date_received >= ?` / `<= ?`，ISO 字典序 == 时间序），但返回 `EmailMetadataRecord`（**只有 metadata，无 AI 字段**）。AI 字段（category / priority / action_type / ai_summary / recommended_actions / reply_suggestion_md）在 `llm_processing.labels_json`（store.py schema 112-130，labels 8000 字符 cap）。→ **digest 取数要 JOIN `email_metadata` + `llm_processing`**（按 internal_id）。
- **state 表**：`sync_store.get_state(key)` / `set_state(key, value)`（1001-1048）通用 KV，digest 的 last-fire 时间戳存这里。
- **dispatch 审计**：`island_dispatch` 表（sync_store 568-590）+ `record_island_dispatch`（3219-3265），event_type='DailyDigest' 自动落表，免改 schema。
- **enable flag**：`config.ping_island_enabled`（config.py 357，默认 True）→ `main.py:274 self.island_enabled`。digest 是它的**子开关**（island 开 + digest 开 才跑）。

**Fork（Swift, `feat/mail-brand`）**

- **场景路由** `MailAgentSessionView.swift`：`switch scenario`（35-49）按 `meta("mailagent.scenario")` 选 layout。6 个 case + fallback。每个 layout 是一个 computed `var xxxLayout: some View`。metadata accessor 集中在 57-78（`meta` / `metaWithDefault`）。chips（313-359）/ intervention buttons（369-441）已成型可复用。
- **关键发现**：`interventionButtonRow`（369-377）`prefix(3)` 只渲前 3 个 button → digest 的 bulk action ≤ 3 个正好。button click（384-413）走 `HookSocketServer.shared.respondToIntervention(toolUseId:, decision:"answer", updatedInput:["choice": opt.id])` 回写，`toolUseId` 从 `session.hookMetadata["tool_use_id"]` 取（plugin envelope.py 145 写的 `bridge-<envelope_id>`）。→ **digest button 复用完全相同的回写路径，0 新协议**。
- **Profile 注册** `ClientProfile.swift`：`ManagedHookClientProfile(id:"mailagent", ...)`（994-1026），`events:` 列 9 个 `HookInstallEventDescriptor`（1015-1025）。runtime profile（1262-1273）brand=.mail 已就位，**无需新 provider**。
- **关键发现**：`events:` 数组里的 `HookInstallEventDescriptor(name:...)` 是给 hook 安装清单用的；要加 `DailyDigest` 作为一个被识别的 event 名，在此加一行。
- grep `MailAgent` 命中：`MailAgentSessionView` / `ClientProfile` / `SessionProvider`（option struct）/ `SessionHoverPreviewView` / `SessionState`（hookMetadata 容器）/ `SessionStore` / `HookSocketServer`。digest 只需碰前 2 个（View + Profile），其余复用。

---

## 2. 端到端数据流（目标态）

```
[每天 9:00 / 18:00 北京]
  main.py: daily_digest_loop (新 asyncio task, gate by digest flag)
     │  tick 每 60s 检查"是否进入未触发的 fire window"
     │  last-fire gate: sync_store.get_state("last_daily_digest_fire")
     ▼
  src/notify/daily_digest.py: run_digest_once(...)
     │  ① DND 检测 (decision 1) → 跳过 / 延迟
     │  ② 取最近 24h 邮件 (EmailRepository JOIN llm_processing)
     │  ③ 算 counts (unread / urgent / by-category)
     │  ④ 选 bulk action 候选 (规则, 非 LLM —— 见 decision 2)
     ▼
  src/llm_agent/digest_summarizer.py: summarize_digest(...)
     │  LLM 单次 tool_use (DIGEST_TOOL_SCHEMA)
     │  输入: 每封 subject + 11 AI 字段 (压缩) + counts + 候选 bulk
     │  输出: summary_md + 精炼 counts + 确认的 bulk_actions[]
     ▼
  src/notify/island_dispatch.py: dispatch_daily_digest(...)
     │  构造 BridgeEnvelope(event_type="DailyDigest",
     │     session_key="mailagent:daily_digest:YYYYMMDD",
     │     intervention=Intervention(options=[bulk_action_1..3]),
     │     metadata={..., "mailagent.digestBulk.<id>.ids": "53,54,55", ...})
     │  → encode → unix socket → fork
     ▼
  [ping-island fork]
  ClientProfile: events 含 DailyDigest (识别)
  MailAgentSessionView: switch case "DailyDigest" → digestLayout (新)
     │  标题"今日总结" + counts chips + bulk action buttons (prefix 3)
     │  用户 click 某 bulk button
     ▼
  HookSocketServer.respondToIntervention(choice="bulk_archive_newsletter")
     │  回写 BridgeResponse {"decision":{"answer":{"choice":...}}}
     ▼
  [plugin] island_dispatch._fire 后台 task 收到 response
  island_response.handle_response(response, envelope_meta)
     │  choice in _BULK_ACTION_IDS
     │  ids = parse envelope_meta["mailagent.digestBulk.<choice>.ids"]
     │  → _run_bulk(choice, ids)  (decision 2)
     ▼
  循环调单封 CLI (mailagent notion update-flag / archive)  OR  新 batch CLI
```

**核心设计原则**：digest 复用现有「envelope → fork → click → response handler」全链路，**唯一的两个真·新增协议面**是：(a) 新 eventType `DailyDigest`；(b) bulk action 的 internal_id 列表通过 metadata 命名空间携带。其余全是「加 case / 加分支」。

---

## 3. 六个决策点（推荐方案 + 备选 + 取舍）

### 决策点 1 — DND / 专注模式检测

**问题**：怎么检测 macOS 勿扰 / 专注模式？开 DND 时是跳过还是延迟到首次活跃再推？

**技术现实**（实读结论）：两个仓里**都没有任何 DND / Focus 检测代码**（grep 零命中）。macOS 没有公开稳定的 DND 查询 API；社区方案是读 `~/Library/DoNotDisturb/DB/Assertions.json`（Focus 模式状态文件，Ventura+），但路径 / schema 跨版本不稳，且在沙盒 / FDA 限制下未必可读（CLAUDE.md 明确本机有 FDA / sandbox 坑）。

**推荐方案：纯时段判断 + 「错过补推一次」，不读系统 DND（MVP）**

- digest 只在 9:00 / 18:00 两个固定时刻附近触发（fire window，见决策点 4）。这两个时刻本身就是「用户大概率在工位 / 通勤」的时段，已经隐含了「不在深夜打扰」。
- **不主动读系统 DND 状态**。理由：(a) 无稳定 API，读 Focus DB 在 FDA/sandbox 下脆弱，违反 CLAUDE.md「优先检查 macOS 限制再尝试」；(b) digest 是低频（每天 2 次）、非紧急（汇总性质）通知，即使在 DND 期间 push 到灵动岛，灵动岛本身是**被动展示**（不响铃、不强弹），打扰度极低；(c) 把复杂度堆在一个默认关闭的实验 feature 上不划算。
- **「错过补推」由 fire-window + last-fire gate 天然处理**（决策点 4）：进程没开错过了 9:00，开机后若当天 9:00 window 还没补过 → 补推一次。这覆盖了「关机 / 睡眠跳过」的主要场景，不需要 DND 检测参与。

**备选 A：读 Focus Assertions.json 软检测**

```python
# src/notify/dnd_detect.py (备选, 不推荐 MVP 落地)
def is_focus_active() -> Optional[bool]:
    """读 ~/Library/DoNotDisturb/DB/Assertions.json 判断 Focus/DND.
    返回 None = 读不到/不确定 (caller 当作"不在 DND"处理, fail-open)。"""
```
- 取舍：能做到「DND 时延迟到下次活跃」，但 FDA 依赖 + 跨 macOS 版本 schema 漂移 + 沙盒风险，维护成本高，收益（少打扰 2 次/天的被动通知）低。**留作 Phase 4 智能 snooze 一起做**（那时本来就要做活跃检测）。

**备选 B：延迟到「检测到用户活跃」再推**

- 复用 `keep_alive` 模块已有的鼠标活跃检测（CLAUDE.md 提到 KEEP_ALIVE 检测真人操作）。DND 期间不推，攒着，等检测到活跃再 fire。
- 取舍：体验最好但实现最重（要跨模块拿活跃信号 + 攒队列 + 去重），且 digest 是「当下 24h 快照」，延迟几小时后推内容已过时（counts 变了）。**不值得**。

**最终建议**：**MVP 走纯时段判断**（决策点 4 的 fire-window 即是）。代码上预留一个 `_should_suppress() -> bool` 钩子（默认 `return False`），Phase 4 要接 DND/活跃检测时只改这一个函数，不动主流程。

---

### 决策点 2 — bulk action 语义（命脉决策）

**问题**：digest 的 bulk action 怎么映射到 `island_response` handler？bulk 需要 internal_id 列表，envelope 怎么携带？handler 怎么批量执行？「写操作必须用户 confirm」怎么满足？

**事实约束（实读，不可绕过）**：

1. `InterventionOption` / `SessionInterventionOption` **只有 id/title/detail，无 payload 字段**。`_extract_choice` 只回 option 的 id 字符串。→ **internal_id 列表无法塞进 option**。
2. `handle_response(response, envelope_meta)` 的 **`envelope_meta` 是完整的 `envelope.metadata` 回流**（dispatch.py 576 `island_response.handle_response(result.response, envelope.metadata)`）。→ **唯一能携带 id 列表的通道是 metadata**。
3. metadata 值必须是 str（envelope.py 143 `{k: str(v) for ...}`），且 envelope 总大小 ≤ 64KiB（超限按值长度降序丢 metadata，envelope.py 184-193）。

**推荐方案：bulk action id 复用「动作类型」语义，internal_id 列表走 metadata 命名空间 `mailagent.digestBulk.<actionId>.ids`，handler 循环调现有单封 CLI**

**(a) bulk action id 设计**（注册进 whitelist）：

```python
# src/notify/island_action_whitelist.py 新增
BULK_ACTION_IDS: Final[FrozenSet[str]] = frozenset({
    "bulk_archive_newsletter",   # 归档一批 newsletter/FYI (→ 批量 mark done)
    "bulk_mark_done",            # 批量标完成 (urgent 处理完一批)
    "bulk_mark_read",            # 批量标已读 (不动 flag)
})
# KNOWN_ACTION_IDS 扩成 5 static + 12 recommended + 3 bulk = 20
KNOWN_ACTION_IDS = STATIC_FALLBACK_ACTION_IDS | RECOMMENDED_ACTION_IDS | BULK_ACTION_IDS

def is_bulk_action_id(action_id: str) -> bool: ...
```

理由：bulk action 数量**有意保持极小（3 个）**。digest 不是「逐封操作面板」，而是「一键清理一类」。3 个覆盖最高频意图（归档 newsletter / 标完成 / 标已读），符合 PRD「轻量通知中心」定位，也守住 fork `prefix(3)` 视觉密度。

**(b) internal_id 列表携带**（metadata 命名空间）：

```python
# envelope.metadata 里, 每个 bulk action 对应一组 ids:
{
  "mailagent.scenario": "DailyDigest",
  "mailagent.digestDate": "20260526",
  "mailagent.digestUnread": "12",
  "mailagent.digestUrgent": "3",
  # 每个出现在 intervention.options 里的 bulk action, 带一个 ids 串:
  "mailagent.digestBulk.bulk_archive_newsletter.ids": "53675,53680,53681,53690,53701",
  "mailagent.digestBulk.bulk_mark_done.ids": "53710,53712",
}
```

- **id 列表上限**：每个 bulk action 最多带 **N=30 个 internal_id**（30 个 6-7 位 id 逗号分隔 ≈ 240 字节，远低于 64KiB；多个 bulk action 合计也就 KB 级）。超过 30 封的「全归档」在 summarizer 端 cap 到 30 并在 summary 文案里注明「（仅处理最近 30 封）」。理由：单次灵动岛 click 触发的批量操作不宜过大（用户无法逐一确认内容），30 是「一类邮件的合理批量」上限。
- **去重 / 边界**：列表里只放 24h 窗口内、`notion_page_id IS NOT NULL`（已同步到 Notion，能 update-flag）、且符合该 action 语义的邮件（newsletter 类只放 category/action 命中 FYI 的）。

**(c) handler 批量执行**（推荐：循环调现有单封 CLI，不新建 batch CLI）：

```python
# src/notify/island_response.py 新增分支
elif is_bulk_action_id(choice):
    await _run_bulk(choice, _parse_digest_ids(envelope_meta, choice))

async def _parse_digest_ids(meta: Dict[str,str], choice: str) -> List[int]:
    """读 meta["mailagent.digestBulk.<choice>.ids"] → [int,...]，非法跳过，cap 30。"""

async def _run_bulk(choice: str, ids: List[int]) -> None:
    """循环调单封 CLI。bulk_archive_newsletter / bulk_mark_done → notion update-flag
    --processing-status 已完成; bulk_mark_read → update-flag --is-read。
    串行 + 每封独立 try (一封失败不阻断后续), 汇总 log。
    """
    for iid in ids:
        await _run(_mailagent_args("notion","update-flag",str(iid),
                   "--processing-status","已完成"), timeout=30)
```

**循环单封 CLI vs 新 batch CLI 的取舍**：

| | 循环单封 CLI（推荐 MVP） | 新 batch CLI `mailagent notion bulk-update-flag --ids` |
|---|---|---|
| 实现量 | 0 新 CLI，复用 `update-flag` | 新 leaf command + schema + 退出码 + 测试 |
| 正确性 | 每封独立事务，幂等（已是 SSoT 反转架构） | 需自己实现部分失败语义 |
| 性能 | N 次 subprocess（30 封 ≈ 几秒，digest 低频可接受） | 1 次 subprocess，快 |
| 一致性 | 复用现有 update-flag 的 outbox/fanout 路径，行为可信 | 要保证走同一套 outbox 派发 |
| 风险 | N 个 subprocess 拉起开销（但 fire-and-forget，用户已 ack） | 引入新写命令的鉴权/PM2 检测面 |

**结论**：MVP 走**循环单封 CLI**。digest 每天 2 次、每次 ≤ 30 封、用户主动点击触发，N 次 subprocess 的开销完全可接受，且复用 `update-flag` 意味着零新写路径、零新鉴权面、行为与现有 Notion 反向同步完全一致。**若实测 30 封循环明显慢（> 10s）再升级 batch CLI**（接口已留好，`_run_bulk` 内部换实现即可，envelope/fork 不动）。

**(d) 「写操作必须用户 confirm」如何满足**（PRD 硬约束）：

- digest envelope 本身**不执行任何写**，它只是描述「有这些邮件，你可以批量归档/标完成」。
- 真正的批量写发生在 **用户在灵动岛点了 bulk button → `respondToIntervention` 回写 choice → `handle_response` 收到 → `_run_bulk` 执行**。整条链路的触发点是用户的一次物理 click。
- 这与现有单封 action（mark_done 等）的 confirm 语义**完全一致**：灵动岛的 button click 本身就是 confirm。**不需要二次确认 dialog**（那是前端 Custom AI chat panel 的 ConfirmToolDialog，跟灵动岛是两条独立路径，PRD 已划清）。
- 防御：`_run_bulk` 前 `is_bulk_action_id(choice)` 二次校验；ids 解析做 NaN/越界/cap 过滤；任一封失败仅 log 不 raise（跟 `_run` 一致）。

---

### 决策点 3 — digest prompt + 输出 schema

**问题**：cross-email summary 的 system/user prompt 怎么组织？`DIGEST_TOOL_SCHEMA` 输出什么？cost 控制？

**推荐方案：新模块 `src/llm_agent/digest_summarizer.py`，照 `task_extractor.py` 模板，单次 tool_use；counts 由代码算（不靠 LLM 数），LLM 只负责「写人话摘要 + 确认 bulk 文案」**

**关键设计决策：counts 不让 LLM 数。** LLM 数数不可靠（几十封邮件让它统计未读/紧急数容易错）。代码侧从 JOIN 结果**确定性算 counts**，传给 LLM 作为已知事实，LLM 只用它写文案。同理 bulk action 的 id 列表**也由代码确定性选**（按 category/action 规则），LLM 只决定「这一批要不要在 digest 里推、文案怎么写」。这样 LLM 出错的爆炸半径限定在「文案质量」，不影响「点了归档到底归档哪几封」的正确性。

**`DIGEST_TOOL_SCHEMA` 输出**：

```python
DIGEST_TOOL_SCHEMA = {
  "name": "summarize_digest",
  "description": "把最近24h邮件汇总成一条灵动岛今日总结。只调用一次。",
  "input_schema": {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary_md", "headline"],
    "properties": {
      "headline": {            # 灵动岛标题副文案, ≤ 30 字
        "type": "string", "maxLength": 30,
        "description": "一句话概括今天邮件态势，如『3封紧急待回复，5封newsletter可清理』"
      },
      "summary_md": {          # 展开后的 2-4 句摘要, ≤ 400 字
        "type": "string", "maxLength": 400,
        "description": "2-4句中文摘要，点出最该关注的1-2封 + 整体态势。inline markdown only。"
      },
      "confirmed_bulk_actions": {   # LLM 从代码给的候选里挑要展示的 (≤3)
        "type": "array", "maxItems": 3,
        "items": {
          "type": "object",
          "required": ["id", "title"],
          "properties": {
            "id": {"type":"string","enum":["bulk_archive_newsletter","bulk_mark_done","bulk_mark_read"]},
            "title": {"type":"string","maxLength":24,  # 按钮文案, 如"归档5封newsletter"
              "description":"动词+数量，数量必须等于代码给的候选数，不要瞎编"},
            "detail": {"type":"string","maxLength":40}  # 可选二行说明
          }
        },
        "description": "从候选bulk中挑1-3个值得在灵动岛一键执行的；候选为空就返回空数组。"
      }
    }
  }
}
```

> 注意 schema **不输出 counts、不输出 ids**。counts 是代码算好传入的（LLM 在 prompt 里看到但不复述进 tool output）；ids 由代码按 confirmed action 的 id 回填到 metadata。LLM 只能从固定 enum 选 action id + 写 title 文案 → 即使 LLM 乱来，也只能在 3 个已知 action 里选，id 列表始终是代码控制的。

**`DigestSummary` dataclass**：

```python
@dataclass
class DigestSummary:
    headline: str
    summary_md: str
    confirmed_actions: List[DigestBulkAction]  # id + title + detail (代码再附 ids)
    # meta
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    model: str = ""
```

**prompt 组织**（`_build_system` / `_build_user`）：

```python
def _build_system(now: datetime) -> List[Dict[str,Any]]:
    # 照 task_extractor: 注入当前时间+周几+时区; 说明"你在写灵动岛今日总结,
    # 调 summarize_digest EXACTLY ONCE, counts是已知事实别改, bulk只能从候选选"。
    # 末尾加 cache_control (照 processor, 但 system 几乎全静态 → 高命中)。

def _build_user(*, emails_brief: List[dict], counts: dict,
                bulk_candidates: List[dict], body_max_per_email: int = 0) -> str:
    # emails_brief: 每封 {subject, sender_name, category, priority, action_type,
    #   ai_summary(截80字), is_read} —— 不传正文! 只传已有AI字段
    # counts: {unread, urgent, by_category:{...}, total}
    # bulk_candidates: [{id, count, sample_subjects:[..3]}]
```

**cost 控制**（关键，24h 可能几十封）：

1. **不传正文**。每封只传 subject + 已算好的 11 AI 字段里的精华（category/priority/action_type/ai_summary 截 80 字）。一封 ≈ 60-100 token，50 封 ≈ 3-5K token。
2. **封数 cap**。digest 输入最多 **M=50 封**（按 priority DESC + date DESC 排序取前 50；超出的归入 counts 但不进 LLM brief）。50 封够覆盖「最该关注的」。
3. **ai_summary 缺失的邮件不补算**。digest 是「汇总已分类的邮件」，没跑过 LLM 分类的（labels_json 为空）只计入 counts、subject 进 brief，不触发新的单封 LLM。digest 自己只烧 1 次 LLM call。
4. **cache**。system 几乎全静态（只有「当前时间」变），单断点 cache 命中率高；但 digest 每天才 2 次、间隔 9h，TTL 1h 会过期 → **cache 收益有限，主要靠不传正文 + cap 控成本**。预估单次 digest ≈ 输入 5K + 输出 0.5K ≈ **$0.01-0.02/次，$0.02-0.04/天**。可忽略。
5. fallback：summarizer LLM 失败 → **降级为「无 LLM 的纯 counts digest」**（headline = 模板字符串 `"今日 {unread} 未读 / {urgent} 紧急"`，summary_md 空，bulk action 仍可由代码规则给出）。digest 不因 LLM 挂而完全不推。

---

### 决策点 4 — 定时触发

**问题**：`daily_digest_loop` 照 `island_snooze` tick 还是 `meeting_expansion` 模式？9:00/18:00 怎么算 next fire（北京时区）？进程没开错过了怎么补？

**推荐方案：tick_loop（60s）+ fire-window 命中检测 + last-fire gate（存 sync_store state），开机后当天未触发过的 window 已过则补推一次**

理由：digest 不是「每隔 N 秒跑一次」（那是 expansion 的 interval 模式），而是「每天在 2 个固定钟点跑」。所以用 **island_snooze 的 tick 节奏（60s 醒一次，可被 shutdown 中断）** + **每次 tick 判断「现在是不是落在某个未触发过的 fire window 里」**。

```python
# main.py 新增 (照 island_snooze_task 的起法, gate by digest flag)
if self.island_enabled and config.mailagent_daily_digest_enabled:
    daily_digest_task = asyncio.create_task(
        daily_digest.tick_loop(
            sync_store=self.watcher.sync_store,
            run_once=self._run_daily_digest_once,  # 注入依赖, 便于测试
            shutdown_event=self._shutdown_event,
        )
    )
```

```python
# src/notify/daily_digest.py
_BEIJING = timezone(timedelta(hours=8))
FIRE_HOURS = (9, 18)             # 北京时间的触发钟点 (config 可覆盖)
FIRE_WINDOW_MIN = 30             # 落在钟点后 30min 内算"该 window"
TICK_INTERVAL_SEC = 60

def _current_fire_slot(now: datetime) -> Optional[str]:
    """now (北京) 若落在某 fire window 内, 返回该 slot 标识 'YYYYMMDD-09';
    否则 None。window = [HH:00, HH:00+30min)。"""

def _already_fired(sync_store, slot: str) -> bool:
    """读 state('last_daily_digest_fire') == slot ? (防同一 window 重复推)"""

def _missed_catchup_slot(now, sync_store) -> Optional[str]:
    """开机补推: 今天已过的最近一个 fire 钟点, 若其 slot 未触发过 → 返回它,
    让进程晚开机时补推一次当天最近该推的。只补"当天最近一个", 不补历史多次。"""

async def tick_loop(*, sync_store, run_once, shutdown_event=None,
                    interval_sec=TICK_INTERVAL_SEC) -> None:
    """每 60s: 算 slot = _current_fire_slot(now) or _missed_catchup_slot(...);
    slot 非空且 not _already_fired → await run_once(slot) → set_state 记 slot。
    照 island_snooze.tick_loop 的 shutdown_event 可中断 sleep 结构。"""
```

**9:00/18:00 北京时区怎么算**：`datetime.now(_BEIJING)`（照 task_extractor 用固定 `+08:00`，不依赖机器时区；CLAUDE.md 项目时区语义全是北京）。`_current_fire_slot` 直接比 `now.hour`：若 `now.hour == 9 and now.minute < 30` → slot `"YYYYMMDD-09"`。简单可靠，无需 `_seconds_until_next` 那种倒计时（tick 模式下每分钟问一次「现在在不在 window」即可）。

**补推语义**（明确）：

- **正常**：进程一直开着，每天 9:00-9:30 内某次 tick 命中 slot `20260526-09` → 推 → 记 state。18:00 同理。
- **开机晚了**：用户 10:00 才开机，当天 `20260526-09` slot 没推过 → `_missed_catchup_slot` 返回它 → **补推一次**。
- **只补当天最近一个，不补历史**：若关机 3 天，开机后只补「今天最近该推的那一个」，不会一次性补 6 条。理由：digest 是「当下 24h 快照」，补 3 天前的 9:00 digest 毫无意义（那 24h 的邮件早已是历史）。
- **跨过钟点没补**：若 9:45 才开机（已过 9:30 window 但未到下个钟点），`_missed_catchup_slot` 仍认为 9:00 slot 当天该推且未推 → 补推（用「现在的 24h」当快照，可接受，因为 9:45 看「过去24h」跟 9:00 看差别不大）。直到 18:00 window 才有下一个 slot。

**config**：

```python
mailagent_daily_digest_enabled: bool = Field(default=False, env="MAILAGENT_DAILY_DIGEST_ENABLED", ...)
mailagent_daily_digest_hours: str = Field(default="9,18", env="MAILAGENT_DAILY_DIGEST_HOURS", ...)  # 逗号分隔小时
mailagent_daily_digest_window_hours: int = Field(default=24, env="...", ...)  # 回看窗口
mailagent_daily_digest_max_emails: int = Field(default=50, env="...", ...)    # LLM brief 封数 cap
mailagent_daily_digest_max_bulk_ids: int = Field(default=30, env="...", ...)  # 每 bulk action id cap
```

**备选：照 meeting_expansion 的 interval+last-run gate** —— 不合适。expansion 是「间隔 N 秒滚一次」，digest 是「固定钟点」。硬套 interval 要算「距离下个 9:00/18:00 还有多久」再 sleep 那么久，sleep 期间不能响应 shutdown（除非 wrap wait_for），且错过 window 的补推逻辑更绕。**tick 模式更直观、更易测**。

---

### 决策点 5 — fork scene（Swift）

**问题**：`MailAgentDigestView` layout 设计 + 注册点清单。fork minimal < 800 行 diff 怎么守。

**推荐方案：不新建 `MailAgentDigestView.swift` 文件，而是在现有 `MailAgentSessionView.swift` 里加一个 `case "DailyDigest"` + 一个 `digestLayout` computed var**

理由：fork minimal < 800 行 diff。新建独立文件会引入新 struct + 新的 metadata accessor 重复 + 新的 button row 重复。**复用 `MailAgentSessionView` 已有的**：`meta()` accessor、`mascotView`、`interventionButtonRow`（含完整 click 回写路径）、`chipsRow` 风格、`accentColor` / `eyebrowLine`。digest 只需要一个新的 `digestLayout`（≈ 50-70 行 SwiftUI）+ 几个 digest 专属 accessor（counts）。

**`digestLayout` 设计**（mockup 风格对齐现有 attentionLayout）：

```swift
// MailAgentSessionView.swift 内新增
case "DailyDigest":
    digestLayout

private var digestUnread: Int { Int(meta("mailagent.digestUnread")) ?? 0 }
private var digestUrgent: Int { Int(meta("mailagent.digestUrgent")) ?? 0 }
private var digestHeadline: String { meta("mailagent.digestHeadline") }
private var digestSummary: String { meta("mailagent.aiSummary") }  // 复用 aiSummary 通道

private var digestLayout: some View {
    VStack(alignment: .leading, spacing: 10) {
        // 头: mascot(default/work) + eyebrow "MailAgent · 今日总结" + headline
        HStack(alignment: .top, spacing: 10) {
            mascotView
            VStack(alignment: .leading, spacing: 2) {
                eyebrowLine(suffix: "今日总结")
                Text(digestHeadline.isEmpty ? "今日邮件汇总" : digestHeadline)
                    .font(.system(size: 14, weight: .semibold))...
            }
        }
        // counts chips: [12 未读] [3 紧急]  (复用 capsule 风格)
        digestCountsRow
        // summary 2-4 句
        if !digestSummary.isEmpty { Text(digestSummary)... lineLimit(3) }
        // bulk action buttons —— 复用 interventionButtonRow (prefix 3) 原样!
        interventionButtonRow
    }
}

private var digestCountsRow: some View {
    HStack(spacing: 6) {
        if digestUnread > 0 { countChip("\(digestUnread) 未读", tint: .gray) }
        if digestUrgent > 0 { countChip("\(digestUrgent) 紧急", tint: critColor) }
        Spacer(minLength: 0)
    }
}
private func countChip(_ text: String, tint: Color) -> some View { ... }  // ≈ priorityChip 复制
```

**`interventionButtonRow` 零改动复用** —— 这是省 diff 的关键。digest 的 bulk action 走 `intervention.options`（plugin 端 `Intervention(options=[InterventionOption(id="bulk_archive_newsletter", title="归档5封newsletter")...])`），fork 端 `interventionButtonRow` 的 `prefix(3)` + `respondToIntervention(choice: opt.id)` 完全适用，**不需要为 digest 写任何新的 button / 回写代码**。

**注册点清单（fork 端全部改动）**：

1. `ClientProfile.swift:1015-1025` events 数组加一行：
   ```swift
   HookInstallEventDescriptor(name: "DailyDigest", templates: [.plain]),
   ```
2. `MailAgentSessionView.swift:35-49` switch 加一个 case：
   ```swift
   case "DailyDigest": digestLayout
   ```
3. `MailAgentSessionView.swift` 加 `digestLayout` + `digestCountsRow` + `countChip` + 3 个 digest accessor。

**diff 预算**：注册点 1 ≈ 1 行；switch case ≈ 1 行；digestLayout 全套 ≈ 60-80 行。**fork 总 diff < 100 行**，远在 800 行预算内，rebase 友好（只在已有 mailagent 区块内加，不碰公共组件）。

**测试**：fork 有 `PingIslandTests/`，照现有 `MailAgentSessionView` 的测试加一个 DailyDigest scenario 的 snapshot/逻辑测试（metadata → 正确 layout 分支）。

---

### 决策点 6 — session_key / envelope eventType

**问题**：digest 的 session_key / eventType / wire 映射。

**推荐方案**（与研究结论一致，已验证可行）：

- **session_key = `mailagent:daily_digest:YYYYMMDD`**（如 `mailagent:daily_digest:20260526`）。
  - 理由：与单邮件 session `mailagent:email:{internal_id}` 命名空间隔离，不冲突。按天唯一 → 同一天 9:00 和 18:00 两次 digest **共享同一 session_key**（fork 端会更新同一 session 而非堆两条）。这符合「今日总结」语义：18:00 的 digest 覆盖/更新 9:00 那条。
  - 备选：`mailagent:daily_digest:YYYYMMDD-HH`（9:00 和 18:00 各一条 session）。取舍：会在 fork 端留两条「今日总结」session，视觉上冗余。**按天合并更干净**。若评审觉得「早晚两次要分开看」再改成带 HH。
- **eventType = `"DailyDigest"`**（`BridgeEnvelope.event_type`）。
- **`_WIRE_EVENT_MAP` 加映射**（envelope.py 38-49）：
  ```python
  "DailyDigest": "Notification",  # 配合 status.kind + intervention 走 fork 通知 phase
  ```
  - 理由：与所有 mail event 一致，wire 层统一翻成 `"Notification"` 让 fork dispatcher 接住（fork 只识别 `UserPromptSubmit/PreToolUse/Notification/Stop/SessionStart` 等内置 hook 名）。原名 `"DailyDigest"` 通过 `metadata["mailagent.eventType"]` 透传（envelope.py 144 自动做）+ `metadata["mailagent.scenario"]="DailyDigest"` 给 fork 选 layout。
- **status_kind**：bulk action 在 → `"waitingForInput"` + `expects_response=True`（让 fork 走 attentionNotification phase，渲染可点 button，跟 urgent 一致）。无 bulk action 时 → `"notification"` + `expects_response=False`（纯展示）。
- **metadata.scenario = `"DailyDigest"`** —— fork `MailAgentSessionView` switch 据此选 `digestLayout`。

---

## 4. 分阶段实施 plan

> 顺序：**Plugin 端先（可独立验证 envelope 编码 + dispatch + 取数 + LLM）→ Fork 端（加 scene）→ 联调（真 push + click）**。每阶段产出可单测，最后才动真灵动岛。

### Phase A — Plugin 取数 + LLM summarizer（无 dispatch、无 fork）

**目标**：能从 SQLite 取 24h 邮件 + 算 counts + 跑 LLM summary，纯函数可单测，不碰 socket/fork。

**新建**：
- `src/llm_agent/digest_summarizer.py` — `DIGEST_TOOL_SCHEMA` + `DigestSummary` / `DigestBulkAction` dataclass + `_build_system(now)` / `_build_user(...)` + `async summarize_digest(*, emails_brief, counts, bulk_candidates, now=None, client=None) -> DigestSummary` + `_parse(result)`（enum 校验兜底）。**照 `task_extractor.py` 结构 1:1**。
- `src/notify/digest_query.py` —— 取数 + 算 counts 模块（独立于 dispatch，便于测）：
  - `def fetch_recent_emails(repo, sync_store, *, window_hours=24, max_emails=50, now=None) -> List[DigestEmailBrief]` —— JOIN `email_metadata`（list_emails date_from/date_to）+ `llm_processing.labels_json`（按 internal_id 取 category/priority/action_type/ai_summary）。
  - `def compute_counts(briefs) -> dict` —— `{unread, urgent, total, by_category}`。urgent 判定复用 `island_dispatch.URGENT_PRIORITY_LABELS` + `ACTION_NEEDS_FLAG`。
  - `def select_bulk_candidates(briefs, *, max_ids=30) -> List[BulkCandidate]` —— 规则选候选：newsletter/FYI 类（category 或 action_type 命中）→ `bulk_archive_newsletter`；已 AI Reviewed 且用户大概率想清的 → `bulk_mark_done` 等。**id 列表在此确定性生成**。

**修改**：
- `src/config.py` — 加 5 个 digest Field（见决策点 4）。
- `.env.example` — 加 5 个 digest 示例（默认 false）。

**关键骨架**：
```python
# src/notify/digest_query.py
@dataclass
class DigestEmailBrief:
    internal_id: int; subject: str; sender_name: str
    category: str; priority: str; action_type: str
    ai_summary: str; is_read: bool; notion_page_id: Optional[str]

@dataclass
class BulkCandidate:
    action_id: str            # bulk_archive_newsletter / ...
    internal_ids: List[int]   # cap max_ids
    sample_subjects: List[str]  # 给 LLM 写文案 (≤3)
```

**该阶段决策点**：3（prompt/schema/cost）、2 的 (b) id 列表生成规则。

**工作量**：summarizer ≈ 照 task_extractor 改，0.5d；digest_query（JOIN + counts + 候选规则）≈ 1d；config + 单测 ≈ 0.5d。**Phase A ≈ 2d**。

**验收**：`pytest tests/llm_agent/test_digest_summarizer.py tests/notify/test_digest_query.py`（mock LLM + mock SQLite，不烧 token）。手测 `python -c "from src.notify.digest_query import fetch_recent_emails; ..."` 在真 db 上跑出 briefs + counts。

---

### Phase B — Plugin dispatch + response handler + 定时 loop（仍无 fork）

**目标**：`dispatch_daily_digest` 能构造正确 envelope（单测断言 metadata/intervention/wire 映射）；`handle_response` 能解析 bulk choice + ids 并循环调 CLI（mock subprocess）；`daily_digest.tick_loop` 能在 fire-window 命中（mock now）。socket 发送 fail-open（没装灵动岛也不报错）。

**新建**：
- `src/notify/daily_digest.py` — `FIRE_HOURS` / `_current_fire_slot` / `_missed_catchup_slot` / `_already_fired` / `_should_suppress`（决策点 1 钩子，默认 False）/ `async run_digest_once(*, sync_store, repo, slot, dispatch_fn=..., summarize_fn=...)` / `async tick_loop(...)`。`run_digest_once` 编排：取数 → counts → 候选 → summarize → dispatch。

**修改**：
- `src/notify/island_dispatch.py` — 加 `def dispatch_daily_digest(*, digest_date, headline, summary_md, unread, urgent, by_category, confirmed_actions: List[Tuple[str,str,Optional[str],List[int]]]) -> None`：
  ```python
  def dispatch_daily_digest(*, digest_date, headline, summary_md,
                            unread, urgent, confirmed_actions):
      if not _state.enabled: return
      options = [InterventionOption(id=a.id, title=a.title, detail=a.detail)
                 for a in confirmed_actions]
      meta = {... "mailagent.scenario":"DailyDigest",
              "mailagent.digestDate":digest_date,
              "mailagent.digestHeadline":headline,
              "mailagent.aiSummary":summary_md,
              "mailagent.digestUnread":str(unread),
              "mailagent.digestUrgent":str(urgent)}
      for a in confirmed_actions:           # ids 走 metadata 命名空间
          meta[f"mailagent.digestBulk.{a.id}.ids"] = ",".join(map(str,a.internal_ids[:30]))
      env = BridgeEnvelope(event_type="DailyDigest",
              session_key=f"mailagent:daily_digest:{digest_date}",
              title=island_i18n.t("mail.digest.title"), preview=headline,
              status_kind="waitingForInput" if options else "notification",
              metadata=meta,
              intervention=Intervention(title=..., message=summary_md, options=options) if options else None,
              expects_response=bool(options))
      _fire(env, internal_id=None)          # digest 无单一 internal_id
  ```
- `src/notify/island_envelope.py:_WIRE_EVENT_MAP` — 加 `"DailyDigest": "Notification"`。
- `src/notify/island_action_whitelist.py` — 加 `BULK_ACTION_IDS` + `is_bulk_action_id` + 扩 `KNOWN_ACTION_IDS`。
- `src/notify/island_response.py` — `handle_response` 加 `elif is_bulk_action_id(choice): await _run_bulk(...)` 分支 + `_parse_digest_ids` + `_run_bulk`。
- `src/notify/island_i18n.py` 对应 locale 文件加 `mail.digest.title` / `mail.digest.message` 等 key（plugin 端 fallback 到 key 也不崩，但应补全 zh-CN/en-US）。
- `main.py` — `__init__` 区 `island_dispatch.init` 后无需改（digest 用同一 dispatcher state）；启动 task 区加 `daily_digest_task`（gate by `island_enabled and config.mailagent_daily_digest_enabled`）；shutdown 区 append 到 `tasks` 取消列表。

**该阶段决策点**：2（bulk 语义全套）、4（定时）、6（session_key/eventType/wire）。

**工作量**：dispatch_daily_digest + envelope/whitelist/response 改 ≈ 1d；daily_digest loop（fire-window + 补推 + 单测 mock now）≈ 1d；main.py 接线 + i18n ≈ 0.5d；单测 ≈ 0.5d。**Phase B ≈ 3d**。

**验收**：`pytest tests/notify/test_dispatch_daily_digest.py test_daily_digest_loop.py test_island_response.py`（断言：envelope wire eventType=Notification + scenario=DailyDigest + metadata 带 digestBulk ids；bulk choice → 解析 ids → 调 N 次 update-flag mock；fire-slot 命中 / 补推 / 不重复推）。手测：临时设 `MAILAGENT_DAILY_DIGEST_HOURS=<当前小时>` + flag 开 + `python main.py`，看 log 是否在 window 内触发 + envelope 编码无误（灵动岛没装时 socket fail-open，log warning 但不崩）。

---

### Phase C — Fork scene（Swift）

**目标**：fork 识别 `DailyDigest` event + `MailAgentSessionView` 渲染 `digestLayout`，bulk button 复用现有回写路径。

**修改**（全部在 fork `feat/mail-brand` 分支，见决策点 5 注册点清单）：
- `PingIsland/Models/ClientProfile.swift` — events 加 `HookInstallEventDescriptor(name: "DailyDigest", templates: [.plain])`。
- `PingIsland/UI/Views/MailAgentSessionView.swift` — switch 加 `case "DailyDigest": digestLayout` + `digestLayout` / `digestCountsRow` / `countChip` + 3 digest accessor（`digestUnread`/`digestUrgent`/`digestHeadline`）。

**该阶段决策点**：5（fork scene + diff 预算）。

**工作量**：digestLayout SwiftUI + accessor ≈ 0.5d；fork 测试 ≈ 0.5d。**Phase C ≈ 1d**。**fork diff < 100 行**。

**验收**：`xcodebuild` 编译过；fork 单测（DailyDigest metadata → digestLayout 分支 + counts 渲染）；本地跑 ping-island.app。

---

### Phase D — 联调 + dogfood

**目标**：plugin 真 push DailyDigest envelope 到运行中的 ping-island.app，灵动岛显示 digest，点 bulk button 真触发批量 update-flag，Notion 端看到批量标完成。

**步骤**：
1. fork 装到本机（build & run ping-island.app，profile mailagent enabled）。
2. plugin `.env`：`MAILAGENT_DAILY_DIGEST_ENABLED=true` + `MAILAGENT_DAILY_DIGEST_HOURS=<当前小时>`（临时，验完改回 9,18）。`pm2 restart mail-sync`。
3. 等 fire-window（或临时把 window 调大 / 直接调 `run_digest_once` 手触发一次）。
4. 看灵动岛出「今日总结」卡片：headline + counts chips + bulk buttons。
5. 点「归档 N 封 newsletter」→ 看 plugin log `[island-response] choice=bulk_archive_newsletter` + N 次 `update-flag` → Notion 端这 N 封 `Processing Status=已完成`。
6. 验证补推：kill mail-sync 跨过一个 fire 钟点，重启，看是否补推一次当天最近 slot。

**该阶段决策点**：全部（端到端验证）。

**工作量**：联调 + 修 cutover-only bug（envelope 字段名 / metadata key 大小写 / fork 解码）≈ 1d。**Phase D ≈ 1d**。

**验收**：灵动岛真显示 digest；click 真批量执行；补推语义正确；`sqlite3 ... "SELECT event_type, COUNT(*) FROM island_dispatch WHERE event_type='DailyDigest'"` 有记录。

---

### 总工作量

| Phase | 内容 | 估算 |
|---|---|---|
| A | 取数 + counts + LLM summarizer（纯函数可测） | 2d |
| B | dispatch + bulk response handler + 定时 loop | 3d |
| C | fork scene（Swift, < 100 行 diff） | 1d |
| D | 联调 + dogfood + bug 修 | 1d |
| **合计** | | **~7d** |

（与 Ping Island PRD 估的「Phase 3 每日巡检」量级一致：原 PRD 4 phase ~8-11d，本 Phase 3 单独 ~7d 合理。）

---

## 5. 开放问题 / 待评审决策

> 这些是我倾向了一个方向但需要你拍板的点（已在正文给推荐，这里汇总让你一眼扫）。

1. **bulk action 集合**：MVP 定 3 个（`bulk_archive_newsletter` / `bulk_mark_done` / `bulk_mark_read`）。够不够？要不要加 `bulk_defer_to_tomorrow`（批量推迟到明天）？—— *倾向先 3 个，dogfood 后按真实需求加。*
2. **session_key 按天合并 vs 早晚分开**：推荐 `mailagent:daily_digest:YYYYMMDD`（18:00 覆盖 9:00 同一卡片）。你是否希望早晚两条 digest 在灵动岛分开留存（那就改 `-HH`）？
3. **bulk id 列表 cap=30**：单次 click 最多批量处理 30 封。是否够 / 是否太多（30 封一键标完成会不会误伤）？—— *倾向 30，且 summary 文案明示「仅最近 30 封」。*
4. **DND 检测**：MVP **不读系统 DND**，靠时段（9/18 点本身已避深夜）+ 灵动岛被动展示低打扰。你是否接受「digest 可能在你开了专注模式时也 push 到灵动岛」？若不接受，需要把备选 A（读 Focus DB）提前到本期（+FDA 风险 + ~1d）。
5. **补推策略**：开机晚了只补「当天最近一个该推的 slot」，不补历史。关机数天再开只补今天最近一次。认可？
6. **counts 维度**：MVP chips 只显示「未读 / 紧急」两个。要不要加「by category」（如 newsletter N 封）chip？—— *倾向只 2 个 chip 保持简洁，category 细分放进 summary_md 文案。*
7. **「无 bulk action 的 digest 要不要推」**：若某天 24h 邮件都不构成 bulk 候选（没 newsletter、没待办堆积），digest 退化成「纯 counts + summary 无按钮」。这种「纯告知」digest 是否值得推（vs 干脆跳过不打扰）？—— *倾向：若 unread/urgent 都为 0 则跳过不推（无事不扰）；否则推纯告知。*

---

## 6. 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| **LLM 在 bulk title 里写错数量**（如代码给 5 封候选，LLM 写「归档 8 封」） | 中 | id 列表由代码控制，真实归档数 = 代码给的 ids 数；title 仅展示文案。可在 dispatch 端用代码算的 count 覆盖/校验 LLM 写的 title 数字（防误导用户）。**建议 dispatch 端强制 title 里的数字 = len(ids)**。 |
| **metadata 携带 ids 撞 64KiB 截断**（极端：多个 bulk action × 大量 id） | 低 | 每 action cap 30 id ≈ 240B，3 action ≈ 720B，远低于 64KiB。且 `encode()` 截断按值长度降序丢，digestBulk ids 不是最长值（summary_md / ctx 更长），即使触发截断也不会先丢 ids。仍建议单测断言「30×3 ids 的 envelope < 64KiB」。 |
| **fire-window 边界抖动**（59s tick 可能跨过 30min window 末尾刚好没命中） | 低 | window 30min 远大于 tick 60s，正常至少命中 28 次 tick。补推逻辑兜底「当天该 slot 未推过就补」，不会漏。 |
| **24h 窗口取数慢**（大邮箱 JOIN llm_processing） | 低 | list_emails 已有 mailbox+sync_status+date_received 复合索引（sync_store 689）；llm_processing 按 internal_id PK join。24h 窗口邮件量有限（几十封）。digest 低频，可接受。 |
| **fork rebase 冲突**（上游改 MailAgentSessionView switch / ClientProfile events） | 低 | digest 改动都在已有 mailagent 专属区块内追加（switch 加 case、events 加行），不碰公共组件。< 100 行 diff，冲突面小。 |
| **digest 与单封 session 在 fork 端混淆** | 低 | session_key 命名空间隔离（`daily_digest:` vs `email:`）+ scenario=DailyDigest 独立 layout 分支。 |
| **补推在用户已手动处理完邮件后推「过时 digest」** | 中 | digest 是「取数那一刻的 24h 快照」，补推时重新取数（run_digest_once 内现取），counts 反映当下而非补推时刻的旧值。不会推过时数据。 |
| **bulk 误操作不可撤销** | 中 | 灵动岛 click = confirm（PRD 语义）；bulk 只做「标完成/已读/归档」这类低破坏性操作（不删邮件、不发送）；标错可在 Notion/Mail.app 手动改回。**不做 bulk 删除/发送类操作**（已在 scope 外排除）。 |

---

## 附：本 plan 涉及的全部文件清单（速查）

**Plugin 新建**（3）：
- `src/llm_agent/digest_summarizer.py`
- `src/notify/digest_query.py`
- `src/notify/daily_digest.py`

**Plugin 修改**（7）：
- `src/notify/island_dispatch.py`（+ `dispatch_daily_digest`）
- `src/notify/island_envelope.py`（`_WIRE_EVENT_MAP` + `"DailyDigest"`）
- `src/notify/island_action_whitelist.py`（+ `BULK_ACTION_IDS` / `is_bulk_action_id`）
- `src/notify/island_response.py`（+ bulk 分支 / `_parse_digest_ids` / `_run_bulk`）
- `src/notify/island_i18n.py` 对应 locale 文件（+ `mail.digest.*` key）
- `src/config.py`（+ 5 个 digest Field）
- `main.py`（+ `daily_digest_task` 启停）
- `.env.example`（+ 5 个示例）

**Fork 修改**（2）：
- `PingIsland/Models/ClientProfile.swift`（events + `DailyDigest`）
- `PingIsland/UI/Views/MailAgentSessionView.swift`（switch case + `digestLayout`）

**测试新建**（plugin）：
- `tests/llm_agent/test_digest_summarizer.py`
- `tests/notify/test_digest_query.py`
- `tests/notify/test_dispatch_daily_digest.py`
- `tests/notify/test_daily_digest_loop.py`
- `tests/notify/test_island_response.py`（扩 bulk 分支）

**测试新建**（fork）：
- `PingIslandTests/` 加 DailyDigest scenario 测试

---

*Plan 完。评审通过后照 Phase A→B→C→D 顺序执行；每 Phase 末 codex review（按 reference_mailagent_frontend_dev_collab 协作规范）。*

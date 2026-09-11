"""同步历史邮件 (task 09-11) —— async_jobs ``history_sync`` 任务的执行器。

用户在设置里框一个日期范围, 把那段时间里**本地缺的**收件箱 / 已发送邮件补回来。
与首次运行的基线、增量水位完全无关: 本模块从不读写 ``last_max_row_id``。

## 两段式

1. **扫描** (``phase='scanning'``): 按天切片调 ``backend.scan_history_window``, 拿到
   窗口内远端全部邮件的元数据, 按 Message-ID 与本地全集比对, 得出"本地缺失"清单。
2. **入库** (``phase='syncing'``): 把缺失的邮件分批以 ``pending`` +
   ``ingest_reason='history_sync'`` 写进 ``email_metadata``, 交给 watcher 现成的待同步
   流水线 (取正文 / 附件 / 索引 / AI 分类 / Notion), 等这一批处理完再投下一批。

🔴 本模块**不取正文、不推 Notion**, 一行都不复制那两段逻辑 —— 历史邮件与实时邮件走
**同一条**入库流水线, 否则两条路径必然漂移。

## 为什么不暂停收新邮件

历史同步可能跑几十分钟, 暂停等于新邮件全部延迟; 而"暂停—恢复"要给 watcher 加外部
控制的状态, 正是本功能要避免的耦合。两者只在四处相撞, 各有既成规则:

- 同一封两边都拿到 → ``save_email`` 的 message_id merge guard 兜底 (写入后新
  internal_id 查不到 = 已被合并);
- 处理队列 → 每批只投 ``BATCH_SIZE`` 封 ``pending``, 而 watcher 按收信时间**从新到旧**
  取 pending, 新邮件天然排在历史邮件前面;
- 邮箱访问 → 按天切片, 片间让出; EWS 限流期间整个扫描/投喂暂停等待;
- 增量水位 → 从不触碰。

## 进度状态存哪

任务本身的终态 / 进度由 ``async_jobs`` + ``JobWorker`` 管 (SSE / 通知中心全复用)。
历史同步特有的阶段与分项计数落 ``sync_state`` 的两个 KV (``history_sync.live.<job_id>``
/ ``history_sync.cancel.<job_id>``) —— **不加表、不做 schema 迁移**: 这是一次性维护任务
的过程量, 不是需要长期查询的业务数据。
"""

from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Callable, List, Optional, Tuple

from loguru import logger

from src.cli.long_task import LongTaskSummary, UnitResult
from src.mail.ingest_provenance import INGEST_HISTORY
from src.mail.throttle_pause import is_uid_backfill_paused
from src.services.errors import ServiceInvalidArgError

if TYPE_CHECKING:
    from src.services.context import ServiceDeps

#: 一批投喂多少封进 pending。大了会让新邮件在队列里等更久 (watcher 每轮只取 10 封),
#: 小了每批都要多等一次 watcher tick。
BATCH_SIZE = 20
#: 等这批行离开 pending 的轮询节拍。
POLL_INTERVAL_SEC = 2.0
#: 连续这么久没有任何一封从 pending 变化 = watcher 没在跑 / 整体卡死。结束任务并留痕,
#: 已写入的行**不回滚**, 留给 watcher 之后自行处理 (只补不删)。
STALL_TIMEOUT_SEC = 600.0
#: 取消后给"最后一批已入库的行"的收尾时间 —— 它们已经在流水线里, 等它们跑完再收摊。
CANCEL_DRAIN_SEC = 120.0
#: EWS 限流 (davmail watchdog 置位) 期间的等待节拍。
THROTTLE_WAIT_SEC = 5.0
#: 单次任务的最大跨度 (天)。与前端校验同一个数, 见 design §5.1。
MAX_WINDOW_DAYS = 365

#: 分项计数的字段全集 —— 与前端 ``HistorySyncCounts`` 逐字段对应, 加字段两边同步。
_COUNT_FIELDS = (
    "scanned",        # 扫描到的远端邮件数 (按 Message-ID 去重后)
    "existing",       # 本地已有 → 跳过, 一行都不动
    "added",          # 本次真正写进 email_metadata 的新行
    "processed",      # 已被流水线处理完的 (= notion_synced + local_only + failed)
    "notion_synced",  # 处理完且建了 Notion 页
    "local_only",     # 处理完但只存本地 (早于 Notion 日期地板 / 未配置 Notion)
    "failed",         # 取正文或同步失败 (watcher 的重试队列仍会自行重试)
    "empty_msgid",    # 远端无 Message-ID, 无法可靠去重 → 跳过并留痕
)

UnitDoneHook = Callable[[UnitResult, LongTaskSummary], Optional[bool]]
RunOutcome = Tuple[List[UnitResult], LongTaskSummary]


def live_state_key(job_id: int) -> str:
    return f"history_sync.live.{job_id}"


def cancel_state_key(job_id: int) -> str:
    return f"history_sync.cancel.{job_id}"


# ============================================================
# 参数校验 (router 与 runner 共用 —— 契约单源)
# ============================================================

def parse_ymd(value: str) -> date:
    """``YYYY-MM-DD`` → date; 格式不对抛 ``ServiceInvalidArgError``。"""
    try:
        return datetime.strptime(str(value or "").strip(), "%Y-%m-%d").date()
    except ValueError:
        raise ServiceInvalidArgError(
            f"日期格式必须是 YYYY-MM-DD, 收到 {value!r}"
        )


def validate_range(
    since: str, until: str, *, today: Optional[date] = None,
    max_days: int = MAX_WINDOW_DAYS,
) -> tuple[date, date]:
    """校验用户框的日期范围, 返回 ``(since, until)``。

    🔴 跨度判据是**日期差**而不是"含两端的天数": ``2025-09-11 → 2026-09-11`` 差 365 天,
    合法; 再往前一天 (366) 不合法。前端 ``validateRange`` 用的是同一条式子
    (design §5.1), 两边必须一致 —— 否则会出现"界面让点、后端拒绝"的死角。
    """
    since_d = parse_ymd(since)
    until_d = parse_ymd(until)
    ref_today = today or datetime.now().date()
    if since_d > until_d:
        raise ServiceInvalidArgError("起始日期不能晚于结束日期")
    if until_d > ref_today:
        raise ServiceInvalidArgError("结束日期不能晚于今天")
    if (until_d - since_d).days > max_days:
        raise ServiceInvalidArgError(f"一次最多同步 {max_days} 天")
    return since_d, until_d


def _day_slices(since_d: date, until_d: date) -> list[tuple[datetime, datetime]]:
    """把 ``[since, until]`` (含两端的本地日期) 切成逐天的 UTC 半开窗口, **最新的一天在前**。

    先扫最近的: 用户最可能等着看的是近期邮件, 而且任务被取消时已完成的那部分更有用。
    本地午夜经 ``astimezone`` 换成 UTC 时刻 —— naive datetime 被解释成本机时区, 与
    用户填日期时的心智 (本地日历) 一致。
    """
    out: list[tuple[datetime, datetime]] = []
    day = until_d
    while day >= since_d:
        start_local = datetime(day.year, day.month, day.day)
        end_local = start_local + timedelta(days=1)
        out.append(
            (start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc))
        )
        day -= timedelta(days=1)
    return out


# ============================================================
# 进度状态 (sync_state 两个 KV, 无 schema 变更)
# ============================================================

class _LiveState:
    """``history_sync.live.<job_id>`` 的读写门面。

    进程重启后 ``JobWorker.recover_orphaned`` 会把任务重新排队、runner 重新扫描,
    累计计数从这里读回继续累加 (已写入的行此时已在本地, 重扫自然计为"已存在")。
    """

    def __init__(self, sync_store: Any, job_id: int, *, since: str, until: str):
        self._store = sync_store
        self._key = live_state_key(job_id)
        self._cancel_key = cancel_state_key(job_id)
        self.phase = "scanning"
        self.since = since
        self.until = until
        self.counts = {f: 0 for f in _COUNT_FIELDS}
        self.complete = True
        self.covered_from: Optional[str] = None
        self.last_error: Optional[str] = None
        self.progress_done = 0
        self.progress_total = 0

    def load(self) -> None:
        """读回上一次的累计计数 (进程重启续跑); 读不到就是全新任务。"""
        try:
            raw = self._store.get_state(self._key)
        except Exception:
            raw = None
        if not raw:
            return
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            return
        for field, value in (data.get("counts") or {}).items():
            if field in self.counts:
                self.counts[field] = int(value or 0)
        self.complete = bool(data.get("complete", True))
        self.covered_from = data.get("covered_from")

    def flush(self) -> None:
        payload = {
            "phase": self.phase,
            "since": self.since,
            "until": self.until,
            "counts": dict(self.counts),
            "complete": self.complete,
            "covered_from": self.covered_from,
            "last_error": self.last_error,
            "progress_done": self.progress_done,
            "progress_total": self.progress_total,
            "updated_at": time.time(),
        }
        try:
            self._store.set_state(self._key, json.dumps(payload, ensure_ascii=False))
        except Exception as e:  # noqa: BLE001 — 进度写失败绝不影响任务本身
            logger.warning(f"[history-sync] live state write failed: {e}")

    def set_phase(self, phase: str) -> None:
        self.phase = phase
        self.flush()

    def bump(self, field: str, n: int = 1) -> None:
        self.counts[field] = self.counts.get(field, 0) + n

    def cancel_requested(self) -> bool:
        try:
            return str(self._store.get_state(self._cancel_key) or "") == "1"
        except Exception:
            return False


def request_cancel(sync_store: Any, job_id: int) -> None:
    """置取消标记 —— router 的 ``POST /api/history-sync/cancel`` 唯一写面。"""
    sync_store.set_state(cancel_state_key(job_id), "1")


def read_live_state(sync_store: Any, job_id: int) -> dict:
    """读某个任务的 live 状态 (router 组装 GET 响应用); 读不到返回空 dict。"""
    try:
        raw = sync_store.get_state(live_state_key(job_id))
        return json.loads(raw) if raw else {}
    except Exception:
        return {}


# ============================================================
# runner
# ============================================================

def _received_dt(row: dict) -> datetime:
    """行的收信时间 (排序用); 解析不出来排到最后。"""
    raw = row.get("date_received") or ""
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _wait_while_throttled(sync_store: Any, state: _LiveState) -> None:
    """EWS 限流期间原地等 —— 限流下继续打 IMAP 只会让配额更难恢复。

    取消请求优先于等待: 用户按了取消就不该再被限流拖着。
    """
    announced = False
    while is_uid_backfill_paused(sync_store):
        if state.cancel_requested():
            return
        if not announced:
            logger.warning("[history-sync] EWS throttling active — 暂停等待配额恢复")
            announced = True
        time.sleep(THROTTLE_WAIT_SEC)
    if announced:
        logger.info("[history-sync] EWS throttling 解除 — 继续")


def _scan(backend: Any, state: _LiveState, slices: list, *, sync_store: Any) -> dict:
    """逐天扫描并按 Message-ID 归并, 返回 ``{message_id: row}``。"""
    found: dict[str, dict] = {}
    for day_start, day_end in slices:
        if state.cancel_requested():
            break
        _wait_while_throttled(sync_store, state)
        if state.cancel_requested():
            break
        result = backend.scan_history_window(day_start, day_end)
        for row in result.items:
            mid = (row.get("message_id") or "").strip()
            if mid and mid not in found:
                found[mid] = row
        if not result.complete:
            state.complete = False
            covered = getattr(result, "covered_from", None)
            if covered is not None:
                # 本地日期字符串 (前端直接显示"只覆盖到 X 日")。多天取最晚的那个下界:
                # 覆盖完整性由最差的那一天决定。
                covered_local = covered.astimezone().strftime("%Y-%m-%d")
                if state.covered_from is None or covered_local > state.covered_from:
                    state.covered_from = covered_local
        state.counts["empty_msgid"] += int(getattr(result, "empty_msgid", 0) or 0)
        state.counts["scanned"] = len(found)
        state.flush()
    return found


def _classify(row: Optional[dict]) -> Optional[str]:
    """一行的终态 → 计数口径; 仍是 ``pending`` 返回 None (继续等)。"""
    if row is None:
        return "gone"                       # 行被删了 (极少见) — 不再等它
    status = str(row.get("sync_status") or "")
    if status == "pending":
        return None
    if status == "synced":
        # 建了 Notion 页 = 推上去了; 没有 = 只存本地 (未配置 Notion / 走的 local-only 分支)
        return "notion_synced" if row.get("notion_page_id") else "local_only"
    if status == "skipped":
        return "local_only"                 # 早于 Notion 日期地板, 正常结果不是失败
    return "failed"                         # fetch_failed / failed / dead_letter


def run_history_sync_job(
    deps: "ServiceDeps",
    *,
    job_id: int,
    params: dict,
    on_unit_done: Optional[UnitDoneHook] = None,
) -> RunOutcome:
    """执行一个 history_sync 任务, 返回 ``(results, summary)``。

    🔴 **有意忽略 ``resume_from``**: 维护族任务的 checkpoint 语义是"跳过 internal_id 小于
    它的 unit", 而本任务每次运行都会**新分配** internal_id —— 拿上一轮的 id 当水位会把
    这一轮的行整片跳掉。进程重启后的正确续跑判据是"已写入的行现在已经在本地", 重新
    扫描时它们自然落进"已存在"而不会重复入库。
    """
    sync_store = deps.sync_store
    since_s = str(params.get("since") or "")
    until_s = str(params.get("until") or "")
    since_d, until_d = validate_range(since_s, until_s)

    backend = deps.backend
    if not hasattr(backend, "scan_history_window"):
        raise ServiceInvalidArgError(
            "当前邮件后端不支持同步历史邮件",
            hint="AppleScript 模式请用 `mailagent init fetch-cache`",
        )

    state = _LiveState(sync_store, job_id, since=since_s, until=until_s)
    state.load()
    state.set_phase("scanning")

    summary = LongTaskSummary()
    results: List[UnitResult] = []

    # --- 1. 扫描 ---
    slices = _day_slices(since_d, until_d)
    found = _scan(backend, state, slices, sync_store=sync_store)

    if state.cancel_requested():
        summary.aborted = True
        summary.aborted_reason = "cancelled"
        state.set_phase("done")
        return results, summary

    # --- 2. 与本地比对 ---
    try:
        known = sync_store.get_all_message_ids()
    except Exception as e:
        raise ServiceInvalidArgError(f"读取本地邮件指纹失败: {e}")
    missing = [row for mid, row in found.items() if mid not in known]
    missing.sort(key=_received_dt, reverse=True)   # 新的先补
    state.counts["scanned"] = len(found)
    state.counts["existing"] = len(found) - len(missing)
    state.progress_total = len(missing)
    summary.total = len(missing)
    state.set_phase("syncing")

    logger.info(
        f"[history-sync] job_id={job_id} {since_s}..{until_s}: 扫描到 {len(found)} 封, "
        f"本地缺 {len(missing)} 封 (complete={state.complete})"
    )

    # --- 3. 分批投喂 + 等流水线处理 ---
    stop_requested = False
    for start in range(0, len(missing), BATCH_SIZE):
        if stop_requested or state.cancel_requested():
            break
        _wait_while_throttled(sync_store, state)
        if state.cancel_requested():
            break

        batch = missing[start:start + BATCH_SIZE]
        tracked: List[int] = []
        for row in batch:
            try:
                internal_id = sync_store.allocate_davmail_internal_id()
            except Exception as e:
                logger.error(f"[history-sync] allocate internal_id failed: {e}")
                _emit(results, summary, state, on_unit_done, 0, "failed", "failed")
                continue
            payload = _save_payload(row, internal_id)
            try:
                saved = sync_store.save_email(payload)
            except Exception as e:
                logger.error(f"[history-sync] save_email raised: {e}")
                saved = False
            if not saved:
                _emit(results, summary, state, on_unit_done, internal_id,
                      "failed", "failed")
                continue
            if sync_store.get(internal_id) is None:
                # 🔴 merge guard 命中: 扫描之后、写入之前, watcher 已经把同一封收进来了
                # (message_id 撞 UNIQUE → 并进既有行, 新分配的 id 查不到)。不是失败,
                # 也不是新增 —— 计"已存在", 与扫描阶段判出来的口径一致。
                state.bump("existing")
                _emit(results, summary, state, on_unit_done, internal_id,
                      "skipped", "merged")
                continue
            tracked.append(internal_id)

        state.counts["added"] += len(tracked)
        state.flush()
        if tracked:
            stop_requested = _await_batch(
                sync_store, tracked, state, summary, results, on_unit_done,
                draining=state.cancel_requested(),
            )

    if state.cancel_requested():
        summary.aborted = True
        summary.aborted_reason = "cancelled"
        logger.info(f"[history-sync] job_id={job_id} 已取消 (已入库的行照常处理完)")
    elif stop_requested:
        summary.aborted = True
        summary.aborted_reason = "stopped"

    state.progress_done = summary.succeeded + summary.failed + summary.skipped
    state.set_phase("done")
    logger.info(
        f"[history-sync] job_id={job_id} 结束: {dict(state.counts)} "
        f"(complete={state.complete}, aborted={summary.aborted})"
    )
    return results, summary


def _save_payload(row: dict, internal_id: int) -> dict:
    """扫描行 → ``save_email`` payload。

    ``ingest_reason='history_sync'`` 是**唯一**与实时邮件的差别 —— 它让三个实时性钩子
    (灵动岛 / Custom Agent 邮件触发 / 项目周报) 对这些行不触发, 见
    ``src.mail.ingest_provenance.is_history_ingest``。
    """
    payload = {
        "internal_id": internal_id,
        "message_id": row.get("message_id"),
        "subject": row.get("subject", ""),
        "sender": row.get("sender") or row.get("sender_email", ""),
        "sender_name": row.get("sender_name", ""),
        "date_received": row.get("date_received", ""),
        "mailbox": row.get("mailbox", ""),
        "is_read": row.get("is_read", False),
        "is_flagged": row.get("is_flagged", False),
        "thread_id": row.get("thread_id"),
        "sync_status": "pending",
        "backend_origin": row.get("backend_origin"),
        "ingest_reason": INGEST_HISTORY,
    }
    for optional in ("imap_uid", "imap_uidvalidity", "entry_id"):
        if row.get(optional) is not None:
            payload[optional] = row[optional]
    return payload


def _emit(
    results: List[UnitResult],
    summary: LongTaskSummary,
    state: _LiveState,
    on_unit_done: Optional[UnitDoneHook],
    internal_id: int,
    status: str,
    outcome: str,
) -> bool:
    """记一封的结果 + 回调 JobWorker 的进度钩子。返回 True 表示请求停止。"""
    if status == "success":
        summary.succeeded += 1
    elif status == "failed":
        summary.failed += 1
    else:
        summary.skipped += 1
    if outcome in state.counts:
        state.bump(outcome)
    if outcome != "merged":
        state.bump("processed")
    state.progress_done = summary.succeeded + summary.failed + summary.skipped
    results.append(UnitResult(internal_id=internal_id, status=status, duration_ms=0))
    if on_unit_done is None:
        return False
    try:
        return on_unit_done(results[-1], summary) is False
    except Exception as e:  # noqa: BLE001 — 进度钩子异常绝不影响任务
        logger.warning(f"[history-sync] on_unit_done raised: {e}")
        return False


def _await_batch(
    sync_store: Any,
    tracked: List[int],
    state: _LiveState,
    summary: LongTaskSummary,
    results: List[UnitResult],
    on_unit_done: Optional[UnitDoneHook],
    *,
    draining: bool,
) -> bool:
    """等这一批行离开 ``pending``。返回 True 表示调用方应停止投喂。

    ``draining=True`` (已取消) 时只给 ``CANCEL_DRAIN_SEC`` 的收尾时间, 不按停滞处理。
    """
    pending = list(tracked)
    deadline = time.monotonic() + (CANCEL_DRAIN_SEC if draining else STALL_TIMEOUT_SEC)
    stop = False
    while pending:
        still: List[int] = []
        progressed = False
        for internal_id in pending:
            try:
                row = sync_store.get(internal_id)
            except Exception:
                row = None
            outcome = _classify(row)
            if outcome is None:
                still.append(internal_id)
                continue
            progressed = True
            if outcome == "failed":
                stop = _emit(results, summary, state, on_unit_done,
                             internal_id, "failed", "failed") or stop
            elif outcome == "gone":
                stop = _emit(results, summary, state, on_unit_done,
                             internal_id, "skipped", "gone") or stop
            else:
                stop = _emit(results, summary, state, on_unit_done,
                             internal_id, "success", outcome) or stop
        pending = still
        if progressed:
            state.flush()
            deadline = time.monotonic() + (
                CANCEL_DRAIN_SEC if draining else STALL_TIMEOUT_SEC
            )
        if not pending or stop:
            break
        if time.monotonic() >= deadline:
            # 🔴 停滞 = watcher 没在处理 (没启动 / 整体卡死)。已写入的行**不回滚**:
            # 它们是合法的 pending 行, watcher 起来后会自己处理完。这里只把它们记成
            # 本次任务没确认成功, 并留下可见的原因 —— 静默结束会让用户以为补完了。
            state.last_error = (
                f"邮件处理停滞: {len(pending)} 封已入库但超过 "
                f"{int(STALL_TIMEOUT_SEC)} 秒没有进展, 请确认后台同步正在运行"
            )
            logger.warning(f"[history-sync] {state.last_error}")
            for internal_id in pending:
                _emit(results, summary, state, on_unit_done, internal_id,
                      "failed", "failed")
            state.flush()
            return True
        time.sleep(POLL_INTERVAL_SEC)
    state.flush()
    return stop

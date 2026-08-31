"""联系人画像 Agent 的执行台账 (`contact_profile_run` 表, DB v72)。

画像批处理此前**一行记录都没有** —— 每轮统计只 `logger.info` 一句就丢了
(`run_profile_batch`)，于是团队页的「记录」列对它永远是空态
(`.trellis/tasks/08-27-l4-tab-workspace/research/r8-...md` §A.0)。这里补上最小的一张
台账: 一轮批处理落一行。

形状取自 `project_progress_sync` 的简版 —— 那是同类的「确定性批处理的一次执行」记录。
**不抄** `matter_run` 的全套 (chat_session / trigger_payload / cost 画像根本没有)。

🔴 **零依赖叶子**: 只用 stdlib + loguru。`src/mail/sync_store.py` 要 import
`CONTACT_PROFILE_RUN_STATUS_VALUES` 给表的 CHECK 用 (值域单源, 不手抄字符串) ——
反过来在这里 import sync_store 就是循环。表 DDL 归 sync_store 拥有 (v72 块),
本模块只读写。

时间单位: epoch **毫秒** (contacts 域全域单位, 与 `contact.profile_updated_at` 同一把
尺子; 批处理手里本来就只有 `round_started_ms`)。🔴 与 `async_jobs` 的 `time.time()`
**秒**不是一回事 —— 投影成 run 历史行时在 API 边界除以 1000
(`src/api/routers/agent_runs.py::_profile_run_item`)，表内不留两种单位。
"""

from __future__ import annotations

import sqlite3
import time
from typing import Any, Dict, List, Mapping, Optional

from loguru import logger

#: 一轮批处理的三种收场。`sync_store` 的表 CHECK 引它 (单源)。
#:   ok   —— 跑过, 有结果 (逐人的成败在 ok_count / failed 里)
#:   noop —— 这一轮没有候选人。不是失败, 也不该显示成「跑了一次画像」
#:   fail —— 批级异常, 或者跑了但一个都没成
CONTACT_PROFILE_RUN_STATUS_VALUES = ("ok", "fail", "noop")


def classify_batch_status(stats: Mapping[str, int], *, error: Optional[str] = None) -> str:
    """一轮批处理的统计 → `CONTACT_PROFILE_RUN_STATUS_VALUES` 之一 (判据单源)。

    「跑了 N 个人、一个都没成」判 fail 而不是 ok: 那种情况下 ok 是谎报, 团队页会显示
    成一次正常执行, 用户看不出画像其实全挂了。
    """
    if error:
        return "fail"
    if int(stats.get("candidates", 0)) <= 0:
        return "noop"
    if int(stats.get("ran", 0)) > 0 and int(stats.get("ok", 0)) == 0 and int(stats.get("failed", 0)) > 0:
        return "fail"
    return "ok"


def _connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    return conn


def record_profile_run(
    db_path: str,
    *,
    started_at_ms: int,
    stats: Mapping[str, int],
    error: Optional[str] = None,
    completed_at_ms: Optional[int] = None,
) -> Optional[int]:
    """落一行执行台账, 返回行 id (写失败返 None)。

    🔴 **写失败只 warning 不抛**: 活儿已经干完了, 因为账本写不进去而让整轮画像 tick 失败
    是本末倒置。调用方 (`run_profile_batch`) 的失败路径还要在这之后把原异常继续上抛,
    这里抛新异常会把原因盖掉。
    """
    completed = completed_at_ms if completed_at_ms is not None else int(time.time() * 1000)
    status = classify_batch_status(stats, error=error)
    try:
        conn = _connect(db_path)
        try:
            cursor = conn.execute(
                "INSERT INTO contact_profile_run "
                "(started_at, completed_at, status, candidates, ran, ok_count, skipped, failed, error) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    int(started_at_ms),
                    completed,
                    status,
                    int(stats.get("candidates", 0)),
                    int(stats.get("ran", 0)),
                    int(stats.get("ok", 0)),
                    int(stats.get("skipped", 0)),
                    int(stats.get("failed", 0)),
                    error,
                ),
            )
            conn.commit()
            return int(cursor.lastrowid)
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.warning(f"[contact-profile] run ledger write failed: {exc}")
        return None


def list_profile_runs(db_path: str, *, limit: int = 20, offset: int = 0) -> List[Dict[str, Any]]:
    """最近 N 轮批处理 (started_at 倒序)。limit clamp 进 [1, 100]，offset clamp >= 0。

    表不存在 (老库没跑到 v72) → 返回空列表, 不抛 —— 读侧对「还没有这张表」与「还没跑过」
    的处置一样都是空态。
    """
    lim = max(1, min(100, limit))
    off = max(0, offset)
    try:
        conn = _connect(db_path)
        try:
            rows = conn.execute(
                "SELECT * FROM contact_profile_run "
                "ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?",
                (lim, off),
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.debug(f"[contact-profile] run ledger read skipped: {exc}")
        return []


def count_profile_runs(db_path: str) -> int:
    """`list_profile_runs` 的 COUNT(*)（分页 total）。表不存在 → 0。"""
    try:
        conn = _connect(db_path)
        try:
            row = conn.execute("SELECT COUNT(*) AS n FROM contact_profile_run").fetchone()
            return int(row["n"]) if row else 0
        finally:
            conn.close()
    except sqlite3.Error as exc:
        logger.debug(f"[contact-profile] run ledger count skipped: {exc}")
        return 0

from collections import deque
from dataclasses import dataclass
from datetime import timezone, timedelta
from typing import List, Optional

BEIJING_TZ = timezone(timedelta(hours=8))


@dataclass
class CreateEmailFromSqliteResult:
    """``NotionSync.create_email_page_from_sqlite`` 的结构化返回 (R-19 / PR-2 critic round 2).

    - ``page_id``: 当前生效的 Notion page id (created / replaced 新页 / skipped 命中的老页)
    - ``action``: ``'created' | 'replaced' | 'skipped'`` —— 用户可见动作
    - ``existing_page_id``: dup-check 命中时老页 id, 没命中是 None
    - ``archived_page_id``: 仅在 ``--replace-existing`` 真把老页 archive 时填; 否则 None

    设计原因 (codex round 2 review): CLI 不应靠 ``(replace_existing, meta.notion_page_id,
    new_page_id)`` 推断动作 —— ``meta.notion_page_id`` 在本地可能为 NULL 或 stale, 但 Notion
    侧通过 ``check_page_exists(message_id)`` 命中 dup, 导致推断结果错。结构化返回让动作判定
    收敛在 ``create_email_page_from_sqlite`` 内部, 与实际 Notion 调用路径 1:1 对应。
    """
    page_id: Optional[str]
    action: str
    existing_page_id: Optional[str] = None
    archived_page_id: Optional[str] = None


class RolloutMetrics:
    """PR-4 R-06 v4 rollout 路由命中计数。

    sync.py 原 _ensure_rollout_counters + record_route_*/snapshot/flush_rollout_stats
    搬到这里。facade NotionSync 与 PageOps 共享同一个实例。

    保留 lazy init 兼容 tests/notion/test_rollout_stats.py 用 __new__ 跳过 __init__
    构造 NotionSync 的取巧用法 — facade record_route_* 仍走 self._rollout._ensure()
    兜底。
    """

    def __init__(self, sync_store=None):
        self._sync_store = sync_store
        self._initialized = False

    def _ensure(self) -> None:
        """Lazy init — 让 test_rollout_stats.py 的 __new__ bypass 也能 work。"""
        if not getattr(self, "_initialized", False):
            self._route_hit = 0
            self._route_miss = 0
            self._route_error = 0
            self._route_latency_samples: List[float] = []
            self._body_miss_recent: "deque[int]" = deque(maxlen=10)
            self._initialized = True

    def record_hit(self, latency_ms: float = 0.0) -> None:
        """SQLite 路径命中."""
        self._ensure()
        self._route_hit += 1
        if latency_ms > 0:
            self._route_latency_samples.append(float(latency_ms))

    def record_miss(self, internal_id: int = 0) -> None:
        """SQLite body miss → fallback 老路径."""
        self._ensure()
        self._route_miss += 1
        if internal_id:
            self._body_miss_recent.append(int(internal_id))

    def record_error(self) -> None:
        """SQLite 路由抛异常 → fallback."""
        self._ensure()
        self._route_error += 1

    def snapshot(self) -> dict:
        """返回 dict + reset 计数 (close window).

        p99 用 *nearest-rank* (ceil) 公式 — 整数算术避免浮点漂:
          idx = ceil(99 * n / 100) - 1 = (99 * n + 99) // 100 - 1, clamped to [0, n-1]
        小窗 (n < 100) 时自然退化为 max(samples), 避免 ``int(n*.99)-1`` 在 n=2 时
        返回 min 的问题 (PR-4 codex critic round 1 blocker fix).
        """
        self._ensure()
        samples = sorted(self._route_latency_samples)
        if samples:
            n = len(samples)
            idx = max(0, min(n - 1, (99 * n + 99) // 100 - 1))
            p99 = samples[idx]
        else:
            p99 = 0.0
        out = {
            "from_sqlite_hit": self._route_hit,
            "fallback_miss": self._route_miss,
            "fallback_error": self._route_error,
            "route_latency_p99_ms": p99,
            "body_miss_internal_ids": list(self._body_miss_recent),
        }
        self._route_hit = 0
        self._route_miss = 0
        self._route_error = 0
        self._route_latency_samples.clear()
        return out

    def flush(self, sync_store=None, *, window_seconds: int = 60) -> Optional[int]:
        """snapshot + 写入 ``v4_rollout_stats`` 表, 返回 rowid (失败 None)."""
        store = sync_store if sync_store is not None else getattr(self, "_sync_store", None)
        if store is None:
            return None
        snap = self.snapshot()
        try:
            return store.write_v4_rollout_snapshot(
                from_sqlite_hit=snap["from_sqlite_hit"],
                fallback_miss=snap["fallback_miss"],
                fallback_error=snap["fallback_error"],
                route_latency_p99_ms=snap["route_latency_p99_ms"],
                body_miss_internal_ids=snap["body_miss_internal_ids"],
                window_seconds=window_seconds,
            )
        except Exception as exc:  # pragma: no cover
            from loguru import logger as _logger
            _logger.warning(
                f"[v4-rollout] flush failed: {type(exc).__name__}: {exc}"
            )
            return None

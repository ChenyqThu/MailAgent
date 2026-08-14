"""``email_metadata.date_received`` 存量 tz 收敛 (幂等 repair op).

## 为什么需要

排序全链路是**词法字符串比较** (SQL ``ORDER BY`` TEXT + 前端 ``localeCompare``
与裸 ``>``)。混合偏移下词法序 ≠ 时间序::

    2026-08-14T10:54:15-07:00   绝对 17:54Z   ← 字典序更小, 被排到后面
    2026-08-14T16:28:16+00:00   绝对 16:28Z   ← 字典序更大, 被排到前面

后果不止"列表顺序乱": 线程折叠头按 ``date_received`` 取最新一封, 选错 head 会
连带把整个线程放进错误的日期分组。

写入侧三条边界 (``_save_email_v3`` / ``save_emails_batch`` /
``update_after_fetch``) 已全部过 ``_normalize_date_received_iso``。本模块只管
**存量** —— 老版本 (2026-07-07 归一修复之前的构建) 写进库的非 UTC 行, 以及
应急回切期间可能混入的行。

## 语义

- 判据是**扫描全表**, 不点名 internal_id → 同一份代码对活库
  (``~/Library/Application Support/mailagent-frontend/data/sync_store.db``)
  与仓库 ``data/sync_store.db`` 都适用。
- **幂等**: 已是 UTC 偏移的行归一后逐字节相同 → 第二次跑 ``updated=0``。
- 🔴 **只改偏移表示, 不改绝对时刻**。naive 行按系统本地 tz 解释 (与写入侧
  ``_normalize_date_received_iso`` 同口径) 后转 UTC。
- 🔴 **空 / NULL / 解析不出来的行一律不碰** —— 空 ``date_received`` 的落桶语义
  (现落"更早") 是独立议题, 本 op 不顺手改它; 解析不出来的原值保留并计数,
  宁可留一行怪数据也不写入一个猜出来的时刻。
- 🔴 归一结果**必须是 tz-aware** 才写。``_normalize_date_received_iso`` 解析
  失败时原样返回 (可能仍是 naive 或垃圾串), 直接写回等于把"没归一"伪装成
  "已归一"。
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from src.mail.sync_store import _normalize_date_received_iso

# 一次 UPDATE 的批大小. 活库可能同时有 backend 在写, 分批提交比一条巨事务
# 更不容易把别人挡在 busy_timeout 外面.
_UPDATE_BATCH = 500


@dataclass
class DateTzRepairReport:
    """一次收敛的结果 (dry-run 与真跑同形状, 只差 ``applied``)."""

    db_path: str
    dry_run: bool
    scanned: int = 0
    """扫过的非空 date_received 行数 (空 / NULL 不计, 它们不在本 op 范围内)。"""
    changed: int = 0
    """需要改写 (dry-run) / 已改写 (真跑) 的行数。"""
    unchanged: int = 0
    """归一后逐字节相同 —— 幂等重跑时这就是全部。"""
    unparseable: int = 0
    """归一后仍不是 tz-aware ISO → 保留原值, 只计数。"""
    samples: list[dict] = field(default_factory=list)
    """前 N 条改写样本, 给 dry-run 人眼核对用。"""

    def as_dict(self) -> dict:
        return {
            "db_path": self.db_path,
            "dry_run": self.dry_run,
            "scanned": self.scanned,
            "changed": self.changed,
            "unchanged": self.unchanged,
            "unparseable": self.unparseable,
            "samples": self.samples,
        }


def to_utc_iso(value: Optional[str]) -> Optional[str]:
    """``date_received`` → UTC 偏移 ISO 8601; 归一不出 tz-aware 结果时返回 ``None``.

    ``None`` 的语义是"别写" —— 调用方保留原值并计入 ``unparseable``。
    """
    normalized = _normalize_date_received_iso(value)
    if not normalized:
        return None
    try:
        dt = datetime.fromisoformat(normalized)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        return None
    return dt.astimezone(timezone.utc).isoformat()


def normalize_date_received_utc(
    db_path: str,
    *,
    dry_run: bool = True,
    sample_limit: int = 10,
    timeout: float = 30.0,
) -> DateTzRepairReport:
    """扫描 ``email_metadata`` 把 ``date_received`` 全部收敛成 UTC 偏移 ISO 8601.

    Args:
        db_path: 目标 sync_store.db (活库 / 仓库 data/ 都行, 判据是全表扫描)。
        dry_run: True 只统计不写 (默认)。
        sample_limit: 报告里带几条改写样本。
        timeout: sqlite busy timeout 秒数 —— 活库可能正被 backend 写。

    Returns:
        :class:`DateTzRepairReport`。
    """
    report = DateTzRepairReport(db_path=str(db_path), dry_run=dry_run)

    conn = sqlite3.connect(db_path, timeout=timeout)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute(f"PRAGMA busy_timeout = {int(timeout * 1000)}")
        rows = conn.execute(
            "SELECT internal_id, date_received FROM email_metadata "
            "WHERE date_received IS NOT NULL AND date_received != ''"
        ).fetchall()

        pending: list[tuple[str, int]] = []
        for row in rows:
            report.scanned += 1
            before = row["date_received"]
            after = to_utc_iso(before)
            if after is None:
                report.unparseable += 1
                continue
            if after == before:
                report.unchanged += 1
                continue
            report.changed += 1
            if len(report.samples) < sample_limit:
                report.samples.append({
                    "internal_id": row["internal_id"],
                    "before": before,
                    "after": after,
                })
            pending.append((after, row["internal_id"]))

        if dry_run or not pending:
            return report

        for start in range(0, len(pending), _UPDATE_BATCH):
            conn.executemany(
                "UPDATE email_metadata SET date_received = ? WHERE internal_id = ?",
                pending[start:start + _UPDATE_BATCH],
            )
            conn.commit()
    finally:
        conn.close()

    return report

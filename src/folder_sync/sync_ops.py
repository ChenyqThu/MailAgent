"""folder 单次同步原语 — FolderSyncWorker tick + CLI `folder sync-now` 共享.

list_folder (IMAP) → repo.upsert_emails → reconcile 软删除 (full 模式). archive 用
since 窗口 + 上限封数控制量级; drafts 全量 (量小).

不在这里做 UIDNEXT 增量判断 (那是 worker tick 的事) — 这里就是"拉窗口 + 落库 + 对账"
的全量原语. worker 用 STATUS UIDNEXT/UIDVALIDITY 决定要不要调本函数, CLI sync-now
直接调.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Optional

from loguru import logger

if TYPE_CHECKING:
    from src.config import Config
    from src.folder_sync.imap_folder_reader import FolderImapReader
    from src.folder_sync.repository import FolderEmailRepository

# 默认值 (config 未设时兜底). B 阶段在 config.py 正式声明这些字段.
_DEFAULT_ARCHIVE_PAST_DAYS = 365
_DEFAULT_ARCHIVE_MAX = 5000
_DEFAULT_DRAFTS_LIMIT = 500


def compute_archive_since(cfg: "Config") -> datetime:
    """archive 同步窗口左界 = 今天 - archive_sync_past_days."""
    days = int(getattr(cfg, "archive_sync_past_days", _DEFAULT_ARCHIVE_PAST_DAYS)
               or _DEFAULT_ARCHIVE_PAST_DAYS)
    return datetime.now(timezone.utc) - timedelta(days=days)


def sync_folder_once(
    folder: str,
    *,
    reader: "FolderImapReader",
    repo: "FolderEmailRepository",
    cfg: "Config",
    full: bool = True,
) -> dict:
    """对单个 folder 跑一次同步 (list → upsert → reconcile).

    Args:
        full: True 时做 reconcile (本地 active 但 IMAP 端没了的 → 软删除). 增量场景
              (只拉新增) 传 False 跳过 reconcile 避免误删窗口外行.

    Returns: {"inserted", "updated", "soft_deleted", "fetched"}.
    """
    if folder == "archive":
        since: Optional[datetime] = compute_archive_since(cfg)
        limit = int(getattr(cfg, "archive_sync_max_messages", _DEFAULT_ARCHIVE_MAX)
                    or _DEFAULT_ARCHIVE_MAX)
    else:  # drafts
        since = None
        limit = _DEFAULT_DRAFTS_LIMIT

    rows = reader.list_folder(folder, since=since, limit=limit)
    stats = repo.upsert_emails(rows)
    stats["fetched"] = len(rows)
    stats["soft_deleted"] = 0

    if full:
        present = {r["imap_uid"] for r in rows if r.get("imap_uid")}
        local = repo.get_active_uids(folder)
        stale = sorted(local - present)
        if stale:
            stats["soft_deleted"] = repo.soft_delete_by_uids(folder, stale)

    try:
        repo.upsert_sync_state(
            folder, last_full_sync_at=time.time(), last_error=None
        )
    except Exception as e:  # sync_state 写失败不影响主数据
        logger.warning(f"[folder-sync] upsert_sync_state({folder}) failed: {e}")

    # SSE: 有变更时 publish folder.synced → 前端 useEventBridge invalidate ['folder', folder].
    # silent on failure (主同步不被 SSE 烧穿).
    if stats.get("inserted") or stats.get("updated") or stats.get("soft_deleted"):
        try:
            from src.events.publisher import safe_publish

            safe_publish("folder.synced", {
                "folder": folder,
                "inserted": stats.get("inserted", 0),
                "updated": stats.get("updated", 0),
                "soft_deleted": stats.get("soft_deleted", 0),
            })
        except Exception:
            pass

    logger.info(f"[folder-sync] sync_folder_once({folder}, full={full}): {stats}")
    return stats

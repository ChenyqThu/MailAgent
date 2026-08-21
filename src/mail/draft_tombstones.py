"""草稿删除墓碑 — 跨进程 (serve-api ↔ mail-sync) 的 reconcile 回弹防护。

背景 (task 08-20-perf-draft-delete): ``delete_draft`` 在 **serve-api 进程**里
本地行先删 (T+0.15s)、IMAP \\Deleted+EXPUNGE 后置 (T+2.5s); ``reconcile_drafts``
在 **mail-sync 进程** 5s 节拍全量对账 —— 落在窗口内的 tick 会看到「远端 uid 还在
+ 本地行没了」, 把正在删除的草稿当新草稿重新入库 (新 internal_id), 用户得手动
再删一次 (实测近半数删除回弹)。

两个动作**不同进程** (Electron backend_lifecycle 分别 spawn ``mailagent serve``
与 ``mailagent serve-api``), 进程内存墓碑挡不住 → 落在两进程共享的
sync_store.db ``sync_state`` KV (单 key JSON dict {uid: 删除时刻}), 读写都经
SyncStore 的 per-call 短命连接, WAL 并发安全。

TTL 30s: 覆盖删除慢链 (实测端到端 ≤5.4s) 数倍余量; 过期后 reconcile 恢复既有
自愈语义 —— IMAP 删失败留下的 Exchange 残留仍会被拉回本地 (用户重删即可)。
uid 在 UIDVALIDITY 不变时单调分配, 30s 内不会被新草稿复用, 按 uid 记即可。
outlook_com 行无 reconcile_drafts, 不需要墓碑。
"""

from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING

from loguru import logger

if TYPE_CHECKING:
    from src.mail.sync_store import SyncStore

STATE_KEY = "drafts_delete_tombstones"
TOMBSTONE_TTL_SEC = 30.0


def _load(sync_store: "SyncStore", now: float) -> dict[int, float]:
    """读 KV → {uid: ts}, 顺手剔除过期/畸形条目。解析失败按空 (不拦对账)。"""
    raw = sync_store.get_state(STATE_KEY)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[int, float] = {}
    for k, v in data.items():
        try:
            uid, ts = int(k), float(v)
        except (TypeError, ValueError):
            continue
        if now - ts < TOMBSTONE_TTL_SEC:
            out[uid] = ts
    return out


def record(sync_store: "SyncStore", uid: int, *, now: float | None = None) -> None:
    """``delete_draft`` 删本地行**之前**调用: uid 落墓碑 (写入即对 reconcile 可见)。

    失败仅 warning 不上抛 —— 墓碑是防回弹优化, 不得阻断删除主链 (最坏回到
    修复前行为: 该次删除可能回弹一次)。
    """
    ts = time.time() if now is None else now
    try:
        entries = _load(sync_store, ts)
        entries[int(uid)] = ts
        sync_store.set_state(
            STATE_KEY, json.dumps({str(k): v for k, v in entries.items()})
        )
    except Exception as e:  # noqa: BLE001 — 防回弹优化, 失败不阻断删除
        logger.warning(f"[draft-tombstone] record uid={uid} failed: {e}")


def active_uids(sync_store: "SyncStore", *, now: float | None = None) -> set[int]:
    """``reconcile_drafts`` to_add 过滤用: 未过期墓碑 uid 集合 (读失败 → 空集不拦)。"""
    ts = time.time() if now is None else now
    try:
        return set(_load(sync_store, ts))
    except Exception as e:  # noqa: BLE001 — 读失败退化为不过滤 (行为同修复前)
        logger.warning(f"[draft-tombstone] load failed: {e}")
        return set()

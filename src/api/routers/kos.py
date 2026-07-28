"""kos 路由 — /api/kos/*。

stats (读) —— KOS 入库台账 ``kos_ingest_log`` + ``sync_state`` 的 ``kos.*`` 健康指标。
远程 web 侧的数据出口，桌面走 IPC (`mailagent kos stats`)。

**聚合逻辑单源** ``src/kos/stats.py::collect_kos_stats`` —— CLI 与本路由调同一个函数，
本模块只负责 envelope 包装（PRD R8：不重蹈 llm 路由那份手抄 SQL）。

db_path 经 ``Depends(get_repository)`` 拿 EmailRepository 的 db_path，与同目录其他读
端点同一来源；meta.source='sqlite'。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter, Depends, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_repository
from src.kos.stats import collect_kos_stats

if TYPE_CHECKING:
    from src.repository import EmailRepository

router = APIRouter(prefix="/api/kos", tags=["kos"])


# ============================================================
# GET /api/kos/stats?days=7  (读, 直查 kos_ingest_log + sync_state)
# ============================================================
@router.get("/stats")
async def kos_stats(
    request: Request,
    days: int = 7,
    _: None = Depends(verify_cf_access),
    repo: "EmailRepository" = Depends(get_repository),
):
    """KOS 入库台账统计 (status 分布 + 错误码分布 + 重试积压 + 健康)。

    与 ``mailagent kos stats`` 同一个聚合函数。days>0 → 仅统计过去 N 天
    (pushed_at >= now-N*86400); days=-1 → 全量; days=0 → E_INVALID_ARG
    (与 CLI 一致, 用 -1 表全量)。

    返回 data = {enabled, gate, missing_keys, days, since_ts, total, total_all,
    by_status, by_status_all, by_error_code, pending_retry, dead_count,
    last_success_ts, health{...}, daily[...]}。台账表不存在 (全新 install / KOS
    从未启用) → 同形状零值 + ``_source='table_missing'``。

    ``gate`` 三态 + ``missing_keys`` 是 issue #64 的显因契约: gate 不满足时渲染侧要
    说清缺什么, 不再整区静默消失。``missing_keys`` **只含键名**, 绝不含键值。
    """
    if days == 0:
        raise APIError(
            "E_INVALID_ARG",
            "days 0 invalid; use -1 (all) or >=1",
            hint="days=-1 for all-time, or days>=1 for a window",
            source="sqlite",
        )

    data = collect_kos_stats(repo.db_path, days=days)
    return success_envelope(data, request=request, source="sqlite")

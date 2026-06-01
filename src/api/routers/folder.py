"""folder 路由 — /api/folder/* (READ only)。

填充 4 个读端点 (handoff §2; 写端点全 defer):
  GET /api/folder/{folder}/list    — list      (FolderEmailMeta[])
  GET /api/folder/{folder}/{id}    — get       (FolderEmailDetail, 404→null)
  GET /api/folder/{folder}/search  — search    (FolderSearchResult)
  GET /api/folder/sync-status      — syncStatus (FolderSyncStatusResult)

实现纪律:
  - 全部经 ``FolderEmailRepository`` (src/folder_sync/repository.py) **直读**
    ``folder_email`` / ``folder_email_fts`` / ``folder_sync_state`` 表 — 这是纯 SQLite
    reader, **避开 davmail gate** (gate 只在 CLI 写命令的 FolderImapReader 路径,
    handoff §2 + gotcha #6)。任何 backend 都能读已同步的本地数据。
  - **gotcha #1 (local_path)**: folder attachments 存的就是 ``{filename, size,
    content_type}`` (imap_folder_reader._extract_attachments_meta, 无 host 路径),
    天然无泄漏; 仍显式投影成 FolderAttachmentMeta 防未来字段漂移。
  - data 形状 = 前端 FolderEmailMeta/Detail/SearchResult/SyncStatusResult
    (shared/api/types.ts + schemas/folder.py)。**list/search 投影成 meta** (丢
    raw_mime_sha256 / synced_at / created_at / updated_at / deleted_at —
    schema 不含这些); get 额外带 body_html / body_markdown。
  - repo 每调用开短命连接即关 (WAL 下与 mail-sync writer 并发安全, gotcha #13)。
  - 统一响应走 app.success_envelope / app.APIError; 鉴权挂 Depends(verify_cf_access);
    meta.source='sqlite'。

注意路由顺序: ``/sync-status`` 必须在 ``/{folder}/...`` 之前声明, 否则
``sync-status`` 会被 ``{folder}`` path 吞掉 (FastAPI 按声明序匹配)。这里 sync-status
prefix 与 ``{folder}/...`` 段数不同 (1 段 vs 2-3 段), 无歧义, 但仍保守先声明定长路由。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from fastapi import APIRouter, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_settings

if TYPE_CHECKING:
    from src.config import Config
    from src.folder_sync.repository import FolderEmailRepository, FolderEmailRow

router = APIRouter(prefix="/api/folder", tags=["folder"])

VALID_FOLDERS = ("archive", "drafts")
LIST_LIMIT_MAX = 500
SEARCH_LIMIT_MAX = 200


def _build_repo(cfg: "Config") -> "FolderEmailRepository":
    """从 config 单例构造 FolderEmailRepository (短连接, 无 davmail 依赖)。"""
    from src.folder_sync.repository import FolderEmailRepository

    return FolderEmailRepository(cfg.sync_store_db_path)


def _validate_folder(folder: str) -> None:
    if folder not in VALID_FOLDERS:
        raise APIError(
            "E_INVALID_ARG",
            f"folder must be one of {list(VALID_FOLDERS)}, got {folder!r}",
            source="sqlite",
        )


def _attachment_to_dict(att: dict[str, Any]) -> dict[str, Any]:
    """folder attachment → FolderAttachmentMeta wire dict (gotcha #1: 仅展示字段)。

    存储形 = {filename, size, content_type} (imap_folder_reader)。显式挑这三个键,
    即便上游将来多塞字段也不外泄 (绝无 local_path / host 路径)。
    """
    return {
        "filename": att.get("filename", "(unnamed)"),
        "size": att.get("size", 0),
        "content_type": att.get("content_type", "application/octet-stream"),
    }


def _row_to_meta(row: "FolderEmailRow") -> dict[str, Any]:
    """FolderEmailRow → FolderEmailMeta wire dict (不含正文)。

    丢弃 raw_mime_sha256 / synced_at / created_at / updated_at / deleted_at
    (前端 FolderEmailMeta 不含, schema forbid extra)。attachments 经
    _attachment_to_dict 投影。
    """
    return {
        "id": row.id,
        "folder": row.folder,
        "imap_uid": row.imap_uid,
        "imap_uidvalidity": row.imap_uidvalidity,
        "message_id": row.message_id,
        "thread_id": row.thread_id,
        "subject": row.subject or "",
        "sender": row.sender or "",
        "sender_name": row.sender_name,
        "to_addr": row.to_addr or "",
        "cc_addr": row.cc_addr or "",
        "date_received": row.date_received,
        "is_flagged": bool(row.is_flagged),
        "has_attachments": bool(row.has_attachments),
        "snippet": row.snippet,
        "attachments": [_attachment_to_dict(a) for a in (row.attachments or [])],
    }


def _row_to_detail(row: "FolderEmailRow") -> dict[str, Any]:
    """FolderEmailRow → FolderEmailDetail wire dict (meta + 正文)。"""
    data = _row_to_meta(row)
    data["body_html"] = row.body_html
    data["body_markdown"] = row.body_markdown
    return data


# ===========================================================================
# GET /api/folder/sync-status — FolderEmailRepository.list_sync_states + count
# (定长路由, 先于 /{folder}/... 声明避免被吞)
# ===========================================================================


@router.get("/sync-status", dependencies=[Depends(verify_cf_access)])
async def folder_sync_status(
    request: Request,
    cfg: "Config" = Depends(get_settings),
):
    """folder_sync_state 表 + 每 folder 行数统计 (镜像 ``mailagent folder sync-status``)。

    data = FolderSyncStatusResult {states, counts} (frontend FolderSyncStatusResult)。
    states = FolderSyncStateItem[] (folder / imap_uidvalidity / last_uidnext /
    last_full_sync_at / last_incremental_sync_at / last_error)。
    """
    repo = _build_repo(cfg)
    states = repo.list_sync_states()
    data = {
        "states": [
            {
                "folder": s.folder,
                "imap_uidvalidity": s.imap_uidvalidity,
                "last_uidnext": s.last_uidnext,
                "last_full_sync_at": s.last_full_sync_at,
                "last_incremental_sync_at": s.last_incremental_sync_at,
                "last_error": s.last_error,
            }
            for s in states
        ],
        "counts": {f: repo.count(f) for f in VALID_FOLDERS},
    }
    return success_envelope(data, request=request, source="sqlite")


# ===========================================================================
# GET /api/folder/by-id/{id} — FolderEmailRepository.get (folder-agnostic)
# (定长 'by-id' 前缀, 先于 /{folder}/{id:int} 声明避免被 {folder} 吞;
#  镜像 Electron folder:get(id) — web FolderApi.get(id) 不带 folder)
# ===========================================================================


@router.get("/by-id/{id:int}", dependencies=[Depends(verify_cf_access)])
async def folder_get_by_id(
    request: Request,
    id: int,
    cfg: "Config" = Depends(get_settings),
):
    """按 row id 直取详情 (folder-agnostic; 含正文 + 附件元数据)。

    web ``FolderApi.get(id)`` 只携带数字 row id, 不带 folder; 从 folder_email row
    自解析 folder (``repo.get(id)`` 是主键查询, row 本就含 row.folder), 镜像
    Electron ``folder:get(id)``。404 (E_NOT_FOUND) → 前端把它当 null。
    """
    repo = _build_repo(cfg)
    row = repo.get(id)
    if row is None:
        raise APIError(
            "E_NOT_FOUND",
            f"folder_email id={id} not found",
            hint="use GET /api/folder/{folder}/list to find available ids",
            source="sqlite",
        )
    return success_envelope(_row_to_detail(row), request=request, source="sqlite")


# ===========================================================================
# GET /api/folder/{folder}/list — FolderEmailRepository.list
# ===========================================================================


@router.get("/{folder}/list", dependencies=[Depends(verify_cf_access)])
async def folder_list(
    request: Request,
    folder: str,
    cfg: "Config" = Depends(get_settings),
    limit: int = Query(200, ge=1, le=LIST_LIMIT_MAX),
    offset: int = Query(0, ge=0),
):
    """列出 folder 内邮件 metadata (本地表直读, 不含正文; date DESC)。

    FolderListOpts 映射: path folder; query limit/offset。
    data = FolderEmailMeta[] (frontend FolderEmailMeta), meta += {count, limit, offset}。
    """
    _validate_folder(folder)
    repo = _build_repo(cfg)
    rows = repo.list(folder, limit=limit, offset=offset)
    data = [_row_to_meta(r) for r in rows]
    return success_envelope(
        data,
        request=request,
        source="sqlite",
        meta_extra={"count": len(data), "limit": limit, "offset": offset},
    )


# ===========================================================================
# GET /api/folder/{folder}/search — FolderEmailRepository.search_fts
# (定长 'search' 段先于 '{id}' 声明, 防 search 被当 id 解析)
# ===========================================================================


@router.get("/{folder}/search", dependencies=[Depends(verify_cf_access)])
async def folder_search(
    request: Request,
    folder: str,
    cfg: "Config" = Depends(get_settings),
    q: str = Query(..., description="FTS5 查询 (默认 CJK-aware smart 改写)"),
    raw: bool = Query(False, description="true=原样下放 FTS5; false(默认)=CJK smart 改写"),
    limit: int = Query(50, ge=1, le=SEARCH_LIMIT_MAX),
):
    """folder_email_fts 全文搜索 (bm25 排序, 限定单 folder)。

    FolderSearchOpts 映射: path folder; query q/raw/limit。默认 smart 模式
    (CJK-aware query 改写); raw=true 走原 FTS5 syntax。
    data = FolderSearchResult {query, transformed_query, total_hits, hits}
    (hits = FolderEmailMeta[], 无正文)。FTS 语法错误 → 空命中 (repo 内吞)。
    """
    _validate_folder(folder)
    repo = _build_repo(cfg)

    if raw:
        transformed_query = None
        fts_query = q
    else:
        from src.repository.email_repository import smart_query_transform

        fts_query = smart_query_transform(q)
        transformed_query = fts_query

    rows = repo.search_fts(fts_query, folder=folder, limit=limit)
    hits = [_row_to_meta(r) for r in rows]
    data = {
        "query": q,
        "transformed_query": transformed_query,
        "total_hits": len(hits),
        "hits": hits,
    }
    meta_extra: dict[str, Any] = {
        "query": q,
        "total_hits": len(hits),
        "limit": limit,
        "count": len(hits),
    }
    if transformed_query is not None and transformed_query != q:
        meta_extra["transformed_query"] = transformed_query
    return success_envelope(
        data, request=request, source="sqlite", meta_extra=meta_extra
    )


# ===========================================================================
# GET /api/folder/{folder}/{id} — FolderEmailRepository.get
# (最泛路由, 最后声明; {id:int} 约束避免吃掉 'list' / 'search' 段)
# ===========================================================================


@router.get("/{folder}/{id:int}", dependencies=[Depends(verify_cf_access)])
async def folder_get(
    request: Request,
    folder: str,
    id: int,
    cfg: "Config" = Depends(get_settings),
):
    """单封详情 (含正文 body_html / body_markdown + 附件元数据)。

    data = FolderEmailDetail (frontend FolderEmailDetail) = meta + 正文。
    404 (E_NOT_FOUND) 当 id 不存在 (前端 get 把 404 当 null)。
    folder path 段做白名单校验 + 与查到的 row.folder 交叉核对 (防跨 folder id 误读)。
    """
    _validate_folder(folder)
    repo = _build_repo(cfg)
    row = repo.get(id)
    if row is None or row.folder != folder:
        raise APIError(
            "E_NOT_FOUND",
            f"folder_email id={id} not found in folder {folder!r}",
            hint="use GET /api/folder/{folder}/list to find available ids",
            source="sqlite",
        )
    return success_envelope(_row_to_detail(row), request=request, source="sqlite")

"""email 路由 — /api/email/*。

读端点经 EmailRepository (Depends(get_repository))，写端点经 cli_runner subprocess。
契约: BACKEND-INTERFACES §2.4 + email-*.schema.json (list/get/body/search/resync/
update-flag)。

本 router 端点:
  GET  /api/email/list                  — repo.list_metadata        (EmailMeta[])
  GET  /api/email/pinned-ids            — repo.list_pinned_ids       (PinnedIds)
  GET  /api/email/{internal_id}         — repo.get_email_full/get_metadata (EmailFull)
  GET  /api/email/{internal_id}/body    — repo.get_body             (EmailBody)
  GET  /api/email/search                — repo.search_email_bodies  (SearchResult)
  POST /api/email/draft                 — service MailWriteService.compose_draft (DraftResult)
  POST /api/email/send                  — service MailWriteService.send (SendResult)
  POST /api/email/{internal_id}/resync  — service MailWriteService.resync (ResyncResult|plan)
  POST /api/email/{internal_id}/update-flag — CLI `notion update-flag` (legacy notion.updateFlag)
  POST /api/email/{internal_id}/flag    — service MailWriteService.set_flags (Sprint 15 outbox SSoT)
  POST /api/email/{internal_id}/archive — service MailWriteService.archive (davmail-only)
  POST /api/email/{internal_id}/draft-plan — service MailWriteService.compose_plan (DraftPlanResult)
  POST /api/email/{internal_id}/pin     — service MailWriteService.set_pin (pin toggle)

设计纪律 (实现规格 + sibling 已写的 envelope/schemas):
  - 读端点 ``data`` 形状 = CLI 同名命令 emit 的 ``data`` (复用
    docs/cli-schema/email-*.schema.json), 直接镜像 CLI commands/email.py 的
    ``_meta_to_dict`` / ``_body_summary`` / ``_attachment_to_dict`` /
    ``_meta_record_to_list_item`` helper, 让 cli.gen.ts 校验不变。
  - 统一响应走 app.success_envelope / app.APIError (全局 handler 转 envelope error +
    正确 HTTP)。meta.source='sqlite' (repo 直查) / 'cli' (in-process service 或 subprocess)。
  - flag / resync (A2) + archive / pin (A3) + compose draft/send/draft-plan (A4) 写端点走
    进程内 MailWriteService (不再 fork CLI)。flag/resync 恒 allow_concurrent (mail-sync 生产
    在线 → pm2 检测会拒); archive/pin/compose 不做 pm2 检测; send 端点恒 confirmed=True (前端
    已弹 SendConfirmDialog)。仅剩 legacy notion update-flag 仍经 cli_runner.run_cli。
  - notion update-flag (仍 fork) 用 **tri-bool 字符串形** ``--is-read true/false`` + **不做**
    pm2 检测 (不带 --allow-concurrent), 与 email flag 路径区别 (实现规格 gotcha #6/#7)。
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.cli_runner import CliRunnerError, get_cli_api_key, run_cli
from src.api.deps import get_repository, get_service_ctx
from src.services import wire
from src.services.errors import ServiceError
from src.services.guards import Actor
from src.services.mail_write import MailWriteService

if TYPE_CHECKING:
    from src.repository import EmailRepository

router = APIRouter(prefix="/api/email", tags=["email"])


# ---------------------------------------------------------------------------
# wire-shape 投影 → src/services/wire.py (D2a 去重, CLI + API 共用单一真源)。
# GET /email/{id} 用 wire.meta_to_dict(include_important=True) 给前端 EmailDetail
# 扩展 is_important; 其余 (list / body / attachment) 与 CLI 逐字段相同。
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# validation constants — 与 CLI email.py 对齐 (相同上限/枚举, 错误才一致)
# ---------------------------------------------------------------------------

VALID_INCLUDE = {"body", "attachments", "all"}
VALID_BODY_FORMATS = {"markdown", "html", "raw"}
VALID_STATUSES = {
    "pending", "fetch_failed", "synced", "failed", "skipped", "dead_letter",
}
LIST_LIMIT_MAX = 500
SEARCH_LIMIT_MAX = 200


def _parse_include(include: str) -> set[str]:
    """逗号分隔 → set; 'all' 展开为 {body, attachments}。镜像 email.py::_parse_include。"""
    if not include:
        return set()
    parts = {p.strip().lower() for p in include.split(",") if p.strip()}
    unknown = parts - VALID_INCLUDE
    if unknown:
        raise APIError(
            "E_INVALID_ARG",
            f"Unknown include value(s): {sorted(unknown)}; "
            f"valid: {sorted(VALID_INCLUDE)}",
            source="sqlite",
        )
    if "all" in parts:
        return {"body", "attachments"}
    return parts


def _count_fts_indexed(repo: "EmailRepository") -> int:
    """`SELECT count(*) FROM email_body_fts` — SearchResult.total_indexed 用。

    repo 无现成 helper (实现规格 gotcha #3), 用 repo._connect() 起一个短命连接
    (与 repo 内部所有读一致: per-call open/close, WAL 下与 mail-sync writer 并发安全)。
    FTS5 表缺失 / 异常时回 0, 不让搜索因 count 失败而 500。
    """
    import sqlite3

    conn = repo._connect()
    try:
        row = conn.execute("SELECT count(*) AS c FROM email_body_fts").fetchone()
        return int(row["c"]) if row else 0
    except sqlite3.OperationalError:
        return 0
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# CLI 错误 → APIError 桥接 (写端点共用)
# ---------------------------------------------------------------------------


def _raise_from_cli_error(exc: CliRunnerError) -> None:
    """把 CliRunnerError 转成 APIError (全局 handler 据 code 映 HTTP)。

    code 优先用 CLI 自报的 ``error.code`` (run_cli 已解析), http_status 由
    app.ERROR_CODE_TO_HTTP[code] 推导。raw stdout/stderr 不回显 (仅 message/hint)。
    """
    raise APIError(
        exc.code,
        exc.message,
        hint=exc.hint,
        source="cli",
    ) from exc


def _raise_from_service_error(exc: ServiceError) -> None:
    """把 in-process service 抛的 ServiceError 转成 APIError (全局 handler 据 code 映 HTTP)。

    与 ``_raise_from_cli_error`` 对称 (后者处理 fork CLI 的 CliRunnerError)。code 用
    service 自报的 ``ServiceError.code`` (E_NOT_FOUND / E_PM2_RUNNING / ...), http_status
    由 app.ERROR_CODE_TO_HTTP[code] 推导。``source='cli'`` 维持既有 wire 契约 (meta.source)。
    """
    raise APIError(exc.code, exc.message, hint=exc.hint, source="cli") from exc


# ===========================================================================
# GET /api/email/list — repo.list_metadata → EmailMeta[]
# ===========================================================================


@router.get("/list", dependencies=[Depends(verify_cf_access)])
async def list_emails(
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
    mailbox: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    since: Optional[str] = Query(None, alias="sinceDate", description="YYYY-MM-DD (date_from)"),
    until: Optional[str] = Query(None, alias="untilDate", description="YYYY-MM-DD (date_to)"),
    from_addr: Optional[str] = Query(None, alias="fromAddr", description="sender 子串"),
    subject: Optional[str] = Query(None, description="subject 子串"),
    is_read: Optional[bool] = Query(None, alias="isRead"),
    is_flagged: Optional[bool] = Query(None, alias="isFlagged"),
    has_notion: Optional[bool] = Query(None, alias="hasNotion"),
    limit: int = Query(50, ge=1, le=LIST_LIMIT_MAX),
    offset: int = Query(0, ge=0),
):
    """列出邮件 metadata (分页 + 过滤)。

    F2 (实现规格): query 键全用前端 types.ts ``ListOpts`` 的 camelCase 契约
    (sinceDate / untilDate / fromAddr / isRead / isFlagged / hasNotion)。旧实现只
    给 ``from`` 起 alias, 其余用 snake_case → 前端发的 camelCase 键被 FastAPI 静默
    丢弃 → 过滤被无声忽略。mailbox / status / subject / limit / offset 在两侧同名,
    无需 alias。
    data = EmailMeta[] (email-list.schema.json email_list_item),
    meta += {total, limit, offset, count} (email-list.schema.json meta)。
    """
    if status is not None and status not in VALID_STATUSES:
        raise APIError(
            "E_INVALID_ARG",
            f"status must be one of {sorted(VALID_STATUSES)}, got {status!r}",
            source="sqlite",
        )

    result = repo.list_metadata(
        mailbox=mailbox,
        status=status,
        date_from=since,
        date_to=until,
        sender_substr=from_addr,
        subject_substr=subject,
        is_read=is_read,
        is_flagged=is_flagged,
        has_notion=has_notion,
        limit=limit,
        offset=offset,
    )
    rows = result.get("emails", [])
    data = [wire.meta_record_to_list_item(r) for r in rows]
    return success_envelope(
        data,
        request=request,
        source="sqlite",
        meta_extra={
            "total": result.get("total", len(rows)),
            "limit": result.get("limit", limit),
            "offset": result.get("offset", offset),
            "count": len(data),
        },
    )


# ===========================================================================
# GET /api/email/{internal_id} — get_email_full / get_metadata → EmailFull
# ===========================================================================


@router.get("/{internal_id:int}", dependencies=[Depends(verify_cf_access)])
async def get_email(
    request: Request,
    internal_id: int,
    repo: "EmailRepository" = Depends(get_repository),
    include: str = Query(
        "", description="逗号分隔: body / attachments / all (默认仅 metadata)"
    ),
):
    """获取单封邮件 metadata + 可选 body 摘要 / attachments。

    ?include=body,attachments → 一次聚合 (repo.get_email_full)。data 形状镜像
    `email get` (email-get.schema.json email_record): 始终含 ``body`` (摘要 | null)
    + ``attachments`` (list | [])。404 (E_NOT_FOUND) 当 metadata 缺失。
    body 是 SUMMARY (format/size_bytes/...), 非内容 — 内容走 /body 端点。
    """
    parts = _parse_include(include)

    if parts:
        full = repo.get_email_full(internal_id)
        if full is None:
            raise APIError(
                "E_NOT_FOUND",
                f"Email with internal_id={internal_id} not found",
                hint="Use GET /api/email/list to find available IDs",
                source="sqlite",
            )
        data = wire.meta_to_dict(full.metadata, include_important=True)
        data["body"] = wire.body_summary(full.body) if "body" in parts else None
        data["attachments"] = (
            [wire.attachment_to_dict(a) for a in full.attachments]
            if "attachments" in parts
            else []
        )
    else:
        meta = repo.get_metadata(internal_id)
        if meta is None:
            raise APIError(
                "E_NOT_FOUND",
                f"Email with internal_id={internal_id} not found",
                hint="Use GET /api/email/list to find available IDs",
                source="sqlite",
            )
        data = wire.meta_to_dict(meta, include_important=True)
        data["body"] = None
        data["attachments"] = []

    return success_envelope(data, request=request, source="sqlite")


# ===========================================================================
# GET /api/email/{internal_id}/body — get_body, 按 format 取字段
# ===========================================================================


@router.get("/{internal_id:int}/body", dependencies=[Depends(verify_cf_access)])
async def get_email_body(
    request: Request,
    internal_id: int,
    repo: "EmailRepository" = Depends(get_repository),
    format: str = Query("markdown", description="markdown (default) / html / raw"),
):
    """返回邮件正文 — markdown / html / raw (raw → content=raw_mime_sha256, 仅哈希)。

    data = EmailBody (email-body.schema.json): {internal_id, format, content,
    size_bytes, fetched_at, fetched_source}。镜像 CLI `email body`:
    单次 get_body 后挑字段 (一次往返拿到 size_bytes/fetched_at)。
    404 (E_NOT_FOUND) 当无 body 行 或 该 format 字段为 None。
    """
    fmt = format.lower()
    if fmt not in VALID_BODY_FORMATS:
        raise APIError(
            "E_INVALID_ARG",
            f"format must be one of {sorted(VALID_BODY_FORMATS)}, got {format!r}",
            source="sqlite",
        )

    body_record = repo.get_body(internal_id)
    if body_record is None:
        raise APIError(
            "E_NOT_FOUND",
            f"No body in SQLite for internal_id={internal_id}",
            hint="可能未经 v4 双写; 后台跑 backfill body 回填",
            source="sqlite",
        )

    if fmt == "markdown":
        content = body_record.markdown
    elif fmt == "html":
        content = body_record.html
    else:  # raw — 只返回 raw MIME 哈希 (不含正文)
        content = body_record.raw_mime_sha256

    if content is None:
        raise APIError(
            "E_NOT_FOUND",
            f"Body format {fmt!r} unavailable for internal_id={internal_id}",
            hint="可能仅 dual-write 了另一种 format; 试 ?format=html / markdown",
            source="sqlite",
        )

    data = {
        "internal_id": internal_id,
        "format": fmt,
        "content": content,
        "size_bytes": (
            body_record.body_size_bytes if fmt != "raw" else len(content)
        ),
        "fetched_at": body_record.fetched_at,
        "fetched_source": body_record.fetched_source,
    }
    return success_envelope(data, request=request, source="sqlite")


# ===========================================================================
# GET /api/email/search — FTS5 bm25 + snippet
# ===========================================================================


@router.get("/search", dependencies=[Depends(verify_cf_access)])
async def search_emails(
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
    q: str = Query(..., description="自然语言关键词 或 FTS5 query 语法"),
    mailbox: Optional[str] = Query(None),
    since: Optional[str] = Query(None, description="YYYY-MM-DD"),
    until: Optional[str] = Query(None, description="YYYY-MM-DD"),
    limit: int = Query(50, ge=1, le=SEARCH_LIMIT_MAX),
    raw: bool = Query(False, description="true=直传 FTS5; false(默认)=CJK smart 改写"),
):
    """FTS5 全文搜索邮件正文 + subject + sender。

    默认 smart 模式 (CJK-aware query 改写); raw=true 走原 FTS5 syntax。
    data = SearchResult (前端 types.ts): {items, total_indexed, transformed_query?,
    mode?}。meta += {query, mode, total_hits, limit, count, transformed_query?}
    (镜像 CLI `email search` meta)。FTS 语法错误 → 空命中 (repo 内部吞掉)。

    A5 (故意偏离 cli-schema): 本端点 ``data`` 是 SearchResult **对象** (含 total_indexed
    等), **非** CLI `email search` emit 的命中数组 —— 因前端 types.ts EmailApi.search
    返回 SearchResult。未来的 schema-conformance 测试勿据 cli-schema 数组形误报本端点。
    """
    if raw:
        hits = repo.search_email_bodies(
            q, limit=limit, mailbox=mailbox, since_date=since, until_date=until
        )
        transformed_query = q
    else:
        from src.repository.email_repository import smart_query_transform

        transformed_query = smart_query_transform(q)
        hits = repo.search_email_bodies(
            transformed_query,
            limit=limit,
            mailbox=mailbox,
            since_date=since,
            until_date=until,
        )

    items = [
        {
            "internal_id": hit.internal_id,
            "subject": hit.subject,
            "sender": hit.sender,
            "date_received": hit.date_received,
            "mailbox": hit.mailbox,
            "rank": hit.rank,
            "snippet": hit.snippet,
            "notion_page_id": hit.notion_page_id,
            "notion_url": hit.notion_url,
        }
        for hit in hits
    ]

    mode = "raw" if raw else "smart"
    total_indexed = _count_fts_indexed(repo)
    # data = 前端 SearchResult 形状 (items + total_indexed + transformed_query? + mode)。
    data: dict[str, Any] = {
        "items": items,
        "total_indexed": total_indexed,
        "mode": mode,
    }
    transformed_changed = (not raw) and transformed_query != q
    if transformed_changed:
        data["transformed_query"] = transformed_query

    meta_extra: dict[str, Any] = {
        "query": q,
        "mode": mode,
        "total_hits": len(items),
        "limit": limit,
        "count": len(items),
        "total_indexed": total_indexed,
    }
    if transformed_changed:
        meta_extra["transformed_query"] = transformed_query

    return success_envelope(
        data, request=request, source="sqlite", meta_extra=meta_extra
    )


# ===========================================================================
# POST /api/email/{internal_id}/resync — CLI `email resync`
# ===========================================================================


@router.post("/{internal_id:int}/resync", dependencies=[Depends(verify_cf_access)])
async def resync_email(
    request: Request,
    internal_id: int,
    body: Optional[dict[str, Any]] = None,
):
    """重传单封邮件到 Notion (A2: in-process MailWriteService, 不再 fork CLI)。

    body (ResyncOpts, 全可选): {replaceExisting, skipParentLookup, dryRun}。
    data = oneOf plan | result (email-resync.schema.json)。
    **恒 allow_concurrent=True** (mail-sync 生产在线 → pm2 检测会拒; 「恒并发」决策上移到
    HTTP 适配器)；dry-run 跳过 auth (plan_resync 纯预览, 无写)。
    """
    opts = body or {}
    dry_run = bool(opts.get("dryRun"))
    replace_existing = bool(opts.get("replaceExisting"))
    skip_parent_lookup = bool(opts.get("skipParentLookup"))

    svc = MailWriteService(get_service_ctx())
    try:
        if dry_run:
            data = await asyncio.to_thread(
                svc.plan_resync,
                internal_id,
                replace_existing=replace_existing,
                skip_parent_lookup=skip_parent_lookup,
            )
        else:
            result = await asyncio.to_thread(
                svc.resync,
                internal_id,
                replace_existing=replace_existing,
                skip_parent_lookup=skip_parent_lookup,
                actor=Actor(kind="http", authenticated=True, label="cf-access"),
                allow_concurrent=True,
            )
            data = {
                "internal_id": result.internal_id,
                "old_page_id": result.old_page_id,
                "new_page_id": result.new_page_id,
                "archived_page_id": result.archived_page_id,
                "action": result.action,
                "dry_run": False,
            }
    except ServiceError as exc:
        _raise_from_service_error(exc)

    return success_envelope(data, request=request, source="cli")


# ===========================================================================
# POST /api/email/{internal_id}/update-flag — CLI `notion update-flag`
# (legacy notion.updateFlag — 直写 Notion 页, 无 outbox; Sprint15 灰度期并存)
# ===========================================================================


def _tri_bool_str(value: Any) -> Optional[str]:
    """把任意可空 bool/字符串归一成 CLI tri-bool 字符串 'true'/'false' (或 None)。

    notion update-flag 用字符串形 ``--is-read true`` (与 email flag 的 slash 形不同)。
    None / 缺省 → None (该字段不传 → CLI 不改)。
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    v = str(value).strip().lower()
    if v in ("true", "1", "yes"):
        return "true"
    if v in ("false", "0", "no"):
        return "false"
    raise APIError(
        "E_INVALID_ARG",
        f"expected boolean for flag, got {value!r}",
        source="cli",
    )


@router.post("/{internal_id:int}/update-flag", dependencies=[Depends(verify_cf_access)])
async def update_flag(
    request: Request,
    internal_id: int,
    body: Optional[dict[str, Any]] = None,
):
    """直写 Notion 邮件页 Is Read / Is Flagged / Processing Status (CLI `notion update-flag`)。

    legacy notion.updateFlag 契约 (UpdateFlagOpts): {isRead, isFlagged,
    processingStatus, dryRun}。tri-bool 用字符串形 ``--is-read true/false``。
    data = notion-update-flag.schema.json {internal_id, page_id,
    updated_properties, dry_run}。404 当无 notion_page_id。
    此命令**不做** pm2 检测 → 不带 --allow-concurrent。
    """
    opts = body or {}
    dry_run = bool(opts.get("dryRun"))

    is_read = _tri_bool_str(opts.get("isRead"))
    is_flagged = _tri_bool_str(opts.get("isFlagged"))
    processing_status = opts.get("processingStatus")

    if is_read is None and is_flagged is None and processing_status is None:
        raise APIError(
            "E_INVALID_ARG",
            "at least one of isRead / isFlagged / processingStatus required",
            source="cli",
        )

    args: list[str] = ["notion", "update-flag", str(internal_id)]
    if is_read is not None:
        args += ["--is-read", is_read]
    if is_flagged is not None:
        args += ["--is-flagged", is_flagged]
    if processing_status is not None:
        args += ["--processing-status", str(processing_status)]
    if dry_run:
        args.append("--dry-run")

    api_key = None if dry_run else get_cli_api_key()
    try:
        result = await run_cli(args, api_key=api_key)
    except CliRunnerError as exc:
        _raise_from_cli_error(exc)

    return success_envelope(
        result.data,
        request=request,
        source="cli",
        meta_extra=result.meta or None,
    )


# ===========================================================================
# GET /api/email/pinned-ids — repo.list_pinned_ids → PinnedIds
# ===========================================================================
# NOTE: 该动态段 ``/{internal_id:int}`` 用 ``:int`` 转换器, "pinned-ids" 本就不匹配,
# 顺序无所谓 (此处定义只为可读)。


@router.get("/pinned-ids", dependencies=[Depends(verify_cf_access)])
async def list_pinned_ids(
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
):
    """列出所有置顶邮件的 internal_id (repo.list_pinned_ids, pinned_at DESC)。

    data = PinnedIds {pinned_ids: int[], count}。前端 InboxView 用它在分页列表外
    补齐置顶项 (置顶可能落在当前页之外)。纯 SQLite 读, 无 auth。
    """
    pinned_ids = repo.list_pinned_ids()
    data = {"pinned_ids": pinned_ids, "count": len(pinned_ids)}
    return success_envelope(data, request=request, source="sqlite")


# ===========================================================================
# POST /api/email/{internal_id}/flag  +  POST /api/email/flag (batch)
#   — A2: in-process MailWriteService.set_flags / plan_flags (Sprint 15 outbox SSoT)
# ===========================================================================
# A2 起不再 fork CLI: 端点解析 body 后直接调进程内 service (asyncio.to_thread)。两个
# 入口共享 _extract_flag_mutation (取 is_read/is_flagged/processing_status) + _run_flag_service,
# 只在 **target** 段不同:
#   - 单封: path ``/{id}/flag`` → positional id (body 也可带 ids[] 走批量, 互斥时 path 被忽略)。
#   - 批量: ``/flag`` (无 path id) → 必带 body ``ids[]``, 空/缺 ids → 400 (C8 契约,
#     对齐 types.ts flag(null,{ids}))。
# **恒 allow_concurrent=True** (gotcha #9: mail-sync 生产恒在线, 否则 pm2 检测拒写;「恒并发」
#   决策上移到 HTTP 适配器)。EmailFlagOpts.allowConcurrent 是 client field, 服务端**恒忽略**。
# email flag 不走 LongTaskContext → 无 partial_failure: 逐项 not_found 落 data.not_found
#   (HTTP 200), 不再有 207 路径。


def _extract_flag_mutation(
    opts: dict[str, Any],
) -> tuple[Optional[bool], Optional[bool], Optional[str]]:
    """从 EmailFlagOpts 取出 (is_read, is_flagged, processing_status)。

    至少一个 isRead / isFlagged / processingStatus, 否则 raise E_INVALID_ARG (→ 400)。
    isRead/isFlagged 非 bool 视作未给 (与历史 slash-form 严格 bool 行为一致);
    processingStatus 空串/非串视作未给。
    """
    is_read = opts.get("isRead")
    is_flagged = opts.get("isFlagged")
    processing_status = opts.get("processingStatus")
    is_read = is_read if isinstance(is_read, bool) else None
    is_flagged = is_flagged if isinstance(is_flagged, bool) else None
    has_processing = isinstance(processing_status, str) and len(processing_status) > 0

    if is_read is None and is_flagged is None and not has_processing:
        raise APIError(
            "E_INVALID_ARG",
            "at least one of isRead / isFlagged / processingStatus required",
            source="cli",
        )
    return is_read, is_flagged, (processing_status if has_processing else None)


async def _run_flag_service(
    request: Request,
    internal_ids: list[int],
    *,
    is_read: Optional[bool],
    is_flagged: Optional[bool],
    processing_status: Optional[str],
    dry_run: bool,
):
    """in-process ``MailWriteService.set_flags`` / ``plan_flags`` + envelope。

    **恒 allow_concurrent=True** (gotcha #9)。dry-run 跳过 auth (plan_flags 纯预览, 无写);
    执行路径用已鉴权 Actor (请求已过 verify_cf_access)。data 形状 = email-flag.schema.json
    (executed flag_result | dry-run plan)。
    """
    svc = MailWriteService(get_service_ctx())

    if dry_run:
        data = svc.plan_flags(
            internal_ids,
            is_read=is_read,
            is_flagged=is_flagged,
            processing_status=processing_status,
        )
        return success_envelope(
            data,
            request=request,
            source="cli",
            meta_extra={"count": len(internal_ids)},
        )

    try:
        result = await asyncio.to_thread(
            svc.set_flags,
            internal_ids,
            is_read=is_read,
            is_flagged=is_flagged,
            processing_status=processing_status,
            actor=Actor(kind="http", authenticated=True, label="cf-access"),
            allow_concurrent=True,
        )
    except ServiceError as exc:
        _raise_from_service_error(exc)

    data = {
        "dry_run": False,
        "updated_ids": result.updated_ids,
        "payload": result.payload,
        "outbox_entries": result.outbox_entries,
    }
    if result.not_found:
        data["not_found"] = result.not_found
    return success_envelope(
        data,
        request=request,
        source="cli",
        meta_extra={
            "count": len(result.updated_ids),
            "not_found_count": len(result.not_found),
        },
    )


def _coerce_flag_ids(ids: Any) -> list[int]:
    """校验 batch ``ids`` 为非空 non-negative int 列表; 否则 raise E_INVALID_ARG。

    bool 是 int 子类, 显式排除 (True/False 不是合法 id)。空列表 / 非列表 → 400
    (C8: 批量端点拒绝空 ids, 不静默 fallback)。
    """
    if not isinstance(ids, list) or len(ids) == 0:
        raise APIError(
            "E_INVALID_ARG",
            "ids must be a non-empty list of non-negative integers",
            source="cli",
        )
    for i in ids:
        if not isinstance(i, int) or isinstance(i, bool) or i < 0:
            raise APIError(
                "E_INVALID_ARG",
                f"ids must be non-negative integers, got {i!r}",
                source="cli",
            )
    return ids


@router.post("/{internal_id:int}/flag", dependencies=[Depends(verify_cf_access)])
async def flag_email(
    request: Request,
    internal_id: int,
    body: Optional[dict[str, Any]] = None,
):
    """写 flag / processing_status intent 到 SQLite + outbox 双 target (CLI `email flag`)。

    Sprint 15 SSoT inversion 主写路径 (区别 legacy notion.updateFlag 直写 Notion)。
    body (EmailFlagOpts): {isRead?, isFlagged?, processingStatus?, ids?, dryRun?}。
    - 单封: path ``internal_id`` (body 不传 ids)。
    - 批量: body ``ids: [1,2,3]`` (与 path id 互斥, 此时忽略 path)。
      (无 path id 的纯批量入口见 ``POST /api/email/flag``。)
    至少给一个 isRead / isFlagged / processingStatus, 否则 400。
    A2: in-process service, 恒 allow_concurrent (#9)。dry-run 跳过 auth。
    data = email-flag.schema.json (executed flag_result | dry-run plan)。
    """
    opts = body or {}
    dry_run = bool(opts.get("dryRun"))
    is_read, is_flagged, processing_status = _extract_flag_mutation(opts)

    # target: --ids 批量 与 单封 path id 互斥 (镜像 emailFlagArgs in write_ops.ts)。
    ids = opts.get("ids")
    if isinstance(ids, list) and len(ids) > 0:
        internal_ids = _coerce_flag_ids(ids)
    else:
        internal_ids = [internal_id]

    return await _run_flag_service(
        request,
        internal_ids,
        is_read=is_read,
        is_flagged=is_flagged,
        processing_status=processing_status,
        dry_run=dry_run,
    )


@router.post("/flag", dependencies=[Depends(verify_cf_access)])
async def flag_emails_batch(
    request: Request,
    body: Optional[dict[str, Any]] = None,
):
    """批量写 flag / processing_status intent (CLI `email flag --ids`) — 无 path id。

    C8 契约: 对齐 types.ts ``flag(null, {ids: [...], isRead: ...})``。body
    (EmailFlagOpts): {ids: [1,2,3], isRead?, isFlagged?, processingStatus?, dryRun?}。
    ``ids`` **必填且非空** (空/缺 → 400, 不像单封端点那样静默 fallback 到 path id)。
    至少给一个 isRead / isFlagged / processingStatus, 否则 400。
    A2: in-process service, 恒 allow_concurrent (#9)。dry-run 跳过 auth。
    data = email-flag.schema.json。

    NOTE: 与单封 ``/{id}/flag`` 不冲突 —— 后者用 ``:int`` 转换器, 字面量 "flag" 不匹配整数段。
    """
    opts = body or {}
    dry_run = bool(opts.get("dryRun"))
    is_read, is_flagged, processing_status = _extract_flag_mutation(opts)
    internal_ids = _coerce_flag_ids(opts.get("ids"))

    return await _run_flag_service(
        request,
        internal_ids,
        is_read=is_read,
        is_flagged=is_flagged,
        processing_status=processing_status,
        dry_run=dry_run,
    )


# ===========================================================================
# POST /api/email/{internal_id}/archive — CLI `email archive` (davmail-only)
# ===========================================================================


@router.post("/{internal_id:int}/archive", dependencies=[Depends(verify_cf_access)])
async def archive_email(
    request: Request,
    internal_id: int,
    body: Optional[dict[str, Any]] = None,
):
    """归档收件箱邮件: IMAP MOVE INBOX→Archive + Mailbox→存档 (A3: in-process MailWriteService)。

    body (可选): {dryRun?}。davmail-only — 非 davmail backend 时 service 抛
    E_INVALID_ARG → 400 (gotcha #6)。archive **不做** pm2 检测 → 无 allow_concurrent
    (gotcha #9)。dry-run 跳过 auth (plan_archive 纯预览, 无写)。
    data = ArchiveResult (success/from_mailbox/to_mailbox/notion_updated/...)。
    """
    opts = body or {}
    dry_run = bool(opts.get("dryRun"))

    svc = MailWriteService(get_service_ctx())
    try:
        if dry_run:
            data = await asyncio.to_thread(svc.plan_archive, internal_id)
        else:
            result = await asyncio.to_thread(
                svc.archive,
                internal_id,
                actor=Actor(kind="http", authenticated=True, label="cf-access"),
            )
            data = {
                "internal_id": result.internal_id,
                "action": "archive",
                "success": True,
                "from_mailbox": result.from_mailbox,
                "to_mailbox": result.to_mailbox,
                "notion_updated": result.notion_updated,
                "notion_error": result.notion_error,
                "dry_run": False,
            }
    except ServiceError as exc:
        _raise_from_service_error(exc)

    return success_envelope(data, request=request, source="cli")


# ===========================================================================
# POST /api/email/{internal_id}/move — 多文件夹同步: 移动到任意文件夹 (davmail-only)
# ===========================================================================


@router.post("/{internal_id:int}/move", dependencies=[Depends(verify_cf_access)])
async def move_email(
    request: Request,
    internal_id: int,
    body: dict[str, Any],
):
    """把邮件移到任意目标文件夹 (IMAP MOVE + Mailbox 更新)。davmail-only。

    body: {dstImapName} (IMAP 原始名 modified-UTF7)。data = MoveResult。
    """
    dst = (body or {}).get("dstImapName") or ""
    if not dst:
        raise APIError("E_INVALID_ARG", "dstImapName required", source="cli")
    svc = MailWriteService(get_service_ctx())
    try:
        result = await asyncio.to_thread(
            svc.move_to_folder,
            internal_id,
            dst,
            actor=Actor(kind="http", authenticated=True, label="cf-access"),
        )
        data = {
            "internal_id": result.internal_id,
            "action": "move",
            "success": True,
            "from_mailbox": result.from_mailbox,
            "to_mailbox": result.to_mailbox,
            "notion_updated": result.notion_updated,
            "notion_error": result.notion_error,
        }
    except ServiceError as exc:
        _raise_from_service_error(exc)
    return success_envelope(data, request=request, source="cli")


# ===========================================================================
# Compose (draft / send / draft-plan) — A4: in-process MailWriteService
# ===========================================================================
# bodyHtml (TipTap getHTML()) **直接传字符串** 给 service (不再落临时文件
# ``--body-html-file`` —— A4 净简化); DraftPlanResult 保持 snake_case (reply_html /
# forward_intro_html / reply_source), **勿 camelCase** (历史 bug)。

VALID_COMPOSE_MODES = {"reply", "reply-all", "forward"}


def _validate_compose_mode(mode: Any) -> str:
    """校验 compose mode ∈ {reply, reply-all, forward}; 缺省 reply-all。"""
    if mode is None:
        return "reply-all"
    m = str(mode)
    if m not in VALID_COMPOSE_MODES:
        raise APIError(
            "E_INVALID_ARG",
            f"mode must be one of {sorted(VALID_COMPOSE_MODES)}, got {mode!r}",
            source="cli",
        )
    return m


def _compose_request_from_body(internal_id: int, opts: dict[str, Any]):
    """HTTP body (camelCase + list 收件人) → ``ComposeRequest`` (service 入参)。

    to/cc/bcc 是 list → join 成逗号串 (service ``_split_addrs`` 再提纯); bodyHtml 直接
    传字符串 (A4: 不再落临时文件)。mode 缺省 reply-all (校验早于 service 构造)。
    """
    from src.services.mail_write import ComposeRequest

    def _join(v: Any) -> Optional[str]:
        return ",".join(str(x) for x in v) if isinstance(v, list) and v else None

    subject = opts.get("subject")
    body_html = opts.get("bodyHtml")
    return ComposeRequest(
        internal_id=internal_id,
        mode=_validate_compose_mode(opts.get("mode")),
        to=_join(opts.get("to")),
        cc=_join(opts.get("cc")),
        bcc=_join(opts.get("bcc")),
        subject=subject if isinstance(subject, str) else None,
        body_html=body_html if isinstance(body_html, str) and body_html else None,
    )


def _require_compose_internal_id(opts: dict[str, Any]) -> int:
    """从 body 取 ``internalId`` (non-negative int), 校验早于 service 构造。"""
    internal_id = opts.get("internalId")
    if not isinstance(internal_id, int) or isinstance(internal_id, bool) or internal_id < 0:
        raise APIError(
            "E_INVALID_ARG",
            f"internalId (non-negative int) required, got {internal_id!r}",
            source="cli",
        )
    return internal_id


@router.post("/draft", dependencies=[Depends(verify_cf_access)])
async def compose_draft(
    request: Request,
    body: Optional[dict[str, Any]] = None,
):
    """把 compose 内容写进 Drafts folder (IMAP APPEND, A4: in-process MailWriteService)。

    body (ComposeDraftOpts): {internalId, mode, to?, cc?, bcc?, subject?, bodyHtml?}。
    bodyHtml (TipTap getHTML()) 直接传字符串 (不再落临时文件)。davmail-only
    (append_draft 走 IMAP); 非 davmail → service 报错透传。data = DraftResult。
    """
    opts = body or {}
    internal_id = _require_compose_internal_id(opts)
    req = _compose_request_from_body(internal_id, opts)
    svc = MailWriteService(get_service_ctx())
    try:
        result = await asyncio.to_thread(
            svc.compose_draft,
            req,
            actor=Actor(kind="http", authenticated=True, label="cf-access"),
        )
    except ServiceError as exc:
        _raise_from_service_error(exc)

    data = {
        "internal_id": result.internal_id,
        "success": True,
        "drafts_folder": result.drafts_folder,
        "appended_uid": result.appended_uid,
        "method": result.method,
        "mode": result.mode,
        "to_count": result.to_count,
        "cc_count": result.cc_count,
        "attachments": result.attachments,
        "warnings": result.warnings,
        "dry_run": False,
    }
    return success_envelope(data, request=request, source="cli")


@router.post("/send", dependencies=[Depends(verify_cf_access)])
async def compose_send(
    request: Request,
    body: Optional[dict[str, Any]] = None,
):
    """SMTP 真实发送 (不可逆, A4: in-process MailWriteService.send)。

    body (SendEmailOpts = ComposeDraftOpts): {internalId, mode, to?, cc?, bcc?,
    subject?, bodyHtml?}。前端已弹 SendConfirmDialog → 端点恒 ``confirmed=True``。
    data = SendResult (sent/message_id/archived_to_sent/method)。
    """
    opts = body or {}
    internal_id = _require_compose_internal_id(opts)
    req = _compose_request_from_body(internal_id, opts)
    svc = MailWriteService(get_service_ctx())
    try:
        result = await asyncio.to_thread(
            svc.send,
            req,
            actor=Actor(kind="http", authenticated=True, label="cf-access"),
            confirmed=True,
        )
    except ServiceError as exc:
        _raise_from_service_error(exc)

    data = {
        "internal_id": result.internal_id,
        "sent": True,
        "mode": result.mode,
        "message_id": result.message_id,
        "archived_to_sent": result.archived_to_sent,
        "method": result.method,
        "to_count": result.to_count,
        "cc_count": result.cc_count,
        "attachments": result.attachments,
        "warnings": result.warnings,
    }
    return success_envelope(data, request=request, source="cli")


@router.post("/{internal_id:int}/draft-plan", dependencies=[Depends(verify_cf_access)])
async def draft_plan(
    request: Request,
    internal_id: int,
    body: Optional[dict[str, Any]] = None,
):
    """compose 预填单一数据源 (A4: in-process MailWriteService.compose_plan)。

    body (DraftPlanOpts 子集): {mode}。返回收件人 / 主题 / 正文 HTML
    (reply 用 LLM reply_suggestion 转的 HTML, forward 用原文引用块 HTML)。
    dry-run → 无 auth。data = DraftPlanResult **snake_case 原样透传**
    (reply_html / forward_intro_html / reply_source) —— 勿 camelCase (gotcha #8)。
    """
    opts = body or {}
    # draft-plan 无 body/recipient override, 仅 mode (compose 打开时调一次)。
    req = _compose_request_from_body(internal_id, {"mode": opts.get("mode")})
    svc = MailWriteService(get_service_ctx())
    try:
        data = await asyncio.to_thread(svc.compose_plan, req)
    except ServiceError as exc:
        _raise_from_service_error(exc)

    return success_envelope(data, request=request, source="cli")


# ===========================================================================
# POST /api/email/{internal_id}/pin — CLI `email pin|unpin`
# ===========================================================================


@router.post("/{internal_id:int}/pin", dependencies=[Depends(verify_cf_access)])
async def pin_email(
    request: Request,
    internal_id: int,
    body: Optional[dict[str, Any]] = None,
):
    """置顶 / 取消置顶邮件 (A3: in-process MailWriteService.set_pin / plan_pin)。

    body (PinOpts): {pinned: bool, dryRun?}。``pinned=true`` → pin, ``false`` → unpin
    (镜像 write_ops.ts pinArgs: ``email pin|unpin <id>``)。写 SQLite is_pinned;
    mail-sync 不读不写该字段 → **不做** pm2 检测。dry-run 跳过 auth。
    data = {internal_id, is_pinned, changed, dry_run}。
    """
    opts = body or {}
    pinned = opts.get("pinned")
    if not isinstance(pinned, bool):
        raise APIError(
            "E_INVALID_ARG",
            f"pinned (bool) required, got {pinned!r}",
            source="cli",
        )
    dry_run = bool(opts.get("dryRun"))

    svc = MailWriteService(get_service_ctx())
    try:
        if dry_run:
            data = await asyncio.to_thread(svc.plan_pin, internal_id, pinned=pinned)
        else:
            result = await asyncio.to_thread(
                svc.set_pin,
                internal_id,
                pinned=pinned,
                actor=Actor(kind="http", authenticated=True, label="cf-access"),
            )
            data = {
                "internal_id": result.internal_id,
                "is_pinned": result.is_pinned,
                "changed": result.changed,
                "dry_run": False,
            }
    except ServiceError as exc:
        _raise_from_service_error(exc)

    return success_envelope(data, request=request, source="cli")

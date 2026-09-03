"""library 路由 — /api/library/*（design §3 端点全表 + 投影行三条只读兄弟端点）。

鉴权一律 ``verify_local_token``（同 exec 家族：唯一调用方是同机 renderer / embedded gateway，
不接受 CF JWT；远程 web 只读面 P3 再议）。业务全在 ``src/library/service.py``（唯一写面），本文件只做
入参形状 + envelope；``LibraryError`` → ``APIError``，CAS 冲突（``E_VERSION_CONFLICT``）的响应体 ``data``
带当前 ``content_hash`` 与 ``content``（design §4，agent 工具腿据此合并后重试一次）。

安全不变式：
  - **renderer 永不拿到绝对路径**：除 ``/mounts`` 家族（设置页要显示挂载目录，design §8.2）外，任何响应体
    都不出现挂载根的绝对路径；``inline`` 的磁盘路径只在进程内流转。
  - 投影行（``mail-attachments``）三条端点只读；其源文件路径经 ``attachment.py::_resolve_guarded_path``
    钉在 ``data/attachments/`` 内（复用，不复制一份）；字节流复用 ``_stream_response``（Range 206）。
  - ``inline`` 对 ``text/html`` 只给 ``Content-Disposition: inline``，iframe 可直接加载（design §2.6）。

响应体字段一律 snake_case，与 ``library_file`` 列名一致（前端 wire 类型按同名对齐）。
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Literal, Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, ValidationError
from starlette.concurrency import run_in_threadpool

from src.api.app import ERROR_CODE_TO_HTTP, APIError, error_envelope, success_envelope
from src.api.auth import verify_local_token
from src.api.deps import get_repository
from src.api.routers.attachment import (
    _fetch_attachment_text_context,
    _resolve_attachment_for_stream,
    _resolve_guarded_path,
    _stream_response,
)
from src.library.constants import FOLDER_PAGE_SIZE, READ_TOOL_MAX_BYTES, SEARCH_MODES, SOURCES
from src.library.service import TEXT_KINDS, Actor, LibraryError, LibraryService, _cap_text

router = APIRouter(
    prefix="/api/library",
    tags=["library"],
    dependencies=[Depends(verify_local_token)],
)

_SOURCE = "library"


@lru_cache(maxsize=1)
def _build_service() -> LibraryService:
    """进程内单例（lazy）：service 只持路径，连接 per-call，WAL 下并发安全。"""
    from src.config import config as _config_singleton
    from src.library.db import resolve_library_db_path, resolve_library_root

    sync_db = _config_singleton.sync_store_db_path
    return LibraryService(resolve_library_db_path(sync_db), resolve_library_root(sync_db), sync_db)


def get_library_service() -> LibraryService:
    return _build_service()


# ---------------------------------------------------------------------------
# 入参形状
# ---------------------------------------------------------------------------


class ActorSpec(BaseModel):
    """调用方身份（写端点可选；缺省 = UI 用户）。custom agent 带 ``agent_id``，写面因此限 agent-docs/ + rw 挂载根。"""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["user", "main_agent", "custom_agent"] = "user"
    agent_id: Optional[str] = None
    session_id: Optional[int] = None
    message_id: Optional[int] = None

    def to_actor(self) -> Actor:
        return Actor(kind=self.kind, agent_id=self.agent_id, session_id=self.session_id, message_id=self.message_id)


def _actor(spec: Optional[ActorSpec]) -> Actor:
    return spec.to_actor() if spec is not None else Actor()


class CreateTextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    parent_path: str = ""
    filename: str
    content: str
    source: str = "user"
    #: ``derived`` = 原文件 id（「派生自 X」回链，F2）；``chat`` = '{sessionId}:{uiMessageId}'（§1.4）。
    source_ref: Optional[str] = None
    change_note: Optional[str] = None
    actor: Optional[ActorSpec] = None


class WriteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str
    expected_hash: Optional[str] = None
    change_note: Optional[str] = None
    actor: Optional[ActorSpec] = None


class AppendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str
    change_note: Optional[str] = None
    actor: Optional[ActorSpec] = None


class MoveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_path: str
    actor: Optional[ActorSpec] = None


class RollbackRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    history_id: int
    actor: Optional[ActorSpec] = None


class KeepAttachmentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    attachment_id: int
    target_path: str
    actor: Optional[ActorSpec] = None


class RescanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mount_id: Optional[int] = None


class MountCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    abs_path: str
    label: Optional[str] = None
    mode: Literal["ro", "rw"] = "rw"


class MountPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: Optional[str] = None
    mode: Optional[Literal["ro", "rw"]] = None


# ---------------------------------------------------------------------------
# envelope 桥
# ---------------------------------------------------------------------------


def _conflict_response(exc: LibraryError, request: Request) -> JSONResponse:
    """带 ``data`` 的错误 envelope（只有 CAS 冲突用）—— 形状由 error_envelope 生成，只补 data。"""
    base = error_envelope(
        exc.code, exc.message, http_status=ERROR_CODE_TO_HTTP.get(exc.code, 409), hint=exc.hint, request=request, source=_SOURCE
    )
    payload = json.loads(bytes(base.body))
    payload["data"] = exc.data
    return JSONResponse(status_code=base.status_code, content=payload)


def _run(request: Request, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> JSONResponse:
    try:
        result = fn(*args, **kwargs)
    except LibraryError as exc:
        if exc.data is not None:
            return _conflict_response(exc, request)
        raise APIError(exc.code, exc.message, hint=exc.hint, source=_SOURCE) from exc
    return success_envelope(result, request=request, source=_SOURCE)


def _validate(model: type[BaseModel], payload: Any) -> BaseModel:
    try:
        return model.model_validate(payload)
    except ValidationError as exc:
        raise APIError("E_INVALID_ARG", f"invalid request body: {exc.errors()[0].get('msg', 'validation error')}", source=_SOURCE) from exc


def _require_source(source: str) -> str:
    if source not in SOURCES:
        raise APIError("E_INVALID_ARG", f"invalid source: {source!r}", hint=f"source ∈ {', '.join(SOURCES)}", source=_SOURCE)
    return source


# ---------------------------------------------------------------------------
# 读面（sync def：阻塞 sqlite / 磁盘由 FastAPI 自动 offload 到线程池）
# ---------------------------------------------------------------------------


@router.get("/tree")
def library_tree(request: Request, service: LibraryService = Depends(get_library_service)):
    """扁平文件夹节点 + 挂载根摘要（无 abs_path）+ 文件总数。"""
    return _run(request, service.tree)


@router.get("/folder")
def library_folder(
    request: Request,
    path: str = Query(""),
    offset: int = Query(0, ge=0),
    limit: int = Query(FOLDER_PAGE_SIZE, ge=1, le=FOLDER_PAGE_SIZE),
    q: Optional[str] = Query(None),
    sort: str = Query("name"),
    dir: str = Query("asc"),  # noqa: A002 — wire 名就叫 dir
    service: LibraryService = Depends(get_library_service),
):
    """文件夹条目 + 元数据，服务端排序后分页（投影文件夹 ``q`` 同时匹配文件名与来源列，F4）。"""
    return _run(request, service.folder, path, offset=offset, limit=limit, q=q, sort=sort, direction=dir)


@router.get("/files")
def library_files(
    request: Request,
    ids: str = Query(..., description="逗号分隔的 file_id（design §9.0 批量现查存在性 / 显示名）"),
    service: LibraryService = Depends(get_library_service),
):
    try:
        file_ids = [int(part) for part in ids.split(",") if part.strip()]
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", "ids must be comma-separated integers", source=_SOURCE) from exc
    if len(file_ids) > 200:
        raise APIError("E_INVALID_ARG", "at most 200 ids per call", source=_SOURCE)
    return _run(request, service.files, file_ids)


@router.get("/recent")
def library_recent(
    request: Request,
    limit: int = Query(20, ge=1, le=100),
    service: LibraryService = Depends(get_library_service),
):
    """跨根按 mtime 取最近改动的文件。资料选择器在用户还没输关键词时用它——
    `/folder` 按 parent_path 精确取直接子项，拿它拼「最近」只覆盖各根顶层，会撒谎。"""
    return _run(request, service.recent, limit=limit)


@router.get("/search")
def library_search(
    request: Request,
    q: str = Query(..., min_length=1, max_length=200),
    limit: int = Query(20, ge=1, le=100),
    mode: str = Query("hybrid", description=f"检索模式 ∈ {', '.join(SEARCH_MODES)}（design §9.1）"),
    service: LibraryService = Depends(get_library_service),
):
    """FTS 双表（含 CJK 走 trigram，1 字拦截进 ``warnings``）+ 语义腿经 RRF 混合；pending 文件顺带抽取。

    🔴 没下载语义模型时 ``mode=hybrid`` **自动退化成纯 FTS**，返回体形状不变：``search_mode`` 说实际跑了
    哪条、``semantic.available`` 说模型在不在、每条命中的 ``lane`` 恒为 ``'fts'``。能力缺席**不进
    ``warnings``**（那里只放这次 query 自身的事，如 ``cjk_too_short:X``）。
    """
    return _run(request, service.search, q, limit=limit, mode=mode)


@router.get("/embed/status")
def library_embed_status(request: Request, service: LibraryService = Depends(get_library_service)):
    """语义索引面板：``{model:{available, model_id, repo, approx_bytes, bytes_on_disk},
    index:{files_total, files_indexed, files_pending, chunks}, job:{kind, running, done, total, error, …}|null}``。

    设置页轮询它（作业跑着时约 1s 一次，跑完停）。**不含任何绝对路径**（renderer 永不拿到）。
    """
    return _run(request, service.embed_status)


@router.post("/embed/download")
def library_embed_download(request: Request, service: LibraryService = Depends(get_library_service)):
    """下载语义模型权重（约 614 MB）→ 立即返回一份 status，进度经 ``GET /embed/status`` 的 ``job`` 轮询。

    已下载 → ``E_INVALID_STATE``；已有作业在跑 → 同样 ``E_INVALID_STATE``（进程内单实例）。
    """
    return _run(request, service.start_download_job)


@router.post("/embed/rebuild")
def library_embed_rebuild(request: Request, service: LibraryService = Depends(get_library_service)):
    """清掉本模型的全部向量并重新后台建索引（低速队列）；返回一份 status，进度同上。没模型 → ``E_INVALID_STATE``。"""
    return _run(request, service.rebuild_index)


@router.get("/file/{file_id}")
def library_file(
    request: Request,
    file_id: int,
    max_bytes: Optional[int] = Query(None, ge=1, le=READ_TOOL_MAX_BYTES),
    service: LibraryService = Depends(get_library_service),
):
    """元数据 + 文本类正文 + ``content_hash``（打开即对账）；``max_bytes`` 是读工具下推的天花板。"""
    return _run(request, service.file, file_id, max_bytes=max_bytes)


@router.get("/file/{file_id}/text")
def library_file_text(
    request: Request,
    file_id: int,
    max_bytes: Optional[int] = Query(None, ge=1, le=READ_TOOL_MAX_BYTES),
    service: LibraryService = Depends(get_library_service),
):
    """解析版（``library_text``）；pending 时就地触发抽取。"""
    return _run(request, service.file_text, file_id, max_bytes=max_bytes)


@router.get("/file/{file_id}/inline")
def library_file_inline(request: Request, file_id: int, service: LibraryService = Depends(get_library_service)):
    """从盘流式返回原件（Range 206）。``text/html`` 只标 inline，让 iframe 直接加载（design §2.6）。"""
    try:
        abs_path, filename, mime, size = service.stream_target(file_id)
    except LibraryError as exc:
        raise APIError(exc.code, exc.message, hint=exc.hint, source=_SOURCE) from exc
    return _stream_response(
        SimpleNamespace(content_type=mime, filename=filename),
        Path(abs_path),
        size,
        disposition="inline",
        range_header=request.headers.get("range"),
    )


@router.get("/file/{file_id}/history/{history_id}")
def library_file_history_snapshot(
    request: Request, file_id: int, history_id: int, service: LibraryService = Depends(get_library_service)
):
    """单条历史的快照正文 + 该行元数据。列表端点只给 snapshot_bytes，展开看正文走这条。"""
    return _run(request, service.history_snapshot, file_id, history_id)


@router.get("/file/{file_id}/history")
def library_file_history(request: Request, file_id: int, service: LibraryService = Depends(get_library_service)):
    """最新在前，不带快照正文（``snapshot_bytes`` 代替）。"""
    return _run(request, service.history, file_id)


# ---------------------------------------------------------------------------
# 投影行（mail-attachments）三条只读兄弟端点 —— 与 /file/{id} 家族同形，id 为 null
# ---------------------------------------------------------------------------


def _projection_text_bytes(repo, attachment_id: int, kind: str, status: str, max_bytes: Optional[int]) -> tuple[Optional[str], bool]:
    """文本类附件的正文：源路径经 ``_resolve_guarded_path`` 钉在附件存储根内后读盘。"""
    if kind not in TEXT_KINDS or status != "present":
        return None, False
    ctx = _fetch_attachment_text_context(repo, attachment_id)
    if ctx is None or not ctx["local_path"]:
        return None, False
    guarded = _resolve_guarded_path(repo, ctx["local_path"])  # 越界 → 403
    try:
        data = guarded.read_bytes()
    except OSError:
        return None, False
    if len(data) > READ_TOOL_MAX_BYTES:
        return None, False
    text = data.decode("utf-8", errors="replace")
    if max_bytes is not None:
        return _cap_text(text, max_bytes)
    return text, False


@router.get("/attachment/{attachment_id}")
def library_attachment(
    request: Request,
    attachment_id: int,
    max_bytes: Optional[int] = Query(None, ge=1, le=READ_TOOL_MAX_BYTES),
    service: LibraryService = Depends(get_library_service),
    repo=Depends(get_repository),
):
    """与 ``GET /library/file/{id}`` 逐字同形的行对象（``id`` 为 null、``is_projection`` true、带来源列）。"""
    try:
        item = service.projection_file(attachment_id)
    except LibraryError as exc:
        raise APIError(exc.code, exc.message, hint=exc.hint, source=_SOURCE) from exc
    item["content"], item["truncated"] = _projection_text_bytes(repo, attachment_id, item["kind"], item["status"], max_bytes)
    return success_envelope(item, request=request, source=_SOURCE)


@router.get("/attachment/{attachment_id}/text")
def library_attachment_text(
    request: Request,
    attachment_id: int,
    max_bytes: Optional[int] = Query(None, ge=1, le=READ_TOOL_MAX_BYTES),
    service: LibraryService = Depends(get_library_service),
):
    """与 ``/file/{id}/text`` 同形；直接读 ``email_attachment_text`` 已抽好的文本，不重抽、不写 ``library_text``。"""
    return _run(request, service.projection_text, attachment_id, max_bytes=max_bytes)


@router.get("/attachment/{attachment_id}/inline")
def library_attachment_inline(request: Request, attachment_id: int, repo=Depends(get_repository)):
    """与 ``/file/{id}/inline`` 同形（Range 206）：base 根 = ``data/attachments/``，复用附件路由的守卫与流式管线。"""
    meta, path, total = _resolve_attachment_for_stream(repo, attachment_id)
    return _stream_response(meta, path, total, disposition="inline", range_header=request.headers.get("range"))


# ---------------------------------------------------------------------------
# 写面
# ---------------------------------------------------------------------------


@router.post("/files")
async def library_create_file(request: Request, service: LibraryService = Depends(get_library_service)):
    """新建 / 上传。JSON ``{parent_path, filename, content, source?, source_ref?, change_note?, actor?}``
    写文本；``application/octet-stream`` + query ``parent_path, filename, source?, source_ref?`` 落二进制。
    已存在 → 409。``source_ref``：``derived`` 存原文件 id（F2 回链），``chat`` 存
    ``'{sessionId}:{uiMessageId}'``（§1.4）。"""
    content_type = request.headers.get("content-type", "")
    if content_type.startswith("application/json"):
        try:
            payload = await request.json()
        except ValueError as exc:
            raise APIError("E_INVALID_ARG", "body is not valid JSON", source=_SOURCE) from exc
        body = _validate(CreateTextRequest, payload)
        data = body.content.encode("utf-8")
        parent, filename, source = body.parent_path, body.filename, body.source
        source_ref = body.source_ref
        change_note, actor = body.change_note, _actor(body.actor)
    else:
        data = await request.body()
        parent = request.query_params.get("parent_path", "")
        filename = request.query_params.get("filename", "")
        source = request.query_params.get("source", "user")
        source_ref = request.query_params.get("source_ref")
        change_note, actor = None, Actor()
        if not filename:
            raise APIError("E_INVALID_ARG", "query param `filename` is required for binary uploads", source=_SOURCE)
    _require_source(source)
    path = f"{parent}/{filename}" if parent else filename
    return await run_in_threadpool(
        _run, request, service.create_file, path, data,
        actor=actor, source=source, source_ref=source_ref, change_note=change_note,
    )


@router.put("/file/{file_id}")
def library_write_file(request: Request, file_id: int, body: WriteRequest, service: LibraryService = Depends(get_library_service)):
    """整体覆写，``expected_hash`` CAS：不符 → 409 + 当前 hash / content；``null`` = 新建语义（已存在也 409）。"""
    return _run(
        request, service.write_file, file_id, body.content,
        expected_hash=body.expected_hash, actor=_actor(body.actor), change_note=body.change_note,
    )


@router.post("/file/{file_id}/append")
def library_append_file(request: Request, file_id: int, body: AppendRequest, service: LibraryService = Depends(get_library_service)):
    """只追加（``library_append`` 的服务端面，无 CAS）。"""
    return _run(request, service.append_file, file_id, body.content, actor=_actor(body.actor), change_note=body.change_note)


@router.post("/file/{file_id}/move")
def library_move_file(request: Request, file_id: int, body: MoveRequest, service: LibraryService = Depends(get_library_service)):
    return _run(request, service.move_file, file_id, body.target_path, actor=_actor(body.actor))


@router.delete("/file/{file_id}")
def library_delete_file(
    request: Request,
    file_id: int,
    purge: bool = Query(False, description="true = 立即永久删除（仅 trashed 行，F11）"),
    actor_kind: Literal["user", "main_agent", "custom_agent"] = Query("user"),
    agent_id: Optional[str] = Query(None),
    service: LibraryService = Depends(get_library_service),
):
    """默认进 ``.trash``（软删）；``purge=true`` 真删文件 + 删行。"""
    if purge:
        return _run(request, service.purge_file, file_id)
    return _run(request, service.trash_file, file_id, actor=Actor(kind=actor_kind, agent_id=agent_id))


@router.post("/file/{file_id}/restore")
def library_restore_file(request: Request, file_id: int, service: LibraryService = Depends(get_library_service)):
    return _run(request, service.restore_file, file_id)


@router.post("/file/{file_id}/rollback")
def library_rollback_file(request: Request, file_id: int, body: RollbackRequest, service: LibraryService = Depends(get_library_service)):
    """拿快照做一次普通写（同一道 CAS / 写侧强制 / 历史）。"""
    return _run(request, service.rollback, file_id, body.history_id, actor=_actor(body.actor))


@router.post("/keep-attachment")
def library_keep_attachment(
    request: Request,
    body: KeepAttachmentRequest,
    service: LibraryService = Depends(get_library_service),
    repo=Depends(get_repository),
):
    """「另存到资料库」：真复制到 ``target_path`` 文件夹，连 ``email_attachment_text`` 已抽好的文本一起复制。"""
    ctx = _fetch_attachment_text_context(repo, body.attachment_id)
    if ctx is None:
        raise APIError("E_NOT_FOUND", f"attachment id={body.attachment_id} not found", source=_SOURCE)
    if not ctx["local_path"]:
        raise APIError("E_NOT_FOUND", f"attachment id={body.attachment_id} has no stored file", source=_SOURCE)
    guarded = _resolve_guarded_path(repo, ctx["local_path"])  # 越界 → 403
    record = repo.get_attachment_text(body.attachment_id)
    text = None
    if record is not None and record.status == "extracted" and record.text_content:
        text = {"text_content": record.text_content, "extractor": record.extractor, "truncated": record.truncated}
    return _run(
        request, service.keep_attachment, body.target_path,
        filename=ctx["filename"], src_path=str(guarded), attachment_id=body.attachment_id, text=text, actor=_actor(body.actor),
    )


@router.post("/rescan")
def library_rescan(request: Request, body: Optional[RescanRequest] = None, service: LibraryService = Depends(get_library_service)):
    """全量对账 → ``{scanned, added, updated, missing, elapsed_ms}``。"""
    return _run(request, service.rescan, body.mount_id if body is not None else None)


# ---------------------------------------------------------------------------
# 挂载根（唯一露出 abs_path 的响应 —— 设置页要显示，design §8.2）
# ---------------------------------------------------------------------------


@router.get("/mounts")
def library_mounts(
    request: Request,
    include_unmounted: bool = Query(False),
    service: LibraryService = Depends(get_library_service),
):
    return _run(request, service.mounts, include_unmounted=include_unmounted)


@router.post("/mounts")
def library_add_mount(request: Request, body: MountCreateRequest, service: LibraryService = Depends(get_library_service)):
    return _run(request, service.add_mount, body.abs_path, label=body.label, mode=body.mode)


@router.patch("/mounts/{mount_id}")
def library_patch_mount(request: Request, mount_id: int, body: MountPatchRequest, service: LibraryService = Depends(get_library_service)):
    return _run(request, service.patch_mount, mount_id, label=body.label, mode=body.mode)


@router.delete("/mounts/{mount_id}")
def library_remove_mount(request: Request, mount_id: int, service: LibraryService = Depends(get_library_service)):
    """卸载：挂载行标 unmounted、文件行标 missing、清文本 / FTS；不删行、不动磁盘。"""
    return _run(request, service.remove_mount, mount_id)

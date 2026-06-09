"""folder 路由 — /api/folder/* (多文件夹同步: 发现 / 白名单 / CRUD)。

端点 (全 davmail-only, cleanup 例外为纯本地):
  GET  /api/folder/discover    — 发现 Exchange 全部文件夹 (层级树 + special-use + 邮件数)
  GET  /api/folder/whitelist   — 读当前 SYNC_FOLDERS 白名单
  PUT  /api/folder/whitelist   — 覆盖式保存白名单 (写 .env)
  POST /api/folder/manage      — 新建子文件夹 (IMAP CREATE)
  PATCH /api/folder/manage     — 重命名文件夹 (IMAP RENAME + 本地一致性)
  DELETE /api/folder/manage    — 删除文件夹 (IMAP DELETE + 本地清理 + 白名单移除)
  POST /api/folder/cleanup     — 取消同步某文件夹时清理本地副本 (纯本地, 不碰 Exchange)

实现纪律:
  - 统一响应走 app.success_envelope / app.APIError; 鉴权挂 Depends(verify_cf_access)。
  - davmail gate 经 _require_davmail (按 config 值判, 不构造 backend)。
  - 写文件夹经 MailWriteService (服务层单一真源, 与 CLI folder create/rename/delete-folder
    共用)。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_settings

if TYPE_CHECKING:
    from src.config import Config

router = APIRouter(prefix="/api/folder", tags=["folder"])


# ============================================================
# 多文件夹同步: discover + whitelist (davmail-only)
# ============================================================

from pydantic import BaseModel  # noqa: E402


class _WhitelistBody(BaseModel):
    """PUT /api/folder/whitelist 请求体 — 完整白名单 (imap 原始名列表, 覆盖式保存)。"""

    folders: list[str]


def _require_davmail(cfg: "Config") -> None:
    if (getattr(cfg, "mailagent_backend", "") or "").lower() != "davmail":
        raise APIError(
            "E_INVALID_ARG",
            "多文件夹发现/白名单需要 davmail 后端 (MAILAGENT_BACKEND=davmail)",
            hint="AppleScript 后端不支持自定义文件夹同步",
            source="imap",
        )


def _current_whitelist(cfg: "Config") -> list[str]:
    from src.mail.backend.davmail_backend import DavMailBackend

    return DavMailBackend._parse_custom_folders(cfg)


@router.get("/discover", dependencies=[Depends(verify_cf_access)])
async def folder_discover(
    request: Request,
    cfg: "Config" = Depends(get_settings),
    counts: bool = Query(True, description="是否逐文件夹 STATUS 邮件数 (慢, 可关)"),
):
    """发现 Exchange 全部文件夹 (LIST → 层级树 + special-use + 邮件数)。davmail-only。

    data = {folders: [扁平含 is_synced/parent/has_children], tree: [嵌套], whitelist: [已同步 imap_name]}。
    """
    _require_davmail(cfg)
    from src.mail.backend.imap_client import build_folder_tree, list_folders

    try:
        folders = list_folders(cfg, with_counts=counts)
    except Exception as e:  # noqa: BLE001 — IMAP/连接失败统一上报
        raise APIError("E_UPSTREAM", f"folder discover failed: {e}", source="imap")
    whitelist = set(_current_whitelist(cfg))
    flat = []
    for fi in folders:
        d = fi.to_dict()
        d["is_synced"] = fi.imap_name in whitelist
        flat.append(d)
    return success_envelope(
        {"folders": flat, "tree": build_folder_tree(folders), "whitelist": sorted(whitelist)},
        request=request,
        source="imap",
    )


@router.get("/whitelist", dependencies=[Depends(verify_cf_access)])
async def folder_get_whitelist(
    request: Request,
    cfg: "Config" = Depends(get_settings),
):
    """读当前 SYNC_FOLDERS 白名单 (imap 原始名列表)。"""
    return success_envelope(
        {"folders": _current_whitelist(cfg)}, request=request, source="sqlite"
    )


@router.put("/whitelist", dependencies=[Depends(verify_cf_access)])
async def folder_set_whitelist(
    body: _WhitelistBody,
    request: Request,
    cfg: "Config" = Depends(get_settings),
):
    """覆盖式保存 SYNC_FOLDERS 白名单 (写 .env, JSON 数组)。需 restart mail-sync 生效。

    排除空项 + INBOX (主路径单独管)，去重保序。系统文件夹由前端 gate (本端点不强校验,
    避免每次 PUT 都 IMAP LIST; 误存系统名也由 _effective_custom_folders 运行时兜底过滤)。
    """
    _require_davmail(cfg)
    import json as _json

    from dotenv import set_key as _set_key

    from src.config import _resolve_env_file

    seen: set[str] = set()
    names: list[str] = []
    for raw in body.folders:
        n = (raw or "").strip()
        if not n or n.upper() == "INBOX" or n in seen:
            continue
        seen.add(n)
        names.append(n)
    try:
        env_file = _resolve_env_file()
        from pathlib import Path as _Path

        _p = _Path(env_file)
        if not _p.exists():
            _p.touch()
        _set_key(str(env_file), "SYNC_FOLDERS", _json.dumps(names, ensure_ascii=False), quote_mode="auto")
    except Exception as e:  # noqa: BLE001
        raise APIError("E_GENERIC", f".env write failed: {e}", source="sqlite")
    return success_envelope(
        {"folders": names, "restart_required": True}, request=request, source="sqlite"
    )


# ============================================================
# 多文件夹同步: 文件夹管理 CRUD (POST/PATCH/DELETE /api/folder/manage, davmail-only)
# ============================================================
import asyncio as _asyncio  # noqa: E402

from src.services.guards import Actor as _Actor  # noqa: E402
from src.services.mail_write import MailWriteService as _MailWriteService  # noqa: E402


class _FolderCreateBody(BaseModel):
    parent: str = ""    # 父文件夹 imap_name (空=顶层)
    name: str           # 子文件夹显示名 (可中文)


class _FolderRenameBody(BaseModel):
    imap_name: str
    new_name: str       # 新叶子显示名 (可中文)


class _FolderDeleteBody(BaseModel):
    imap_name: str


def _svc(request: Request) -> "_MailWriteService":
    from src.api.deps import get_service_ctx

    return _MailWriteService(get_service_ctx())


def _http_actor() -> "_Actor":
    return _Actor(kind="http", authenticated=True, label="cf-access")


def _svc_error_to_api(exc) -> None:
    raise APIError(
        getattr(exc, "code", "E_GENERIC"),
        getattr(exc, "message", str(exc)),
        hint=getattr(exc, "hint", None),
        source="cli",
    )


@router.post("/manage", dependencies=[Depends(verify_cf_access)])
async def folder_manage_create(body: _FolderCreateBody, request: Request, cfg: "Config" = Depends(get_settings)):
    """新建子文件夹 (IMAP CREATE → EWS)。davmail-only。"""
    _require_davmail(cfg)
    from src.services.errors import ServiceError

    try:
        result = await _asyncio.to_thread(
            _svc(request).create_folder, body.parent, body.name, actor=_http_actor()
        )
        return success_envelope(
            {"action": result.action, "imap_name": result.imap_name},
            request=request, source="cli",
        )
    except ServiceError as exc:
        _svc_error_to_api(exc)


@router.patch("/manage", dependencies=[Depends(verify_cf_access)])
async def folder_manage_rename(body: _FolderRenameBody, request: Request, cfg: "Config" = Depends(get_settings)):
    """重命名文件夹 (IMAP RENAME + 本地一致性)。系统文件夹拒绝。davmail-only。"""
    _require_davmail(cfg)
    from src.services.errors import ServiceError

    try:
        result = await _asyncio.to_thread(
            _svc(request).rename_folder, body.imap_name, body.new_name, actor=_http_actor()
        )
        return success_envelope(
            {
                "action": result.action,
                "imap_name": result.imap_name,
                "new_imap_name": result.new_imap_name,
                "affected_local_rows": result.affected_local_rows,
                "restart_required": result.restart_required,
            },
            request=request, source="cli",
        )
    except ServiceError as exc:
        _svc_error_to_api(exc)


@router.delete("/manage", dependencies=[Depends(verify_cf_access)])
async def folder_manage_delete(body: _FolderDeleteBody, request: Request, cfg: "Config" = Depends(get_settings)):
    """删除文件夹 (IMAP DELETE + 本地清理 + 白名单移除)。系统文件夹拒绝。davmail-only。"""
    _require_davmail(cfg)
    from src.services.errors import ServiceError

    try:
        result = await _asyncio.to_thread(
            _svc(request).delete_folder, body.imap_name, actor=_http_actor()
        )
        return success_envelope(
            {
                "action": result.action,
                "imap_name": result.imap_name,
                "affected_local_rows": result.affected_local_rows,
                "restart_required": result.restart_required,
            },
            request=request, source="cli",
        )
    except ServiceError as exc:
        _svc_error_to_api(exc)


class _FolderCleanupBody(BaseModel):
    imap_name: str


@router.post("/cleanup", dependencies=[Depends(verify_cf_access)])
async def folder_manage_cleanup(body: _FolderCleanupBody, request: Request):
    """取消同步某文件夹时清理本地副本 (P5)。**不碰 Exchange 文件夹**, 纯本地删除 +
    白名单移除。非 davmail 也可 (纯本地操作)。"""
    from src.services.errors import ServiceError

    try:
        result = await _asyncio.to_thread(
            _svc(request).cleanup_local_folder, body.imap_name, actor=_http_actor()
        )
        return success_envelope(
            {
                "action": result.action,
                "imap_name": result.imap_name,
                "affected_local_rows": result.affected_local_rows,
                "restart_required": result.restart_required,
            },
            request=request, source="cli",
        )
    except ServiceError as exc:
        _svc_error_to_api(exc)

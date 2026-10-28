"""DavMail 认证失效自助重连路由 —— /api/davmail/reauth/*（task 10-28-davmail-self-reauth）。

  POST /api/davmail/reauth/start     → {session_id, authorize_url, expires_at}
  POST /api/davmail/reauth/complete  {session_id, callback} → {ok, stage, code, message}

流程本体在 ``src/mail/davmail_reauth.py``，本路由只管会话和 HTTP 形状：
- 会话只存内存，10 分钟过期（与授权码有效期对齐）。会话里存 start 时读到的 DavMail 配置，
  complete 不再重读。成功后删除会话；失败保留，用户可以换一个授权码再贴。
- complete 的业务失败（授权码过期、写入失败、验证失败……）一律 200 + ``ok=false``，弹窗按
  ``stage`` / ``code`` 展示；只有请求本身不合法才走错误 envelope。
- 同一时间只跑一个 complete：两次并发写 token 文件会互相覆盖备份。

鉴权：``verify_cf_access``（本机 token / CF Access，owner-only）。非 davmail 后端 → 409。
🔴 请求体里的回调原文不进日志、不进响应。
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter, Body, Depends, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.mail import davmail_reauth
from src.mail.davmail_reauth import OAuthSettings, ReauthError

if TYPE_CHECKING:
    from src.config import Config

router = APIRouter(
    prefix="/api/davmail",
    tags=["davmail"],
    dependencies=[Depends(verify_cf_access)],
)

SESSION_TTL_SECS = 600


@dataclass(frozen=True)
class _Session:
    settings: OAuthSettings
    expires_at: float


_sessions: dict[str, _Session] = {}
_complete_lock = asyncio.Lock()


@lru_cache(maxsize=1)
def _sync_store():
    """进程内 SyncStore 单例（lazy），只持 db_path。构造纪律同 ``routers/history_sync.py``。"""
    from src.config import config as _config_singleton
    from src.mail.sync_store import SyncStore

    return SyncStore(_config_singleton.sync_store_db_path)


def get_reauth_store():
    """FastAPI 依赖：写 ``davmail.auth.last_interactive_at`` 的 sync_state 面（测试经 overrides 换临时库）。"""
    return _sync_store()


def _require_davmail(cfg: "Config") -> None:
    if (getattr(cfg, "mailagent_backend", "") or "").lower() != "davmail":
        raise APIError(
            "E_INVALID_STATE",
            "当前邮件后端不是 DavMail，不需要重新认证",
            http_status=409,
        )


def _prune(now: float) -> None:
    for sid in [sid for sid, s in _sessions.items() if s.expires_at <= now]:
        _sessions.pop(sid, None)


@router.post("/reauth/start")
def start_reauth(request: Request, cfg: "Config" = Depends(get_settings)):
    _require_davmail(cfg)
    try:
        settings = davmail_reauth.load_oauth_settings(cfg)
    except ReauthError as err:
        raise APIError("E_INVALID_STATE", err.message, http_status=409) from None

    now = time.time()
    _prune(now)
    session_id = secrets.token_urlsafe(16)
    expires_at = now + SESSION_TTL_SECS
    _sessions[session_id] = _Session(settings=settings, expires_at=expires_at)
    return success_envelope(
        {
            "session_id": session_id,
            "authorize_url": davmail_reauth.build_authorize_url(settings),
            "expires_at": int(expires_at),
        },
        request=request,
    )


@router.post("/reauth/complete")
async def complete_reauth(
    request: Request,
    body: Optional[dict[str, Any]] = Body(default=None),
    cfg: "Config" = Depends(get_settings),
    store: Any = Depends(get_reauth_store),
):
    _require_davmail(cfg)
    raw = body or {}
    session_id = raw.get("session_id")
    callback = raw.get("callback")
    if not isinstance(session_id, str) or not session_id:
        raise APIError("E_INVALID_ARG", "session_id is required")
    if not isinstance(callback, str):
        raise APIError("E_INVALID_ARG", "callback must be a string")

    session = _sessions.get(session_id)
    if session is None or session.expires_at <= time.time():
        _sessions.pop(session_id, None)
        return success_envelope(
            {
                "ok": False,
                "stage": "session",
                "code": "E_SESSION_EXPIRED",
                "message": "登录链接已过期，请点「重新获取链接」。",
            },
            request=request,
        )

    if _complete_lock.locked():
        raise APIError("E_INVALID_STATE", "上一次认证还在进行中，请稍候", http_status=409)
    async with _complete_lock:
        result = await davmail_reauth.complete_reauth(
            cfg, session.settings, callback, sync_store=store
        )
    if result.ok:
        _sessions.pop(session_id, None)
    return success_envelope(
        {"ok": result.ok, "stage": result.stage, "code": result.code, "message": result.message},
        request=request,
    )

"""IM 对话（飞书）投影面 —— /api/im/*（08-01 阶段 2 PR-4「信任可见」）。

PRODUCT.md 设计原则 1（*"Make trust observable: expose provenance, permissions,
run state, approvals, costs, and failure causes at the point of action"*）要求
IM 入口引入的新 provenance 与新权限面**在桌面 App 上看得见**。本 router 就是那
条投影链的后端一段：``sync_state`` 的 ``im.feishu.*`` + ``external_credential``
的 ``im:feishu`` 行 + CHAT_DB 的 ``origin='im'`` 审批行 → HTTP → 设置-AI 的
「飞书对话」区（``ImFeishuSection.tsx``）。

形态照 ``admin.davmailHealth``（sync_state → API → 设置页状态行）的先例。

鉴权分层：
  - ``GET /status`` / ``GET /approvals`` → ``verify_cf_access``（owner-only 读，
    本地 token 腿 + 远程 CF JWT 腿 —— 远程 web 也该看得见连接状态与审批历史）。
  - 🔴 ``POST /pair`` → ``verify_local_token``（**只认本地 token，不接受 CF JWT**，
    镜像 ``island.py:141`` 的 announce 腿）。绑定是「把一个飞书账号接进本机执行
    通道」的动作，远程浏览器不该发起；桌面 renderer 的 fetch 由 main 进程
    ``chat_local_bridge`` 透明注入本地 token，故设置页照常可用、远程 web 恒 403。

开关语义（🔴 与别的 flag-gated router 不同，有意如此）：
  - ``/status`` **不挂** flag 门 —— 「未启用」本身就是要如实告诉用户的状态之一
    （``enabled=false`` + 上次记录的 connection_status）。整区 409 会让设置页只能
    显示「加载失败」，正是本 PR 要消灭的那种不可见。
  - ``/pair`` **挂** flag 门（409）—— flag off 时 worker 根本没起、没有 bot 在收
    消息，出一个永远兑不掉的码是骗人。
  - ``/approvals`` 不挂门 —— 历史是既成事实，关掉开关不该让它消失。

🔴 绑定码回显纪律：``/status`` **只报「有没有一个有效码在等」，绝不回显码本身**
（PR-2 ``mailagent im status`` 同纪律，有测试钉）。``/pair`` **可以**回码 —— 它是
owner 在桌面上主动索取的一次性动作，与「被动状态面不泄露」并不矛盾。

``src.im.*`` / ``src.agent_config.*`` 一律 **lazy import**（handler 内）：让
``import src.api.app`` 在没装 lark-oapi 的裸 worktree 也不炸（镜像 island.py /
connector.py 的 lazy import 纪律）。
"""

from __future__ import annotations

from functools import lru_cache
from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter, Depends, Request
from loguru import logger
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access, verify_local_token
from src.api.deps import get_chat_db, get_settings

if TYPE_CHECKING:  # pragma: no cover - 仅类型
    from src.chat.db import ChatDb
    from src.im.state import ImFeishuState

router = APIRouter(prefix="/api/im", tags=["im"])

#: 审批历史投影的默认 / 上限条数。设置页只需要「最近做过什么」，不是审计导出。
_APPROVALS_DEFAULT_LIMIT = 20
_APPROVALS_MAX_LIMIT = 100


class ImPairBody(BaseModel):
    """``POST /pair`` 请求体。整体可省（默认实例）—— 不传 = 不 rebind。"""

    rebind: bool = False


@lru_cache(maxsize=1)
def _sync_store():
    """进程内 SyncStore 单例（lazy）。只持 db_path，连接 per-call 短命，WAL 并发安全。

    镜像 ``deps._build_report_store`` 的构造纪律；放这里而不是 deps.py 是因为除本
    router 外没有第二个消费方，没必要把它抬成公共依赖。
    """
    from src.config import config as _config_singleton
    from src.mail.sync_store import SyncStore

    return SyncStore(_config_singleton.sync_store_db_path)


def get_im_state() -> "ImFeishuState":
    """FastAPI 依赖：``im.feishu.*`` 的读写门面（测试经 dependency_overrides 换替身）。"""
    from src.im.state import ImFeishuState

    return ImFeishuState(_sync_store())


def _require_enabled(settings: Any) -> None:
    if not getattr(settings, "im_feishu_enabled", False):
        raise APIError(
            "E_IM_DISABLED",
            "Feishu IM chat is disabled (set MAILAGENT_IM_FEISHU=true and restart the backend)",
            http_status=409,
        )


def _credential_meta() -> dict:
    """``im:feishu`` 凭证行的**非敏感**投影（🔴 ``peek_credential`` 不解密不读密文列）。

    ``app_id`` 行的明文 ``metadata_json`` 是 PR-2 写进去的 bot 身份展示位
    （``app_id`` / ``app_name`` / ``bot_open_id``）—— 它存在的唯一理由是破 C6 实证
    的**同名陷阱**（对话 app 与通知 app 在飞书后台可以同名，认 app_id 不认名字）。
    """
    from src.im.credentials import KEY_APP_ID, KEY_APP_SECRET, NAMESPACE

    try:
        from src.agent_config.credentials import peek_credential

        id_meta = peek_credential(NAMESPACE, KEY_APP_ID)
        secret_meta = peek_credential(NAMESPACE, KEY_APP_SECRET)
    except Exception as e:  # noqa: BLE001 — 凭证层挂了只该降级展示，不该让状态面 500
        logger.warning(f"[im] 凭证元数据读取失败（按未配置展示）: {type(e).__name__}")
        return {
            "credential_present": False,
            "credential_updated_at": None,
            "bot_app_id": "",
            "metadata_app_name": "",
            "metadata_bot_open_id": "",
        }

    meta = getattr(id_meta, "metadata", None) or {}
    return {
        # 「凭证在不在」= 两把都在（``load_credentials`` 的同一判据：任一缺失即没有可用凭证）
        "credential_present": id_meta is not None and secret_meta is not None,
        "credential_updated_at": getattr(id_meta, "updated_at", None),
        "bot_app_id": str(meta.get("app_id") or ""),
        "metadata_app_name": str(meta.get("app_name") or ""),
        "metadata_bot_open_id": str(meta.get("bot_open_id") or ""),
    }


def _build_status(state: "ImFeishuState", settings: Any) -> dict:
    from src.im.pairing import peek_pair_code_expiry

    data = state.snapshot()
    data["enabled"] = bool(getattr(settings, "im_feishu_enabled", False))

    cred = _credential_meta()
    # 展示位取值：live 的 sync_state 优先，回落凭证行 metadata（worker 从未连上时
    # metadata 也可能是空的 —— 那就如实空着，不编）。
    data["bot_app_name"] = data.get("bot_app_name") or cred["metadata_app_name"]
    data["bot_open_id"] = data.get("bot_open_id") or cred["metadata_bot_open_id"]
    data["bot_app_id"] = cred["bot_app_id"]
    data["credential_present"] = cred["credential_present"]
    data["credential_updated_at"] = cred["credential_updated_at"]

    # 🔴 只报「有没有码在等」，不回显码本身。
    pending = peek_pair_code_expiry(state)
    data["pair_code_pending"] = pending is not None
    data["pair_code_expires_at"] = pending or 0
    return data


@router.get("/status")
async def im_status(
    request: Request,
    _: None = Depends(verify_cf_access),
    state: "ImFeishuState" = Depends(get_im_state),
    settings=Depends(get_settings),
) -> Any:
    """飞书连接 / 绑定 / 凭证状态（设置页「飞书对话」区的数据源）。

    🔴 **不挂 flag 门**：``enabled=false`` 是要如实呈现的状态之一，见模块 docstring。
    ``connection_status`` 在 ``enabled=false`` 时是**上次记录**（serve 被 kill -9 时
    它可能还停在 connected），UI 必须照此措辞，别直接当当前状态显示。
    """
    data = await run_in_threadpool(_build_status, state, settings)
    return success_envelope(data, request=request)


@router.post("/pair")
async def im_pair(
    request: Request,
    _: None = Depends(verify_local_token),
    state: "ImFeishuState" = Depends(get_im_state),
    settings=Depends(get_settings),
    body: ImPairBody = ImPairBody(),
) -> Any:
    """生成一次性绑定码（6 位数字，TTL 10 分钟）—— Settings 版的 ``mailagent im pair``。

    语义逐字对齐 CLI（``src/cli/commands/im.py::pair``）：已绑定且未显式 ``rebind``
    → 拒（否则陌生人/误操作能顶掉 owner）；``rebind=true`` → 先解绑再出码。
    """
    _require_enabled(settings)

    def _issue() -> dict:
        from src.im.pairing import PAIR_CODE_TTL_SEC, issue_pair_code

        bound = state.get_bound_open_id()
        if bound and not body.rebind:
            raise APIError(
                "E_INVALID_ARG",
                f"already bound to open_id={bound}",
                hint="确实要换人 / 换设备就传 rebind=true（会先解绑，再出新码）。",
            )
        unbound_from = ""
        if bound and body.rebind:
            unbound_from = bound
            state.set_bound_open_id("")

        code, expires_at = issue_pair_code(state)
        return {
            "code": code,
            "expires_at": expires_at,
            "expires_in_sec": PAIR_CODE_TTL_SEC,
            "unbound_from": unbound_from,
        }

    data = await run_in_threadpool(_issue)
    logger.info(
        "[im] 绑定码已生成（Settings 面）"
        f"{'，已解绑原 open_id' if data['unbound_from'] else ''}"
    )
    return success_envelope(data, request=request)


@router.get("/approvals")
async def im_approvals(
    request: Request,
    _: None = Depends(verify_cf_access),
    chat_db: "ChatDb" = Depends(get_chat_db),
    limit: int = _APPROVALS_DEFAULT_LIMIT,
) -> Any:
    """飞书会话里发生过的**人工审批决定**（最近 N 条）。

    🔴 语义是「``origin='im'`` 会话里的审批决定」，**不是**「点击发生在飞书」——
    gateway 对桌面卡与飞书卡写的是同一个 ``approval_status``，DB 层分不出点击来自
    哪一侧（见 ``ChatDb.list_im_approvals`` 的红字）。UI 文案照此写。

    ``available=false`` = 账本读不到（ai_chat.db 不存在 / 表未初始化 / 锁），**不是**
    「零条」—— 把不可达渲染成 0 就是谎报（镜像 ``count_auto_whitelist_writes`` 的
    None-vs-空 纪律）。
    """
    n = max(1, min(int(limit or _APPROVALS_DEFAULT_LIMIT), _APPROVALS_MAX_LIMIT))
    rows: Optional[list] = await run_in_threadpool(chat_db.list_im_approvals, n)
    return success_envelope(
        {"available": rows is not None, "items": rows or []},
        request=request,
        meta_extra={"limit": n, "count": len(rows or [])},
    )

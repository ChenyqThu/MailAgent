"""KOS availability, doctor, read-only tool passthrough, and save-to-KOS routes."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.chat.kos_save import SaveConversationError
from src.kos.client import KOSClient, KOSError

router = APIRouter()


def _chat_facade():
    from src.api.routers import chat as m

    return m


@router.get("/kos-available", dependencies=[Depends(verify_cf_access)])
async def kos_available(request: Request):
    """KOS 可用性（OAuth 凭据齐全）。镜像 chat:kosAvailable → boolean。"""
    return success_envelope(_chat_facade()._kos_available(), request=request, source="sqlite")


@router.post("/kos-doctor", dependencies=[Depends(verify_cf_access)])
async def kos_doctor(request: Request):
    """KOS 连接检查（issue #54）：分步 凭据→health→token→list_pages，逐步 ok/fail+detail。

    data = ``[{status:'ok'|'fail', check, detail}]``（形状对齐 notion-agent doctor）。
    凭据热读 .env（对齐 chat_config 的 _kos_cred：.env 显式存在即以 .env 为准——用户刚
    在 Settings 保存/清空的凭据立即生效），并用热读值新建 KOSClient —— 不用 kos-call 的
    _get_kos_client 单例（其凭据在首次构造时固化 + token cache 会掩盖凭据失效）。
    分步逻辑在 src/kos/doctor.py（client 可注入，单测 stub）。
    """
    from src.kos.doctor import KOS_CRED_KEYS, run_kos_doctor

    env_vals: Dict[str, Any] = {}
    try:
        env_path = _chat_facade().get_env_file_path()
        if env_path:
            env_vals = _chat_facade().dotenv_values(env_path) or {}
    except Exception:  # noqa: BLE001 — best-effort; 回退 os.environ
        env_vals = {}

    def _cred(k: str) -> str:
        return _chat_facade()._read_hot_env_cred(env_vals, k)

    creds = {k: _cred(k) for k in KOS_CRED_KEYS}
    missing = [k for k in KOS_CRED_KEYS if not creds[k]]
    consumer_enabled = _chat_facade()._hot_bool(
        env_vals, "MAILAGENT_KOS_CONSUMER_ENABLED", _chat_facade().get_settings().kos_consumer_enabled
    )
    client = KOSClient(
        base_url=creds["KOS_MCP_BASE"] or None,
        client_id=creds["KOS_OAUTH_CLIENT_ID"] or None,
        client_secret=creds["KOS_OAUTH_CLIENT_SECRET"] or None,
    )
    checks = await run_in_threadpool(
        run_kos_doctor, client, missing_keys=missing, consumer_enabled=consumer_enabled
    )
    return success_envelope(
        checks, request=request, source="kos", meta_extra={"count": len(checks)}
    )




@router.post("/kos-call", dependencies=[Depends(verify_cf_access)])
async def kos_call(request: Request):
    """KOS 只读工具代理（3b-4）：``{name, args}`` → KOSClient.call_tool → caller-friendly value。

    **只读白名单端点**：``name`` 必须命中 ``_KOS_READ_TOOL_ALLOWLIST``（gateway 的 6 个只读
    KOS 工具，issue #57：query / search / get_page / find_experts / list_pages /
    get_backlinks），否则 E_KOS_TOOL_NOT_ALLOWED(403)。**写工具（put_page / delete_page /
    extract_facts / …）与 skill 发现（list_skills / get_skill / recall）都不放行** —— OAuth
    client 本身是 read+write scope，只读边界必须由服务端结构性保证，不能只靠"gateway 没注册"。
    （chat 一键存档走 /save-to-kos 的专用 put_page 路径，不经本端点。）data = call_tool 返回
    （list/dict/str）。KOS 不可达 → KOSError 转 502 envelope（code=E_KOS_*，前端工具 duck-type
    读 code → LLM fallback 本地 FTS5）。
    """
    try:
        payload = await request.json()
    except Exception:
        raise APIError("E_INVALID_ARG", "kos-call body must be JSON")
    if not isinstance(payload, dict):
        raise APIError("E_INVALID_ARG", "kos-call body must be a JSON object")
    name = payload.get("name")
    args = payload.get("args")
    if not isinstance(name, str) or not name:
        raise APIError("E_INVALID_ARG", "kos-call requires name:str")
    if name not in _chat_facade()._KOS_READ_TOOL_ALLOWLIST:
        raise APIError(
            "E_KOS_TOOL_NOT_ALLOWED",
            f"kos-call refuses '{name}': only KOS read tools may be proxied",
            hint="allowed: " + ", ".join(sorted(_chat_facade()._KOS_READ_TOOL_ALLOWLIST)),
            http_status=403,
            source="kos",
        )
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise APIError("E_INVALID_ARG", "kos-call requires args:object")
    try:
        result = await run_in_threadpool(_chat_facade()._get_kos_client().call_tool, name, args)
    except KOSError as e:
        raise APIError(e.code, str(e), http_status=502)
    return success_envelope(result, request=request, source="kos")


@router.post("/save-to-kos", dependencies=[Depends(verify_cf_access)])
async def save_to_kos(request: Request, body: Optional[Dict[str, Any]] = None):
    """chat 一键保存对话到 KOS（3b-4）：复刻 kos_save.ts（读 chat_db + summarize LLM + put_page）。

    body = SaveConversationInput ``{messageId, slug?, title?}``。data = {slug, status, contentBytes}。
    summarize LLM 失败非致命（fallback raw transcript）；校验 / KOS 错误 → 对应 status envelope
    （E_NOT_FOUND→404 / E_INVALID_ARG→400 / E_KOS_*→502）。 """
    opts = body or {}
    message_id = opts.get("messageId")
    if not isinstance(message_id, int) or isinstance(message_id, bool) or message_id < 0:
        raise APIError("E_INVALID_ARG", "save-to-kos requires messageId:int (non-negative)")
    slug = opts.get("slug")
    title = opts.get("title")
    cfg = _chat_facade().get_settings()
    # saved_at（动态；frontmatter saved_at 行，非字节对齐字段）。ISO 8601 + 真实毫秒 + Z
    # （仿 TS new Date().toISOString()，codex review NIT）。
    _now = datetime.now(timezone.utc)
    saved_at_iso = _now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{_now.microsecond // 1000:03d}Z"
    try:
        result = await run_in_threadpool(
            _chat_facade().save_conversation_to_kos,
            chat_db=_chat_facade().get_chat_db(),
            kos_client=_chat_facade()._get_kos_client(),
            message_id=message_id,
            slug=slug if isinstance(slug, str) and slug else None,
            title=title if isinstance(title, str) and title else None,
            sync_db_path=cfg.sync_store_db_path,
            saved_at_iso=saved_at_iso,
            llm_api_key=(cfg.llm_api_key or "").strip(),
            llm_api_base=(cfg.llm_api_base or ""),
            llm_model=(cfg.llm_model or ""),
        )
    except SaveConversationError as e:
        if e.code == "E_NOT_FOUND":
            status = 404
        elif e.code == "E_INVALID_ARG":
            status = 400
        else:
            status = 502
        raise APIError(e.code, str(e), http_status=status)
    return success_envelope(result, request=request, source="kos")


# ── mem0 端点（M1/M2/M3 — auto-capture / search / compile-user-md）────────────

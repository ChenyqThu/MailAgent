"""Profile docs, assistant identity, and matter web-face routes for /api/agent."""

from __future__ import annotations

import json
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Request

from src.agent_config.store import (
    CONTACT_AGENT_DOC_NAME,
    CONTACT_ORG_FRAME_DOC_NAME,
    MATTER_AGENT_DOC_NAME,
    MEMORY_DOC_NAME,
    STORABLE_DOC_NAMES,
    get_agent_config_store,
)
from src.agent_config.projections import skills_doc_projection
from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access

from loguru import logger

router = APIRouter()

_MATTER_WEB_FACE_KEY = "matter_run_web_face"


def _agent_consts():
    from src.api.routers import agent as m

    return m


_DOC_ORDER = list(STORABLE_DOC_NAMES) + ["skills"]


def _editable_doc_dict(doc: Any) -> dict[str, Any]:
    return {
        "docName": doc.doc_name,
        "content": doc.content,
        "contentHash": doc.content_hash,
        "updatedBy": doc.updated_by,
        "updatedAt": doc.updated_at,
        "editable": True,
    }


def _editable_doc_with_default(name: str, doc: Any) -> dict[str, Any]:
    payload = _editable_doc_dict(doc)
    if name == MATTER_AGENT_DOC_NAME:
        from src.matters.run_spec import default_task_contract

        payload["defaultContent"] = default_task_contract()
    elif name == CONTACT_AGENT_DOC_NAME:
        from src.contacts.governance import default_governance_prompt

        payload["defaultContent"] = default_governance_prompt()
    return payload


def _projection_doc_dict(doc_name: str, content: str) -> dict[str, Any]:
    return {
        "docName": doc_name,
        "content": content,
        "contentHash": None,
        "updatedBy": "projection",
        "updatedAt": None,
        "editable": False,
    }


def _memory_budget() -> int:
    """memory.md 硬字符预算（config.memory_md_budget_chars，默认 5000）。lazy import 守
    chat.py 同款 lazy-config 纪律（裸 worktree / CI import self-check 不炸）。"""
    from src.config import config as cfg

    return cfg.memory_md_budget_chars


def _memory_doc_dict(doc: Any) -> dict[str, Any]:
    """memory.md doc dict = 可编辑 doc + ``budgetChars``（恒注入预算，前端显著显示长度/占比）
    + 已分层时的 ``layers``（阶段 0.5-③ PR-2：每层 chars/budget，Settings 分层预算条）。

    ``layers`` 判据是**文档结构**（``memory_layer_stats`` → ``has_layer_structure``）而非 flag：
    未分层（flag 从没开过 / 老文档）→ 该键缺席，前端退回单条总预算条（现状）。
    🔴 PUT 仍只校**总**预算（``write_profile_doc``）—— 分层信息是展示，不是新的校验闸：逐节报错
    会把手编用户堵死在一份自动维护的文档上。lazy import 守 chat.py 同款 lazy-config 纪律。"""
    from src.memory.memory_md import memory_layer_stats

    d = _editable_doc_dict(doc)
    budget = _memory_budget()
    d["budgetChars"] = budget
    layers = memory_layer_stats(doc.content, budget)
    if layers is not None:
        d["layers"] = layers
    return d


def _skills_projection() -> str:
    """SKILLS.md 投影（manifest skills，PR3 后含 installed）。best-effort：失败 → 空占位。"""
    try:
        from src.skills.registry import build_manifest

        return skills_doc_projection(build_manifest(None).skills)
    except Exception:  # noqa: BLE001 — projection best-effort
        return skills_doc_projection([])


@router.get("/profile/docs", dependencies=[Depends(verify_cf_access)])
async def list_profile_docs(request: Request):
    """列出全部文档：4 份可信身份 + memory.md（可编辑，带预算，seed-on-read）+ SKILLS 投影。"""
    store = get_agent_config_store()
    docs = [_editable_doc_dict(d) for d in store.list_profile_docs()]  # soul/agent/rules/user
    docs.append(_memory_doc_dict(store.get_profile_doc(MEMORY_DOC_NAME)))
    docs.append(_projection_doc_dict("skills", _skills_projection()))
    return success_envelope({"docs": docs}, request=request, source="sqlite",
                            meta_extra={"count": len(docs)})


@router.get("/profile/docs/{name}", dependencies=[Depends(verify_cf_access)])
async def get_profile_doc(name: str, request: Request):
    """读单个文档。skills → 投影；soul/agent/rules/user/memory → store（seed-on-read）。"""
    if name == "skills":
        return success_envelope(_projection_doc_dict("skills", _skills_projection()),
                                request=request, source="sqlite")
    if name not in STORABLE_DOC_NAMES:
        raise APIError(
            "E_NOT_FOUND",
            f"unknown profile doc: {name} (expected one of {_DOC_ORDER})",
            http_status=404,
            source="sqlite",
        )
    doc = get_agent_config_store().get_profile_doc(name)
    if name == MEMORY_DOC_NAME:
        return success_envelope(_memory_doc_dict(doc), request=request, source="sqlite")
    return success_envelope(
        _editable_doc_with_default(name, doc), request=request, source="sqlite"
    )


@router.get("/profile/history", dependencies=[Depends(verify_cf_access)])
async def list_profile_history(
    request: Request,
    doc_name: Optional[str] = Query(None, alias="docName"),
    limit: int = Query(50, ge=1, le=500),
):
    """profile 文档版本历史（DESC，可按 docName 过滤）。供 rollback / 审计。"""
    if doc_name is not None and doc_name not in STORABLE_DOC_NAMES:
        raise APIError(
            "E_INVALID_ARG",
            f"docName must be one of {list(STORABLE_DOC_NAMES)}",
            http_status=400,
            source="sqlite",
        )
    entries = get_agent_config_store().list_profile_history(doc_name, limit=limit)
    data = [
        {
            "id": e.id,
            "docName": e.doc_name,
            "oldHash": e.old_hash,
            "newHash": e.new_hash,
            "changedBy": e.changed_by,
            "sessionId": e.session_id,
            "messageId": e.message_id,
            "createdAt": e.created_at,
        }
        for e in entries
    ]
    return success_envelope({"history": data}, request=request, source="sqlite",
                            meta_extra={"count": len(data)})


# ── profile 写（PR6 —— agent/用户经确认编辑 SOUL/AGENT/RULES/USER + rollback）──────────


@router.post("/profile/docs/{name}", dependencies=[Depends(verify_cf_access)])
async def write_profile_doc(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    """覆盖一个可编辑文档（SOUL/AGENT/RULES/USER/memory）。RULES.md 过 validator（deny-list
    拦截露骨的安全颠覆指令）；memory.md 过硬字符预算（恒注入每轮 prompt，拒超预算防撑爆）。
    body = {content, updatedBy?, sessionId?, messageId?}。"""
    if name not in STORABLE_DOC_NAMES:
        raise APIError("E_NOT_FOUND", f"unknown or non-editable profile doc: {name}",
                       http_status=404, source="sqlite")
    raw = body or {}
    content = raw.get("content")
    if not isinstance(content, str):
        raise APIError("E_INVALID_ARG", "body.content must be a string",
                       http_status=400, source="sqlite")
    # 身份文档为空会让恒注入的 prompt 缺一段，所以拒空；但 matter_agent 相反 ——
    # 空内容**就是**「恢复默认」的表示法（run_spec 回落代码里的任务契约），
    # 拒空等于把「恢复默认」这个动作从 API 上抹掉。
    if not content.strip() and name not in {
        MATTER_AGENT_DOC_NAME,
        CONTACT_AGENT_DOC_NAME,
        CONTACT_ORG_FRAME_DOC_NAME,
    }:
        raise APIError("E_INVALID_ARG", "body.content must be a non-empty string",
                       http_status=400, source="sqlite")
    updated_by = raw.get("updatedBy") if raw.get("updatedBy") in ("user", "agent_proposed") else "user"
    if name == "rules":
        # 安全 floor 结构上不可弱化（前端 prepend PRODUCT_SAFETY_FLOOR）；validator 是
        # belt-and-suspenders，拦截把「忽略前文 / 绕过确认」写进 RULES 的露骨尝试。
        from src.agent_config.validator import validate_rules_content

        reason = validate_rules_content(content)
        if reason:
            raise APIError("E_INVALID_ARG", reason, http_status=400, source="sqlite")
    elif name == MEMORY_DOC_NAME:
        # memory.md 恒注入每轮 system prompt（MEMORY fence）→ enforce 硬字符预算，防用户粘贴
        # 巨文撑爆每轮 prompt。非 RULES → **不**套 validate_rules_content（那是身份约束校验）；
        # memory 作 untrusted 背景注入、结构上无法弱化 PRODUCT_SAFETY_FLOOR。
        budget = _memory_budget()
        if len(content) > budget:
            raise APIError(
                "E_INVALID_ARG",
                f"memory.md exceeds the {budget}-character budget (got {len(content)}); "
                "trim it before saving",
                http_status=400, source="sqlite",
            )
    doc = get_agent_config_store().set_profile_doc(
        name, content, updated_by=updated_by,
        session_id=raw.get("sessionId"), message_id=raw.get("messageId"),
    )
    if name == MEMORY_DOC_NAME:
        return success_envelope(_memory_doc_dict(doc), request=request, source="sqlite")
    return success_envelope(
        _editable_doc_with_default(name, doc), request=request, source="sqlite"
    )


@router.post("/profile/docs/{name}/rollback", dependencies=[Depends(verify_cf_access)])
async def rollback_profile_doc(name: str, request: Request, body: Optional[dict[str, Any]] = None):
    """把文档回滚到某历史版本（按 targetHash 定位 content_snapshot）。body = {targetHash, updatedBy?}。

    回滚**不**重复 budget 校验：历史快照落库时已在预算内（capture 截断 / 写端点 guard），恢复
    已知良好版本是显式用户操作；即便后来调小了预算，也允许恢复历史（下轮 capture 会自动再压回）。
    RULES 例外（S1 R2）：目标快照仍过 validate_rules_content（store 层），拒把越权版本回滚复活。"""
    if name not in STORABLE_DOC_NAMES:
        raise APIError("E_NOT_FOUND", f"unknown or non-editable profile doc: {name}",
                       http_status=404, source="sqlite")
    raw = body or {}
    target = raw.get("targetHash")
    if not isinstance(target, str) or not target:
        raise APIError("E_INVALID_ARG", "body.targetHash is required", http_status=400, source="sqlite")
    updated_by = raw.get("updatedBy") if raw.get("updatedBy") in ("user", "agent_proposed") else "user"
    try:
        doc = get_agent_config_store().rollback_profile_doc(
            name, target, updated_by=updated_by, session_id=raw.get("sessionId")
        )
    except KeyError as exc:
        raise APIError("E_NOT_FOUND", str(exc), http_status=404, source="sqlite") from exc
    except ValueError as exc:
        # S1 R2 — RULES 回滚目标含越权指令（store 层 validate_rules_content 拒）→ 400。
        raise APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite") from exc
    if name == MEMORY_DOC_NAME:
        return success_envelope(_memory_doc_dict(doc), request=request, source="sqlite")
    return success_envelope(
        _editable_doc_with_default(name, doc), request=request, source="sqlite"
    )



_ASSISTANT_IDENTITY_KEY = "assistant_identity"
ASSISTANT_NAME_MAX_CHARS = 40


def _normalize_assistant_avatar(avatar: Any) -> Optional[dict[str, Any]]:
    """assistant 头像校验：None / bot / image 三态（legacy oreo 不适用——主 agent 无存量行）。
    越域一律 ValueError（调用方折 400）。"""
    from src.reports.wire import (
        BOT_AVATAR_COLORS,
        BOT_AVATAR_SHAPES,
        _normalize_avatar_image,
    )

    if avatar is None:
        return None
    if not isinstance(avatar, dict):
        raise ValueError("avatar must be an object or null")
    if avatar.get("type") == "image":
        return _normalize_avatar_image(avatar)
    if avatar.get("type") == "bot":
        shape = avatar.get("shape")
        color = avatar.get("color")
        if shape not in BOT_AVATAR_SHAPES:
            raise ValueError("avatar.shape must be a supported bot shape")
        if color not in BOT_AVATAR_COLORS:
            raise ValueError("avatar.color must be a supported bot color")
        if set(avatar) != {"type", "shape", "color"}:
            raise ValueError("avatar with type=bot accepts only keys: type, shape, color")
        return {"type": "bot", "shape": shape, "color": color}
    raise ValueError("avatar.type must be 'bot' or 'image'")


def _read_assistant_identity() -> dict[str, Any]:
    """缺行/坏 JSON/坏形状 → 默认 {name: None, avatar: None}（显示型数据 fail-open 到默认脸）。"""
    raw = get_agent_config_store().get_owner_setting(_ASSISTANT_IDENTITY_KEY)
    default: dict[str, Any] = {"name": None, "avatar": None}
    if not raw:
        return default
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return default
    if not isinstance(parsed, dict):
        return default
    name = parsed.get("name")
    avatar = parsed.get("avatar")
    return {
        "name": name if isinstance(name, str) and name.strip() else None,
        "avatar": avatar if isinstance(avatar, dict) else None,
    }


@router.get("/assistant-identity", dependencies=[Depends(verify_cf_access)])
async def get_assistant_identity(request: Request):
    """读主 agent 身份（名字 + 头像）。"""
    return success_envelope(_read_assistant_identity(), request=request, source="sqlite")


@router.put("/assistant-identity", dependencies=[Depends(verify_cf_access)])
async def set_assistant_identity(request: Request, body: Optional[dict[str, Any]] = None):
    """写主 agent 身份（全量替换）。body = {name: str|null, avatar: dict|null}；
    name 去首尾空白、空串折 null、超长 400；avatar 越域 400（校验同 report agent）。"""
    payload = body or {}
    name = payload.get("name")
    if name is not None and not isinstance(name, str):
        raise APIError(
            "E_INVALID_ARG", "name must be a string or null", http_status=400, source="sqlite"
        )
    normalized_name: Optional[str] = None
    if isinstance(name, str):
        stripped = name.strip()
        if len(stripped) > ASSISTANT_NAME_MAX_CHARS:
            raise APIError(
                "E_INVALID_ARG",
                f"name must be <= {ASSISTANT_NAME_MAX_CHARS} chars",
                http_status=400,
                source="sqlite",
            )
        normalized_name = stripped or None
    try:
        normalized_avatar = _normalize_assistant_avatar(payload.get("avatar"))
    except ValueError as exc:
        raise APIError("E_INVALID_ARG", str(exc), http_status=400, source="sqlite") from exc

    identity = {"name": normalized_name, "avatar": normalized_avatar}
    get_agent_config_store().set_owner_setting(
        _ASSISTANT_IDENTITY_KEY, json.dumps(identity, ensure_ascii=False)
    )
    logger.info(
        f"assistant identity updated: name={normalized_name!r} "
        f"avatar={'set' if normalized_avatar else 'default'} (owner UI)"
    )
    return success_envelope(identity, request=request, source="sqlite")


@router.get("/matter-web-face", dependencies=[Depends(verify_cf_access)])
async def get_matter_web_face(request: Request):
    """读跟进 run 的网页检索档。缺行/脏值 → 'keep'（= gateway 侧同一个默认值）。"""
    raw = get_agent_config_store().get_owner_setting(_MATTER_WEB_FACE_KEY)
    mode = raw if raw in _agent_consts().MATTER_RUN_WEB_FACES else _agent_consts().MATTER_RUN_WEB_FACE_DEFAULT
    return success_envelope({"mode": mode}, request=request, source="sqlite")


@router.put("/matter-web-face", dependencies=[Depends(verify_cf_access)])
async def set_matter_web_face(request: Request, body: Optional[dict[str, Any]] = None):
    """写跟进 run 的网页检索档；仅 owner UI 可达，越域值一律 400（绝不静默回落 —— 见上方
    常量处的说明：UI 显示的档与实际生效的档劈叉，比一个 400 危险得多）。"""
    mode = (body or {}).get("mode")
    if mode not in _agent_consts().MATTER_RUN_WEB_FACES:
        raise APIError(
            "E_INVALID_ARG",
            f"body.mode must be one of {_agent_consts().MATTER_RUN_WEB_FACES}",
            http_status=400,
            source="sqlite",
        )
    store = get_agent_config_store()
    previous = store.get_owner_setting(_MATTER_WEB_FACE_KEY) or _agent_consts().MATTER_RUN_WEB_FACE_DEFAULT
    store.set_owner_setting(_MATTER_WEB_FACE_KEY, mode)
    logger.info(f"matter run web face switched: {previous} → {mode} (owner UI)")
    return success_envelope({"mode": mode}, request=request, source="sqlite")


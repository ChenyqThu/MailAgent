"""Contact Profile WP6：证据拼装、LLM 生成、批处理与 dream worker。"""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Optional

from jsonschema import ValidationError, validate
from loguru import logger

from src.agents.fence import fence_email_envelope, fence_untrusted, sanitize_untrusted
from src.config import config as app_config
from src.contacts import governance
from src.contacts import service as contact_service
from src.contacts.org_frame import (
    OrgFrame,
    department_in_frame,
    load_org_frame,
    normalize_department_path,
    render_org_frame,
)
from src.contacts.profile_config import (
    ContactProfileAgentConfig,
    get_contact_profile_agent_config,
)
from src.contacts.profile_prompts import (
    PROFILE_TOOL_NAME,
    PROFILE_TOOL_SCHEMA,
    build_profile_system_prompt,
)
from src.contacts.repository import ContactRepository
from src.contacts.taxonomy import CONTACT_KIND_PERSON, strip_evidence_refs
from src.llm_agent.client import LLMCallError, LLMClient
from src.kos.client import KOSClient
from src.repository.email_repository import EmailRepository

PROFILE_MIN = 50
PROFILE_INCREMENTAL_MIN = 10
PROFILE_REFRESH_DAYS = 30
PROFILE_EVIDENCE_MAIL_LIMIT = 20
PROFILE_EVIDENCE_CHAR_BUDGET = 40_000
PROFILE_KOS_REFERENCE_CHAR_BUDGET = 3_000
PROFILE_KOS_TIMEOUT_SECONDS = 5.0
PROFILE_G1_MIN_CHARS = 200
PROFILE_SUMMARY_LIST_MAX = 120
PROFILE_LAST_FIRE_KEY = "contact_profile_last_fire"
PROFILE_TICK_INTERVAL_SEC = 60


@dataclass
class ProfileEvidence:
    mode: str
    user_content: str
    mail_count: int
    substantive_chars: int
    first_internal_id: Optional[int]
    last_internal_id: Optional[int]
    internal_ids: tuple[int, ...] = ()


def _json_dict(raw: Any) -> Dict[str, Any]:
    try:
        value = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _previous_watermark(profile: Dict[str, Any]) -> Optional[int]:
    window = profile.get("evidence_window")
    if not isinstance(window, dict):
        return None
    value = window.get("to")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _kos_reference(
    *,
    display_name: str,
    primary_email: str,
    client: Optional[KOSClient] = None,
) -> str:
    kos = client or KOSClient(timeout_seconds=PROFILE_KOS_TIMEOUT_SECONDS)
    if not kos.configured:
        logger.debug("[contact-profile] KOS reference skipped: not configured")
        return ""
    query = " ".join(part for part in (display_name.strip(), primary_email.strip()) if part)
    if not query:
        logger.debug("[contact-profile] KOS reference skipped: empty identity query")
        return ""
    try:
        hits = kos.query(query, limit=5)
    except Exception as exc:  # noqa: BLE001 — KOS is optional background; profile must fail-open
        logger.debug(f"[contact-profile] KOS reference skipped: {exc}")
        return ""
    compact_hits = [
        {
            key: hit.get(key)
            for key in ("title", "slug", "chunk_text", "effective_date", "updated_at")
            if hit.get(key) not in (None, "")
        }
        for hit in hits
        if isinstance(hit, dict)
    ]
    if not compact_hits:
        return ""
    content = sanitize_untrusted(
        json.dumps(compact_hits, ensure_ascii=False, separators=(",", ":"))
    )
    if len(content) > PROFILE_KOS_REFERENCE_CHAR_BUDGET:
        marker = "…[truncated]"
        content = content[: PROFILE_KOS_REFERENCE_CHAR_BUDGET - len(marker)] + marker
    return fence_untrusted("KOS_REFERENCE", content)


def build_profile_evidence(
    conn: sqlite3.Connection,
    *,
    contact_id: int,
    db_path: str,
    user_email: str = "",
    self_emails: str = "",
    email_repo: Optional[EmailRepository] = None,
    full_refresh: bool = False,
    use_kos: bool = False,
    kos_client: Optional[KOSClient] = None,
) -> ProfileEvidence:
    """拼 first/incremental 两区证据；incremental 以旧 evidence_window.to 为水位。"""
    row = contact_service._require_contact(conn, contact_id)
    primary_email_row = conn.execute(
        "SELECT email_normalized FROM contact_email WHERE contact_id=? "
        "ORDER BY is_primary DESC, id ASC LIMIT 1",
        (contact_id,),
    ).fetchone()
    primary_email = str(primary_email_row[0]) if primary_email_row else ""
    existing_profile = _json_dict(row["profile_json"])
    mode = "incremental" if existing_profile and not full_refresh else "first"
    min_internal_id = _previous_watermark(existing_profile) if mode == "incremental" else None
    self_addresses = contact_service.resolve_self_addresses(
        conn, user_email=user_email, extra_raw=self_emails
    )
    authored_page = contact_service.list_contact_mail_rows(
        conn,
        contact_id,
        self_addresses=self_addresses,
        direction="from_them",
        limit=PROFILE_EVIDENCE_MAIL_LIMIT,
        min_internal_id=min_internal_id,
    )
    authored_rows = list(authored_page["rows"])
    rows = authored_rows
    if len(rows) < PROFILE_EVIDENCE_MAIL_LIMIT:
        all_page = contact_service.list_contact_mail_rows(
            conn,
            contact_id,
            self_addresses=self_addresses,
            limit=PROFILE_EVIDENCE_MAIL_LIMIT * 2,
            min_internal_id=min_internal_id,
        )
        selected_ids = {int(mail["internal_id"]) for mail in rows}
        for mail in all_page["rows"]:
            internal_id = int(mail["internal_id"])
            if internal_id in selected_ids:
                continue
            rows.append(mail)
            selected_ids.add(internal_id)
            if len(rows) >= PROFILE_EVIDENCE_MAIL_LIMIT:
                break
    per_mail_budget = PROFILE_EVIDENCE_CHAR_BUDGET // PROFILE_EVIDENCE_MAIL_LIMIT
    repo = email_repo or EmailRepository(db_path)
    envelopes: list[str] = []
    ids: list[int] = []
    substantive_chars = 0
    for mail in rows:
        internal_id = int(mail["internal_id"])
        subject = str(mail["subject"] or "")
        body = repo.get_body_markdown(internal_id, max_chars=per_mail_budget)
        if body is not None and len(body) >= per_mail_budget:
            marker = "…[truncated]"
            body = body[: max(0, per_mail_budget - len(marker))] + marker
        substantive_chars += len(subject) + len(body or "")
        envelopes.append(
            fence_email_envelope(
                internal_id=internal_id,
                subject=subject,
                sender=mail["sender"],
                date=mail["date_received"],
                body_markdown=body,
            )
        )
        ids.append(internal_id)

    sections: list[str] = []
    if use_kos:
        reference = _kos_reference(
            display_name=str(row["display_name"] or ""),
            primary_email=primary_email,
            client=kos_client,
        )
        if reference:
            sections.append("KOS REFERENCE (BACKGROUND ONLY; DO NOT CITE):\n" + reference)
    if mode == "incremental":
        sections.append(
            "EXISTING PROFILE (BACKGROUND ONLY; DO NOT CITE):\n"
            + json.dumps(existing_profile, ensure_ascii=False, sort_keys=True)
        )
    sections.append(
        "NEW EMAIL EVIDENCE (ONLY CITABLE REGION):\n" + "\n\n".join(envelopes)
    )
    return ProfileEvidence(
        mode=mode,
        user_content="\n\n".join(sections),
        mail_count=len(rows),
        substantive_chars=substantive_chars,
        first_internal_id=min(ids) if ids else None,
        last_internal_id=max(ids) if ids else None,
        internal_ids=tuple(ids),
    )


def _model_chain(cfg: ContactProfileAgentConfig) -> Optional[list[str]]:
    if cfg.fallback_models is not None:
        fallbacks = cfg.fallback_models
    else:
        fallbacks = [
            item.strip()
            for item in (app_config.llm_fallback_models or "").split(",")
            if item.strip()
        ]
    return (
        None
        if (not cfg.model and cfg.fallback_models is None)
        else [cfg.model or app_config.llm_model, *fallbacks]
    )


def _validate_payload(payload: Dict[str, Any], evidence: ProfileEvidence) -> Dict[str, Any]:
    validate(instance=payload, schema=PROFILE_TOOL_SCHEMA["input_schema"])
    if payload.get("skip") is True:
        reason_value = payload.get("reason")
        reason = (
            reason_value.strip()
            if isinstance(reason_value, str) and reason_value.strip()
            else "insufficient evidence"
        )
        return {"skip": True, "reason": reason[:500]}
    required_profile_keys = (
        "summary",
        "role_title",
        "formal_name",
        "department",
        "topics",
        "projects",
        "communication_style",
        "contact_info",
        "evolution",
        "contradictions",
        "evidence_window",
    )
    missing_keys = [key for key in required_profile_keys if key not in payload]
    if missing_keys:
        raise ValidationError(
            "non-skip profile is missing required fields: " + ", ".join(missing_keys)
        )
    if not str(payload.get("summary") or "").strip():
        raise ValidationError("summary is required for a non-skip profile")
    normalized = dict(payload)
    normalized.pop("skip", None)
    # schema 允许非 skip 产出带 "reason": null；分支校验后该字段不入库。
    normalized.pop("reason", None)
    normalized["evidence_window"] = {
        "from": evidence.first_internal_id,
        "to": evidence.last_internal_id,
        "mail_count": evidence.mail_count,
        "mode": evidence.mode,
    }
    encoded = json.dumps(normalized, ensure_ascii=False)
    if len(encoded) > 100_000:
        raise ValidationError("profile JSON exceeds 100000 characters")
    return normalized


def _profile_identity_evidence(
    conn: sqlite3.Connection, evidence: ProfileEvidence
) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    internal_ids = evidence.internal_ids or tuple(
        internal_id
        for internal_id in (evidence.first_internal_id, evidence.last_internal_id)
        if internal_id is not None
    )
    for internal_id in dict.fromkeys(internal_ids):
        row = conn.execute(
            "SELECT m.message_id, m.subject, b.body_markdown "
            "FROM email_metadata m LEFT JOIN email_body b ON b.internal_id=m.internal_id "
            "WHERE m.internal_id=?",
            (internal_id,),
        ).fetchone()
        if row is None:
            continue
        message_id = str(row["message_id"] or "").strip()
        body = str(row["body_markdown"] or "")
        quote = next((line.strip() for line in body.splitlines() if line.strip()), "")
        if not quote:
            quote = str(row["subject"] or "").strip()
        if message_id and quote:
            items.append({"message_id": message_id, "quote": quote[:500]})
    return items


def _create_profile_identity_suggestions(
    conn: sqlite3.Connection,
    *,
    contact_id: int,
    payload: Dict[str, Any],
    evidence: ProfileEvidence,
    now_ms: int,
    org_frame: Optional[OrgFrame] = None,
) -> None:
    frame = org_frame if org_frame is not None else load_org_frame()
    row = contact_service._require_contact(conn, contact_id)
    locks = contact_service.parse_identity_locks(row["identity_locks_json"])
    evidence_items = _profile_identity_evidence(conn, evidence)
    suggestion_evidence = evidence_items[:3]
    for field in ("role_title", "department", "formal_name"):
        value = payload.get(field)
        normalized_value = strip_evidence_refs(str(value)) if value is not None else ""
        if field == "department":
            normalized_value = normalize_department_path(normalized_value)
            current_value = normalize_department_path(row[field])
        else:
            current_value = str(row[field] or "").strip()
        if (
            not normalized_value
            or field in locks
            or normalized_value.casefold() == current_value.casefold()
        ):
            continue
        if not suggestion_evidence:
            logger.warning(
                f"[contact-profile] contact={contact_id} identity suggestion skipped: "
                f"no usable email evidence for {field}"
            )
            continue
        try:
            governance.create_suggestion(
                conn,
                suggestion_type="identity",
                contact_ids=[contact_id],
                payload={"field": field, "value": normalized_value},
                evidence=suggestion_evidence,
                now_ms=now_ms,
                org_frame=frame,
            )
        except Exception as exc:
            logger.warning(
                f"[contact-profile] contact={contact_id} identity suggestion failed "
                f"for {field}: {exc}"
            )


def _anchor_tokens(value: Any) -> set[str]:
    return {
        token
        for token in re.findall(r"[^\W_]+", str(value or "").casefold())
        if len(token) >= 2
    }


def _profile_matches_contact(
    payload: Dict[str, Any], row: sqlite3.Row, email_anchors: list[str]
) -> bool:
    profiled_name = payload.get("formal_name")
    if profiled_name is None or not str(profiled_name).strip():
        return True
    profiled_tokens = _anchor_tokens(profiled_name)
    signals = _anchor_tokens(row["display_name"]) | _anchor_tokens(row["formal_name"])
    for email in email_anchors:
        localpart = str(email).partition("@")[0].casefold()
        if len(localpart) >= 2:
            signals.add(localpart)
    return any(
        left == right or left in right or right in left
        for left in profiled_tokens
        for right in signals
    )


def _publish_contact_changed(contact_id: int, *, scope: str) -> None:
    """画像态落库后广播 ``contact.changed``（perf-sse-realtime R1-3）。

    🔴 只在**事务提交后**调（与 ``matter.changed`` 同纪律 —— 事件先到、DB 后提交
    会让前端 refetch 读到旧值）。lossy 总线, 吞错; 前端失效
    ``['contacts','list']`` 前缀 + ``['contacts','detail',id]``。
    """
    try:
        from src.events.publisher import safe_publish
        safe_publish(
            "contact.changed",
            data={"scope": scope, "contact_ids": [int(contact_id)]},
            source="contact-profile",
        )
    except Exception:
        pass


def _finish_skipped(
    db_path: str, contact_id: int, *, now_ms: int, reason: str, mail_count: int
) -> str:
    payload = json.dumps(
        {"reason": reason[:500], "mail_count": int(mail_count)}, ensure_ascii=False
    )
    with ContactRepository(db_path).transaction() as conn:
        row = contact_service._require_contact(conn, contact_id)
        if row["profile_json"] is not None:
            conn.execute(
                "UPDATE contact SET profile_status='ok', profile_attempted_at=?, "
                "profile_error=NULL, updated_at=? WHERE id=?",
                (now_ms, now_ms, contact_id),
            )
            logger.info(
                f"[contact-profile] contact={contact_id} kept existing profile after skip: {reason}"
            )
            result = "ok"
        else:
            conn.execute(
                "UPDATE contact SET profile_status='skipped', profile_attempted_at=?, "
                "profile_error=?, updated_at=? WHERE id=?",
                (now_ms, payload, now_ms, contact_id),
            )
            result = "skipped"
    # 提交后广播 (画像状态变化也要让打开中的 detail 面即时看到)。
    _publish_contact_changed(contact_id, scope="profile")
    return result


def _finish_failed(db_path: str, contact_id: int, *, now_ms: int, error: str) -> None:
    with ContactRepository(db_path).transaction() as conn:
        conn.execute(
            "UPDATE contact SET profile_status='failed', profile_attempted_at=?, "
            "profile_error=?, updated_at=? WHERE id=?",
            (now_ms, error[:1000], now_ms, contact_id),
        )
    _publish_contact_changed(contact_id, scope="profile")


def claim_profile_run(db_path: str, contact_id: int, *, now_ms: Optional[int] = None) -> bool:
    """原子置 running；墓碑拒绝，重复点击返回 False。hidden 有意允许手动生成。"""
    now_ms = now_ms or int(time.time() * 1000)
    with ContactRepository(db_path).transaction() as conn:
        row = contact_service._require_contact(conn, contact_id)
        if row["merged_into"] is not None:
            raise contact_service.ContactError(
                "E_CONTACT_MERGED", f"contact {contact_id} was merged"
            )
        if row["profile_status"] == "running":
            return False
        conn.execute(
            "UPDATE contact SET profile_status='running', profile_attempted_at=?, "
            "profile_error=NULL, updated_at=? WHERE id=?",
            (now_ms, now_ms, contact_id),
        )
    return True


async def generate_contact_profile(
    db_path: str,
    contact_id: int,
    *,
    cfg: Optional[ContactProfileAgentConfig] = None,
    client: Optional[LLMClient] = None,
    now_ms: Optional[int] = None,
    user_email: str = "",
    self_emails: str = "",
    full_refresh: bool = False,
) -> str:
    """生成一个画像；调用方已 claim running。所有失败 fail-closed 且不推进水位。"""
    now_ms = now_ms or int(time.time() * 1000)
    cfg = cfg or get_contact_profile_agent_config(db_path)
    org_frame = load_org_frame()
    try:
        conn = ContactRepository(db_path).connect()
        try:
            row = contact_service._require_contact(conn, contact_id)
            mail_count_snapshot = int(row["mail_count"] or 0)
            primary_email_row = conn.execute(
                "SELECT email_normalized FROM contact_email WHERE contact_id=? "
                "ORDER BY is_primary DESC, id ASC LIMIT 1",
                (contact_id,),
            ).fetchone()
            primary_email = str(primary_email_row[0]) if primary_email_row else ""
            email_anchors = [
                str(email_row[0])
                for email_row in conn.execute(
                    "SELECT email_normalized FROM contact_email WHERE contact_id=?",
                    (contact_id,),
                ).fetchall()
            ]
            evidence = build_profile_evidence(
                conn,
                contact_id=contact_id,
                db_path=db_path,
                user_email=user_email,
                self_emails=self_emails,
                full_refresh=full_refresh,
                use_kos=cfg.use_kos,
            )
        finally:
            conn.close()
        if evidence.substantive_chars < PROFILE_G1_MIN_CHARS:
            return _finish_skipped(
                db_path,
                contact_id,
                now_ms=now_ms,
                reason="pre-LLM evidence shorter than 200 characters",
                mail_count=evidence.mail_count,
            )

        own_client = client is None
        llm = client or LLMClient()
        try:
            result = await llm.classify(
                system_blocks=[
                    {
                        "type": "text",
                        "text": build_profile_system_prompt(
                            mode=evidence.mode,
                            target_display_name=str(row["display_name"] or ""),
                            target_primary_email=primary_email,
                            target_gender=str(row["gender"] or ""),
                            custom_prompt=cfg.prompt,
                            org_frame_text=render_org_frame(org_frame),
                        ),
                    }
                ],
                user_content=evidence.user_content,
                tool_schema=PROFILE_TOOL_SCHEMA,
                tool_name=PROFILE_TOOL_NAME,
                model_chain=_model_chain(cfg),
            )
        finally:
            if own_client:
                await llm.close()
        payload = _validate_payload(dict(result.tool_input or {}), evidence)
        if payload.get("skip") is True:
            return _finish_skipped(
                db_path,
                contact_id,
                now_ms=now_ms,
                reason=str(payload["reason"]),
                mail_count=evidence.mail_count,
            )
        if not _profile_matches_contact(payload, row, email_anchors):
            profiled_name = str(payload.get("formal_name") or "")[:500]
            error = json.dumps(
                {"reason": "anchor_mismatch", "profiled": profiled_name},
                ensure_ascii=False,
            )
            _finish_failed(db_path, contact_id, now_ms=now_ms, error=error)
            logger.warning(
                f"[contact-profile] contact={contact_id} anchor mismatch: {profiled_name}"
            )
            return "failed"
        encoded = json.dumps(payload, ensure_ascii=False)
        with ContactRepository(db_path).transaction() as conn:
            conn.execute(
                "UPDATE contact SET profile_json=?, profile_updated_at=?, "
                "profile_mail_count=?, profile_model=?, profile_status='ok', "
                "profile_attempted_at=?, profile_error=NULL, updated_at=? WHERE id=?",
                (
                    encoded,
                    now_ms,
                    mail_count_snapshot,
                    result.model,
                    now_ms,
                    now_ms,
                    contact_id,
                ),
            )
            try:
                _create_profile_identity_suggestions(
                    conn,
                    contact_id=contact_id,
                    payload=payload,
                    evidence=evidence,
                    now_ms=now_ms,
                    org_frame=org_frame,
                )
            except Exception as exc:
                logger.warning(
                    f"[contact-profile] contact={contact_id} identity suggestion stage "
                    f"failed: {exc}"
                )
        # 提交后广播: 画像生成完成, detail/list 即时刷新 (不等 3s 轮询)。
        _publish_contact_changed(contact_id, scope="profile")
        return "ok"
    except (LLMCallError, ValidationError, ValueError, TypeError, sqlite3.Error) as exc:
        _finish_failed(db_path, contact_id, now_ms=now_ms, error=str(exc))
        logger.warning(f"[contact-profile] contact={contact_id} failed: {exc}")
        return "failed"
    except Exception as exc:  # noqa: BLE001 — fail-closed at the contact boundary
        _finish_failed(db_path, contact_id, now_ms=now_ms, error=str(exc))
        logger.warning(f"[contact-profile] contact={contact_id} failed: {exc}")
        return "failed"


def select_profile_candidates(
    conn: sqlite3.Connection, *, now_ms: int, limit: int
) -> list[sqlite3.Row]:
    """自动准入与增量判据；kind 字面量来自 taxonomy 单源。"""
    refresh_before = now_ms - PROFILE_REFRESH_DAYS * 24 * 60 * 60 * 1000
    return conn.execute(
        "SELECT * FROM contact WHERE merged_into IS NULL AND hidden_at IS NULL "
        "AND kind = ? AND mail_count >= ? AND sent_to_count >= 1 AND ("
        "  profile_updated_at IS NULL "
        "  OR mail_count - COALESCE(profile_mail_count, 0) >= ? "
        "  OR (profile_updated_at <= ? AND last_seen_at > profile_updated_at)"
        ") ORDER BY CASE WHEN profile_updated_at IS NULL THEN 0 ELSE 1 END, "
        "COALESCE(profile_mail_count, 0) ASC, mail_count DESC, id ASC LIMIT ?",
        (
            CONTACT_KIND_PERSON,
            PROFILE_MIN,
            PROFILE_INCREMENTAL_MIN,
            refresh_before,
            limit,
        ),
    ).fetchall()


def clear_stale_running(conn: sqlite3.Connection, *, round_started_ms: int) -> int:
    cursor = conn.execute(
        "UPDATE contact SET profile_status='failed', "
        "profile_error='interrupted before completion', updated_at=? "
        "WHERE profile_status='running' AND profile_attempted_at < ?",
        (round_started_ms, round_started_ms),
    )
    return int(cursor.rowcount or 0)


async def run_profile_batch(
    *,
    db_path: str,
    cfg: ContactProfileAgentConfig,
    now_ms: Optional[int] = None,
    generate_fn: Callable[..., Any] = generate_contact_profile,
) -> Dict[str, int]:
    round_started_ms = now_ms or int(time.time() * 1000)
    repo = ContactRepository(db_path)
    with repo.transaction() as conn:
        clear_stale_running(conn, round_started_ms=round_started_ms)
        candidates = select_profile_candidates(
            conn, now_ms=round_started_ms, limit=cfg.daily_limit
        )
    stats = {"candidates": len(candidates), "ran": 0, "ok": 0, "skipped": 0, "failed": 0}
    for row in candidates:
        contact_id = int(row["id"])
        try:
            if not claim_profile_run(db_path, contact_id, now_ms=round_started_ms):
                continue
            stats["ran"] += 1
            status = await generate_fn(
                db_path, contact_id, cfg=cfg, now_ms=round_started_ms
            )
            stats[status] += 1
        except Exception as exc:  # noqa: BLE001 — one contact never aborts the batch
            stats["failed"] += 1
            _finish_failed(db_path, contact_id, now_ms=round_started_ms, error=str(exc))
    logger.info(
        "[contact-profile] batch candidates={} ran={} ok={} skip={} fail={}",
        stats["candidates"], stats["ran"], stats["ok"], stats["skipped"], stats["failed"],
    )
    return stats


def profile_slot_marker(now: datetime, fire_hour: int) -> str:
    return f"{now.strftime('%Y%m%d')}-{fire_hour:02d}"


def profile_due(now: datetime, fire_hour: int, last_marker: Optional[str]) -> bool:
    return now.hour >= fire_hour and last_marker != profile_slot_marker(now, fire_hour)


async def run_scheduled_tick(
    *,
    sync_store: Any,
    db_path: str,
    settings: Any = app_config,
    now: Optional[datetime] = None,
    run_batch_fn: Callable[..., Any] = run_profile_batch,
) -> bool:
    """一次热读 tick；行级 enabled 关闭时不跑画像。"""
    cfg = get_contact_profile_agent_config(db_path)
    if not cfg.row_exists or not cfg.enabled:
        return False
    now = now or datetime.now().astimezone()
    last_marker = sync_store.get_state(PROFILE_LAST_FIRE_KEY)
    if not profile_due(now, cfg.fire_hour, last_marker):
        return False
    marker = profile_slot_marker(now, cfg.fire_hour)
    try:
        await run_batch_fn(db_path=db_path, cfg=cfg, now_ms=int(now.timestamp() * 1000))
    finally:
        sync_store.set_state(PROFILE_LAST_FIRE_KEY, marker)
    return True


async def tick_loop(
    *,
    sync_store: Any,
    db_path: str,
    shutdown_event: Optional[asyncio.Event] = None,
    interval_sec: int = PROFILE_TICK_INTERVAL_SEC,
) -> None:
    while shutdown_event is None or not shutdown_event.is_set():
        try:
            await run_scheduled_tick(sync_store=sync_store, db_path=db_path)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[contact-profile] tick failed: {exc}")
        try:
            if shutdown_event is None:
                await asyncio.sleep(interval_sec)
            else:
                await asyncio.wait_for(shutdown_event.wait(), timeout=interval_sec)
                break
        except asyncio.TimeoutError:
            continue


def profile_summary_from_text(summary: Any) -> Optional[str]:
    """列表行摘要的**归一 + 截断单源**: 折叠所有空白成单空格, 再截 120 字符。

    列表 SQL 已改成 `json_extract(profile_json,'$.summary')` 直接取这一段, 但归一
    留在 Python: 「先折叠空白再截 N 字符」用 SQL 的 substr 复刻不出来 (substr 先截,
    折叠后长度就短于 N), 而截断长度是对外可见的文案语义。
    """
    text = str(summary or "").replace("\r", " ").replace("\n", " ")
    text = " ".join(text.split())
    if not text:
        return None
    return text[:PROFILE_SUMMARY_LIST_MAX]


def profile_feature_configured(conn: sqlite3.Connection, *, env_enabled: bool) -> bool:
    if not env_enabled:
        return False
    try:
        row = conn.execute(
            "SELECT enabled FROM report_agent WHERE id='contact_profile_agent'"
        ).fetchone()
    except sqlite3.Error:
        return False
    return bool(row and row[0])


def _skip_meta(raw_error: Any) -> tuple[Optional[str], Optional[int]]:
    data = _json_dict(raw_error)
    if not data:
        return (str(raw_error) if raw_error else None, None)
    reason = str(data.get("reason") or "") or None
    try:
        mail_count = int(data["mail_count"]) if data.get("mail_count") is not None else None
    except (TypeError, ValueError):
        mail_count = None
    return reason, mail_count


def profile_projection(
    row: sqlite3.Row,
    *,
    configured: bool,
    org_frame: Optional[OrgFrame] = None,
) -> Dict[str, Any]:
    frame = org_frame if org_frame is not None else load_org_frame()
    document = _json_dict(row["profile_json"])
    raw_status = row["profile_status"]
    if not configured:
        state = "unconfigured"
    elif raw_status in {"running", "failed", "skipped"}:
        state = raw_status
    elif document and raw_status == "ok":
        state = "ok"
    elif int(row["mail_count"] or 0) < PROFILE_MIN:
        state = "below_threshold"
    else:
        state = "pending_batch"

    locks = contact_service.parse_identity_locks(row["identity_locks_json"])
    ignored = document.get("ignored_suggestions")
    ignored_fields = {
        str(item) for item in ignored if isinstance(ignored, list) and isinstance(item, str)
    } if isinstance(ignored, list) else set()
    current_info = _json_dict(row["contact_info_json"])
    suggested_info = document.get("contact_info")
    suggestions: list[Dict[str, Any]] = []
    candidates = (
        ("formal_name", document.get("formal_name"), row["formal_name"]),
        ("department", document.get("department"), row["department"]),
        (
            "phone",
            suggested_info.get("phone") if isinstance(suggested_info, dict) else None,
            current_info.get("phone"),
        ),
    )
    for field, value, current in candidates:
        normalized = strip_evidence_refs(str(value)) if value is not None else ""
        if field == "department":
            normalized = normalize_department_path(normalized)
            current = normalize_department_path(current)
        if (
            not normalized
            or field in ignored_fields
            or field in locks
            or normalized == str(current or "").strip()
        ):
            continue
        suggestion = {"field": field, "value": normalized}
        if (
            field == "department"
            and not frame.is_empty
            and not department_in_frame(frame, normalized)
        ):
            suggestion["out_of_frame"] = True
        suggestions.append(suggestion)

    error, attempted_mail_count = _skip_meta(row["profile_error"])
    mail_count = int(row["mail_count"] or 0)
    return {
        "document": document or None,
        "profile_json": document or None,
        "profile_updated_at": row["profile_updated_at"],
        "profile_mail_count": row["profile_mail_count"],
        "profile_model": row["profile_model"],
        "profile_status": raw_status,
        "profile_attempted_at": row["profile_attempted_at"],
        "profile_error": error,
        "attempted_mail_count": attempted_mail_count,
        "status": state,
        "profile_min": PROFILE_MIN,
        "eligible": (
            row["merged_into"] is None
            and row["hidden_at"] is None
            and row["kind"] == CONTACT_KIND_PERSON
            and mail_count >= PROFILE_MIN
            and int(row["sent_to_count"] or 0) >= 1
        ),
        "needed_mail_count": max(0, PROFILE_MIN - mail_count),
        "suggestions": suggestions,
    }


def ignore_profile_suggestion(
    conn: sqlite3.Connection, contact_id: int, *, field: str, now_ms: int
) -> None:
    row = contact_service._require_live_contact(conn, contact_id)
    document = _json_dict(row["profile_json"])
    ignored = document.get("ignored_suggestions")
    values = [str(item) for item in ignored] if isinstance(ignored, list) else []
    if field not in values:
        values.append(field)
    document["ignored_suggestions"] = values
    conn.execute(
        "UPDATE contact SET profile_json=?, updated_at=? WHERE id=?",
        (json.dumps(document, ensure_ascii=False), now_ms, contact_id),
    )

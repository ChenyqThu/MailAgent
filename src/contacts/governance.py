"""WP7 通讯录治理建议队列与 headless run spec。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Optional, TypedDict

from src.contacts import service as contact_service
from src.contacts.service import ContactError, parse_identity_locks
from src.contacts.taxonomy import (
    CONTACT_KIND_VALUES,
    CONTACT_LOCKABLE_FIELDS,
    CONTACT_SUGGESTION_STATUS_VALUES,
    CONTACT_SUGGESTION_TYPE_VALUES,
)

CONTACT_GOVERNANCE_JOB_TYPE = "contact_governance"
CONTACT_GOVERNANCE_MAX_RUN_SECONDS = 1800
CONTACT_GOVERNANCE_FIRE_KEY = "contact_governance.last_fire_day"

#: 治理 run 要 MOUNT 的 skill 族（工具面投影，WP7 批② gateway 侧接线时补齐）。
#: 🔴 不是可选的润色：gateway 的 per-agent skill MOUNT 门（S6 W3-1b）对任何带 agentRunContext
#: 的 run 都会跑一遍 `applySkillGating(gated, spec.toolPolicy.skills ?? [])`，缺这个键 = 零挂载
#: = email / search 两族读工具**整族消失**。而每条治理建议都必须带一条能在 email_metadata 里
#: 查到的邮件证据（``validate_evidence``），读不到邮件的 run 结构上产不出任何合法建议。
#: report 族有意不挂：治理扫描不产报告（matter 跟进挂它是为了那边的报告能力卡）。
#: 其余读工具（contact_* / kos / calendar / session / …）是 CORE_UNGATED，MOUNT 门管不到。
CONTACT_GOVERNANCE_SKILLS = ("email", "search")

_GOVERNANCE_PROMPT = """你是 MailAgent 的通讯录管理员。任务：读新往来邮件，对照通讯录，找出下面五类问题，用建议工具逐条提交，由 owner 审核后生效：
1. 同一个人被拆成多条（换邮箱、改名、中英文名各建了一条）→ 提合并建议；
2. 身份字段（姓名/英文名/组织/部门/职位/电话/上级）缺失或过时 → 提更正建议；
3. 地址已停用（交接邮件、离职告别、签名换了新地址）→ 提「标曾用」建议；
4. 汇报关系有直接证据 → 提上级建议；
5. 类型判错（机器人/群发别名被当成了人，或反过来）→ 提改判建议。
纪律：
- 身份信息优先采信本人最新邮件的签名档；他人转述与旧签名只作旁证。
- 每条建议必须带证据（message_id + 原文中最短的命中句）；没有证据就不提。
- 已锁定字段不再碰，除非新证据晚于锁定时间且与现值直接矛盾。
- 换邮箱成对提：先找交接句，再比对签名与同线程接续，说明哪个转正、哪个标曾用。
- 宁缺毋滥：每轮只提有把握的少数几条；不确定不提，不猜，不删数据，一切保持可逆。"""

_GOVERNANCE_KOS_GUIDANCE = """KOS 背景参考：
- 对涉及身份、职位、组织的判断，先用 kos_search / kos_get_page 查此人的 wiki 页作背景参考。
- KOS 是参考，不是证据；每条建议的 evidence 仍必须是邮件 message_id 与最短命中原文。"""


class ContactGovernanceSuggestion(TypedDict):
    id: int
    type: str
    contact_ids: list[int]
    payload: dict[str, Any]
    evidence: list[dict[str, str]]
    confidence: Optional[float]
    status: str
    block_reason: Optional[str]
    created_at: int
    decided_at: Optional[int]


def _governance_prompt(*, use_kos: bool) -> str:
    return (
        _GOVERNANCE_PROMPT + f"\n\n{_GOVERNANCE_KOS_GUIDANCE}"
        if use_kos
        else _GOVERNANCE_PROMPT
    )


def default_governance_prompt() -> str:
    return _governance_prompt(use_kos=True)


def _effective_prompt(*, use_kos: bool = True) -> str:
    try:
        from src.agent_config.store import CONTACT_AGENT_DOC_NAME, get_agent_config_store

        doc = get_agent_config_store().get_profile_doc(
            CONTACT_AGENT_DOC_NAME, seed_if_absent=False
        )
        custom = (getattr(doc, "content", "") or "").strip()
        prompt = _governance_prompt(use_kos=use_kos)
        return prompt + (f"\n\n{custom}" if custom else "")
    except Exception:
        return _governance_prompt(use_kos=use_kos)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _message_timestamp(value: Any) -> Optional[int]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        numeric = float(text)
        return int(numeric * 1000) if numeric < 10_000_000_000 else int(numeric)
    except ValueError:
        pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except ValueError:
        return None


def validate_evidence(conn: sqlite3.Connection, items: Any) -> list[dict[str, str]]:
    if not isinstance(items, list) or not items:
        raise ContactError("E_EVIDENCE_REQUIRED", "at least one email evidence item is required")
    out: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, Mapping):
            raise ContactError("E_INVALID_EVIDENCE", "evidence item must be an object")
        message_id = str(item.get("message_id") or "").strip()
        quote = str(item.get("quote") or "").strip()
        if not message_id or not quote:
            raise ContactError("E_INVALID_EVIDENCE", "message_id and quote are required")
        row = conn.execute(
            "SELECT message_id FROM email_metadata WHERE message_id=?", (message_id,)
        ).fetchone()
        if row is None:
            raise ContactError("E_EVIDENCE_NOT_FOUND", f"email evidence not found: {message_id}")
        out.append({"message_id": message_id, "quote": quote[:500]})
    return out


def evidence_fingerprint(items: Iterable[Mapping[str, Any]]) -> str:
    message_ids = sorted({str(item.get("message_id") or "").strip() for item in items})
    return hashlib.sha256("\n".join(message_ids).encode("utf-8")).hexdigest()


def _normalized_contact_ids(conn: sqlite3.Connection, values: Any) -> list[int]:
    if not isinstance(values, list) or not values:
        raise ContactError("E_INVALID_CONTACT_IDS", "contact_ids must be a non-empty list")
    try:
        contact_ids = sorted({int(value) for value in values})
    except (TypeError, ValueError) as exc:
        raise ContactError("E_INVALID_CONTACT_IDS", "contact_ids must contain integers") from exc
    for contact_id in contact_ids:
        contact_service._require_live_contact(conn, contact_id)
    return contact_ids


def _identity_current(row: sqlite3.Row, field: str) -> Any:
    if field != "phone":
        return row[field]
    try:
        info = json.loads(row["contact_info_json"] or "{}")
    except (TypeError, ValueError):
        info = {}
    return info.get("phone") if isinstance(info, dict) else None


def _guard_locked_fields(
    conn: sqlite3.Connection,
    suggestion_type: str,
    contact_ids: list[int],
    payload: Mapping[str, Any],
    evidence: list[dict[str, str]],
) -> None:
    if suggestion_type == "relation":
        row = contact_service._require_live_contact(conn, contact_ids[0])
        if row["manager_src"] == "manual":
            raise ContactError("E_FIELD_LOCKED", "manual manager relation is locked")
        return
    if suggestion_type != "identity":
        return
    field = str(payload.get("field") or "")
    if field not in CONTACT_LOCKABLE_FIELDS:
        raise ContactError("E_INVALID_FIELD", f"field must be one of {CONTACT_LOCKABLE_FIELDS}")
    row = contact_service._require_live_contact(conn, contact_ids[0])
    locked_at = parse_identity_locks(row["identity_locks_json"]).get(field)
    if locked_at is None:
        return
    placeholders = ",".join("?" for _ in evidence)
    dates = conn.execute(
        f"SELECT date_received FROM email_metadata WHERE message_id IN ({placeholders})",
        tuple(item["message_id"] for item in evidence),
    ).fetchall()
    newest = max((_message_timestamp(item[0]) or 0 for item in dates), default=0)
    if newest <= locked_at or payload.get("value") == _identity_current(row, field):
        raise ContactError("E_FIELD_LOCKED", f"identity field is locked: {field}")


def create_suggestion(
    conn: sqlite3.Connection,
    *,
    suggestion_type: str,
    contact_ids: Any,
    payload: Any,
    evidence: Any,
    confidence: Optional[float] = None,
    now_ms: Optional[int] = None,
) -> dict[str, Any]:
    if suggestion_type not in CONTACT_SUGGESTION_TYPE_VALUES:
        raise ContactError("E_INVALID_SUGGESTION_TYPE", "invalid contact suggestion type")
    if not isinstance(payload, Mapping):
        raise ContactError("E_INVALID_PAYLOAD", "payload must be an object")
    if confidence is not None and not 0 <= float(confidence) <= 1:
        raise ContactError("E_INVALID_CONFIDENCE", "confidence must be between 0 and 1")
    normalized_ids = _normalized_contact_ids(conn, contact_ids)
    normalized_evidence = validate_evidence(conn, evidence)
    _guard_locked_fields(conn, suggestion_type, normalized_ids, payload, normalized_evidence)
    ids_json = _json(normalized_ids)
    fingerprint = evidence_fingerprint(normalized_evidence)
    duplicate_sql = (
        "SELECT id, status FROM contact_suggestion WHERE type=? AND contact_ids_json=? "
        "AND evidence_fingerprint=? AND status IN ('pending','ignored','blocked') "
    )
    duplicate_params: tuple[Any, ...] = (suggestion_type, ids_json, fingerprint)
    if suggestion_type == "identity":
        # identity 建议是单字段粒度：同证据可分别更正多个字段。value 有意不进键，
        # 保持「同字段建议一旦被忽略，不因 LLM 换措辞/新值而复活」的语义。
        duplicate_sql += "AND json_extract(payload_json, '$.field')=? "
        duplicate_params += (str(payload.get("field") or ""),)
    duplicate = conn.execute(
        duplicate_sql + "ORDER BY id DESC LIMIT 1",
        duplicate_params,
    ).fetchone()
    if duplicate is not None:
        return {"id": int(duplicate["id"]), "created": False, "status": duplicate["status"]}
    cursor = conn.execute(
        "INSERT INTO contact_suggestion "
        "(type, contact_ids_json, payload_json, evidence_json, evidence_fingerprint, "
        "confidence, status, created_at) VALUES (?,?,?,?,?,?,'pending',?)",
        (
            suggestion_type,
            ids_json,
            _json(dict(payload)),
            _json(normalized_evidence),
            fingerprint,
            float(confidence) if confidence is not None else None,
            int(now_ms if now_ms is not None else time.time() * 1000),
        ),
    )
    return {"id": int(cursor.lastrowid), "created": True, "status": "pending"}


def _decode_suggestion(row: sqlite3.Row) -> ContactGovernanceSuggestion:
    return {
        "id": int(row["id"]), "type": row["type"],
        "contact_ids": json.loads(row["contact_ids_json"]),
        "payload": json.loads(row["payload_json"]),
        "evidence": json.loads(row["evidence_json"]),
        "confidence": row["confidence"], "status": row["status"],
        "block_reason": row["block_reason"], "created_at": row["created_at"],
        "decided_at": row["decided_at"],
    }


def list_suggestions(
    conn: sqlite3.Connection, *, status: str = "pending", limit: int = 50,
    cursor: Optional[tuple[int, int]] = None,
) -> dict[str, Any]:
    if status not in CONTACT_SUGGESTION_STATUS_VALUES:
        raise ContactError("E_INVALID_STATUS", "invalid contact suggestion status")
    where = "status=?"
    params: list[Any] = [status]
    if cursor is not None:
        where += " AND (created_at < ? OR (created_at = ? AND id < ?))"
        params.extend((cursor[0], cursor[0], cursor[1]))
    rows = conn.execute(
        f"SELECT * FROM contact_suggestion WHERE {where} "
        "ORDER BY created_at DESC, id DESC LIMIT ?", (*params, limit + 1),
    ).fetchall()
    visible = rows[:limit]
    next_cursor = None
    if len(rows) > limit and visible:
        last = visible[-1]
        next_cursor = f"{last['created_at']}:{last['id']}"
    return {"items": [_decode_suggestion(row) for row in visible], "next_cursor": next_cursor}


def ignore_suggestion(conn: sqlite3.Connection, suggestion_id: int, *, now_ms: int) -> dict[str, Any]:
    row = conn.execute("SELECT status FROM contact_suggestion WHERE id=?", (suggestion_id,)).fetchone()
    if row is None:
        raise ContactError("E_NOT_FOUND", "contact suggestion not found")
    if row["status"] != "pending":
        raise ContactError("E_INVALID_STATE", "only pending suggestions can be ignored")
    conn.execute(
        "UPDATE contact_suggestion SET status='ignored', decided_at=? WHERE id=?",
        (now_ms, suggestion_id),
    )
    return {"id": suggestion_id, "status": "ignored", "decided_at": now_ms}


def adopt_suggestion(conn: sqlite3.Connection, suggestion_id: int, *, now_ms: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM contact_suggestion WHERE id=?", (suggestion_id,)).fetchone()
    if row is None:
        raise ContactError("E_NOT_FOUND", "contact suggestion not found")
    if row["status"] != "pending":
        raise ContactError("E_INVALID_STATE", "only pending suggestions can be adopted")
    suggestion = _decode_suggestion(row)
    contact_ids, payload = suggestion["contact_ids"], suggestion["payload"]
    try:
        if suggestion["type"] == "identity":
            field = str(payload.get("field") or "")
            contact_service.update_identity_fields(conn, contact_ids[0], {field: payload.get("value")}, now=now_ms)
        elif suggestion["type"] == "former_email":
            contact_service.mark_email_former(conn, contact_ids[0], str(payload.get("email") or ""), now=now_ms)
        elif suggestion["type"] == "relation":
            manager_id = payload.get("manager_id")
            contact_service.set_manager(conn, contact_ids[0], int(manager_id) if manager_id is not None else None, src="auto", now_ms=now_ms)
        elif suggestion["type"] == "kind":
            kind = str(payload.get("kind") or "")
            if kind not in CONTACT_KIND_VALUES:
                raise ContactError("E_INVALID_KIND", "invalid contact kind")
            contact_service.set_kind(conn, contact_ids[0], kind, now=now_ms)
        elif suggestion["type"] == "merge" and len(contact_ids) != 2:
            raise ContactError("E_INVALID_CONTACT_IDS", "merge requires exactly two contacts")
        conn.execute(
            "UPDATE contact_suggestion SET status='adopted', block_reason=NULL, decided_at=? WHERE id=?",
            (now_ms, suggestion_id),
        )
    except ContactError as exc:
        conn.execute(
            "UPDATE contact_suggestion SET status='blocked', block_reason=?, decided_at=? WHERE id=?",
            (f"{exc.code}: {exc.message}", now_ms, suggestion_id),
        )
        return {
            "id": suggestion_id,
            "status": "blocked",
            "decided_at": now_ms,
            "error": {"code": exc.code, "message": exc.message},
        }
    result = {"id": suggestion_id, "status": "adopted", "decided_at": now_ms}
    if suggestion["type"] == "merge":
        result["merge_pair"] = contact_ids
    return result


def assemble_contact_governance_spec(job: Any) -> dict[str, Any]:
    from src.config import config
    from src.contacts.governance_config import get_contact_governance_agent_config

    params = job.params or {}
    cfg = get_contact_governance_agent_config(config.sync_store_db_path)
    spec = {
        "jobId": job.job_id,
        "runKind": CONTACT_GOVERNANCE_JOB_TYPE,
        "agentId": "contact_governance_agent",
        "trigger": {
            "id": None,
            "kind": str(params.get("trigger_kind") or "schedule"),
            "firedAt": datetime.fromtimestamp(job.created_at, tz=timezone.utc).isoformat(),
        },
        "prompt": {"taskPrompt": _effective_prompt(use_kos=cfg.use_kos)},
        "useKos": cfg.use_kos,
        "model": cfg.model or None,
        # 🔴 allowedTools 恒 []：治理 run 的工具面由 gateway 按 class 从 `contact_governance`
        # 矩阵行 + wrapCfgForAgentRun 的读面 belt 推导（读全给、写一个不给、只留三个建议通道），
        # 名单交集在这里没有合法用途；gateway 侧对 runKind='contact_governance' 也会强制 []。
        # grantExec / grantWeb 一个都不写 —— 通讯录扫描既不执行也不出网。
        "toolPolicy": {
            "allowedTools": [],
            "skills": list(CONTACT_GOVERNANCE_SKILLS),
        },
        "budget": {"maxRunSeconds": CONTACT_GOVERNANCE_MAX_RUN_SECONDS},
        "sessionTitle": "通讯录治理扫描",
    }
    if cfg.fallback_models is not None:
        spec["fallbackModels"] = list(cfg.fallback_models)
    return spec


def enqueue_governance_job(
    job_repo: Any, *, trigger_kind: str, idempotency_key: Optional[str] = None
) -> dict[str, Any]:
    conn = job_repo._connect()
    try:
        active = conn.execute(
            "SELECT job_id, status FROM async_jobs WHERE job_type=? "
            "AND status IN ('queued','running') ORDER BY job_id DESC LIMIT 1",
            (CONTACT_GOVERNANCE_JOB_TYPE,),
        ).fetchone()
    finally:
        conn.close()
    if active is not None:
        return {
            "job_id": int(active["job_id"]),
            "status": active["status"],
            "created": False,
            "coalesced": True,
        }
    job_id, created = job_repo.enqueue(
        job_type=CONTACT_GOVERNANCE_JOB_TYPE,
        target_kind="contact_directory",
        target_key="global",
        params={"trigger_kind": trigger_kind},
        idempotency_key=idempotency_key,
    )
    job = job_repo.get(job_id)
    return {
        "job_id": job_id,
        "status": job.status if job is not None else "queued",
        "created": created,
        "coalesced": not created,
    }

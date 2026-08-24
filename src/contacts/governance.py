"""WP7 通讯录治理建议队列与 headless run spec。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Optional, TypedDict

from loguru import logger

from src.contacts import service as contact_service
from src.contacts.org_frame import (
    OrgFrame,
    department_in_frame,
    load_org_frame,
    normalize_department_path,
    organization_in_frame,
    render_org_frame,
)
from src.contacts.service import ContactError, parse_identity_locks
from src.contacts.taxonomy import (
    CONTACT_KIND_VALUES,
    CONTACT_LOCKABLE_FIELDS,
    CONTACT_SUGGESTION_STATUS_VALUES,
    CONTACT_SUGGESTION_TYPE_VALUES,
    strip_evidence_refs,
)

CONTACT_GOVERNANCE_JOB_TYPE = "contact_governance"
CONTACT_GOVERNANCE_MAX_RUN_SECONDS = 1800
CONTACT_GOVERNANCE_FIRE_KEY = "contact_governance.last_fire_day"

#: 整批处置的两个动作。值域在 `bulk_resolve_suggestions` 校验（非法值 → 400
#: E_INVALID_ARG，跟随本面 view/sort/kind 的错误形状），REST schema 只承载形状。
CONTACT_SUGGESTION_BULK_ACTIONS = ("adopt", "ignore")
#: 一次整批处置最多带多少条。范围是**服务端全量 pending**（前端分页拉不齐 id，按已加载页
#: 做只会清一半积压），所以上限是服务端的事：500 ≈ 几十轮扫描的积压，够清空常见队列，
#: 又挡住一个事务里塞进几千条。没清完的条数由返回值的 ``remaining`` 如实交代。
CONTACT_SUGGESTION_BULK_MAX = 500
#: merge 类**不进整批采纳**：真合并要人工走合并预览二次确认（逐条 adopt 也只校验不执行）。
CONTACT_SUGGESTION_BULK_SKIP_MERGE = "merge_requires_manual_confirmation"

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
    frame = load_org_frame()
    custom = ""
    try:
        from src.agent_config.store import CONTACT_AGENT_DOC_NAME, get_agent_config_store

        doc = get_agent_config_store().get_profile_doc(
            CONTACT_AGENT_DOC_NAME, seed_if_absent=False
        )
        custom = (getattr(doc, "content", "") or "").strip()
    except Exception:
        pass
    prompt = _governance_prompt(use_kos=use_kos)
    compact_frame = render_org_frame(frame)
    if compact_frame:
        prompt += (
            "\n\nORG FRAME（owner 预设可信参考）：\n"
            f"{compact_frame}\n"
            "规则：organization 必须从 Companies 的 canonical 名中选择；department "
            "必须挂在某条 Departments 路径之下，可再深一两级，并统一使用 ` / ` 分隔。"
            "不确定归属时不要提案，不要编造路径。框架不是证据，身份建议仍须邮件证据支撑。"
        )
    return prompt + (f"\n\n{custom}" if custom else "")


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
    org_frame: Optional[OrgFrame] = None,
) -> dict[str, Any]:
    if suggestion_type not in CONTACT_SUGGESTION_TYPE_VALUES:
        raise ContactError("E_INVALID_SUGGESTION_TYPE", "invalid contact suggestion type")
    if not isinstance(payload, Mapping):
        raise ContactError("E_INVALID_PAYLOAD", "payload must be an object")
    normalized_payload = dict(payload)
    normalized_payload.pop("out_of_frame", None)
    if suggestion_type == "identity":
        field = str(normalized_payload.get("field") or "")
        if field in {"department", "organization"}:
            value = strip_evidence_refs(str(normalized_payload.get("value") or ""))
            if field == "department":
                value = normalize_department_path(value)
            normalized_payload["value"] = value
            frame = org_frame if org_frame is not None else load_org_frame()
            in_frame = (
                department_in_frame(frame, value)
                if field == "department"
                else organization_in_frame(frame, value)
            )
            if not frame.is_empty and not in_frame:
                normalized_payload["out_of_frame"] = True
    if confidence is not None and not 0 <= float(confidence) <= 1:
        raise ContactError("E_INVALID_CONFIDENCE", "confidence must be between 0 and 1")
    normalized_ids = _normalized_contact_ids(conn, contact_ids)
    normalized_evidence = validate_evidence(conn, evidence)
    _guard_locked_fields(
        conn, suggestion_type, normalized_ids, normalized_payload, normalized_evidence
    )
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
        duplicate_params += (str(normalized_payload.get("field") or ""),)
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
            _json(normalized_payload),
            _json(normalized_evidence),
            fingerprint,
            float(confidence) if confidence is not None else None,
            int(now_ms if now_ms is not None else time.time() * 1000),
        ),
    )
    # 🔴 通知**不**在这里发: create_suggestion 恒运行在调用方尚未提交的写事务内
    # (profile.py `with ContactRepository(db_path).transaction() as conn:` /
    # contact_agent.py `with repo.transaction() as conn:`，均 BEGIN IMMEDIATE 立即持锁)。
    # 若在此处调 NotifyCenter (独立连接, 自己的 BEGIN IMMEDIATE) 会与外层未释放的写锁
    # 循环等待: 外层 commit 等 create_suggestion 返回 → create_suggestion 等 NotifyCenter →
    # NotifyCenter 等外层的锁 —— 结构性死锁, 不是「事务短所以竞争窗口小」能救的
    # (task 08-20-notification-center 返工记录, 见
    # test_create_suggestion_returns_fast_and_never_calls_notify_directly /
    # test_publish_inside_open_transaction_raises_locked)。调用方须在 **commit 之后**
    # 对 created=True 的结果调 notify_pending_suggestion(db_path)。
    return {"id": int(cursor.lastrowid), "created": True, "status": "pending"}


def notify_pending_suggestion(db_path: str) -> None:
    """新增一条待审建议后 → reviews/info 聚合通知 (design §7「contact 治理建议队列常驻计次」行)。

    🔴 调用时机纪律: 必须在建议已经 commit 之后调用 (调用方按 create_suggestion 返回的
    created=True 决定是否调用)。走独立连接查询 + 独立连接 publish，两次都是全新连接、
    不复用调用方的 conn —— 若在调用方未提交的事务内部调用会死锁 (见 create_suggestion
    头注)。pending 计数用新连接查询, 此时外层已提交, 计数天然含刚插入的这条。
    dedupe_key 固定为 ``contact_suggestion:pending`` —— 每条新建议都计次到同一活跃行
    (NotifyCenter 的 recurrence_no 承担「第几条」)。通知路径绝不影响建议入库
    (design §3.3 同款纪律): 整段 try 吞 + warning。
    """
    try:
        count_conn = sqlite3.connect(db_path, timeout=5)
        try:
            pending = int(
                count_conn.execute(
                    "SELECT COUNT(*) FROM contact_suggestion WHERE status='pending'"
                ).fetchone()[0]
            )
        finally:
            count_conn.close()

        from src.notify.center import NotifyCenter

        NotifyCenter(db_path).publish(
            category="reviews",
            source="contact",
            severity="info",
            title="通讯录待审建议",
            body=f"当前有 {pending} 条待审建议等待处理",
            dedupe_key="contact_suggestion:pending",
            payload={"link": {"type": "contact_queue"}, "pending": pending},
        )
    except Exception as e:  # noqa: BLE001 — 通知路径绝不影响建议入库
        logger.warning(f"[contact-governance] notify_center publish failed: {e}")


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


def _apply_adoption(
    conn: sqlite3.Connection, suggestion: ContactGovernanceSuggestion, *, now_ms: int
) -> None:
    """按 type 把一条建议落进主表（不动 contact_suggestion 行本身）。

    守卫拦下时抛 ContactError —— 调用方决定把这一行标 blocked 之后是抛 4xx（逐条口）
    还是继续处理批里的下一条（整批口）。merge 只校验形状不执行合并：真合并的唯一路径
    是人工走合并预览二次确认。
    """
    contact_ids, payload = suggestion["contact_ids"], suggestion["payload"]
    if suggestion["type"] == "identity":
        field = str(payload.get("field") or "")
        value = payload.get("value")
        normalized_value = strip_evidence_refs(str(value)) if value is not None else ""
        contact_service.update_identity_fields(
            conn, contact_ids[0], {field: normalized_value}, now=now_ms
        )
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


def _mark_decided(
    conn: sqlite3.Connection, suggestion_id: int, status: str, *, now_ms: int,
    block_reason: Optional[str] = None,
) -> None:
    conn.execute(
        "UPDATE contact_suggestion SET status=?, block_reason=?, decided_at=? WHERE id=?",
        (status, block_reason, now_ms, suggestion_id),
    )


def adopt_suggestion(conn: sqlite3.Connection, suggestion_id: int, *, now_ms: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM contact_suggestion WHERE id=?", (suggestion_id,)).fetchone()
    if row is None:
        raise ContactError("E_NOT_FOUND", "contact suggestion not found")
    if row["status"] != "pending":
        raise ContactError("E_INVALID_STATE", "only pending suggestions can be adopted")
    suggestion = _decode_suggestion(row)
    contact_ids = suggestion["contact_ids"]
    try:
        _apply_adoption(conn, suggestion, now_ms=now_ms)
        _mark_decided(conn, suggestion_id, "adopted", now_ms=now_ms)
    except ContactError as exc:
        _mark_decided(
            conn, suggestion_id, "blocked", now_ms=now_ms,
            block_reason=f"{exc.code}: {exc.message}",
        )
        return {
            "id": suggestion_id,
            "status": "blocked",
            "decided_at": now_ms,
            "error": {"code": exc.code, "message": exc.message},
        }
    result = {"id": suggestion_id, "status": "adopted", "decided_at": now_ms}
    # 采纳动到的联系人 (router 据此在事务提交后发 contact.changed 定向失效)。
    result["contact_ids"] = list(contact_ids)
    if suggestion["type"] == "merge":
        result["merge_pair"] = contact_ids
    return result


def bulk_resolve_suggestions(
    conn: sqlite3.Connection, *, action: str, now_ms: int
) -> dict[str, Any]:
    """整批采纳 / 整批忽略待审建议 —— 范围是服务端全量 pending，调用方不传 id。

    🔴 逐条不整批失败：批里某条被不变量守卫拦下时按逐条口同款标 blocked 并计入
    ``blocked``，**不打断**剩下几十条（整批的价值就是清积压，一条挡住全批回滚等于没有
    整批口）。merge 类进 ``skipped`` 不采纳，理由同 ``_apply_adoption``。

    ``ignore`` 收全部（含 merge）—— 忽略没有主表副作用。

    整批共用调用方传进来的 conn/事务（router 层 ``with repo.transaction()``），
    ``contact.changed`` 由 router 在**提交之后**广播（事务内不发事件）。
    """
    if action not in CONTACT_SUGGESTION_BULK_ACTIONS:
        raise ContactError(
            "E_INVALID_ARG", f"action must be one of {CONTACT_SUGGESTION_BULK_ACTIONS}"
        )
    # 排序与 list_suggestions 逐字同款：超过上限时先处置用户正看着的那一页，
    # 剩下的由 remaining 交代（再点一次接着清）。
    rows = conn.execute(
        "SELECT * FROM contact_suggestion WHERE status='pending' "
        "ORDER BY created_at DESC, id DESC LIMIT ?",
        (CONTACT_SUGGESTION_BULK_MAX,),
    ).fetchall()
    adopted = 0
    ignored = 0
    blocked: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    touched_contact_ids: set[int] = set()
    for row in rows:
        suggestion = _decode_suggestion(row)
        suggestion_id = suggestion["id"]
        if action == "ignore":
            _mark_decided(conn, suggestion_id, "ignored", now_ms=now_ms)
            ignored += 1
            continue
        if suggestion["type"] == "merge":
            skipped.append(
                {"id": suggestion_id, "reason": CONTACT_SUGGESTION_BULK_SKIP_MERGE}
            )
            continue
        try:
            _apply_adoption(conn, suggestion, now_ms=now_ms)
        except ContactError as exc:
            _mark_decided(
                conn, suggestion_id, "blocked", now_ms=now_ms,
                block_reason=f"{exc.code}: {exc.message}",
            )
            blocked.append(
                {"id": suggestion_id, "code": exc.code, "message": exc.message}
            )
            continue
        _mark_decided(conn, suggestion_id, "adopted", now_ms=now_ms)
        adopted += 1
        touched_contact_ids.update(suggestion["contact_ids"])
    remaining = int(
        conn.execute(
            "SELECT COUNT(*) FROM contact_suggestion WHERE status='pending'"
        ).fetchone()[0]
    )
    return {
        "action": action,
        "adopted": adopted,
        "ignored": ignored,
        "blocked": blocked,
        "skipped": skipped,
        # 处置后仍待审的条数（上限截断 + merge 跳过都会留下东西），前端据此知道没清完。
        "remaining": remaining,
        # 采纳动到的联系人 (router 据此在事务提交后发 contact.changed 定向失效)。
        "contact_ids": sorted(touched_contact_ids),
    }


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

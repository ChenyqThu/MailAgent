"""SQLite access and read projections for the Contact Directory.

schema 归 ``src/mail/sync_store.py`` 的 v54 migration 拥有 (``CONTACT_TABLE_DDLS``
/ ``CONTACT_INDEX_DDLS``), 本仓库**不建表** —— 连接假设三表已在位。
list/detail/governance/backfill 读侧查询集中于此，``src/api/routers/contacts.py``
与 ``src/skills/builtin/contacts.py`` 共享同一套实现，不保留裸 SQL。
"""

from __future__ import annotations

import base64
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional, Sequence

from src.contacts import service as contact_service
from src.contacts.service import ContactError
from src.contacts.taxonomy import CONTACT_KIND_PERSON

VIEW_VALUES = ("known", "all")
SORT_VALUES = ("density", "recent", "name")

#: 联系人主邮箱 (无显式主时退化最小地址) —— resolve 端点同款相关子查询。
#: 列表 / 详情 / 组织关系三处共用一份, `{alias}` 是外层 contact 的别名。
_PRIMARY_EMAIL_SQL = (
    "(SELECT COALESCE(MAX(CASE WHEN pe.is_primary = 1 "
    "    THEN pe.email_normalized END), MIN(pe.email_normalized)) "
    " FROM contact_email pe WHERE pe.contact_id = {alias}.id)"
)
_PRIMARY_EMAIL_SQL_C = _PRIMARY_EMAIL_SQL.format(alias="c")

#: keyset 游标里那几列在 SELECT 里的列名前缀 (投影时剔除, 不进对外行形状)。
_CURSOR_COL_PREFIX = "_ks"

#: 每种 sort 的排序键 = (SQL 表达式, 方向) 有序元组; 游标就是这些表达式在末行的取值。
_LIST_SORT_KEYS: dict[str, tuple[tuple[str, str], ...]] = {
    "density": (
        ("c.sent_to_count", "DESC"),
        ("c.mail_count", "DESC"),
        ("COALESCE(c.last_seen_at, -1)", "DESC"),
        ("c.id", "ASC"),
    ),
    "recent": (
        ("COALESCE(c.last_seen_at, -1)", "DESC"),
        ("c.mail_count", "DESC"),
        ("c.id", "ASC"),
    ),
    "name": (
        (
            "COALESCE(c.display_name, "
            + _PRIMARY_EMAIL_SQL_C
            + ", '') COLLATE NOCASE",
            "ASC",
        ),
        ("c.id", "ASC"),
    ),
}

#: 组织关系投影的行字段 (裁决 4 最小集 + primary_email/kind —— Monogram 色相
#: 锚点 = 主邮箱 (D10), 分区头「写邮件并抄送上级」需要上级主邮箱)。
_REL_FIELDS = (
    "id",
    "display_name",
    "formal_name",
    "organization",
    "role_title",
    "kind",
    "mail_count",
    "primary_email",
)


class ContactRepository:
    def __init__(self, db_path: str | Path):
        self.db_path = str(db_path)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 30000")
        return conn

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def _like_pattern(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _json_list(raw: Any) -> list:
    try:
        data = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return []
    return data if isinstance(data, list) else []


def _json_dict(raw: Any) -> dict:
    try:
        data = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _encode_list_cursor(values: list[Any]) -> str:
    """游标 = base64url(JSON 数组)。"""
    raw = json.dumps(values, ensure_ascii=False, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_list_cursor(cursor: str, arity: int) -> list[Any]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        values = json.loads(
            base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        )
    except (TypeError, ValueError) as exc:
        raise ContactError("E_INVALID_ARG", "cursor is malformed") from exc
    if not isinstance(values, list) or len(values) != arity:
        raise ContactError(
            "E_INVALID_ARG", "cursor does not match the requested sort"
        )
    return values


def _keyset_where(
    keys: tuple[tuple[str, str], ...], values: list[Any]
) -> tuple[str, list[Any]]:
    """「严格排在游标之后」的词典序谓词 (行值比较的展开式)。"""
    clauses: list[str] = []
    params: list[Any] = []
    for index, (expr, direction) in enumerate(keys):
        parts = []
        for prev_index, (prev_expr, _) in enumerate(keys[:index]):
            parts.append(f"{prev_expr} = ?")
            params.append(values[prev_index])
        parts.append(f"{expr} {'<' if direction == 'DESC' else '>'} ?")
        params.append(values[index])
        clauses.append("(" + " AND ".join(parts) + ")")
    return "(" + " OR ".join(clauses) + ")", params


def _rel_person(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in _REL_FIELDS}


def get_governance_status(conn: sqlite3.Connection) -> dict[str, Any]:
    from src.contacts import governance as contact_governance

    pending_count = int(
        conn.execute(
            "SELECT COUNT(*) FROM contact_suggestion WHERE status='pending'"
        ).fetchone()[0]
    )
    fire_marker = conn.execute(
        "SELECT value FROM sync_state WHERE key=?",
        (contact_governance.CONTACT_GOVERNANCE_FIRE_KEY,),
    ).fetchone()
    latest_job = conn.execute(
        "SELECT created_at, status, last_error FROM async_jobs WHERE job_type=? "
        "ORDER BY job_id DESC LIMIT 1",
        (contact_governance.CONTACT_GOVERNANCE_JOB_TYPE,),
    ).fetchone()
    return {
        "enabled": True,
        "pending_count": pending_count,
        "last_fire_day": fire_marker[0] if fire_marker else None,
        # async_jobs 时刻是 epoch 秒；对外契约统一毫秒（history/daily-summary 同款）。
        "last_scan_at": int(float(latest_job[0]) * 1000)
        if latest_job and latest_job[0] is not None
        else None,
        "last_scan_status": latest_job[1] if latest_job else None,
        "last_scan_error": latest_job[2] if latest_job else None,
    }


def list_governance_history(
    conn: sqlite3.Connection, *, limit: int
) -> list[dict[str, Any]]:
    from src.contacts import governance as contact_governance

    rows = conn.execute(
        "SELECT job_id, status, created_at, started_at, finished_at, last_error, "
        "result_json, params_json "
        "FROM async_jobs WHERE job_type=? ORDER BY job_id DESC LIMIT ?",
        (contact_governance.CONTACT_GOVERNANCE_JOB_TYPE, limit),
    ).fetchall()

    # async_jobs 的时刻列是 epoch 秒；对外契约统一毫秒（daily-summary 与前端时间处理同款）。
    def _ms(value: Any) -> Optional[int]:
        return int(float(value) * 1000) if value is not None else None

    items = []
    for row in rows:
        suggestions_created = None
        if row["result_json"]:
            try:
                result = json.loads(row["result_json"])
                value = (
                    result.get("suggestions_created")
                    if isinstance(result, dict)
                    else None
                )
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    suggestions_created = value
            except (json.JSONDecodeError, TypeError):
                pass
        trigger_kind = None
        if row["params_json"]:
            try:
                params = json.loads(row["params_json"])
                raw_kind = (
                    params.get("trigger_kind") if isinstance(params, dict) else None
                )
                if isinstance(raw_kind, str) and raw_kind:
                    trigger_kind = raw_kind
            except (json.JSONDecodeError, TypeError):
                pass
        items.append(
            {
                "job_id": int(row["job_id"]),
                "status": row["status"],
                "created_at": _ms(row["created_at"]),
                "started_at": _ms(row["started_at"]),
                "finished_at": _ms(row["finished_at"]),
                "last_error": row["last_error"],
                "suggestions_created": suggestions_created,
                "trigger_kind": trigger_kind,
            }
        )
    return items


def get_profile_daily_summary(
    conn: sqlite3.Connection, *, start_ms: int, end_ms: int
) -> dict[str, Any]:
    summary_row = conn.execute(
        "SELECT COUNT(*) AS attempted, "
        "COALESCE(SUM(CASE WHEN profile_status='ok' THEN 1 ELSE 0 END), 0) AS ok, "
        "COALESCE(SUM(CASE WHEN profile_status='skipped' THEN 1 ELSE 0 END), 0) AS skipped, "
        "COALESCE(SUM(CASE WHEN profile_status='failed' THEN 1 ELSE 0 END), 0) AS failed, "
        "MAX(profile_attempted_at) AS last_attempted_at "
        "FROM contact WHERE profile_attempted_at >= ? AND profile_attempted_at < ?",
        (start_ms, end_ms),
    ).fetchone()
    return {
        "attempted": int(summary_row["attempted"] or 0),
        "ok": int(summary_row["ok"] or 0),
        "skipped": int(summary_row["skipped"] or 0),
        "failed": int(summary_row["failed"] or 0),
        "last_attempted_at": summary_row["last_attempted_at"],
    }


def get_backfill_progress(conn: sqlite3.Connection) -> dict[str, Any]:
    from src.contacts.scanner import WATERMARK_KEY

    row = conn.execute(
        "SELECT value FROM sync_state WHERE key=?", (WATERMARK_KEY,)
    ).fetchone()
    try:
        watermark = int(row[0]) if row else 0
    except (TypeError, ValueError):
        watermark = 0
    total_rows = int(conn.execute("SELECT COUNT(*) FROM email_metadata").fetchone()[0])
    scanned_rows = int(
        conn.execute(
            "SELECT COUNT(*) FROM email_metadata WHERE internal_id <= ?",
            (watermark,),
        ).fetchone()[0]
    )
    return {
        "scanned": scanned_rows,
        "total": total_rows,
        "drained": scanned_rows >= total_rows,
    }


def resolve_by_emails(
    conn: sqlite3.Connection, normalized_emails: Sequence[str]
) -> dict[str, dict[str, Any]]:
    wanted = list(normalized_emails)
    if not wanted:
        return {}
    placeholders = ",".join("?" * len(wanted))
    sql = (
        "SELECT ce.email_normalized AS q_email, c.id, c.display_name, "
        "  c.formal_name, c.kind, "
        "  (SELECT COALESCE(MAX(CASE WHEN pe.is_primary = 1 "
        "      THEN pe.email_normalized END), MIN(pe.email_normalized)) "
        "   FROM contact_email pe WHERE pe.contact_id = c.id) AS primary_email "
        "FROM contact_email ce "
        "JOIN contact c ON c.id = ce.contact_id "
        f"WHERE ce.email_normalized IN ({placeholders})"
    )
    found: dict[str, dict[str, Any]] = {}
    for row in conn.execute(sql, wanted):
        found[row["q_email"]] = {
            "id": row["id"],
            "display_name": row["display_name"],
            "formal_name": row["formal_name"],
            "kind": row["kind"],
            "primary_email": row["primary_email"],
        }
    return found


def query_contact_list(
    repo: ContactRepository,
    *,
    view: str,
    q: Optional[str],
    sort: str,
    limit: Optional[int],
    cursor: Optional[str],
) -> dict[str, Any]:
    """通讯录列表的取数 + 行投影 (同步, 阻塞)。"""
    from src.contacts import profile as contact_profile

    if view not in VIEW_VALUES:
        raise ContactError("E_INVALID_ARG", f"view must be one of {VIEW_VALUES}")
    if sort not in SORT_VALUES:
        raise ContactError("E_INVALID_ARG", f"sort must be one of {SORT_VALUES}")
    if limit is not None and limit <= 0:
        raise ContactError("E_INVALID_ARG", "limit must be a positive integer")

    where = ["c.merged_into IS NULL"]
    params: list[Any] = []
    if view == "known":
        where.append(
            "c.hidden_at IS NULL AND c.is_self = 0 "
            "AND c.kind = 'person' AND c.sent_to_count > 0"
        )
    term = (q or "").strip()
    if term:
        pattern = _like_pattern(term)
        where.append(
            "(c.display_name LIKE ? ESCAPE '\\' "
            "OR c.formal_name LIKE ? ESCAPE '\\' "
            "OR c.organization LIKE ? ESCAPE '\\' "
            "OR c.name_variants_json LIKE ? ESCAPE '\\' "
            "OR EXISTS (SELECT 1 FROM contact_email qe "
            "  WHERE qe.contact_id = c.id AND qe.email_normalized LIKE ? ESCAPE '\\'))"
        )
        params.extend([pattern] * 5)

    keys = _LIST_SORT_KEYS[sort]
    where_sql = " AND ".join(where)
    count_sql = f"SELECT COUNT(*) FROM contact c WHERE {where_sql}"
    count_params = list(params)

    item_where = where_sql
    item_params = list(params)
    if cursor:
        keyset_sql, keyset_params = _keyset_where(
            keys, _decode_list_cursor(cursor, len(keys))
        )
        item_where = f"{item_where} AND {keyset_sql}"
        item_params.extend(keyset_params)

    order = ", ".join(f"{expr} {direction}" for expr, direction in keys)
    cursor_cols = "".join(
        f", {expr} AS {_CURSOR_COL_PREFIX}{index}"
        for index, (expr, _) in enumerate(keys)
    )
    sql = (
        "SELECT c.id, c.display_name, c.formal_name, c.organization, c.department, "
        "  c.role_title, c.function, c.seniority, c.gender, c.kind, c.hidden_at, c.is_self, "
        "  c.mail_count, c.sent_to_count, c.first_seen_at, c.last_seen_at, "
        "  c.meeting_count, c.last_met_at, c.next_meeting_at, "
        "  c.manager_contact_id, m.display_name AS manager_display_name, "
        "  json_extract(c.profile_json, '$.summary') AS profile_summary_raw, "
        "  (SELECT COUNT(*) FROM contact_email ce WHERE ce.contact_id = c.id) AS email_count, "
        f"  {_PRIMARY_EMAIL_SQL_C} AS primary_email"
        f"{cursor_cols} "
        "FROM contact c "
        "LEFT JOIN contact m ON m.id = c.manager_contact_id "
        f"WHERE {item_where} "
        f"ORDER BY {order}"
    )
    if limit is not None:
        sql += " LIMIT ?"
        item_params.append(limit + 1)

    conn = repo.connect()
    try:
        rows = conn.execute(sql, item_params).fetchall()
        total = int(conn.execute(count_sql, count_params).fetchone()[0])
    finally:
        conn.close()

    has_more = limit is not None and len(rows) > limit
    if has_more:
        rows = rows[:limit]
    next_cursor = (
        _encode_list_cursor(
            [rows[-1][f"{_CURSOR_COL_PREFIX}{index}"] for index in range(len(keys))]
        )
        if has_more and rows
        else None
    )
    hidden_cols = {"profile_summary_raw"}
    items = [
        {
            **{
                key: row[key]
                for key in row.keys()
                if key not in hidden_cols and not key.startswith(_CURSOR_COL_PREFIX)
            },
            "is_self": bool(row["is_self"]),
            "profile_summary": contact_profile.profile_summary_from_text(
                row["profile_summary_raw"]
            ),
            "profile_min": contact_profile.PROFILE_MIN,
            "profile_eligible": (
                row["hidden_at"] is None
                and row["kind"] == CONTACT_KIND_PERSON
                and int(row["mail_count"] or 0) >= contact_profile.PROFILE_MIN
                and int(row["sent_to_count"] or 0) >= 1
            ),
        }
        for row in rows
    ]
    return {"items": items, "total": total, "next_cursor": next_cursor}


def load_org_relations(conn: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    """WP5 组织关系投影: manager / reports / peers (设计 §2.2.1)。"""
    contact_id = int(row["id"])
    primary_sql = _PRIMARY_EMAIL_SQL.format(alias="r")
    manager = None
    if row["manager_contact_id"] is not None:
        manager_row = conn.execute(
            "SELECT r.id, r.display_name, r.formal_name, r.organization, "
            f"  r.role_title, r.kind, r.mail_count, {primary_sql} AS primary_email "
            "FROM contact r WHERE r.id = ?",
            (row["manager_contact_id"],),
        ).fetchone()
        if manager_row is not None:
            manager = _rel_person(manager_row)
    reports = [
        _rel_person(r)
        for r in conn.execute(
            "SELECT r.id, r.display_name, r.formal_name, r.organization, "
            f"  r.role_title, r.kind, r.mail_count, {primary_sql} AS primary_email "
            "FROM contact r "
            "WHERE r.manager_contact_id = ? AND r.merged_into IS NULL "
            "  AND r.hidden_at IS NULL "
            "ORDER BY r.mail_count DESC, r.id ASC",
            (contact_id,),
        )
    ]
    peers: list = []
    if row["organization"]:
        peers = [
            _rel_person(r)
            for r in conn.execute(
                "SELECT r.id, r.display_name, r.formal_name, r.organization, "
                f"  r.role_title, r.kind, r.mail_count, {primary_sql} AS primary_email "
                "FROM contact r "
                "WHERE r.id <> ? AND r.merged_into IS NULL "
                "  AND r.kind = 'person' "
                "  AND r.hidden_at IS NULL AND r.organization = ? "
                "  AND (? IS NULL OR r.department IS NULL OR r.department = ?) "
                "ORDER BY r.mail_count DESC, r.id ASC LIMIT 6",
                (
                    contact_id,
                    row["organization"],
                    row["department"],
                    row["department"],
                ),
            )
        ]
    return {"manager": manager, "reports": reports, "peers": peers}


def load_contact_detail(
    conn: sqlite3.Connection, contact_id: int, *, profile_enabled: bool = True
) -> dict[str, Any]:
    from src.contacts import profile as contact_profile

    row = conn.execute(
        "SELECT * FROM contact WHERE id=?", (contact_id,)
    ).fetchone()
    if row is None:
        raise ContactError("E_CONTACT_NOT_FOUND", f"contact {contact_id} not found")
    emails = [
        {
            "address": e["email_normalized"],
            "is_primary": bool(e["is_primary"]),
            "former_at": e["former_at"],
            "mail_count": e["mail_count"],
            "first_seen_at": e["first_seen_at"],
            "last_seen_at": e["last_seen_at"],
        }
        for e in conn.execute(
            "SELECT * FROM contact_email WHERE contact_id=? "
            "ORDER BY is_primary DESC, mail_count DESC, id ASC",
            (contact_id,),
        )
    ]
    contact_info = _json_dict(row["contact_info_json"])
    relations = load_org_relations(conn, row)
    configured = contact_profile.profile_feature_configured(
        conn, env_enabled=profile_enabled
    )
    return {
        "id": row["id"],
        "display_name": row["display_name"],
        "formal_name": row["formal_name"],
        "organization": row["organization"],
        "department": row["department"],
        "role_title": row["role_title"],
        "function": row["function"],
        "seniority": row["seniority"],
        "gender": row["gender"],
        "kind": row["kind"],
        "kind_locked_at": row["kind_locked_at"],
        "is_self": bool(row["is_self"]),
        "hidden_at": row["hidden_at"],
        "merged_into": row["merged_into"],
        "notes": row["notes"],
        "phone": contact_info.get("phone"),
        "contact_info": contact_info,
        "name_variants": _json_list(row["name_variants_json"]),
        "identity_locks": contact_service.parse_identity_locks(
            row["identity_locks_json"]
        ),
        "mail_count": row["mail_count"],
        "sent_to_count": row["sent_to_count"],
        "first_seen_at": row["first_seen_at"],
        "last_seen_at": row["last_seen_at"],
        "meeting_count": row["meeting_count"],
        "last_met_at": row["last_met_at"],
        "next_meeting_at": row["next_meeting_at"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "emails": emails,
        "manager": relations["manager"],
        "manager_src": row["manager_src"],
        "reports": relations["reports"],
        "peers": relations["peers"],
        "profile": contact_profile.profile_projection(row, configured=configured),
    }


def list_contact_matters(
    conn: sqlite3.Connection, contact_id: int
) -> list[dict[str, Any]]:
    contact_service._require_contact(conn, contact_id)
    rows = conn.execute(
        "SELECT ms.matter_id, ms.role, m.public_id, m.title, m.status, "
        "  m.archived_at "
        "FROM matter_stakeholder ms "
        "JOIN matter m ON m.id = ms.matter_id "
        "WHERE ms.contact_id = ? AND ms.deleted_at IS NULL "
        "  AND m.deleted_at IS NULL "
        "ORDER BY m.updated_at DESC",
        (contact_id,),
    ).fetchall()
    return [
        {
            "matter_id": row["matter_id"],
            "public_id": row["public_id"],
            "title": row["title"],
            "status": row["status"],
            "role": row["role"],
            "archived_at": row["archived_at"],
        }
        for row in rows
    ]

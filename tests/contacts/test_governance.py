from __future__ import annotations

import json
import sqlite3
from types import SimpleNamespace

import pytest

from src.contacts import governance
from src.contacts.service import ContactError, set_manager
from src.mail.new_watcher import _fire_contact_governance_if_due
from src.mail.sync_store import SyncStore
from src.sync.async_jobs import AsyncJob, AsyncJobRepository


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    for contact_id, name in ((1, "Alice"), (2, "Bob"), (3, "Carol")):
        conn.execute(
            "INSERT INTO contact (id, display_name, kind, created_at, updated_at) "
            "VALUES (?,?,'person',1,1)",
            (contact_id, name),
        )
    conn.execute(
        "INSERT INTO contact_email (contact_id, email_normalized, is_primary, created_at) "
        "VALUES (1,'alice@example.com',1,1)"
    )
    conn.execute(
        "INSERT INTO email_metadata (internal_id, message_id, date_received) VALUES "
        "(10,'m-old','1000'),"
        "(11,'m-new','3000')"
    )
    conn.commit()
    yield conn, str(path)
    conn.close()


def _proposal(conn, suggestion_type="identity", contact_ids=None, payload=None, evidence=None):
    return governance.create_suggestion(
        conn,
        suggestion_type=suggestion_type,
        contact_ids=contact_ids or [1],
        payload=payload or {"field": "organization", "value": "ACME"},
        evidence=evidence if evidence is not None else [{"message_id": "m-old", "quote": "ACME"}],
        confidence=0.9,
        now_ms=1000,
    )


@pytest.mark.parametrize(
    "evidence,code",
    [
        ([], "E_EVIDENCE_REQUIRED"),
        ([{"message_id": "m-old", "quote": ""}], "E_INVALID_EVIDENCE"),
        ([{"message_id": "missing", "quote": "x"}], "E_EVIDENCE_NOT_FOUND"),
    ],
)
def test_evidence_validation_fail_closed(db, evidence, code):
    conn, _ = db
    with pytest.raises(ContactError) as exc_info:
        _proposal(conn, evidence=evidence)
    assert exc_info.value.code == code


def test_fingerprint_dedupes_ignored_suggestion(db):
    conn, _ = db
    first = _proposal(conn)
    governance.ignore_suggestion(conn, first["id"], now_ms=2000)
    second = _proposal(conn)
    assert second == {"id": first["id"], "created": False, "status": "ignored"}


def test_identity_lock_requires_newer_contradicting_evidence(db):
    conn, _ = db
    locked_at = 2_000_000
    conn.execute(
        "UPDATE contact SET organization='Old', identity_locks_json=? WHERE id=1",
        (json.dumps({"organization": locked_at}),),
    )
    with pytest.raises(ContactError) as exc_info:
        _proposal(conn, payload={"field": "organization", "value": "New"})
    assert exc_info.value.code == "E_FIELD_LOCKED"
    accepted = _proposal(
        conn,
        payload={"field": "organization", "value": "New"},
        evidence=[{"message_id": "m-new", "quote": "joined New"}],
    )
    assert accepted["created"] is True


def test_manual_relation_is_locked(db):
    conn, _ = db
    set_manager(conn, 1, 2, src="manual", now_ms=100)
    with pytest.raises(ContactError) as exc_info:
        _proposal(
            conn, "relation", [1], {"manager_id": 3},
            [{"message_id": "m-old", "quote": "reports to Carol"}],
        )
    assert exc_info.value.code == "E_FIELD_LOCKED"


def test_adopt_five_types_and_merge_only_returns_preview(db):
    conn, _ = db
    identity = _proposal(conn)
    assert governance.adopt_suggestion(conn, identity["id"], now_ms=3000)["status"] == "adopted"
    row = conn.execute("SELECT organization, identity_locks_json FROM contact WHERE id=1").fetchone()
    assert row["organization"] == "ACME" and "organization" in row["identity_locks_json"]

    kind = _proposal(conn, "kind", [2], {"kind": "robot"})
    governance.adopt_suggestion(conn, kind["id"], now_ms=3001)
    assert conn.execute("SELECT kind FROM contact WHERE id=2").fetchone()[0] == "robot"

    relation = _proposal(conn, "relation", [3], {"manager_id": 2})
    governance.adopt_suggestion(conn, relation["id"], now_ms=3002)
    relation_row = conn.execute(
        "SELECT manager_contact_id, manager_src FROM contact WHERE id=3"
    ).fetchone()
    assert tuple(relation_row) == (2, "auto")

    conn.execute("UPDATE contact_email SET is_primary=0 WHERE contact_id=1")
    former = _proposal(conn, "former_email", [1], {"email": "alice@example.com"})
    governance.adopt_suggestion(conn, former["id"], now_ms=3003)
    assert conn.execute("SELECT former_at FROM contact_email WHERE contact_id=1").fetchone()[0] == 3003

    merge = _proposal(conn, "merge", [1, 2], {})
    result = governance.adopt_suggestion(conn, merge["id"], now_ms=3004)
    assert result["merge_pair"] == [1, 2]
    assert conn.execute("SELECT merged_into FROM contact WHERE id=2").fetchone()[0] is None


def test_blocked_guards_persist_reason(db):
    conn, _ = db
    former = _proposal(conn, "former_email", [1], {"email": "alice@example.com"})
    result = governance.adopt_suggestion(conn, former["id"], now_ms=4000)
    assert result["status"] == "blocked"
    assert result["error"]["code"] == "E_PRIMARY_EMAIL_CANNOT_BE_FORMER"
    assert conn.execute("SELECT status FROM contact_suggestion WHERE id=?", (former["id"],)).fetchone()[0] == "blocked"

    set_manager(conn, 1, 2, src="auto", now_ms=4001)
    cycle = _proposal(conn, "relation", [2], {"manager_id": 1})
    result = governance.adopt_suggestion(conn, cycle["id"], now_ms=4002)
    assert result["status"] == "blocked"
    assert result["error"]["code"] == "E_MANAGER_CYCLE"


def test_daily_tick_fires_once(db):
    conn, path = db
    conn.commit()
    assert _fire_contact_governance_if_due(path, "2026-08-19") is True
    assert _fire_contact_governance_if_due(path, "2026-08-19") is False
    repo = AsyncJobRepository(path)
    with repo._connect() as job_conn:
        assert job_conn.execute(
            "SELECT COUNT(*) FROM async_jobs WHERE job_type='contact_governance'"
        ).fetchone()[0] == 1


def test_spec_shape_and_flag_gate(monkeypatch):
    import src.config as config_module

    monkeypatch.setattr(
        config_module, "config", SimpleNamespace(contacts_enabled=True, contact_agent_enabled=True)
    )
    job = AsyncJob(
        job_id=7, job_type="contact_governance", target_kind="contact_directory",
        target_key="global", params={"trigger_kind": "manual"}, status="queued",
        idempotency_key=None, created_at=1.0, updated_at=1.0,
        progress_done=0, progress_total=0, checkpoint_internal_id=None,
        result=None, last_error=None, started_at=None, finished_at=None,
    )
    spec = governance.assemble_contact_governance_spec(job)
    assert spec["runKind"] == "contact_governance"
    # 🔴 WP7 批② —— toolPolicy 恰好两个键，多一个少一个都是安全语义变化：
    #   · allowedTools 恒 []（工具面由 gateway 按 class 推导，名单交集在这个 venue 没有合法用途）
    #   · skills = 挂载集。**不是可选润色**：gateway 的 per-agent skill MOUNT 门对任何带
    #     agentRunContext 的 run 恒跑一遍，缺这个键 = 零挂载 = email/search 两族读工具整族消失，
    #     而每条建议都必须带一条查得到的邮件证据 → 扫描结构上产不出任何合法建议（run 照跑、
    #     永远空手而归，且不报错）。
    #   · 任何 grant* 键都不许出现（既不执行也不出网）。
    assert spec["toolPolicy"] == {
        "allowedTools": [],
        "skills": list(governance.CONTACT_GOVERNANCE_SKILLS),
    }
    assert "email" in governance.CONTACT_GOVERNANCE_SKILLS
    assert not any(key.startswith("grant") for key in spec["toolPolicy"])
    config_module.config.contact_agent_enabled = False
    with pytest.raises(ContactError) as exc_info:
        governance.assemble_contact_governance_spec(job)
    assert exc_info.value.code == "E_DISABLED"


def test_default_prompt_has_five_categories_and_evidence_requirement():
    prompt = governance.default_governance_prompt()
    assert "通讯录管理员" in prompt
    assert all(f"{number}." in prompt for number in range(1, 6))
    assert "message_id" in prompt

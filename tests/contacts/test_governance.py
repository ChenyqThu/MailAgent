from __future__ import annotations

import json
import sqlite3
import asyncio
from datetime import datetime as real_datetime
from types import SimpleNamespace

import pytest

from src.contacts import governance
from src.contacts.org_frame import parse_org_frame
from src.contacts.governance_config import get_contact_governance_agent_config
from src.contacts.service import ContactError, set_manager
from src.mail.new_watcher import NewWatcher, _fire_contact_governance_if_due
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


def test_identity_dedupe_allows_two_fields_from_the_same_evidence(db):
    conn, _ = db
    organization = _proposal(
        conn, payload={"field": "organization", "value": "ACME"}
    )
    department = _proposal(
        conn, payload={"field": "department", "value": "Platform"}
    )
    assert organization["created"] is True
    assert department["created"] is True
    assert organization["id"] != department["id"]


def test_identity_dedupe_reuses_same_field_and_evidence(db):
    conn, _ = db
    first = _proposal(conn)
    second = _proposal(conn)
    assert second == {"id": first["id"], "created": False, "status": "pending"}


# ==================== 通知中心接线 (task 08-20-notification-center M2 批 B3b, 返工) ====================
# design §7「contact 治理建议队列常驻计次」行。
#
# 🔴 返工记录 (2026-08-21): 最初实现在 create_suggestion 内部直接调用发通知——
# create_suggestion 恒运行在调用方尚未提交的写事务里 (profile.py 的
# `with ContactRepository(db_path).transaction() as conn:` / contact_agent.py 的
# `with repo.transaction() as conn:`，两者都是 BEGIN IMMEDIATE 立即持写锁)。在这层
# 事务内部再开 NotifyCenter 的独立连接抢 BEGIN IMMEDIATE，形成循环等待：外层 commit
# 等 create_suggestion 返回 → create_suggestion 等 NotifyCenter → NotifyCenter 等外层
# 的锁。这是结构性死锁，不是"事务短所以竞争窗口小"能救的——生产环境每次真实调用都会
# 卡满 busy_timeout 才返回，且通知从未发出去。
#
# 修法: create_suggestion 只做 INSERT + 返回 created，不再碰通知；通知移到调用方
# `with` 块退出 (commit 完成) 之后，按 created 是否为真调用
# `governance.notify_pending_suggestion(db_path)`（独立、全新连接，不复用调用方 conn）。


def _fetch_notifications(db_path: str) -> list[dict]:
    nconn = sqlite3.connect(db_path)
    nconn.row_factory = sqlite3.Row
    try:
        rows = nconn.execute("SELECT * FROM notification ORDER BY id").fetchall()
    finally:
        nconn.close()
    return [dict(r) for r in rows]


def _patch_notify_center_fast_timeout(monkeypatch) -> None:
    """把 NotifyCenter 内部连接的 busy_timeout 缩短到亚秒级——仅用于让「事务内调用会
    卡住」的红测试快跑，不改生产默认 (NotifyCenter._connect 硬编码 timeout=30.0 /
    busy_timeout=30000)。"""
    from src.notify.center import NotifyCenter

    def _fast_connect(self):
        conn = sqlite3.connect(self.db_path, timeout=0.2)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = 200")
        return conn

    monkeypatch.setattr(NotifyCenter, "_connect", _fast_connect)


def test_publish_inside_open_transaction_raises_locked(db, monkeypatch):
    """钉住死锁机制本身: 外层 conn 持有未提交的写事务时, 任何人在其内部尝试
    NotifyCenter.publish (独立连接 BEGIN IMMEDIATE) 都会抢不到锁而抛
    OperationalError('database is locked')——这正是最初实现的运行时症状
    (被 create_suggestion 自己的 try/except 吞掉, 表现为「通知永远发不出去」)。"""
    from src.notify.center import NotifyCenter

    _patch_notify_center_fast_timeout(monkeypatch)
    conn, path = db
    result = _proposal(conn)  # INSERT 已执行, conn 仍处于未提交的隐式写事务
    assert result["created"] is True

    with pytest.raises(sqlite3.OperationalError, match="locked"):
        NotifyCenter(path).publish(
            category="reviews", source="contact", title="t",
            dedupe_key="contact_suggestion:pending",
        )


def test_create_suggestion_returns_fast_and_never_calls_notify_directly(db, monkeypatch):
    """回归闸: create_suggestion 不再在内部调用 notify_pending_suggestion——
    用 spy 直接断言调用关系 (比计时更确定), 同时用缩短的 busy_timeout 兜底断言
    耗时远低于「卡在锁上」的量级 (双重信号, 变异验证时任一个都应该翻红)。"""
    called = []
    monkeypatch.setattr(governance, "notify_pending_suggestion", lambda *a, **kw: called.append(a))
    _patch_notify_center_fast_timeout(monkeypatch)

    import time as _time

    conn, _path = db
    started = _time.monotonic()
    result = _proposal(conn)
    elapsed = _time.monotonic() - started

    assert result["created"] is True
    assert called == []  # create_suggestion 自己从不调用 notify_pending_suggestion
    assert elapsed < 0.1  # 远低于 200ms 的 fast busy_timeout —— 没有尝试抢外层的写锁


def test_notify_pending_suggestion_after_commit_publishes(db):
    """修法路径: commit 之后再调用 notify_pending_suggestion, 独立连接不再有锁竞争。"""
    conn, path = db
    result = _proposal(conn)
    conn.commit()
    assert result["created"] is True

    governance.notify_pending_suggestion(path)

    rows = _fetch_notifications(path)
    assert len(rows) == 1
    row = rows[0]
    assert row["category"] == "reviews"
    assert row["severity"] == "info"
    assert row["source"] == "contact"
    assert row["dedupe_key"] == "contact_suggestion:pending"
    assert "1" in row["body"]
    payload = json.loads(row["payload_json"])
    assert payload["link"] == {"type": "contact_queue"}


def test_notify_pending_suggestion_bumps_recurrence_for_each_created_call(db):
    """聚合计次: 调用方对每条 created=True 的建议各调一次, dedupe_key 聚合到同一行。"""
    conn, path = db
    organization = _proposal(conn, payload={"field": "organization", "value": "ACME"})
    department = _proposal(conn, payload={"field": "department", "value": "Platform"})
    conn.commit()
    assert organization["created"] is True
    assert department["created"] is True

    governance.notify_pending_suggestion(path)
    governance.notify_pending_suggestion(path)

    rows = _fetch_notifications(path)
    assert len(rows) == 1  # 聚合到同一行, 不是两行
    row = rows[0]
    assert row["recurrence_no"] == 2
    assert "2" in row["body"]


def test_duplicate_suggestion_created_false_is_the_caller_gate(db):
    """created=False 时调用方 (profile.py / contact_agent.py) 不该再调
    notify_pending_suggestion——这里只验证 create_suggestion 的返回值门禁本身正确
    (调用方门禁逻辑见 tests/contacts/test_profile.py / test_governance_api.py)。"""
    conn, path = db
    first = _proposal(conn)
    second = _proposal(conn)
    conn.commit()
    assert first["created"] is True
    assert second["created"] is False

    governance.notify_pending_suggestion(path)  # 只有 first 该触发, 调用方只调一次

    rows = _fetch_notifications(path)
    assert len(rows) == 1
    assert rows[0]["recurrence_no"] == 1


def test_notify_publish_failure_does_not_break_suggestion_creation(db, monkeypatch):
    """notify_pending_suggestion 自身吞异常, 不影响调用方的其余逻辑。"""
    from src.notify.center import NotifyCenter

    conn, path = db

    def boom(*a, **kw):
        raise RuntimeError("notify center down")

    monkeypatch.setattr(NotifyCenter, "publish", boom)
    result = _proposal(conn)
    conn.commit()
    assert result["created"] is True

    governance.notify_pending_suggestion(path)  # 不应抛出
    assert _fetch_notifications(path) == []


@pytest.mark.parametrize(
    ("field", "value", "frame_text", "expected_payload"),
    [
        (
            "department",
            "A/B/C [id: 11]",
            "# Departments\nA / B",
            {"field": "department", "value": "A / B / C"},
        ),
        (
            "department",
            "X/Y [id: 11]",
            "# Departments\nA / B",
            {"field": "department", "value": "X / Y", "out_of_frame": True},
        ),
        (
            "organization",
            "Other [id: 11]",
            "# Companies\nAcme | acme.example",
            {"field": "organization", "value": "Other", "out_of_frame": True},
        ),
        (
            "organization",
            "Acme [id: 11]",
            "# Companies\nAcme | acme.example",
            {"field": "organization", "value": "Acme"},
        ),
        (
            "department",
            "X/Y [id: 11]",
            "",
            {"field": "department", "value": "X / Y"},
        ),
    ],
)
def test_identity_org_frame_normalization_and_soft_marking(
    db, field, value, frame_text, expected_payload
):
    conn, _ = db
    created = governance.create_suggestion(
        conn,
        suggestion_type="identity",
        contact_ids=[1],
        payload={"field": field, "value": value},
        evidence=[{"message_id": "m-new", "quote": "identity evidence"}],
        now_ms=1000,
        org_frame=parse_org_frame(frame_text),
    )
    stored = conn.execute(
        "SELECT payload_json FROM contact_suggestion WHERE id=?", (created["id"],)
    ).fetchone()[0]
    assert json.loads(stored) == expected_payload


def test_identity_ignored_field_does_not_revive_for_a_new_value(db):
    conn, _ = db
    first = _proposal(conn)
    governance.ignore_suggestion(conn, first["id"], now_ms=2000)
    second = _proposal(
        conn, payload={"field": "organization", "value": "ACME Corporation"}
    )
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


def test_adopt_identity_suggestion_strips_legacy_evidence_refs(db):
    conn, _ = db
    identity = _proposal(
        conn,
        payload={"field": "organization", "value": "ACME  Labs [id: 11]"},
    )
    governance.adopt_suggestion(conn, identity["id"], now_ms=3000)
    assert conn.execute(
        "SELECT organization FROM contact WHERE id=1"
    ).fetchone()[0] == "ACME Labs"


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


def test_bulk_adopt_skips_merge_blocks_guarded_and_keeps_going(db):
    """整批采纳：merge 归 skipped（仍 pending）、被守卫拦下的归 blocked，
    都**不打断**批里其余几条 —— 一条挡住全批回滚等于没有整批口。"""
    conn, _ = db
    identity = _proposal(conn)
    merge = _proposal(conn, "merge", [1, 2], {})
    # former_email 指向唯一主邮箱 → 采纳时被 E_PRIMARY_EMAIL_CANNOT_BE_FORMER 拦下。
    former = _proposal(conn, "former_email", [1], {"email": "alice@example.com"})
    kind = _proposal(conn, "kind", [2], {"kind": "robot"})

    result = governance.bulk_resolve_suggestions(conn, action="adopt", now_ms=5000)

    assert result["action"] == "adopt"
    assert result["adopted"] == 2
    assert result["ignored"] == 0
    assert result["skipped"] == [
        {"id": merge["id"], "reason": governance.CONTACT_SUGGESTION_BULK_SKIP_MERGE}
    ]
    assert [item["id"] for item in result["blocked"]] == [former["id"]]
    assert result["blocked"][0]["code"] == "E_PRIMARY_EMAIL_CANNOT_BE_FORMER"
    # merge 那条还留在队列里等人工确认 → remaining 记它一条。
    assert result["remaining"] == 1
    assert result["contact_ids"] == [1, 2]

    statuses = dict(
        conn.execute("SELECT id, status FROM contact_suggestion").fetchall()
    )
    assert statuses[identity["id"]] == "adopted"
    assert statuses[kind["id"]] == "adopted"
    assert statuses[merge["id"]] == "pending"
    assert statuses[former["id"]] == "blocked"
    # 真的写进了主表（不是只翻了建议行的状态）。
    assert conn.execute("SELECT organization FROM contact WHERE id=1").fetchone()[0] == "ACME"
    assert conn.execute("SELECT kind FROM contact WHERE id=2").fetchone()[0] == "robot"


def test_bulk_ignore_marks_everything_including_merge(db):
    """忽略没有主表副作用，merge 也一起收 —— 与采纳口的分叉只在 adopt 这一侧。"""
    conn, _ = db
    _proposal(conn)
    _proposal(conn, "merge", [1, 2], {})

    result = governance.bulk_resolve_suggestions(conn, action="ignore", now_ms=5100)

    assert (result["ignored"], result["adopted"]) == (2, 0)
    assert result["skipped"] == [] and result["blocked"] == []
    assert result["remaining"] == 0
    # 主表零副作用，也就没有可失效的联系人。
    assert result["contact_ids"] == []
    assert [row[0] for row in conn.execute("SELECT status FROM contact_suggestion")] == [
        "ignored",
        "ignored",
    ]


def test_bulk_truncates_at_limit_and_reports_remaining(db, monkeypatch):
    conn, _ = db
    monkeypatch.setattr(governance, "CONTACT_SUGGESTION_BULK_MAX", 2)
    # 三条各指一个人：同证据同类型同人会被 create_suggestion 判重合成一条。
    for contact_id in (1, 2, 3):
        _proposal(conn, "kind", [contact_id], {"kind": "robot"})

    result = governance.bulk_resolve_suggestions(conn, action="ignore", now_ms=5200)

    assert result["ignored"] == 2
    assert result["remaining"] == 1


def test_bulk_rejects_unknown_action(db):
    conn, _ = db
    with pytest.raises(ContactError) as exc_info:
        governance.bulk_resolve_suggestions(conn, action="delete", now_ms=5300)
    assert exc_info.value.code == "E_INVALID_ARG"


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


def test_spec_shape(db, monkeypatch):
    import src.config as config_module

    _, path = db
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE report_agent SET model='provider:model', "
            "fallback_models_json='[\"fallback:a\"]' "
            "WHERE id='contact_governance_agent'"
        )
        conn.commit()
    monkeypatch.setattr(
        config_module,
        "config",
        SimpleNamespace(
            sync_store_db_path=path,
        ),
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
    assert spec["model"] == "provider:model"
    assert spec["fallbackModels"] == ["fallback:a"]
    assert spec["useKos"] is True
    assert "kos_search / kos_get_page" in spec["prompt"]["taskPrompt"]
    assert "KOS 是参考，不是证据" in spec["prompt"]["taskPrompt"]
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
    # env 闸已退役（2026-08-19 cutover）：assemble 不再有 E_DISABLED 分支。


def test_governance_use_kos_hot_read_default_and_spec_disable(db, monkeypatch):
    import src.config as config_module

    _, path = db
    initial = get_contact_governance_agent_config(path)
    assert initial.use_kos is True
    with sqlite3.connect(path) as conn:
        conn.execute(
            "UPDATE report_agent SET enabled=1, trigger_json=? "
            "WHERE id='contact_governance_agent'",
            (json.dumps({"fire_hour": "bad", "use_kos": False}),),
        )
        conn.commit()
    cfg = get_contact_governance_agent_config(path)
    assert cfg.fire_hour == 5
    assert cfg.use_kos is False
    monkeypatch.setattr(
        config_module,
        "config",
        SimpleNamespace(
            contacts_enabled=True,
            contact_agent_enabled=True,
            sync_store_db_path=path,
        ),
    )
    job = AsyncJob(
        job_id=8, job_type="contact_governance", target_kind="contact_directory",
        target_key="global", params={"trigger_kind": "schedule"}, status="queued",
        idempotency_key=None, created_at=1.0, updated_at=1.0,
        progress_done=0, progress_total=0, checkpoint_internal_id=None,
        result=None, last_error=None, started_at=None, finished_at=None,
    )
    spec = governance.assemble_contact_governance_spec(job)
    assert spec["useKos"] is False
    assert "kos_search / kos_get_page" not in spec["prompt"]["taskPrompt"]


def test_scheduled_tick_uses_row_enabled_and_fire_hour(db, monkeypatch):
    import src.mail.new_watcher as watcher_module

    conn, path = db
    conn.execute(
        "UPDATE report_agent SET enabled=1, trigger_json='{\"fire_hour\":5}' "
        "WHERE id='contact_governance_agent'"
    )
    conn.commit()
    class FixedDateTime:
        hour = 4

        @classmethod
        def now(cls):
            return real_datetime(
                2026,
                8,
                20,
                cls.hour,
                tzinfo=real_datetime.now().astimezone().tzinfo,
            )

    monkeypatch.setattr(watcher_module, "datetime", FixedDateTime)

    fake = SimpleNamespace(
        _last_contact_governance_check_at=None,
        sync_store=SimpleNamespace(db_path=path),
    )
    asyncio.run(NewWatcher._contact_governance_tick(fake))
    with sqlite3.connect(path) as check:
        assert check.execute(
            "SELECT COUNT(*) FROM async_jobs WHERE job_type='contact_governance'"
        ).fetchone()[0] == 0

    FixedDateTime.hour = 5
    due = SimpleNamespace(
        _last_contact_governance_check_at=None,
        sync_store=SimpleNamespace(db_path=path),
    )
    asyncio.run(NewWatcher._contact_governance_tick(due))
    with sqlite3.connect(path) as check:
        assert check.execute(
            "SELECT COUNT(*) FROM async_jobs WHERE job_type='contact_governance'"
        ).fetchone()[0] == 1

    conn.execute(
        "UPDATE report_agent SET enabled=0 WHERE id='contact_governance_agent'"
    )
    conn.execute(
        "DELETE FROM sync_state WHERE key=?",
        (governance.CONTACT_GOVERNANCE_FIRE_KEY,),
    )
    conn.execute("DELETE FROM async_jobs WHERE job_type='contact_governance'")
    conn.commit()
    disabled = SimpleNamespace(
        _last_contact_governance_check_at=None,
        sync_store=SimpleNamespace(db_path=path),
    )
    asyncio.run(NewWatcher._contact_governance_tick(disabled))
    with sqlite3.connect(path) as check:
        assert check.execute(
            "SELECT COUNT(*) FROM async_jobs WHERE job_type='contact_governance'"
        ).fetchone()[0] == 0


def test_default_prompt_has_five_categories_and_evidence_requirement():
    prompt = governance.default_governance_prompt()
    assert "通讯录管理员" in prompt
    assert all(f"{number}." in prompt for number in range(1, 6))
    assert "message_id" in prompt

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from types import SimpleNamespace

import pytest
from jsonschema import ValidationError, validate

from src.contacts import profile
from src.contacts.profile_config import ContactProfileAgentConfig
from src.contacts.profile_config import get_contact_profile_agent_config
from src.contacts.profile_prompts import PROFILE_TOOL_SCHEMA, build_profile_system_prompt
from src.llm_agent.client import LLMResult
from src.mail.sync_store import SyncStore


def _conn(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _seed_contact(
    path,
    contact_id: int,
    *,
    mail_count: int = 50,
    sent_to_count: int = 1,
    kind: str = "person",
    hidden_at=None,
    merged_into=None,
    is_self: int = 0,
    profile_json=None,
    profile_updated_at=None,
    profile_mail_count=None,
    profile_status=None,
    profile_attempted_at=None,
    last_seen_at=None,
):
    with _conn(path) as conn:
        conn.execute(
            "INSERT INTO contact (id, display_name, kind, hidden_at, merged_into, is_self, "
            "mail_count, sent_to_count, profile_json, profile_updated_at, "
            "profile_mail_count, profile_status, profile_attempted_at, last_seen_at, "
            "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1)",
            (
                contact_id,
                f"Person {contact_id}",
                kind,
                hidden_at,
                merged_into,
                is_self,
                mail_count,
                sent_to_count,
                json.dumps(profile_json, ensure_ascii=False) if profile_json else None,
                profile_updated_at,
                profile_mail_count,
                profile_status,
                profile_attempted_at,
                last_seen_at,
            ),
        )
        conn.execute(
            "INSERT INTO contact_email (id, contact_id, email_normalized, is_primary, created_at) "
            "VALUES (?,?,?,?,1)",
            (contact_id, contact_id, f"p{contact_id}@example.com", 1),
        )
        conn.commit()


def _seed_mail(
    path,
    contact_id: int,
    internal_id: int,
    body,
    *,
    subject="Subject",
    sender_email=None,
    role="sender",
):
    sender_email = sender_email or f"p{contact_id}@example.com"
    with _conn(path) as conn:
        conn.execute(
            "INSERT INTO email_metadata (internal_id, subject, sender, sender_email, "
            "date_received, mailbox) VALUES (?,?,?,?,?,?)",
            (
                internal_id,
                subject,
                f"Sender <{sender_email}>",
                sender_email,
                f"2026-08-{min(internal_id, 28):02d}T10:00:00+00:00",
                "INBOX",
            ),
        )
        if body is not None:
            conn.execute(
                "INSERT INTO email_body (internal_id, body_markdown, body_format, "
                "body_size_bytes, fetched_at, fetched_source) VALUES (?,?,?,?,1,'test')",
                (internal_id, body, "text-only", len(body)),
            )
        conn.execute(
            "INSERT INTO contact_email_link (email_id, internal_id, role, seen_at) "
            "VALUES (?,?, ?, ?)",
            (contact_id, internal_id, role, internal_id * 1000),
        )
        conn.commit()


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return str(path)


def test_candidate_admission_and_incremental_boundaries(db):
    now = 2_000_000_000_000
    old = now - 30 * 24 * 60 * 60 * 1000
    _seed_contact(db, 1, mail_count=49)
    _seed_contact(db, 2, mail_count=50)
    _seed_contact(db, 3, hidden_at=1)
    _seed_contact(db, 4, kind="robot")
    _seed_contact(db, 5, sent_to_count=0)
    _seed_contact(db, 6, is_self=1)
    _seed_contact(db, 7, merged_into=2)
    _seed_contact(
        db, 8, mail_count=59, profile_json={"summary": "old"},
        profile_updated_at=now - 1, profile_mail_count=50, last_seen_at=now,
    )
    _seed_contact(
        db, 9, mail_count=60, profile_json={"summary": "old"},
        profile_updated_at=now - 1, profile_mail_count=50, last_seen_at=now,
    )
    _seed_contact(
        db, 10, profile_json={"summary": "old"}, profile_updated_at=old,
        profile_mail_count=50, last_seen_at=old + 1,
    )
    _seed_contact(
        db, 11, profile_json={"summary": "old"}, profile_updated_at=old,
        profile_mail_count=50, last_seen_at=old,
    )
    with _conn(db) as conn:
        ids = [
            row["id"]
            for row in profile.select_profile_candidates(conn, now_ms=now, limit=50)
        ]
    assert ids == [2, 6, 9, 10]


def test_evidence_budget_none_body_incremental_and_fence(db, monkeypatch):
    _seed_contact(db, 1, mail_count=3)
    _seed_mail(db, 1, 1, "A" * 3000, subject="Long")
    _seed_mail(db, 1, 2, None, subject="No body")
    calls = []
    real_fence = profile.fence_email_envelope

    def tracking_fence(**kwargs):
        calls.append(kwargs)
        return real_fence(**kwargs)

    monkeypatch.setattr(profile, "fence_email_envelope", tracking_fence)
    with _conn(db) as conn:
        evidence = profile.build_profile_evidence(
            conn, contact_id=1, db_path=db
        )
    assert evidence.mode == "first"
    assert evidence.mail_count == 2
    assert len(calls) == 2
    by_id = {call["internal_id"]: call for call in calls}
    assert by_id[2]["body_markdown"] is None
    assert "…[truncated]" in by_id[1]["body_markdown"]
    assert len(by_id[1]["body_markdown"]) <= (
        profile.PROFILE_EVIDENCE_CHAR_BUDGET // profile.PROFILE_EVIDENCE_MAIL_LIMIT
    )

    with _conn(db) as conn:
        conn.execute(
            "UPDATE contact SET profile_json=? WHERE id=1",
            (json.dumps({"summary": "old", "evidence_window": {"to": 1}}),),
        )
        conn.commit()
    with _conn(db) as conn:
        incremental = profile.build_profile_evidence(
            conn, contact_id=1, db_path=db
        )
    assert incremental.mode == "incremental"
    assert incremental.mail_count == 1
    assert incremental.first_internal_id == 2
    assert "BACKGROUND ONLY; DO NOT CITE" in incremental.user_content

    with _conn(db) as conn:
        refreshed = profile.build_profile_evidence(
            conn, contact_id=1, db_path=db, full_refresh=True
        )
    assert refreshed.mode == "first"
    assert refreshed.mail_count == 2
    assert refreshed.first_internal_id == 1
    assert "BACKGROUND ONLY; DO NOT CITE" not in refreshed.user_content


def test_evidence_prioritizes_target_authored_before_participation(db):
    _seed_contact(db, 1, mail_count=25)
    _seed_mail(db, 1, 1, "Target-authored signal " * 30)
    for internal_id in range(2, 26):
        _seed_mail(
            db,
            1,
            internal_id,
            f"Broadcast {internal_id} " * 30,
            sender_email="owner@example.com",
            role="cc",
        )

    with _conn(db) as conn:
        evidence = profile.build_profile_evidence(conn, contact_id=1, db_path=db)

    assert evidence.mail_count == profile.PROFILE_EVIDENCE_MAIL_LIMIT
    assert evidence.first_internal_id == 1
    assert evidence.last_internal_id == 25
    assert "Broadcast 6" not in evidence.user_content
    assert evidence.user_content.index("Target-authored signal") < evidence.user_content.index("Broadcast 25")


def test_prompt_family_contains_skip_actions_and_custom_append():
    first = build_profile_system_prompt(
        mode="first",
        target_display_name="Gary W",
        target_primary_email="gary.w@example.com",
        custom_prompt="owner tail",
    )
    incremental = build_profile_system_prompt(
        mode="incremental",
        target_display_name="Gary W",
        target_primary_email="gary.w@example.com",
    )
    assert '{"skip": true' in first
    assert "owner tail" in first
    assert "强化 / 补充 / 修正 / 重构 / 不改" not in first
    assert "强化 / 补充 / 修正 / 重构 / 不改" in incremental
    assert "BACKGROUND ONLY" in incremental
    assert '"ev": <primary evidence internal_id or null>' in first
    assert "summary and other narrative fields" in first
    assert first.startswith("TARGET CONTACT")
    assert "Gary W" in first
    assert "gary.w@example.com" in first
    assert "no target signal" in first
    assert "Never write a profile about anyone other than the TARGET CONTACT" in first
    assert "TARGET CONTACT remains the only person" in incremental


def test_profile_config_hot_reads_row_and_bad_trigger_defaults(db):
    initial = get_contact_profile_agent_config(db)
    assert initial.row_exists is True
    assert initial.enabled is False
    assert initial.fire_hour == 4
    assert initial.daily_limit == 50
    with _conn(db) as conn:
        conn.execute(
            "UPDATE report_agent SET enabled=1, model='provider:model', "
            "fallback_models_json='[\"fallback:a\"]', prompt='tail', "
            "trigger_json='not-json' WHERE id='contact_profile_agent'"
        )
        conn.commit()
    updated = get_contact_profile_agent_config(db)
    assert updated.enabled is True
    assert updated.model == "provider:model"
    assert updated.fallback_models == ["fallback:a"]
    assert updated.prompt == "tail"
    assert updated.fire_hour == 4
    assert updated.daily_limit == 50


def test_model_chain_double_follow_semantics(monkeypatch):
    monkeypatch.setattr(profile.app_config, "llm_model", "global:primary")
    monkeypatch.setattr(
        profile.app_config, "llm_fallback_models", "global:a, global:b"
    )
    assert profile._model_chain(ContactProfileAgentConfig()) is None
    assert profile._model_chain(
        ContactProfileAgentConfig(model="row:primary")
    ) == ["row:primary", "global:a", "global:b"]
    assert profile._model_chain(
        ContactProfileAgentConfig(fallback_models=[])
    ) == ["global:primary"]


class _FakeClient:
    def __init__(self, payload):
        self.payload = payload

    async def classify(self, **kwargs):
        return LLMResult(
            tool_input=self.payload,
            input_tokens=1,
            output_tokens=1,
            cache_creation_input_tokens=0,
            cache_read_input_tokens=0,
            model="test:model",
            latency_ms=1,
        )


def _valid_payload():
    return {
        "summary": "长期负责项目协调 [id:1]",
        "role_title": "Project Manager",
        "formal_name": "Person 1",
        "department": "PMO",
        "topics": ["交付"],
        "projects": ["Atlas"],
        "communication_style": "简洁",
        "contact_info": {"phone": "+1 555"},
        "evolution": [{"at": "2026-08", "text": "开始负责 Atlas 交付", "ev": 1}],
        "contradictions": [],
        "evidence_window": {"from": 1, "to": 1, "mail_count": 1, "mode": "first"},
    }


def test_profile_schema_requires_structured_evolution_and_unambiguous_skip():
    validate(instance=_valid_payload(), schema=PROFILE_TOOL_SCHEMA["input_schema"])

    string_evolution = _valid_payload()
    string_evolution["evolution"] = ["2026-08 开始负责 Atlas 交付 [id:1]"]
    with pytest.raises(ValidationError):
        validate(
            instance=string_evolution,
            schema=PROFILE_TOOL_SCHEMA["input_schema"],
        )

    ambiguous_skip = _valid_payload()
    ambiguous_skip.update({"skip": False, "reason": "not actually skipped"})
    with pytest.raises(ValidationError):
        validate(
            instance=ambiguous_skip,
            schema=PROFILE_TOOL_SCHEMA["input_schema"],
        )

    # 2026-08-19 真机全员生成失败的回归：prompt 强调 skip 规则后模型会顺手输出
    # "skip": false 甚至 "reason": null —— 两者都必须放行（null 无害，写库前 pop），
    # 只有字符串 reason（上面那条）保持非法。
    explicit_not_skip = _valid_payload()
    explicit_not_skip["skip"] = False
    validate(instance=explicit_not_skip, schema=PROFILE_TOOL_SCHEMA["input_schema"])
    null_reason = _valid_payload()
    null_reason.update({"skip": False, "reason": None})
    validate(instance=null_reason, schema=PROFILE_TOOL_SCHEMA["input_schema"])


@pytest.mark.asyncio
async def test_generation_g1_skip_fail_closed_skip_and_success(db):
    _seed_contact(db, 1, mail_count=50)
    _seed_mail(db, 1, 1, "short")
    assert profile.claim_profile_run(db, 1)
    status = await profile.generate_contact_profile(db, 1, client=_FakeClient(_valid_payload()))
    assert status == "skipped"
    with _conn(db) as conn:
        row = conn.execute("SELECT * FROM contact WHERE id=1").fetchone()
        assert row["profile_status"] == "skipped"
        assert row["profile_mail_count"] is None
        assert json.loads(row["profile_error"])["mail_count"] == 1

    with _conn(db) as conn:
        conn.execute(
            "UPDATE email_body SET body_markdown=?, body_size_bytes=? WHERE internal_id=1",
            ("Evidence " * 100, 900),
        )
        conn.execute(
            "UPDATE contact SET profile_json=?, profile_mail_count=40, profile_status=NULL WHERE id=1",
            (json.dumps({"summary": "previous"}),),
        )
        conn.commit()
    assert profile.claim_profile_run(db, 1)
    assert await profile.generate_contact_profile(db, 1, client=_FakeClient({})) == "failed"
    with _conn(db) as conn:
        row = conn.execute("SELECT * FROM contact WHERE id=1").fetchone()
        assert json.loads(row["profile_json"])["summary"] == "previous"
        assert row["profile_mail_count"] == 40
        assert row["profile_status"] == "failed"

    assert profile.claim_profile_run(db, 1)
    assert await profile.generate_contact_profile(
        db, 1, client=_FakeClient({"skip": True, "reason": "too weak"})
    ) == "ok"
    with _conn(db) as conn:
        row = conn.execute("SELECT * FROM contact WHERE id=1").fetchone()
        assert row["profile_mail_count"] == 40
        assert row["profile_status"] == "ok"
        assert json.loads(row["profile_json"])["summary"] == "previous"

    assert profile.claim_profile_run(db, 1)
    assert await profile.generate_contact_profile(
        db, 1, client=_FakeClient(_valid_payload())
    ) == "ok"
    with _conn(db) as conn:
        row = conn.execute("SELECT * FROM contact WHERE id=1").fetchone()
        saved = json.loads(row["profile_json"])
        assert row["profile_status"] == "ok"
        assert row["profile_mail_count"] == 50
        assert row["profile_model"] == "test:model"
        assert row["profile_error"] is None
        assert saved["evidence_window"]["mail_count"] == 1


@pytest.mark.asyncio
async def test_anchor_mismatch_fails_without_overwriting_profile_or_watermark(db):
    previous = {
        "summary": "Existing profile",
        "evidence_window": {"from": 1, "to": 7, "mail_count": 7, "mode": "first"},
    }
    _seed_contact(
        db,
        1,
        mail_count=50,
        profile_json=previous,
        profile_mail_count=40,
        profile_status="ok",
    )
    _seed_mail(db, 1, 8, "Fresh target evidence " * 30)
    assert profile.claim_profile_run(db, 1)
    mismatched = _valid_payload()
    mismatched["formal_name"] = "Lucien Chen"

    assert await profile.generate_contact_profile(
        db, 1, client=_FakeClient(mismatched)
    ) == "failed"
    with _conn(db) as conn:
        row = conn.execute("SELECT * FROM contact WHERE id=1").fetchone()
        assert json.loads(row["profile_json"]) == previous
        assert row["profile_mail_count"] == 40
        assert row["profile_status"] == "failed"
        assert json.loads(row["profile_error"]) == {
            "reason": "anchor_mismatch",
            "profiled": "Lucien Chen",
        }


@pytest.mark.asyncio
@pytest.mark.parametrize("formal_name", ["Personality", "p1 Rivera"])
async def test_anchor_match_accepts_display_substring_and_email_localpart(db, formal_name):
    _seed_contact(db, 1, mail_count=50)
    _seed_mail(db, 1, 1, "Target evidence " * 30)
    assert profile.claim_profile_run(db, 1)
    payload = _valid_payload()
    payload["formal_name"] = formal_name

    assert await profile.generate_contact_profile(
        db, 1, client=_FakeClient(payload)
    ) == "ok"


@pytest.mark.asyncio
async def test_existing_profile_g1_skip_restores_ok_without_moving_watermark(db):
    previous = {
        "summary": "Existing profile",
        "evidence_window": {"from": 1, "to": 7, "mail_count": 7, "mode": "first"},
    }
    _seed_contact(
        db,
        1,
        mail_count=50,
        profile_json=previous,
        profile_mail_count=40,
        profile_status="ok",
    )
    _seed_mail(db, 1, 8, "short")
    assert profile.claim_profile_run(db, 1)

    assert await profile.generate_contact_profile(
        db, 1, client=_FakeClient(_valid_payload())
    ) == "ok"
    with _conn(db) as conn:
        row = conn.execute("SELECT * FROM contact WHERE id=1").fetchone()
        assert row["profile_status"] == "ok"
        assert json.loads(row["profile_json"]) == previous
        assert row["profile_mail_count"] == 40


def test_profile_due_once_and_catchup():
    before = datetime(2026, 8, 19, 3, 59)
    at = datetime(2026, 8, 19, 4, 0)
    later = datetime(2026, 8, 19, 12, 0)
    marker = profile.profile_slot_marker(at, 4)
    assert not profile.profile_due(before, 4, None)
    assert profile.profile_due(at, 4, None)
    assert profile.profile_due(later, 4, None)
    assert not profile.profile_due(later, 4, marker)


@pytest.mark.asyncio
async def test_scheduled_tick_gates_and_failure_still_marks(db, monkeypatch):
    class State:
        def __init__(self):
            self.values = {}

        def get_state(self, key):
            return self.values.get(key)

        def set_state(self, key, value):
            self.values[key] = value

    state = State()
    monkeypatch.setattr(
        profile,
        "get_contact_profile_agent_config",
        lambda _: ContactProfileAgentConfig(row_exists=True, enabled=False),
    )
    assert not await profile.run_scheduled_tick(
        sync_store=state,
        db_path=db,
        settings=SimpleNamespace(),
        now=datetime(2026, 8, 19, 12, 0),
    )

    monkeypatch.setattr(
        profile,
        "get_contact_profile_agent_config",
        lambda _: ContactProfileAgentConfig(row_exists=True, enabled=True, fire_hour=4),
    )

    async def broken(**kwargs):
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await profile.run_scheduled_tick(
            sync_store=state,
            db_path=db,
            settings=SimpleNamespace(),
            now=datetime(2026, 8, 19, 12, 0),
            run_batch_fn=broken,
        )
    assert state.values[profile.PROFILE_LAST_FIRE_KEY] == "20260819-04"


@pytest.mark.asyncio
async def test_batch_daily_limit_sort_and_stale_running_cleanup(db):
    _seed_contact(db, 1, mail_count=80)
    _seed_contact(db, 2, mail_count=100, profile_json={"summary": "old"}, profile_mail_count=80)
    _seed_contact(db, 3, mail_count=90)
    _seed_contact(
        db, 4, mail_count=0, sent_to_count=0, profile_status="running", profile_attempted_at=1
    )
    seen = []

    async def fake_generate(db_path, contact_id, **kwargs):
        seen.append(contact_id)
        with _conn(db_path) as conn:
            conn.execute(
                "UPDATE contact SET profile_status='ok', profile_updated_at=2, "
                "profile_mail_count=mail_count WHERE id=?",
                (contact_id,),
            )
            conn.commit()
        return "ok"

    stats = await profile.run_profile_batch(
        db_path=db,
        cfg=ContactProfileAgentConfig(row_exists=True, enabled=True, daily_limit=2),
        now_ms=10,
        generate_fn=fake_generate,
    )
    assert seen == [3, 1]
    assert stats == {"candidates": 2, "ran": 2, "ok": 2, "skipped": 0, "failed": 0}
    with _conn(db) as conn:
        stale = conn.execute("SELECT * FROM contact WHERE id=4").fetchone()
        assert stale["profile_status"] == "failed"
        assert stale["profile_error"] == "interrupted before completion"

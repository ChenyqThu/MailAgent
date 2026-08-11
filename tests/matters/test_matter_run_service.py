"""MatterRunService（P4 D3/D4）：watermark 形状与 rev 规则 / enqueue / coalesce /
幂等重放 / cancel 三态 / lifecycle_state 七值。"""

from __future__ import annotations

import json
import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.run_service import (
    MATTER_RUN_LIFECYCLE_STATES,
    MatterRunService,
    lifecycle_state,
    watermark_diff,
)
from src.matters.service import MatterError
from src.sync.async_jobs import AsyncJobRepository


def _seed_emails(db_path: str) -> None:
    conn = sqlite3.connect(db_path)
    try:
        for iid, thread_id in ((201, "TA"), (202, "TA"), (203, None)):
            conn.execute(
                "INSERT INTO email_metadata (internal_id, message_id, thread_id, "
                "subject, sender, date_received, mailbox, sync_status, is_read, "
                "is_flagged, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,0,0,1,1)",
                (
                    iid, f"<m-{iid}@x.test>", thread_id, f"S{iid}", "a@x.test",
                    "2026-08-01 09:00:00", "收件箱", "synced",
                ),
            )
        conn.commit()
    finally:
        conn.close()


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "run-service.db"
    SyncStore(str(path))
    _seed_emails(str(path))
    clock = {"now": 10_000}
    service = MatterRunService(
        MatterRepository(path), clock_ms=lambda: clock["now"]
    )
    created = service.create_matter(
        {"title": "Run Matter"}, idempotency_key="create", source="desktop_ui"
    )
    pid = created["matter"]["public_id"]
    version = created["version"]
    return service, pid, version, str(path), clock


def _link(service, pid, version, key, kind, idem, **extra):
    return service.add_resource(
        pid,
        {"provider": "mailagent", "external_key": key, "kind": kind, **extra},
        expected_version=version,
        idempotency_key=idem,
        source="desktop_ui",
    )


# ── watermark（D4）──────────────────────────────────────────────────────────────


def test_watermark_shape_and_rev_rules(env):
    service, pid, version, path, _ = env
    result = _link(service, pid, version, "email:203", "email", "l1")
    result = _link(service, pid, result["version"], "thread:TA", "thread", "l2")
    result = _link(
        service, pid, result["version"], "doc:xyz", "doc", "l3",
        revision="rev-7",
    )
    matter_id = result["matter"]["id"]
    watermark = service.current_watermark(matter_id)
    # 形状（D4 键序）：五键齐备
    assert list(watermark) == [
        "computed_at", "matter_version", "max_event_id",
        "latest_accepted_update_id", "resources",
    ]
    revs = watermark["resources"]
    by_key = {}
    with sqlite3.connect(path) as conn:
        for rid, key in conn.execute("SELECT id, external_key FROM resource"):
            by_key[key] = str(rid)
    assert revs[by_key["email:203"]] == "1"  # email 不可变
    assert revs[by_key["thread:TA"]] == "2:202"  # {成员数}:{max_internal_id}
    assert revs[by_key["doc:xyz"]] == "rev-7"  # revision 优先
    assert watermark["matter_version"] == result["version"]
    assert watermark["max_event_id"] > 0


def test_watermark_excludes_excluded_and_keeps_metadata_only(env):
    service, pid, version, path, _ = env
    result = _link(
        service, pid, version, "doc:meta", "doc", "l1", access_policy="metadata_only"
    )
    result = _link(
        service, pid, result["version"], "doc:excl", "doc", "l2",
        access_policy="excluded",
    )
    matter_id = result["matter"]["id"]
    revs = service.current_watermark(matter_id)["resources"]
    with sqlite3.connect(path) as conn:
        keys = {key: str(rid) for rid, key in conn.execute("SELECT id, external_key FROM resource")}
    assert keys["doc:meta"] in revs  # metadata_only 进指纹
    assert keys["doc:excl"] not in revs  # excluded 完全不进指纹


def test_watermark_diff_baseline_and_changes():
    current = {"max_event_id": 5, "resources": {"1": "a", "2": "b"}}
    first = watermark_diff(None, current)
    assert first["changed"] and first["first_run"]
    same = watermark_diff({"max_event_id": 5, "resources": {"1": "a", "2": "b"}}, current)
    assert not same["changed"]
    moved = watermark_diff({"max_event_id": 3, "resources": {"1": "a", "3": "c"}}, current)
    assert moved["changed"]
    assert moved["added_resources"] == ["2"]
    assert moved["removed_resources"] == ["3"]
    assert moved["new_events"] == 2
    assert moved["touched_resources"] == ["2"]


# ── enqueue / coalesce / 幂等（D3）─────────────────────────────────────────────


def test_enqueue_creates_queued_run_and_async_job(env):
    service, pid, version, path, _ = env
    result = service.enqueue_run(
        pid, expected_version=version, idempotency_key="k1", source="desktop_ui"
    )
    assert result["coalesced"] is False
    run = result["run"]
    assert run["lifecycle_state"] == "queued"
    assert run["trigger_kind"] == "manual"
    assert run["input_watermark"]["matter_version"] == version
    assert run["async_job_id"] is not None
    job = AsyncJobRepository(path).get(run["async_job_id"])
    assert job.job_type == "matter_followup"
    assert job.status == "queued"
    assert job.params == {
        "matter_id": run["matter_id"], "matter_run_id": run["id"],
        "trigger_kind": "manual",
    }
    assert job.idempotency_key == run["idempotency_key"]


def test_enqueue_version_conflict(env):
    service, pid, version, _, _ = env
    with pytest.raises(MatterError) as excinfo:
        service.enqueue_run(
            pid, expected_version=version + 5, idempotency_key="k1",
            source="desktop_ui",
        )
    assert excinfo.value.code == "E_VERSION_CONFLICT"


def test_enqueue_coalesces_onto_active_run(env):
    service, pid, version, _, _ = env
    first = service.enqueue_run(
        pid, expected_version=version, idempotency_key="k1", source="desktop_ui"
    )
    second = service.enqueue_run(
        pid, expected_version=version, idempotency_key="k2", source="desktop_ui"
    )
    assert second["coalesced"] is True
    assert second["run"]["id"] == first["run"]["id"]
    assert second["run"]["coalesced_trigger_count"] == 1
    # 合并不建第二个 job
    assert AsyncJobRepository(
        service.repository.db_path
    ).get(second["run"]["async_job_id"]).job_id == first["run"]["async_job_id"]


def test_enqueue_idempotent_replay_returns_same_run(env):
    service, pid, version, _, _ = env
    first = service.enqueue_run(
        pid, expected_version=version, idempotency_key="k1", source="desktop_ui"
    )
    replay = service.enqueue_run(
        pid, expected_version=version, idempotency_key="k1", source="desktop_ui"
    )
    assert replay["coalesced"] is False
    assert replay["run"]["id"] == first["run"]["id"]
    assert replay["run"]["coalesced_trigger_count"] == 0  # 重放不计入合并


# ── cancel 三态（D3）───────────────────────────────────────────────────────────


def test_cancel_queued_aborts_job_and_sets_canceled(env):
    service, pid, version, path, _ = env
    run = service.enqueue_run(
        pid, expected_version=version, idempotency_key="k1", source="desktop_ui"
    )["run"]
    result = service.cancel_run(
        pid, run["id"], idempotency_key="c1", source="desktop_ui"
    )
    assert result["run"]["lifecycle_state"] == "canceled"
    assert result["run"]["status"] is None
    job = AsyncJobRepository(path).get(run["async_job_id"])
    assert job.status == "aborted"


def test_cancel_running_sets_cancel_requested_and_posts_stop(env, monkeypatch):
    service, pid, version, _, _ = env
    run = service.enqueue_run(
        pid, expected_version=version, idempotency_key="k1", source="desktop_ui"
    )["run"]
    # 模拟 worker 已 claim + started（job 不再 queued → CAS 输 → running 分支）
    AsyncJobRepository(service.repository.db_path).claim_next(
        types=frozenset({"matter_followup"})
    )
    assert service.mark_started(run["id"])
    with service.repository.transaction() as conn:
        conn.execute(
            "UPDATE matter_run SET chat_session_id=77 WHERE id=?", (run["id"],)
        )
    posted = {}
    monkeypatch.setattr(
        MatterRunService, "_post_run_stop",
        lambda self, sid: posted.setdefault("session_id", sid),
    )
    result = service.cancel_run(
        pid, run["id"], idempotency_key="c1", source="desktop_ui"
    )
    assert result["run"]["lifecycle_state"] == "running"  # 仍在跑，等 worker 收敛
    assert result["run"]["cancel_requested_at"] is not None
    assert posted["session_id"] == 77


def test_cancel_terminal_run_is_invalid_state(env):
    service, pid, version, _, _ = env
    run = service.enqueue_run(
        pid, expected_version=version, idempotency_key="k1", source="desktop_ui"
    )["run"]
    assert service.mark_started(run["id"])
    assert service.finish_run(run["id"], "ok")
    with pytest.raises(MatterError) as excinfo:
        service.cancel_run(pid, run["id"], idempotency_key="c1", source="desktop_ui")
    assert excinfo.value.code == "E_INVALID_STATE"


# ── lifecycle_state 七值（D3 单源）─────────────────────────────────────────────


def test_lifecycle_state_seven_values():
    base = {
        "started_at": None, "completed_at": None, "canceled_at": None, "status": None,
    }
    assert lifecycle_state(base) == "queued"
    assert lifecycle_state({**base, "started_at": 1}) == "running"
    for status in ("ok", "noop", "warn", "fail"):
        assert (
            lifecycle_state({**base, "started_at": 1, "completed_at": 2, "status": status})
            == status
        )
    assert lifecycle_state({**base, "canceled_at": 3}) == "canceled"
    # 覆盖顺序：canceled 压过一切；completed+坏 status 保守 fail
    assert lifecycle_state({**base, "started_at": 1, "completed_at": 2, "canceled_at": 3}) == "canceled"
    assert lifecycle_state({**base, "started_at": 1, "completed_at": 2, "status": None}) == "fail"
    assert set(MATTER_RUN_LIFECYCLE_STATES) == {
        "queued", "running", "ok", "noop", "warn", "fail", "canceled",
    }


def test_mark_started_cas_blocks_second_active(env):
    service, pid, version, _, _ = env
    first = service.enqueue_run(
        pid, expected_version=version, idempotency_key="k1", source="desktop_ui"
    )["run"]
    assert service.mark_started(first["id"])
    # 直接插第二条 queued 行（绕过 enqueue 的单活跃检查），CAS 必须撞 partial unique
    with service.repository.transaction() as conn:
        cursor = conn.execute(
            "INSERT INTO matter_run(matter_id,trigger_kind,idempotency_key,"
            "queued_at,created_at) VALUES (?,?,?,?,?)",
            (first["matter_id"], "manual", "raced", 1, 1),
        )
        raced_id = int(cursor.lastrowid)
    assert service.mark_started(raced_id) is False


def test_finish_run_merges_error_and_is_idempotent(env):
    service, pid, version, _, _ = env
    run = service.enqueue_run(
        pid, expected_version=version, idempotency_key="k1", source="desktop_ui"
    )["run"]
    assert service.mark_started(run["id"])
    with service.repository.transaction() as conn:
        service._stash_dropped(conn, run["id"], [{"id": "chg_01", "reason": "x"}])
    assert service.finish_run(
        run["id"], "warn", usage={"steps": 3}, error={"code": "E_X"},
        chat_session_id=9,
    )
    row = service.get_run(run["id"])
    error = json.loads(row["error_json"])
    assert error["code"] == "E_X"
    assert error["dropped"][0]["id"] == "chg_01"  # propose 暂存的 dropped 不被覆盖
    assert row["chat_session_id"] == 9
    # 已终态 → no-op
    assert service.finish_run(run["id"], "ok") is False
    assert service.get_run(run["id"])["status"] == "warn"

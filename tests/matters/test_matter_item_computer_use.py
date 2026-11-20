"""Wave 5: explicit propose_only computer_use_draft dispatch -> spec -> /today closure."""

from __future__ import annotations

import os
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.api.app import app
from src.api.auth import verify_cf_access
from src.api.deps import get_settings
from src.api.routers.matters import get_matter_service
from src.mail.sync_store import SyncStore
from src.matters.attention import AttentionService
from src.matters.events import ITEM_DISPATCHED
from src.matters.models import MatterItemDispatchState, MatterItemExecProfile
from src.matters.repository import MatterRepository
from src.matters.resource_identity import MatterError
from src.matters.run_service import MatterRunService
from src.matters.run_spec import assemble_item_spec
from src.matters.service import Actor, MatterService
from src.notify.center import NotifyCenter
from src.sync.async_jobs import AsyncJobRepository

NOW = 1_787_600_000_000


def _mutation(key: str, *, actor: Actor = Actor()) -> dict[str, object]:
    return {
        "source": "desktop_ui",
        "idempotency_key": key,
        "actor": actor,
    }


@pytest.fixture
def env(tmp_path):
    db_path = tmp_path / "cu_dispatch.db"
    SyncStore(str(db_path))
    repo = MatterRepository(db_path)
    jobs = AsyncJobRepository(db_path)
    clock = lambda: NOW  # noqa: E731
    service = MatterService(repo, job_repo=jobs, clock_ms=clock)
    run_service = MatterRunService(repo, job_repo=jobs, clock_ms=clock)
    attention = AttentionService(repo, clock_ms=clock)
    notify = NotifyCenter(db_path, clock_ms=clock)

    matter = service.create_matter({"title": "报销与供应商门户"}, **_mutation("m-1"))["matter"]
    public_id = matter["public_id"]
    item = service.create_item(
        public_id,
        {
            "kind": "action",
            "title": "登录供应商门户填写草稿",
            "exec_profile": MatterItemExecProfile.PROPOSE_ONLY.value,
        },
        expected_version=matter["version"],
        **_mutation("i-1"),
    )["item"]
    auto_item = service.create_item(
        public_id,
        {
            "kind": "action",
            "title": "全自动普通行动项",
            "exec_profile": MatterItemExecProfile.AUTONOMOUS.value,
        },
        expected_version=matter["version"] + 1,
        **_mutation("i-2"),
    )["item"]
    return SimpleNamespace(
        db_path=db_path,
        repo=repo,
        jobs=jobs,
        service=service,
        run_service=run_service,
        attention=attention,
        notify=notify,
        public_id=public_id,
        item_id=item["id"],
        auto_item_id=auto_item["id"],
    )


def test_dispatch_with_propose_only_computer_use_draft_persists_and_projects_spec(
    env, monkeypatch
):
    dispatched = env.service.dispatch_item(
        env.public_id,
        env.item_id,
        computer_use_draft={
            "allowed_apps": ["  Safari  ", "Notes", "Safari"],
            "allowed_domains": ["https://Portal.Vendor.com/login?next=/form", "linear.app"],
        },
        **_mutation("d-cu-1"),
    )
    dispatch = dispatched["dispatch"]
    assert dispatch["exec_profile"] == "propose_only"
    job = env.jobs.get(dispatch["async_job_id"])
    assert job is not None
    expected_draft = {
        "allowed_apps": ["Safari", "Notes"],
        "allowed_domains": ["portal.vendor.com", "linear.app"],
        "connectors": ["browser_use", "desktop_use"],
    }
    assert job.params["computer_use_draft"] == expected_draft

    # ITEM_DISPATCHED audit event also retains the normalized draft.
    events = env.service.get_matter(env.public_id, include=("timeline",))["timeline"]
    dispatched_events = [e for e in events if e["kind"] == ITEM_DISPATCHED]
    assert len(dispatched_events) == 1
    assert dispatched_events[0]["payload"]["computer_use_draft"] == expected_draft

    # Even when browser_use/desktop_use appear in connected_connector_ids, normal
    # grantConnectors stays read-only for normal connectors and never leaks CU connectors.
    monkeypatch.setattr(
        "src.matters.run_spec.connected_connector_ids",
        lambda _settings: ("notion", "browser_use", "desktop_use"),
    )
    settings = SimpleNamespace(
        sync_store_db_path=str(env.db_path),
        mcp_connectors_enabled=True,
        matter_followup_agent_profile_id="",
    )
    spec = assemble_item_spec(job, settings=settings)
    assert spec["jobId"] == job.job_id
    assert spec["matterItem"]["dispatchId"] == dispatch["id"]
    assert spec["computerUsePolicy"] == {
        "enabled": True,
        "mode": "propose_only",
        "stopBeforeSubmit": True,
        "allowedApps": ["Safari", "Notes"],
        "allowedDomains": ["portal.vendor.com", "linear.app"],
        "connectors": ["browser_use", "desktop_use"],
    }
    # Static tool surface & exec prohibition stay intact; normal connectors stay read-only.
    assert spec["toolPolicy"]["allowedTools"] == []
    assert "grantExec" not in spec["toolPolicy"]
    assert "grantExec" not in spec
    assert spec["toolPolicy"].get("grantConnectors") == {"notion": "read"}
    assert "stop_before_submit=True" in spec["prompt"]["taskPrompt"]
    assert "propose_only" in spec["prompt"]["taskPrompt"]


def test_dispatch_without_computer_use_draft_leaves_spec_unchanged(env):
    dispatched = env.service.dispatch_item(env.public_id, env.item_id, **_mutation("d-plain"))
    dispatch = dispatched["dispatch"]
    job = env.jobs.get(dispatch["async_job_id"])
    assert job is not None
    assert "computer_use_draft" not in job.params

    settings = SimpleNamespace(
        sync_store_db_path=str(env.db_path),
        calendar_enabled=False,
        notion_token="",
        matter_followup_agent_profile_id="",
    )
    spec = assemble_item_spec(job, settings=settings)
    assert "computerUsePolicy" not in spec
    assert "Computer Use Draft Mode" not in spec["prompt"]["taskPrompt"]


def test_dispatch_rejects_autonomous_non_user_wildcards_and_unsafe_schemes(env):
    # Item with autonomous default profile rejects computer_use_draft.
    with pytest.raises(MatterError) as exc:
        env.service.dispatch_item(
            env.public_id,
            env.auto_item_id,
            computer_use_draft={"allowed_domains": ["linear.app"]},
            **_mutation("bad-auto-item"),
        )
    assert exc.value.code == "E_INVALID_STATE"

    # Explicit autonomous / edit_with_approval profile override rejects computer_use_draft.
    for bad_profile in ("autonomous", "edit_with_approval"):
        with pytest.raises(MatterError) as exc:
            env.service.dispatch_item(
                env.public_id,
                env.item_id,
                profile=bad_profile,
                computer_use_draft={"allowed_domains": ["linear.app"]},
                **_mutation(f"bad-profile-{bad_profile}"),
            )
        assert exc.value.code == "E_INVALID_STATE"

    # Non-user actors cannot mint computer_use_draft grants.
    for actor_kind in ("agent", "system"):
        with pytest.raises(MatterError) as exc:
            env.service.dispatch_item(
                env.public_id,
                env.item_id,
                computer_use_draft={"allowed_apps": ["Safari"]},
                **_mutation(
                    f"bad-actor-{actor_kind}",
                    actor=Actor(kind=actor_kind, actor_id="runner-1"),
                ),
            )
        assert exc.value.code == "E_AUTH_FAILED"

    # Empty, bare wildcard, unsafe scheme, unknown connector, unknown key -> E_INVALID_ARG.
    bad_payloads = [
        {},
        {"allowed_apps": [], "allowed_domains": []},
        {"allowed_apps": ["*"]},
        {"allowed_apps": ["Safari*"], "connectors": ["desktop_use"]},
        {"allowed_domains": ["*"]},
        {"allowed_domains": ["*.*"]},
        {"allowed_domains": ["*.com"]},
        {"allowed_domains": ["https://*"]},
        {"allowed_domains": ["file:///etc/passwd"]},
        {"allowed_domains": ["file:/etc/passwd"]},
        {"allowed_domains": ["javascript:alert(1)"]},
        {"allowed_domains": ["data:text/html,<script>"]},
        {"allowed_domains": ["chrome://settings"]},
        {"allowed_domains": ["about:blank"]},
        {"allowed_domains": ["ftp://files.example.com"]},
        {"allowed_domains": ["linear.app"], "connectors": []},
        {"allowed_domains": ["linear.app"], "connectors": ["exec"]},
        {"allowed_domains": ["linear.app"], "grant_exec": True},
    ]
    for idx, payload in enumerate(bad_payloads):
        with pytest.raises(MatterError) as exc:
            env.service.dispatch_item(
                env.public_id,
                env.item_id,
                computer_use_draft=payload,
                **_mutation(f"bad-draft-{idx}"),
            )
        assert exc.value.code == "E_INVALID_ARG", payload


def test_connector_derivation_and_subdomain_wildcard(env):
    d1 = env.service.dispatch_item(
        env.public_id,
        env.item_id,
        computer_use_draft={"allowed_domains": ["*.atlassian.net"]},
        **_mutation("d-sub"),
    )["dispatch"]
    job1 = env.jobs.get(d1["async_job_id"])
    assert job1 is not None
    assert job1.params["computer_use_draft"] == {
        "allowed_apps": [],
        "allowed_domains": ["*.atlassian.net"],
        "connectors": ["browser_use"],
    }


def test_assemble_item_spec_fail_closed_on_tampered_profile_or_job_mismatch(env):
    dispatched = env.service.dispatch_item(
        env.public_id,
        env.item_id,
        computer_use_draft={"allowed_apps": ["Mail"], "connectors": ["desktop_use"]},
        **_mutation("d-tamper"),
    )
    dispatch_id = dispatched["dispatch"]["id"]
    job = env.jobs.get(dispatched["dispatch"]["async_job_id"])
    assert job is not None

    settings = SimpleNamespace(
        sync_store_db_path=str(env.db_path),
        calendar_enabled=False,
        notion_token="",
        matter_followup_agent_profile_id="",
    )

    # Mismatched async_job_id on dispatch row -> E_SPEC_AGENT_INVALID.
    with env.repo.transaction() as conn:
        conn.execute(
            "UPDATE matter_item_dispatch SET async_job_id = ? WHERE id = ?",
            (job.job_id + 999, dispatch_id),
        )
    with pytest.raises(MatterError) as exc:
        assemble_item_spec(job, settings=settings)
    assert exc.value.code == "E_SPEC_AGENT_INVALID"

    # Restore job_id, tamper exec_profile -> autonomous -> E_SPEC_AGENT_INVALID.
    with env.repo.transaction() as conn:
        conn.execute(
            "UPDATE matter_item_dispatch SET async_job_id = ?, exec_profile = 'autonomous' WHERE id = ?",
            (job.job_id, dispatch_id),
        )
    with pytest.raises(MatterError) as exc:
        assemble_item_spec(job, settings=settings)
    assert exc.value.code == "E_SPEC_AGENT_INVALID"


def test_answer_dispatch_preserves_draft_and_closes_via_today_and_notify(env):
    dispatched = env.service.dispatch_item(
        env.public_id,
        env.item_id,
        computer_use_draft={
            "allowed_apps": ["Safari"],
            "allowed_domains": ["portal.vendor.com"],
        },
        **_mutation("d-flow"),
    )
    dispatch_id = dispatched["dispatch"]["id"]
    job1_id = dispatched["dispatch"]["async_job_id"]
    assert job1_id is not None

    # Worker claims round 1 and hits a login/captcha wall -> needs_input -> awaiting_input.
    assert env.service.mark_dispatch_started(dispatch_id, async_job_id=job1_id) is True
    awaiting = env.run_service.report_item_dispatch(
        env.public_id,
        dispatch_id,
        {
            "needs_input": {
                "question": "门户弹出二次验证码，请确认是否继续提交草稿？",
                "options": ["已登录继续", "取消"],
            }
        },
    )
    assert awaiting["state"] == MatterItemDispatchState.AWAITING_INPUT.value
    assert awaiting["update_id"] is None

    # /today exception surface (live item dispatches) surfaces awaiting_input.
    live_items = env.service.list_live_item_dispatches()["items"]
    assert len(live_items) == 1
    assert live_items[0]["id"] == dispatch_id
    assert live_items[0]["state"] == MatterItemDispatchState.AWAITING_INPUT.value

    # Owner answers -> round 2 job MUST inherit the normalized computer_use_draft.
    answered = env.service.answer_dispatch(
        env.public_id,
        dispatch_id,
        text="已登录继续",
        **_mutation("ans-1"),
    )
    dispatch2 = answered["dispatch"]
    assert dispatch2["attempt_count"] == 2
    job2 = env.jobs.get(dispatch2["async_job_id"])
    assert job2 is not None
    assert job2.params["computer_use_draft"] == {
        "allowed_apps": ["Safari"],
        "allowed_domains": ["portal.vendor.com"],
        "connectors": ["browser_use", "desktop_use"],
    }

    settings = SimpleNamespace(
        sync_store_db_path=str(env.db_path),
        calendar_enabled=False,
        notion_token="",
        matter_followup_agent_profile_id="",
    )
    spec2 = assemble_item_spec(job2, settings=settings)
    assert spec2["computerUsePolicy"]["stopBeforeSubmit"] is True
    assert spec2["matterItem"]["dispatchId"] == dispatch_id

    # Round 2 stages draft (stop_before_submit=True) and reports via matter_item_report.
    assert env.service.mark_dispatch_started(dispatch_id, async_job_id=job2.job_id) is True
    reported = env.run_service.report_item_dispatch(
        env.public_id,
        dispatch_id,
        {
            "summary": "已在 portal.vendor.com 填写完报销草稿，停在最终提交前等待审阅",
            "changes": [
                {
                    "kind": "action",
                    "target": {"id": env.item_id},
                    "after": {"status": "waiting"},
                }
            ],
        },
    )
    assert reported["state"] == MatterItemDispatchState.PROPOSED.value
    assert reported["dropped"] == []
    update_id = reported["update_id"]
    assert update_id is not None

    # No autonomous submission: dispatch stays 'proposed' (not 'done'), update stays 'pending'.
    dispatch_after = env.service.list_dispatches(env.public_id)[0]
    assert dispatch_after["state"] == MatterItemDispatchState.PROPOSED.value
    assert dispatch_after["ended_at"] is None
    detail = env.service.get_matter(env.public_id, include=("updates",))
    pending_updates = [u for u in detail["updates"] if u["id"] == update_id]
    assert pending_updates and pending_updates[0]["review_status"] == "pending"

    # AttentionFact('needs_review') + NotifyCenter review notification created.
    facts = env.attention.list_attention(
        public_id=env.public_id, state="open", kind="needs_review"
    )
    assert any(f["subject_key"] == f"update:{update_id}" for f in facts)
    review_notifs = env.notify.list(category="reviews", state="open")
    assert review_notifs.total >= 1
    assert any(
        item.get("dedupe_key") == f"matter_update:{update_id}"
        and (item.get("payload") or {}).get("update_id") == update_id
        for item in review_notifs.items
    )

    # /today live item dispatches no longer duplicates proposed dispatch in awaiting/failed view.
    assert env.service.list_live_item_dispatches()["items"] == []


def test_rest_dispatch_endpoint_accepts_and_validates_computer_use_draft(tmp_path):
    db_path = tmp_path / "rest_cu.db"
    SyncStore(str(db_path))
    settings = SimpleNamespace(sync_store_db_path=str(db_path))
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_matter_service] = lambda: MatterService(
        MatterRepository(db_path)
    )
    try:
        with TestClient(app) as http:
            matter = http.post(
                "/api/matters",
                json={
                    "title": "REST CU",
                    "mutation": {"source": "desktop_ui", "idempotency_key": "m1"},
                },
            ).json()["data"]["matter"]
            public_id = matter["public_id"]
            v1 = matter["version"]
            propose_resp = http.post(
                f"/api/matters/{public_id}/items",
                json={
                    "kind": "action",
                    "title": "Stage portal draft",
                    "exec_profile": "propose_only",
                    "mutation": {
                        "source": "desktop_ui",
                        "idempotency_key": "i1",
                        "expected_version": v1,
                    },
                },
            )
            assert propose_resp.status_code == 201
            propose_item = propose_resp.json()["data"]["item"]
            v2 = propose_resp.json()["data"]["version"]
            auto_resp = http.post(
                f"/api/matters/{public_id}/items",
                json={
                    "kind": "action",
                    "title": "Auto item",
                    "exec_profile": "autonomous",
                    "mutation": {
                        "source": "desktop_ui",
                        "idempotency_key": "i2",
                        "expected_version": v2,
                    },
                },
            )
            assert auto_resp.status_code == 201
            auto_item = auto_resp.json()["data"]["item"]

            ok_resp = http.post(
                f"/api/matters/{public_id}/items/{propose_item['id']}/dispatch",
                json={
                    "computer_use_draft": {
                        "allowed_domains": ["https://linear.app/acme"],
                    },
                    "mutation": {"source": "desktop_ui", "idempotency_key": "d-ok"},
                },
            )
            assert ok_resp.status_code == 201
            job_id = ok_resp.json()["data"]["dispatch"]["async_job_id"]
            job = AsyncJobRepository(db_path).get(job_id)
            assert job is not None
            assert job.params["computer_use_draft"] == {
                "allowed_apps": [],
                "allowed_domains": ["linear.app"],
                "connectors": ["browser_use"],
            }

            bad_scheme = http.post(
                f"/api/matters/{public_id}/items/{propose_item['id']}/dispatch",
                json={
                    "computer_use_draft": {"allowed_domains": ["javascript:alert(1)"]},
                    "mutation": {"source": "desktop_ui", "idempotency_key": "d-js"},
                },
            )
            assert bad_scheme.status_code == 400
            assert bad_scheme.json()["error"]["code"] == "E_INVALID_ARG"

            bad_profile = http.post(
                f"/api/matters/{public_id}/items/{auto_item['id']}/dispatch",
                json={
                    "computer_use_draft": {"allowed_domains": ["linear.app"]},
                    "mutation": {"source": "desktop_ui", "idempotency_key": "d-auto"},
                },
            )
            assert bad_profile.status_code == 409
            assert bad_profile.json()["error"]["code"] == "E_INVALID_STATE"

            bad_extra = http.post(
                f"/api/matters/{public_id}/items/{propose_item['id']}/dispatch",
                json={
                    "unknown_top_level": 123,
                    "mutation": {"source": "desktop_ui", "idempotency_key": "d-extra"},
                },
            )
            assert bad_extra.status_code == 422
    finally:
        app.dependency_overrides.clear()

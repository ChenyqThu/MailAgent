"""Wave 5 (WS-5) Python Belt 3: DB-verified `matter_followup` computer_use_run child grant gate."""

from __future__ import annotations

import json
import sqlite3
import time

import pytest

from src.connectors import service as svc


def _seed_dispatch_and_job(
    db_path: str,
    *,
    job_status: str = "running",
    dispatch_state: str = "running",
    exec_profile: str = "propose_only",
    params_obj: dict | None = None,
    link_job: bool = True,
) -> tuple[int, int]:
    """Seed matter + matter_item + async_jobs + matter_item_dispatch in SyncStore DB."""
    from src.mail.sync_store import SyncStore

    SyncStore(db_path)
    now_ms = int(time.time() * 1000)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO matter (public_id, title, created_at, updated_at) "
            "VALUES ('MAT-CU-1', 'Test Matter', ?, ?)",
            (now_ms, now_ms),
        )
        matter_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute(
            "INSERT INTO matter_item (matter_id, kind, title, status, owner_kind, "
            "created_by_kind, created_at, updated_at) "
            "VALUES (?, 'action', 'Submit OA', 'open', 'user', 'user', ?, ?)",
            (matter_id, now_ms, now_ms),
        )
        item_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

        params_str = json.dumps(
            params_obj
            if params_obj is not None
            else {
                "computer_use_draft": {
                    "allowed_apps": [],
                    "allowed_domains": ["oa.company.com"],
                    "connectors": ["browser_use"],
                }
            }
        )
        conn.execute(
            "INSERT INTO async_jobs (job_type, params_json, status, created_at, updated_at) "
            "VALUES ('matter_item_run', ?, ?, ?, ?)",
            (params_str, job_status, time.time(), time.time()),
        )
        job_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        linked_job_id = job_id if link_job else job_id + 999
        conn.execute(
            "INSERT INTO matter_item_dispatch (matter_id, item_id, state, executor_kind, "
            "executor_id, exec_profile, async_job_id, created_by_kind, dispatched_at, "
            "created_at, updated_at) "
            "VALUES (?, ?, ?, 'agent', 'matter_followup', ?, ?, 'user', ?, ?, ?)",
            (
                matter_id,
                item_id,
                dispatch_state,
                exec_profile,
                linked_job_id,
                now_ms,
                now_ms,
                now_ms,
            ),
        )
        dispatch_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.commit()
        return int(job_id), int(dispatch_id)
    finally:
        conn.close()


def _arm_connectors(store) -> None:
    for cid in ("browser_use", "desktop_use"):
        store.upsert_connector(
            cid,
            server_url="",
            display_name=cid,
            transport="stdio",
            source="managed_local",
        )
        store.update_connector_state(cid, status="connected")
    store.sync_connector_tools(
        "browser_use",
        [
            {
                "name": "browser_snapshot",
                "description": "Snapshot",
                "input_schema": None,
                "output_schema": None,
                "crud_type": "read",
            },
            {
                "name": "browser_click",
                "description": "Click",
                "input_schema": None,
                "output_schema": None,
                "crud_type": "write",
            },
            {
                "name": "browser_wipe",
                "description": "Wipe",
                "input_schema": None,
                "output_schema": None,
                "crud_type": "write",
                "destructive": True,
            },
            {
                "name": "browser_disabled",
                "description": "Disabled",
                "input_schema": None,
                "output_schema": None,
                "crud_type": "write",
            },
        ],
    )
    store.set_connector_tool_mode("browser_use", "browser_disabled", "off")
    store.sync_connector_tools(
        "desktop_use",
        [
            {
                "name": "desktop_click",
                "description": "Click",
                "input_schema": None,
                "output_schema": None,
                "crud_type": "write",
            }
        ],
    )
    store.upsert_connector(
        "notion",
        server_url="https://mcp.notion.com/mcp",
        display_name="Notion",
        source="custom_mcp",
    )
    store.update_connector_state("notion", status="connected")
    store.sync_connector_tools(
        "notion",
        [
            {
                "name": "notion_create_page",
                "description": "Create page",
                "input_schema": None,
                "output_schema": None,
                "crud_type": "write",
            }
        ],
    )


@pytest.mark.asyncio
async def test_belt3_allows_write_for_verified_propose_only_child_and_blocks_destructive(
    fresh_agent_cfg, tmp_path, monkeypatch
):
    import src.config as cfg_mod
    import src.connectors.client as client_mod

    db_path = str(tmp_path / "sync_store.db")
    monkeypatch.setattr(cfg_mod.config, "sync_store_db_path", db_path)
    _arm_connectors(fresh_agent_cfg)
    job_id, dispatch_id = _seed_dispatch_and_job(db_path)

    class _FakeClient:
        calls: list[tuple[str, str]] = []

        def __init__(self, connector_id, **_kwargs):
            self.connector_id = connector_id

        async def call_tool(self, tool_name, arguments=None, **_kwargs):
            _FakeClient.calls.append((self.connector_id, tool_name))
            return {"content": "ok", "images": [], "is_error": False, "truncated": False}

    monkeypatch.setattr(client_mod, "ConnectorClient", _FakeClient)

    valid_caller = {
        "context_mode": "matter_followup",
        "agent_id": "matter:MAT-CU-1",
        "job_id": job_id,
        "dispatch_id": dispatch_id,
        "child_tool": "computer_use_run",
    }

    async def _simulate_router_invoke(cid: str, tool_name: str):
        ceiling = svc.resolve_caller_ceiling(valid_caller, cid)
        matter_venue = svc.is_matter_followup_caller(valid_caller)
        child_granted = svc.is_matter_computer_use_child_authorized(valid_caller, cid)
        return await svc.invoke_connector_tool(
            cid,
            tool_name,
            {},
            ceiling=ceiling,
            deny_ask_mode=matter_venue and not child_granted,
            deny_destructive=matter_venue,
        )

    # 1) Verified child call on browser_use write tool (effective mode='ask') passes!
    res = await _simulate_router_invoke("browser_use", "browser_click")
    assert res["content"] == "ok"
    assert _FakeClient.calls == [("browser_use", "browser_click")]

    # 2) Destructive write STILL blocked (deny_destructive stays True)!
    with pytest.raises(svc.ConnectorInvokeDenied) as e_dest:
        await _simulate_router_invoke("browser_use", "browser_wipe")
    assert e_dest.value.code == "E_CONNECTOR_TOOL_DISABLED"

    # 3) Explicit 'off' tool STILL blocked!
    with pytest.raises(svc.ConnectorInvokeDenied) as e_off:
        await _simulate_router_invoke("browser_use", "browser_disabled")
    assert e_off.value.code == "E_CONNECTOR_TOOL_DISABLED"

    # 4) desktop_use was NOT in draft connectors=["browser_use"] -> 403!
    with pytest.raises(svc.ConnectorInvokeDenied) as e_wrong_conn:
        await _simulate_router_invoke("desktop_use", "desktop_click")
    assert e_wrong_conn.value.code == "E_CONNECTOR_GRANT_DENIED"
    assert e_wrong_conn.value.http_status == 403

    # 5) Third-party connector (notion) NEVER authorized -> 403!
    with pytest.raises(svc.ConnectorInvokeDenied) as e_notion:
        await _simulate_router_invoke("notion", "notion_create_page")
    assert e_notion.value.code == "E_CONNECTOR_GRANT_DENIED"
    assert e_notion.value.http_status == 403

    # 6) Plain matter_followup caller (no child grant) remains read-only!
    plain_caller = {"context_mode": "matter_followup", "agent_id": "matter:MAT-CU-1"}
    assert svc.resolve_caller_ceiling(plain_caller, "browser_use") == "read"
    assert svc.is_matter_followup_caller(valid_caller) is True


@pytest.mark.parametrize(
    "case_name,db_kwargs,caller_patch",
    [
        ("stopped_job", {"job_status": "succeeded"}, {}),
        ("queued_job", {"job_status": "queued"}, {}),
        ("awaiting_dispatch", {"dispatch_state": "awaiting_input"}, {}),
        ("proposed_dispatch", {"dispatch_state": "proposed"}, {}),
        ("autonomous_profile", {"exec_profile": "autonomous"}, {}),
        ("unlinked_job", {"link_job": False}, {}),
        ("missing_draft", {"params_obj": {}}, {}),
        (
            "wildcard_domain",
            {"params_obj": {"computer_use_draft": {"allowed_domains": ["*"], "connectors": ["browser_use"]}}},
            {},
        ),
        ("wrong_child_tool", {}, {"child_tool": "run_command"}),
        ("bool_job_id", {}, {"job_id": True}),
    ],
)
def test_belt3_fails_closed_on_invalid_state_or_claims(
    fresh_agent_cfg, tmp_path, monkeypatch, case_name, db_kwargs, caller_patch
):
    import src.config as cfg_mod

    db_path = str(tmp_path / f"{case_name}.db")
    monkeypatch.setattr(cfg_mod.config, "sync_store_db_path", db_path)
    _arm_connectors(fresh_agent_cfg)
    job_id, dispatch_id = _seed_dispatch_and_job(db_path, **db_kwargs)

    caller = {
        "context_mode": "matter_followup",
        "agent_id": "matter:MAT-CU-1",
        "job_id": job_id,
        "dispatch_id": dispatch_id,
        "child_tool": "computer_use_run",
        **caller_patch,
    }
    assert svc.is_matter_computer_use_child_authorized(caller, "browser_use") is False
    with pytest.raises(svc.ConnectorInvokeDenied) as exc_info:
        svc.resolve_caller_ceiling(caller, "browser_use")
    assert exc_info.value.code == "E_CONNECTOR_GRANT_DENIED"
    assert exc_info.value.http_status == 403


def test_belt3_derived_connectors_when_omitted_from_draft(tmp_path, monkeypatch):
    import src.config as cfg_mod

    db_path = str(tmp_path / "derived.db")
    monkeypatch.setattr(cfg_mod.config, "sync_store_db_path", db_path)
    job_id, dispatch_id = _seed_dispatch_and_job(
        db_path,
        params_obj={"computer_use_draft": {"allowed_apps": ["Microsoft Teams"]}},
    )
    caller = {
        "context_mode": "matter_followup",
        "job_id": job_id,
        "dispatch_id": dispatch_id,
        "child_tool": "computer_use_run",
    }
    assert svc.is_matter_computer_use_child_authorized(caller, "desktop_use") is True
    assert svc.resolve_caller_ceiling(caller, "desktop_use") == "write"
    assert svc.is_matter_computer_use_child_authorized(caller, "browser_use") is False

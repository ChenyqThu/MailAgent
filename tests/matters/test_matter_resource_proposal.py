"""提案新建资料关联（0812 dogfood 收口）：跟进 Agent 在 Notion / Jira / 全库邮件 / 网页里
找到的**新**证据，经 ``kind=resource`` 提案 → owner 接受 → 真的落成一条 resource + link。

改动前的病根：``_apply_accepted_change`` 的 resource 分支只认「已关联但未确认」的 link，
提案里给一个新的外部资料，owner 点接受时会被 ``resource_change_skipped`` 静默跳过 ——
界面上什么都不发生。``kind=fact`` 的 sources 同理（只接受已关联资源 id，越界整条 drop）。

本文件同时钉住三条安全性：
  1. provider 必须落在白名单里（builtin + **已连接** connector），推导失败 fail-closed；
  2. external_key 按各 provider 既有约定校验，随意串不进库；
  3. fact 的 source 可以引用**同一份提案里正在新建**的 resource，但越界引用仍然 drop。
"""

from __future__ import annotations

import sqlite3
from types import SimpleNamespace

import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService

NOTION_SPEC = {
    "provider": "notion",
    "kind": "doc",
    "external_key": "page:2f1a4c9e-0000-4b1e-9a55-abcdefabcdef",
    "title": "Q3 上线计划",
    "canonical_url": "https://www.notion.so/2f1a4c9e",
}


class _FakeConnectorStore:
    """agent_config 的最小替身：只提供 ``list_connectors``（白名单推导唯一消费的方法）。"""

    def __init__(self, rows):
        self._rows = rows

    def list_connectors(self):
        return self._rows


def _connector(connector_id: str, *, status: str = "connected", enabled: bool = True):
    return SimpleNamespace(connector_id=connector_id, status=status, enabled=enabled)


@pytest.fixture
def env(tmp_path, monkeypatch):
    path = tmp_path / "resource_proposal.db"
    SyncStore(str(path))
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO email_metadata(internal_id,message_id,thread_id,subject,"
            "sync_status) VALUES (7001,'<m-7001@test>','thr-7001','新的客户来信','synced')"
        )
    store = _FakeConnectorStore([_connector("notion"), _connector("figma", status="disconnected")])
    monkeypatch.setattr("src.agent_config.store.get_agent_config_store", lambda: store)
    settings = SimpleNamespace(mcp_connectors_enabled=True)
    service = MatterRunService(MatterRepository(path), settings=settings)
    created = service.create_matter(
        {"title": "资料提案"}, idempotency_key="create", source="desktop_ui"
    )
    pid = created["matter"]["public_id"]
    linked = service.add_resource(
        pid,
        {"provider": "mailagent", "kind": "doc", "external_key": "doc:seed"},
        expected_version=created["version"],
        idempotency_key="seed-link",
        source="desktop_ui",
    )
    seed_resource_id = linked["resources"][0]["resource"]["id"]
    return service, pid, seed_resource_id, str(path), settings


def _start_run(service, pid, key="run-1"):
    run = service.enqueue_run(
        pid,
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key=key,
        source="desktop_ui",
    )["run"]
    assert service.mark_started(run["id"])
    return run["id"]


def _propose(service, pid, changes, *, key="run-1", summary="提案摘要"):
    run_id = _start_run(service, pid, key)
    return service.propose_update(
        pid, run_id, {"summary": summary, "changes": changes}
    ), run_id


def _accept(service, pid, update_id, *, key="acc-1"):
    return service.accept_update(
        pid,
        update_id,
        selected_change_ids=None,
        expected_version=service.get_matter(pid)["matter"]["version"],
        idempotency_key=key,
        source="desktop_ui",
    )


def _timeline_kinds(path):
    with sqlite3.connect(path) as conn:
        return [row[0] for row in conn.execute("SELECT kind FROM matter_event ORDER BY id")]


# ── 🔴 端到端：新建关联真的落库（改动前必红：accept 侧 resource_change_skipped）──────


def test_new_resource_change_is_proposed_accepted_and_linked(env):
    service, pid, seed_resource_id, path, _ = env
    proposed, _ = _propose(
        service,
        pid,
        [
            {
                "id": "chg_res",
                "kind": "resource",
                "operation": "add",
                "resource": dict(NOTION_SPEC),
                "text": "Notion 上有一份 Q3 上线计划",
                "sources": [],
            },
            {
                "id": "chg_fact",
                "kind": "fact",
                "text": "上线时间已定在 9/15",
                "sources": [{"change_id": "chg_res", "evidence": "计划页时间表"}],
            },
        ],
    )
    assert proposed["dropped"] == []
    update_id = proposed["update_id"]
    assert update_id is not None

    result = _accept(service, pid, update_id)
    assert [w for w in result["warnings"] if w.startswith("resource_change_skipped")] == []

    with sqlite3.connect(path) as conn:
        conn.row_factory = sqlite3.Row
        resource = conn.execute(
            "SELECT * FROM resource WHERE provider='notion' AND external_key=?",
            (NOTION_SPEC["external_key"],),
        ).fetchone()
        assert resource is not None
        assert resource["kind"] == "doc"
        assert resource["title"] == NOTION_SPEC["title"]
        assert resource["canonical_url"] == NOTION_SPEC["canonical_url"]
        link = conn.execute(
            "SELECT * FROM matter_resource WHERE resource_id=?", (resource["id"],)
        ).fetchone()
        assert link is not None
        assert link["deleted_at"] is None
        assert link["confirmed_at"] is not None  # owner 已经审过，不再走 suggested→confirmed
        assert link["added_by_kind"] == "agent"
    assert "resource_linked" in _timeline_kinds(path)
    # seed 资源没有被顺手动过
    assert seed_resource_id != resource["id"]


def test_accept_replay_and_already_linked_do_not_duplicate(env):
    service, pid, _, path, _ = env
    proposed, run_id = _propose(
        service,
        pid,
        [{"id": "chg_res", "kind": "resource", "resource": dict(NOTION_SPEC), "sources": []}],
    )
    first = _accept(service, pid, proposed["update_id"], key="acc-1")
    assert first["warnings"] == []
    # 同 idempotency_key 重放 → 事件与 link 都不重复
    _accept(service, pid, proposed["update_id"], key="acc-1")
    service.finish_run(run_id, "ok")

    # 第二份提案给同一个 external_key → 已关联，如实归类为 already_linked，不重复建 link
    second, _ = _propose(
        service,
        pid,
        [{"id": "chg_res2", "kind": "resource", "resource": dict(NOTION_SPEC), "sources": []}],
        key="run-2",
        summary="重复关联",
    )
    result = _accept(service, pid, second["update_id"], key="acc-2")
    assert any(w.startswith("resource_already_linked") for w in result["warnings"])
    with sqlite3.connect(path) as conn:
        rows = conn.execute(
            "SELECT COUNT(*) FROM matter_resource mr JOIN resource r ON r.id=mr.resource_id "
            "WHERE r.external_key=?",
            (NOTION_SPEC["external_key"],),
        ).fetchone()
    assert rows[0] == 1


# ── provider 白名单（变异验证靶点①）────────────────────────────────────────────


def test_unknown_provider_is_dropped(env):
    service, pid, _, _, _ = env
    proposed, _ = _propose(
        service,
        pid,
        [
            {
                "id": "chg_res",
                "kind": "resource",
                "resource": {**NOTION_SPEC, "provider": "evilcorp"},
                "sources": [],
            }
        ],
    )
    assert [d["reason"] for d in proposed["dropped"]] == ["resource_provider_not_allowed"]


def test_unconnected_connector_provider_is_dropped(env):
    service, pid, _, _, _ = env
    proposed, _ = _propose(
        service,
        pid,
        [
            {
                "id": "chg_res",
                "kind": "resource",
                "resource": {**NOTION_SPEC, "provider": "figma", "external_key": "file:abc"},
                "sources": [],
            }
        ],
    )
    assert [d["reason"] for d in proposed["dropped"]] == ["resource_provider_not_allowed"]


def test_connector_enumeration_failure_is_fail_closed(env, monkeypatch):
    """白名单推导失败 → 只剩 builtin，connector 来源的 change 一律拒（不是放行）。"""
    service, pid, _, _, _ = env

    def boom():
        raise RuntimeError("agent_config unavailable")

    monkeypatch.setattr("src.agent_config.store.get_agent_config_store", boom)
    proposed, _ = _propose(
        service,
        pid,
        [{"id": "chg_res", "kind": "resource", "resource": dict(NOTION_SPEC), "sources": []}],
    )
    assert [d["reason"] for d in proposed["dropped"]] == ["resource_provider_not_allowed"]


def test_accept_re_validates_provider_against_the_static_catalog(env):
    """第二道白名单：propose 的裁决不是唯一一道。

    直接把一条越界 provider 的 change 写进 ``changes_json``（模拟 propose 之后被改写），
    接受时仍然落不了地 —— 只留 warning，不 upsert 也不建 link。
    """
    service, pid, _, path, _ = env
    now = service.clock_ms()
    with service.repository.transaction() as conn:
        matter = service.repository.get_matter(conn, pid)
        update_id = service.repository.insert_update(
            conn,
            {
                "matter_id": matter["id"],
                "review_status": "pending",
                "summary": "被改写过的提案",
                "from_event_id": None,
                "to_event_id": None,
                "anchored_matter_version": int(matter["version"]),
                "original_proposal_json": "{}",
                "changes_json": service._dump(
                    [
                        {
                            "id": "chg_res",
                            "kind": "resource",
                            "resource": {
                                "provider": "evilcorp",
                                "kind": "doc",
                                "external_key": "page:x",
                            },
                        }
                    ]
                ),
                "citations_json": "[]",
                "confidence": None,
                "agent_run_id": None,
                "created_by_kind": "agent",
                "created_by_id": "test",
                "created_at": now,
            },
        )
    result = _accept(service, pid, update_id)
    assert any(
        w.startswith("resource_link_rejected:chg_res:resource_provider_not_allowed")
        for w in result["warnings"]
    )
    with sqlite3.connect(path) as conn:
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM resource WHERE provider='evilcorp'"
            ).fetchone()[0]
            == 0
        )


# ── external_key 形状 / 存在性 ────────────────────────────────────────────────


def test_confirming_and_creating_are_mutually_exclusive(env):
    """两个形态同时给 = 说不清要做哪件事 —— 不猜，剔除（gateway zod 也这么拒）。"""
    service, pid, seed_resource_id, _, _ = env
    proposed, _ = _propose(
        service,
        pid,
        [
            {
                "id": "chg_res",
                "kind": "resource",
                "target": {"entity": "resource", "id": seed_resource_id},
                "resource": dict(NOTION_SPEC),
                "sources": [],
            }
        ],
    )
    assert [d["reason"] for d in proposed["dropped"]] == ["resource_spec_invalid"]


def test_connector_external_key_shape_is_validated(env):
    service, pid, _, _, _ = env
    proposed, _ = _propose(
        service,
        pid,
        [
            {
                "id": "chg_res",
                "kind": "resource",
                "resource": {**NOTION_SPEC, "external_key": "随便写的一句话 没有实体前缀"},
                "sources": [],
            }
        ],
    )
    assert [d["reason"] for d in proposed["dropped"]] == ["resource_key_invalid"]


def test_new_mailagent_email_must_exist(env):
    service, pid, _, path, _ = env
    proposed, _ = _propose(
        service,
        pid,
        [
            {
                "id": "chg_ok",
                "kind": "resource",
                "resource": {
                    "provider": "mailagent",
                    "kind": "email",
                    "external_key": "email:7001",
                    "title": "新的客户来信",
                },
                "sources": [],
            },
            {
                "id": "chg_ghost",
                "kind": "resource",
                "resource": {
                    "provider": "mailagent",
                    "kind": "email",
                    "external_key": "email:999999",
                    "title": "编出来的邮件",
                },
                "sources": [],
            },
        ],
    )
    assert {d["id"]: d["reason"] for d in proposed["dropped"]} == {
        "chg_ghost": "resource_not_found"
    }
    _accept(service, pid, proposed["update_id"])
    with sqlite3.connect(path) as conn:
        keys = [
            row[0]
            for row in conn.execute(
                "SELECT external_key FROM resource WHERE provider='mailagent'"
            )
        ]
    assert "email:7001" in keys
    assert "email:999999" not in keys


def test_web_provider_requires_absolute_url(env):
    service, pid, _, _, _ = env
    proposed, _ = _propose(
        service,
        pid,
        [
            {
                "id": "chg_ok",
                "kind": "resource",
                "resource": {
                    "provider": "web",
                    "kind": "url",
                    "external_key": "https://status.example.test/incident/42",
                    "title": "故障通告",
                },
                "sources": [],
            },
            {
                "id": "chg_bad",
                "kind": "resource",
                "resource": {
                    "provider": "web",
                    "kind": "url",
                    "external_key": "javascript:alert(1)",
                },
                "sources": [],
            },
        ],
    )
    assert {d["id"]: d["reason"] for d in proposed["dropped"]} == {
        "chg_bad": "resource_key_invalid"
    }


# ── fact source 引用同提案新建资源（变异验证靶点②）──────────────────────────


def test_fact_source_out_of_scope_change_id_is_dropped(env):
    service, pid, _, _, _ = env
    proposed, _ = _propose(
        service,
        pid,
        [
            {
                "id": "chg_res",
                "kind": "resource",
                "resource": {**NOTION_SPEC, "provider": "evilcorp"},
                "sources": [],
            },
            {
                # 引用一个**被剔掉**的 resource change → 仍然是越界
                "id": "chg_fact_dead",
                "kind": "fact",
                "text": "引用了被丢弃的资料",
                "sources": [{"change_id": "chg_res"}],
            },
            {
                # 引用一个根本不存在的 change id → 越界
                "id": "chg_fact_ghost",
                "kind": "fact",
                "text": "引用了不存在的 change",
                "sources": [{"change_id": "chg_nope"}],
            },
        ],
    )
    reasons = {d["id"]: d["reason"] for d in proposed["dropped"]}
    assert reasons["chg_fact_dead"] == "fact_without_source"
    assert reasons["chg_fact_ghost"] == "fact_without_source"


def test_fact_source_change_id_must_point_at_a_resource_change(env):
    service, pid, seed_resource_id, _, _ = env
    proposed, _ = _propose(
        service,
        pid,
        [
            {"id": "chg_act", "kind": "action", "text": "跟进采购", "sources": []},
            {
                "id": "chg_fact",
                "kind": "fact",
                "text": "引用了一个 action change",
                "sources": [{"change_id": "chg_act"}],
            },
            {
                "id": "chg_fact_ok",
                "kind": "fact",
                "text": "引用既有资源仍然可以",
                "sources": [{"resource_id": seed_resource_id}],
            },
        ],
    )
    reasons = {d["id"]: d["reason"] for d in proposed["dropped"]}
    assert reasons == {"chg_fact": "fact_without_source"}

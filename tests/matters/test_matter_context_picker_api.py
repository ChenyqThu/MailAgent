"""设计对齐批次 2a（G-14 / G-15）新增的三个只读/投影面。

覆盖：
  · `GET /{id}/resource-candidates` —— 与 discover 同引擎但**零写入**（打开弹窗无副作用）；
  · `GET /{id}/resource-attachments` —— 已关联邮件的附件批量投影（inline 不算资料）；
  · relation 行的 `provenance` 解析投影（备注挂在这里，见 service._relation_row）。
"""

from __future__ import annotations

import os
import sqlite3
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
from src.matters.repository import MatterRepository
from src.matters.service import MatterService


@pytest.fixture
def client(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    settings = SimpleNamespace(matters_enabled=True, sync_store_db_path=str(path))
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_matter_service] = lambda: MatterService(
        MatterRepository(path)
    )
    with TestClient(app) as test_client:
        yield test_client, path
    app.dependency_overrides.clear()


def _mutation(key: str, version: int | None = None) -> dict[str, object]:
    payload: dict[str, object] = {"source": "desktop_ui", "idempotency_key": key}
    if version is not None:
        payload["expected_version"] = version
    return payload


def _insert_email(path, internal_id: int, *, thread_id: str, subject: str) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO email_metadata "
            "(internal_id,message_id,thread_id,subject,sender,to_addr,cc_addr,date_received,snippet) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (
                internal_id,
                f"message-{internal_id}",
                thread_id,
                subject,
                "peer@example.com",
                "owner@example.com",
                "legal@example.com",
                f"2026-08-{internal_id:02d}T12:00:00Z",
                "",
            ),
        )
        conn.commit()


def _insert_attachment(
    path, attachment_id: int, internal_id: int, *, filename: str, inline: int = 0
) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute(
            "INSERT INTO email_attachment "
            "(id,internal_id,filename,content_type,size_bytes,is_inline,created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (attachment_id, internal_id, filename, "application/pdf", 2048, inline, 0.0),
        )
        conn.commit()


def _create_matter(http, title: str = "Picker Matter") -> dict:
    created = http.post(
        "/api/matters", json={"title": title, "mutation": _mutation(f"create:{title}")}
    )
    assert created.status_code == 201
    return created.json()["data"]["matter"]


def _link_email(http, public_id: str, version: int, internal_id: int, key: str) -> int:
    linked = http.post(
        f"/api/matters/{public_id}/resources",
        json={
            "source_resource": {
                "provider": "mailagent",
                "kind": "email",
                "internal_id": internal_id,
                "link_scope": "single",
            },
            "confirmed": True,
            "mutation": _mutation(key, version),
        },
    )
    assert linked.status_code == 201, linked.text
    return linked.json()["data"]["version"]


# ── G-14 手动关联：link 级字段不再被 source_resource 路径吞掉 ────────────────


def test_source_resource_link_honours_pinned_and_confirmed(client):
    """手动关联必须落成「已确认」，否则在 UI 上与 Agent 建议无法区分（还会多两颗钮）。"""
    http, path = client
    matter = _create_matter(http)
    _insert_email(path, 1, thread_id="t-1", subject="Manual link")

    linked = http.post(
        f"/api/matters/{matter['public_id']}/resources",
        json={
            "source_resource": {
                "provider": "mailagent",
                "kind": "email",
                "internal_id": 1,
                "link_scope": "thread",
            },
            "pinned": True,
            "confirmed": True,
            "mutation": _mutation("link:manual", matter["version"]),
        },
    )
    assert linked.status_code == 201, linked.text

    items = http.get(f"/api/matters/{matter['public_id']}/resources").json()["data"]["items"]
    assert len(items) == 2  # email + thread
    for item in items:
        assert item["link"]["confirmed_at"] is not None
        assert item["link"]["pinned"] is True
    # sub_state 仍由 snapshot 按资源类型决定，不被 link 级字段覆盖。
    by_kind = {item["resource"]["kind"]: item["link"]["sub_state"] for item in items}
    assert by_kind == {"email": "none", "thread": "active"}


def test_source_resource_link_without_link_fields_is_unchanged(client):
    """不传这些字段的老调用方（⌘K 捕获浮层）行为一个字节不变。"""
    http, path = client
    matter = _create_matter(http)
    _insert_email(path, 1, thread_id="t-1", subject="Captured")
    linked = http.post(
        f"/api/matters/{matter['public_id']}/resources",
        json={
            "source_resource": {
                "provider": "mailagent",
                "kind": "email",
                "internal_id": 1,
                "link_scope": "single",
            },
            "mutation": _mutation("link:capture", matter["version"]),
        },
    )
    assert linked.status_code == 201, linked.text

    items = http.get(f"/api/matters/{matter['public_id']}/resources").json()["data"]["items"]
    assert [(item["link"]["pinned"], item["link"]["confirmed_at"]) for item in items] == [
        (False, None)
    ]


# ── G-16 干系人候选：两条 email metadata 产出路径都必须带地址列 ──────────────
#
# 前端 `matterStakeholderCandidates.ts` 只从 resource metadata 推「本事项往来里出现过」的人，
# 后端不写这三列 = 那份候选列在生产上恒空（2a review 抓到的 HIGH-2）。两条产出路径各钉一条。


def test_manual_link_metadata_carries_address_columns(client):
    http, path = client
    matter = _create_matter(http)
    _insert_email(path, 1, thread_id="t-1", subject="Kickoff")
    _link_email(http, matter["public_id"], matter["version"], 1, "link:1")

    items = http.get(f"/api/matters/{matter['public_id']}/resources").json()["data"]["items"]
    email_item = next(item for item in items if item["resource"]["kind"] == "email")
    metadata = email_item["resource"]["metadata"]
    assert metadata["sender"] == "peer@example.com"
    assert metadata["to_addr"] == "owner@example.com"
    assert metadata["cc_addr"] == "legal@example.com"


def test_discovered_suggestion_metadata_carries_address_columns(client):
    http, path = client
    matter = _create_matter(http)
    _insert_email(path, 1, thread_id="t-1", subject="Anchor")
    _insert_email(path, 2, thread_id="t-1", subject="Same thread follow-up")
    _link_email(http, matter["public_id"], matter["version"], 1, "link:1")

    # 只读候选端点与 discover 同引擎，弹窗里那一组走的是这条 —— 先验它（discover 会把这封
    # 挂成建议，之后它就从「未关联候选」里消失了）。
    candidates = http.get(f"/api/matters/{matter['public_id']}/resource-candidates")
    assert candidates.json()["data"]["items"][0]["metadata"]["cc_addr"] == "legal@example.com"

    discovered = http.post(
        f"/api/matters/{matter['public_id']}/resource-suggestions/discover", json={}
    )
    assert discovered.status_code == 200, discovered.text
    suggestions = discovered.json()["data"]["items"]
    assert [item["resource"]["metadata"]["internal_id"] for item in suggestions] == [2]
    metadata = suggestions[0]["resource"]["metadata"]
    assert metadata["sender"] == "peer@example.com"
    assert metadata["to_addr"] == "owner@example.com"
    assert metadata["cc_addr"] == "legal@example.com"


# ── G-14 tab ① 候选：只读 ──────────────────────────────────────────────────────


def test_resource_candidates_are_read_only_and_reuse_discovery_anchors(client):
    http, path = client
    matter = _create_matter(http)
    _insert_email(path, 1, thread_id="t-1", subject="Anchor mail")
    _insert_email(path, 2, thread_id="t-1", subject="Same thread follow-up")
    _insert_email(path, 3, thread_id="t-other", subject="Unrelated mail")
    version = _link_email(http, matter["public_id"], matter["version"], 1, "link:1")

    before = http.get(f"/api/matters/{matter['public_id']}")
    assert before.status_code == 200
    version_before = before.json()["data"]["matter"]["version"]
    resources_before = http.get(f"/api/matters/{matter['public_id']}/resources")
    assert len(resources_before.json()["data"]["items"]) == 1

    candidates = http.get(f"/api/matters/{matter['public_id']}/resource-candidates")
    assert candidates.status_code == 200
    items = candidates.json()["data"]["items"]
    # 同线程的第 2 封进候选；已关联的第 1 封与无锚的第 3 封都不进。
    assert [item["metadata"]["internal_id"] for item in items] == [2]
    assert "与已关联邮件处于同一线程" in items[0]["reason"]
    assert items[0]["external_key"] == "email:2"

    # 🔴 零副作用：版本不动、资料条数不动（这正是它与 discover 的唯一区别）。
    after = http.get(f"/api/matters/{matter['public_id']}")
    assert after.json()["data"]["matter"]["version"] == version_before == version
    resources_after = http.get(f"/api/matters/{matter['public_id']}/resources")
    assert len(resources_after.json()["data"]["items"]) == 1


def test_resource_candidates_limit_is_bounded(client):
    http, path = client
    matter = _create_matter(http)
    for internal_id in range(1, 6):
        _insert_email(path, internal_id, thread_id="t-1", subject=f"Mail {internal_id}")
    _link_email(http, matter["public_id"], matter["version"], 1, "link:1")

    limited = http.get(
        f"/api/matters/{matter['public_id']}/resource-candidates", params={"limit": 2}
    )
    assert limited.status_code == 200
    assert len(limited.json()["data"]["items"]) == 2
    assert http.get(
        f"/api/matters/{matter['public_id']}/resource-candidates", params={"limit": 0}
    ).status_code == 422


# ── G-14 tab ③ 附件：批量 + 只列已关联邮件的 ──────────────────────────────────


def test_resource_attachments_are_scoped_to_linked_emails_and_skip_inline(client):
    http, path = client
    matter = _create_matter(http)
    _insert_email(path, 1, thread_id="t-1", subject="Contract mail")
    _insert_email(path, 2, thread_id="t-2", subject="Unlinked mail")
    _insert_attachment(path, 11, 1, filename="contract.pdf")
    _insert_attachment(path, 12, 1, filename="signature.png", inline=1)
    _insert_attachment(path, 13, 2, filename="never-shown.pdf")
    _link_email(http, matter["public_id"], matter["version"], 1, "link:1")

    listed = http.get(f"/api/matters/{matter['public_id']}/resource-attachments")
    assert listed.status_code == 200
    items = listed.json()["data"]["items"]
    assert [item["filename"] for item in items] == ["contract.pdf"]
    assert items[0]["external_key"] == "attachment:11"
    assert items[0]["email_subject"] == "Contract mail"
    assert items[0]["linked"] is False


def test_resource_attachment_reports_already_linked(client):
    http, path = client
    matter = _create_matter(http)
    _insert_email(path, 1, thread_id="t-1", subject="Contract mail")
    _insert_attachment(path, 11, 1, filename="contract.pdf")
    version = _link_email(http, matter["public_id"], matter["version"], 1, "link:1")

    linked = http.post(
        f"/api/matters/{matter['public_id']}/resources",
        json={
            "provider": "mailagent",
            "kind": "file",
            "external_key": "attachment:11",
            "title": "contract.pdf",
            "confirmed": True,
            "mutation": _mutation("link:attachment", version),
        },
    )
    assert linked.status_code == 201, linked.text

    items = http.get(
        f"/api/matters/{matter['public_id']}/resource-attachments"
    ).json()["data"]["items"]
    assert [(item["external_key"], item["linked"]) for item in items] == [
        ("attachment:11", True)
    ]


# ── G-15 关系：provenance 解析投影（备注落点） ────────────────────────────────


def test_relation_rows_expose_parsed_provenance(client):
    http, _ = client
    source = _create_matter(http, "Source Matter")
    target = _create_matter(http, "Target Matter")

    created = http.post(
        f"/api/matters/{source['public_id']}/relations",
        json={
            "target_public_id": target["public_id"],
            "relation_type": "depends_on",
            "provenance": {"note": "等对方合规先过", "created_via": "context_tab"},
            "mutation": _mutation("relation:create", source["version"]),
        },
    )
    assert created.status_code == 201, created.text
    relation = created.json()["data"]["relation"]
    assert relation["provenance"] == {
        "note": "等对方合规先过",
        "created_via": "context_tab",
    }
    # 原始列保留 —— 这是 additive 投影，不是替换。
    assert isinstance(relation["provenance_json"], str)

    listed = http.get(f"/api/matters/{source['public_id']}/relations")
    assert listed.status_code == 200
    rows = listed.json()["data"]["items"]
    assert len(rows) == 1
    assert rows[0]["provenance"]["note"] == "等对方合规先过"
    assert rows[0]["target_public_id"] == target["public_id"]
    assert rows[0]["target_title"] == "Target Matter"

    removed = http.request(
        "DELETE",
        f"/api/matters/{source['public_id']}/relations/{rows[0]['id']}",
        json={"mutation": _mutation("relation:delete", created.json()["data"]["version"])},
    )
    assert removed.status_code == 200, removed.text
    assert removed.json()["data"]["relation"]["provenance"]["note"] == "等对方合规先过"
    assert http.get(f"/api/matters/{source['public_id']}/relations").json()["data"][
        "items"
    ] == []

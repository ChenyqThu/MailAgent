"""P4 email 域守卫（D5）：GET /api/email/{id} 的可选 ``matter_scope``。

- 在场 → internal_id ∈ matter 的 **allowed** 关联集（access_policy='allowed' 且
  关联未删）否则 403 E_MATTER_SCOPE；metadata_only 的正文在这里挡住。
- 不带 matter_scope → 行为不变（P3 manual 语义字节级不动）。
"""

from __future__ import annotations

import os
import sqlite3

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
os.environ.setdefault("MAILAGENT_API_DEV", "true")
os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")

from src.api.app import app
from src.api.auth import verify_cf_access
from src.api.deps import get_repository
from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.service import MatterService
from src.repository import EmailRepository


def _seed_email(conn, iid: int) -> None:
    conn.execute(
        "INSERT INTO email_metadata (internal_id, message_id, subject, sender, "
        "date_received, mailbox, sync_status, is_read, is_flagged, created_at, "
        "updated_at) VALUES (?,?,?,?,?,?,?,0,0,1,1)",
        (
            iid, f"<m-{iid}@x.test>", f"S{iid}", "a@x.test",
            "2026-08-01 09:00:00", "收件箱", "synced",
        ),
    )


@pytest.fixture
def env(tmp_path):
    path = tmp_path / "email-scope.db"
    SyncStore(str(path))
    conn = sqlite3.connect(str(path))
    for iid in (301, 302, 303):
        _seed_email(conn, iid)
    conn.commit()
    conn.close()
    service = MatterService(MatterRepository(path))
    created = service.create_matter(
        {"title": "Scope Matter"}, idempotency_key="create", source="desktop_ui"
    )
    pid = created["matter"]["public_id"]
    linked = service.add_resource(
        pid,
        {"provider": "mailagent", "external_key": "email:301", "kind": "email"},
        expected_version=created["version"], idempotency_key="l1",
        source="desktop_ui",
    )
    linked = service.add_resource(
        pid,
        {
            "provider": "mailagent", "external_key": "email:302", "kind": "email",
            "access_policy": "metadata_only",
        },
        expected_version=linked["version"], idempotency_key="l2",
        source="desktop_ui",
    )
    matter_id = linked["matter"]["id"]
    repo = EmailRepository(db_path=str(path))
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[get_repository] = lambda: repo
    with TestClient(app) as client:
        yield client, repo, matter_id
    app.dependency_overrides.clear()


def test_matter_scope_allows_allowed_and_blocks_rest(env):
    client, _, matter_id = env
    ok = client.get(f"/api/email/301?matter_scope={matter_id}")
    assert ok.status_code == 200
    # metadata_only → 正文/详情读挡住
    meta_only = client.get(f"/api/email/302?matter_scope={matter_id}")
    assert meta_only.status_code == 403
    assert meta_only.json()["error"]["code"] == "E_MATTER_SCOPE"
    # 未关联 → 挡住
    outside = client.get(f"/api/email/303?matter_scope={matter_id}")
    assert outside.status_code == 403
    assert outside.json()["error"]["code"] == "E_MATTER_SCOPE"


def test_without_matter_scope_behaviour_unchanged(env):
    client, _, _ = env
    for iid in (301, 302, 303):
        assert client.get(f"/api/email/{iid}").status_code == 200


def test_repository_allowed_only_flag(env):
    _, repo, matter_id = env
    # 默认路径（P3 语义）：metadata_only 也在集合里 —— 字节级不变
    assert repo._matter_email_internal_ids(matter_id) == [301, 302]
    # allowed_only（P4 run 路径）：只剩 allowed
    assert repo._matter_email_internal_ids(matter_id, allowed_only=True) == [301]
    assert repo.matter_scope_contains(matter_id, 301) is True
    assert repo.matter_scope_contains(matter_id, 302) is False

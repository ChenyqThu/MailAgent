"""P7 导出：机器读 JSON + 人读 Markdown，资料只出引用不出正文。"""

from __future__ import annotations

import json

import pytest

from src.mail.sync_store import SyncStore
from src.matters.export import export_matter, export_matter_markdown
from src.matters.repository import MatterRepository
from src.matters.service import Actor, MatterService

NOW = 1_760_000_000_000
USER = Actor(kind="user", actor_id="me")


@pytest.fixture
def service(tmp_path):
    path = tmp_path / "export.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(str(path)), clock_ms=lambda: NOW)


@pytest.fixture
def matter(service):
    created = service.create_matter(
        {"title": "Atlas 上线", "description": "把 Atlas 推上生产", "tags": ["交付"]},
        idempotency_key="create",
        source="test",
    )["matter"]
    service.patch_matter(
        created["public_id"],
        {"goal_checks": [{"t": "合同签署", "done": True}, {"t": "验收通过", "done": False}]},
        idempotency_key="checks",
        source="test",
        expected_version=created["version"],
        actor=USER,
    )
    return service.get_matter(created["public_id"])["matter"]


def test_json_export_carries_the_core_shape(service, matter):
    data = export_matter(service, matter["public_id"])
    assert data["export_version"] == 1
    assert data["matter"]["public_id"] == matter["public_id"]
    assert data["matter"]["goal"] == "把 Atlas 推上生产"
    assert data["matter"]["tags"] == ["交付"]
    assert data["matter"]["goal_checks"] == [
        {"t": "合同签署", "done": True},
        {"t": "验收通过", "done": False},
    ]
    # 时间统一成 ISO，机器读端不用再猜单位
    assert data["matter"]["created_at"].startswith("20")
    assert json.dumps(data)  # 必须可序列化


def test_markdown_export_is_readable_and_marks_check_state(service, matter):
    text = export_matter_markdown(service, matter["public_id"])
    assert text.startswith("# Atlas 上线")
    assert matter["public_id"] in text
    assert "- [x] 合同签署" in text
    assert "- [ ] 验收通过" in text


def test_resources_export_as_references_without_body(service, matter):
    """🔴 资料只出引用：外部系统仍是内容权威，而且资料正文按不可信数据处理，
    不该被搬进一个没有围栏的文件。"""
    service.add_resource(
        matter["public_id"],
        {
            "provider": "mailagent",
            "kind": "email",
            "external_key": "email:4242",
            "title": "报价单 v3",
            "metadata": {"cached_excerpt": "机密正文不该出现在导出里"},
        },
        idempotency_key="link",
        source="test",
        expected_version=matter["version"],
        actor=USER,
    )

    data = export_matter(service, matter["public_id"])
    assert len(data["resources"]) == 1
    resource = data["resources"][0]
    assert resource["external_key"] == "email:4242"
    assert resource["title"] == "报价单 v3"
    assert "cached_excerpt" not in json.dumps(resource, ensure_ascii=False)
    assert "机密正文" not in json.dumps(data, ensure_ascii=False)
    assert "机密正文" not in export_matter_markdown(service, matter["public_id"])


def test_markdown_escapes_table_breaking_characters(service, matter):
    service.create_stakeholder(
        matter["public_id"],
        {"display_name": "A | B", "email": "a@example.test", "role": "决策人"},
        idempotency_key="sh",
        source="test",
        expected_version=matter["version"],
        actor=USER,
    )
    text = export_matter_markdown(service, matter["public_id"])
    # 干系人表是 markdown 表格；未转义的竖线会把整行拆成额外的列
    assert "A \\| B" in text

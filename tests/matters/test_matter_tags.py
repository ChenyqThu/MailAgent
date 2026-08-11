from __future__ import annotations

import pytest

from src.mail.sync_store import SyncStore
from src.matters.models import MATTER_TAG_DEFAULT_COLOR, MATTER_TAG_DEFAULT_SHAPE
from src.matters.repository import MatterRepository
from src.matters.service import MatterError, MatterService


@pytest.fixture
def service(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(path), clock_ms=lambda: 1_800_000_000_000)


def _mutation(key: str) -> dict[str, object]:
    return {"idempotency_key": key, "source": "desktop_ui"}


def _create(service: MatterService, title: str, tags: list[str]):
    return service.create_matter(
        {"title": title, "tags": tags},
        idempotency_key=f"create:{title}",
        source="desktop_ui",
    )


def _matter_tags(service: MatterService, public_id: str) -> list[str]:
    return service.get_matter(public_id)["matter"]["tags"]


def _tag_by_name(service: MatterService, name: str) -> dict[str, object]:
    tags = {tag["name"]: tag for tag in service.list_tags()}
    return tags[name]


def test_rename_rewrites_references_in_one_transaction(service, monkeypatch):
    first = _create(service, "First", ["legacy", "keep"])
    second = _create(service, "Second", ["legacy"])
    service.upsert_tag_style(
        "legacy", color="--c-warn", shape="diamond", **_mutation("style:legacy")
    )
    original_refresh = service.refresh_search_projection

    def fail_after_first_refresh(conn, matter_id):
        original_refresh(conn, matter_id)
        raise RuntimeError("injected refresh failure")

    monkeypatch.setattr(service, "refresh_search_projection", fail_after_first_refresh)
    with pytest.raises(RuntimeError, match="injected refresh failure"):
        service.rename_tag("legacy", "renamed", **_mutation("rename:rollback"))

    assert _matter_tags(service, first["matter"]["public_id"]) == ["legacy", "keep"]
    assert _matter_tags(service, second["matter"]["public_id"]) == ["legacy"]
    with service.repository.connect() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM matter_tag WHERE name='legacy'"
        ).fetchone()[0] == 1
        assert conn.execute(
            "SELECT COUNT(*) FROM matter_tag WHERE name='renamed'"
        ).fetchone()[0] == 0


def test_rename_collision_merges_without_duplicate_tags(service):
    first = _create(service, "First", ["old", "keep"])
    second = _create(service, "Second", ["old", "new"])
    third = _create(service, "Third", ["new"])
    service.upsert_tag_style(
        "old", color="--c-warn", shape="diamond", **_mutation("style:old")
    )
    service.upsert_tag_style(
        "new", color="--c-info", shape="ring", **_mutation("style:new")
    )

    result = service.rename_tag("old", "new", **_mutation("rename:merge"))

    assert result["affected_count"] == 2
    assert _matter_tags(service, first["matter"]["public_id"]) == ["new", "keep"]
    assert _matter_tags(service, second["matter"]["public_id"]) == ["new"]
    assert _matter_tags(service, third["matter"]["public_id"]) == ["new"]
    merged = _tag_by_name(service, "new")
    assert merged["color"] == "--c-info"
    assert merged["shape"] == "ring"
    assert merged["usage_count"] == 3
    with service.repository.connect() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM matter_tag WHERE name='old'"
        ).fetchone()[0] == 0


def test_delete_removes_tag_references_without_deleting_matters(service):
    first = _create(service, "First", ["drop", "keep"])
    second = _create(service, "Second", ["drop"])
    service.upsert_tag_style(
        "drop", color="--c-crit", shape="bar", **_mutation("style:drop")
    )

    result = service.delete_tag("drop", **_mutation("delete:drop"))

    assert result["deleted"] is True
    assert result["affected_count"] == 2
    assert _matter_tags(service, first["matter"]["public_id"]) == ["keep"]
    assert _matter_tags(service, second["matter"]["public_id"]) == []
    with service.repository.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM matter").fetchone()[0] == 2
        assert conn.execute(
            "SELECT COUNT(*) FROM matter_tag WHERE name='drop'"
        ).fetchone()[0] == 0


def test_legacy_undefined_tag_is_listed_with_default_style(service):
    _create(service, "Legacy", ["orphan"])

    tag = _tag_by_name(service, "orphan")

    assert tag["color"] == MATTER_TAG_DEFAULT_COLOR.value
    assert tag["shape"] == MATTER_TAG_DEFAULT_SHAPE.value
    assert tag["created_at"] is None
    assert tag["usage_count"] == 1
    assert tag["inferred"] is True


def test_usage_count_excludes_deleted_matters(service):
    _create(service, "Live A", ["counted"])
    _create(service, "Live B", ["counted"])
    deleted = _create(service, "Deleted", ["counted"])
    service.trash(
        deleted["matter"]["public_id"],
        expected_version=deleted["version"],
        idempotency_key="trash:deleted",
        source="desktop_ui",
    )

    tag = _tag_by_name(service, "counted")

    assert tag["usage_count"] == 2


def test_invalid_tag_color_and_shape_are_rejected(service):
    with pytest.raises(MatterError) as color_error:
        service.upsert_tag_style(
            "bad", color="#ff0000", shape="ring", **_mutation("style:bad-color")
        )
    assert color_error.value.code == "E_INVALID_ARG"

    with pytest.raises(MatterError) as shape_error:
        service.upsert_tag_style(
            "bad", color="--c-ok", shape="triangle", **_mutation("style:bad-shape")
        )
    assert shape_error.value.code == "E_INVALID_ARG"

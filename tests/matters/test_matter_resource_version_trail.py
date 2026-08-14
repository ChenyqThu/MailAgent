"""资料版本轨迹（v57 / 批 M7，设计稿 H3§5.4）。

盯的是**只有真的检出到新版本才看得见**的那几件事：

  · 归档写点只有一个 —— `fetch_url_resource` 检出到新 content_hash 的那一刻，且必须
    在 UPDATE **之前**取快照。写在后面 = 轨迹里全是当前值的复读，而单测若只数行数
    根本发现不了（行数一样对）。所以这里逐字段比对**旧值**；
  · 首次抓取不留档、内容没变不留档 —— 两者都是「没有上一版」，留一条空壳会把
    「只检出过一次」谎报成「有过一版」；
  · 当时那份摘要必须被留下来 —— 覆盖即永久丢失，这正是本表存在的理由；
  · `diff` 从提案落到轨迹最新一行，且不覆盖已经写过的那句；
  · `tracks_versions` 把「这类资料不跟踪版本」与「还没检出过」分开（前端两种空态文案
    的判据单源）。
"""

from __future__ import annotations

import httpx
import pytest

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.resource_identity import MatterError
from src.matters.service import MatterService
from src.matters.url_fetch import URL_FETCH_ALLOWED_CONTENT_TYPES, content_hash

FIRST_TEXT = "第一版：交付窗口在 9 月第二周，回调重试 3 次。"
SECOND_TEXT = "第二版：交付窗口挪到 10 月首周，回调重试 5 次。"


@pytest.fixture()
def env(tmp_path):
    path = tmp_path / "sync.db"
    SyncStore(str(path))
    clock = {"now": 1_900_000_000_000}
    body = {"text": FIRST_TEXT}

    def fake_fetch(url: str) -> dict[str, object]:
        return {
            "url": url,
            "final_url": url,
            "status": httpx.codes.OK,
            "content_type": next(iter(URL_FETCH_ALLOWED_CONTENT_TYPES)),
            "title": "Spec",
            "text": body["text"],
            "truncated": False,
        }

    service = MatterService(
        MatterRepository(path), clock_ms=lambda: clock["now"], url_fetcher=fake_fetch
    )
    created = service.create_matter(
        {"title": "版本轨迹"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    linked = service.add_resource(
        public_id,
        {
            "provider": "web",
            "external_key": "https://example.test/spec",
            "kind": "url",
            "canonical_url": "https://example.test/spec",
        },
        expected_version=created["version"],
        idempotency_key="link",
        source="desktop_ui",
    )
    resource_id = linked["resources"][0]["resource"]["id"]
    return service, public_id, resource_id, clock, body


def _set_summary(service: MatterService, resource_id: int, text: str, src: str) -> None:
    """直接落一份摘要 —— 模拟提案接受后写进 `resource.sum` 的既有链路（批 M6）。"""
    with service.repository.transaction() as conn:
        conn.execute(
            'UPDATE resource SET "sum"=?, sum_src=?, sum_at=? WHERE id=?',
            (text, src, 1_800_000_000_000, resource_id),
        )


def _advance_and_refetch(service, public_id, resource_id, clock, body, text) -> None:
    body["text"] = text
    clock["now"] += 10_000
    service.fetch_url_resource(public_id, resource_id, force=True)


def test_first_fetch_records_no_history(env):
    """首次抓取 = 没有上一版可归档，轨迹必须仍是空的（不是"有过一版"）。"""
    service, public_id, resource_id, _, _ = env
    service.fetch_url_resource(public_id, resource_id)

    trail = service.list_resource_versions(public_id, resource_id)
    assert trail["tracks_versions"] is True
    assert trail["items"] == []


def test_refetch_with_unchanged_content_records_no_history(env):
    """内容没变的重抓（force / 缓存过期复验）不是版本变化。"""
    service, public_id, resource_id, clock, body = env
    service.fetch_url_resource(public_id, resource_id)
    _advance_and_refetch(service, public_id, resource_id, clock, body, FIRST_TEXT)

    assert service.list_resource_versions(public_id, resource_id)["items"] == []


def test_new_version_archives_the_previous_revision_and_its_summary(env):
    """🔴 归档写点：留下的必须是**被覆盖前**的版本身份与那一份摘要。"""
    service, public_id, resource_id, clock, body = env
    service.fetch_url_resource(public_id, resource_id)
    _set_summary(service, resource_id, "第一版说交付在 9 月。", "agent")
    first_hash = content_hash(FIRST_TEXT)

    _advance_and_refetch(service, public_id, resource_id, clock, body, SECOND_TEXT)

    trail = service.list_resource_versions(public_id, resource_id)
    assert len(trail["items"]) == 1
    archived = trail["items"][0]
    # 逐字段比**旧值** —— 写在 UPDATE 之后的话这三项会变成新版本的复读，只数行数发现不了。
    assert archived["revision"] == first_hash
    assert archived["content_hash"] == first_hash
    assert archived["sum"] == "第一版说交付在 9 月。"
    assert archived["sum_src"] == "agent"
    assert archived["superseded_at"] == clock["now"]
    assert archived["diff_text"] is None  # 没人写过就是 None，服务端不编

    # 当前版本**不在**轨迹里 —— 它是 resource 行自己（同一事实只有一处真源）。
    with service.repository.connect() as conn:
        current = service.repository.get_resource(conn, resource_id)
    assert current["content_hash"] == content_hash(SECOND_TEXT)
    assert current["content_hash"] not in {row["content_hash"] for row in trail["items"]}


def test_summary_overwritten_after_a_new_version_still_survives_in_the_trail(env):
    """留档的理由：当前摘要是可覆盖的单值，覆盖即永久丢失。"""
    service, public_id, resource_id, clock, body = env
    service.fetch_url_resource(public_id, resource_id)
    _set_summary(service, resource_id, "第一版说交付在 9 月。", "agent")
    _advance_and_refetch(service, public_id, resource_id, clock, body, SECOND_TEXT)
    _set_summary(service, resource_id, "第二版说交付挪到 10 月。", "agent")

    trail = service.list_resource_versions(public_id, resource_id)
    assert [row["sum"] for row in trail["items"]] == ["第一版说交付在 9 月。"]


def test_trail_is_newest_first_across_several_versions(env):
    service, public_id, resource_id, clock, body = env
    service.fetch_url_resource(public_id, resource_id)
    _advance_and_refetch(service, public_id, resource_id, clock, body, SECOND_TEXT)
    _advance_and_refetch(service, public_id, resource_id, clock, body, "第三版。")

    stamps = [row["superseded_at"] for row in
              service.list_resource_versions(public_id, resource_id)["items"]]
    assert len(stamps) == 2
    assert stamps == sorted(stamps, reverse=True)


def test_proposal_diff_fills_the_latest_trail_row_once(env):
    """`resource.diff` 落到**被取代的那一版**上；重放不覆盖已经给 owner 看过的那句。"""
    service, public_id, resource_id, clock, body = env
    service.fetch_url_resource(public_id, resource_id)
    _advance_and_refetch(service, public_id, resource_id, clock, body, SECOND_TEXT)

    with service.repository.transaction() as conn:
        assert service.repository.fill_latest_version_diff(
            conn, resource_id, "回调重试 3 → 5 次，交付窗口 9 月 → 10 月。"
        )
    assert service.list_resource_versions(public_id, resource_id)["items"][0][
        "diff_text"
    ] == "回调重试 3 → 5 次，交付窗口 9 月 → 10 月。"

    # 幂等闸：已有 diff 的行不被改写（同一提案重放 / 下一轮 run 又提了一句）。
    with service.repository.transaction() as conn:
        assert not service.repository.fill_latest_version_diff(
            conn, resource_id, "覆盖企图"
        )
    assert "覆盖企图" not in str(
        service.list_resource_versions(public_id, resource_id)["items"][0]["diff_text"]
    )


def test_proposal_diff_on_a_resource_without_history_is_dropped(env):
    """还没有过版本变化 ⇒ 没有"上一版" ⇒ diff 无处可落，**不新建行**。"""
    service, public_id, resource_id, _, _ = env
    service.fetch_url_resource(public_id, resource_id)

    with service.repository.transaction() as conn:
        assert not service.repository.fill_latest_version_diff(conn, resource_id, "变了")
    assert service.list_resource_versions(public_id, resource_id)["items"] == []


def test_tracks_versions_separates_the_two_empty_states(env):
    """🔴 前端两种空态的判据单源：邮件类资料结构上不跟踪版本，不是"还没检出过"。"""
    service, public_id, _, _, _ = env
    version = service.get_matter(public_id)["matter"]["version"]
    linked = service.add_resource(
        public_id,
        {"provider": "web", "external_key": "https://example.test/other",
         "kind": "doc", "canonical_url": "https://example.test/other"},
        expected_version=version,
        idempotency_key="link-doc",
        source="desktop_ui",
    )
    doc_id = next(
        item["resource"]["id"] for item in linked["resources"]
        if item["resource"]["kind"] == "doc"
    )
    assert service.list_resource_versions(public_id, doc_id) == {
        "tracks_versions": False,
        "items": [],
    }


def test_accepting_a_proposal_files_its_diff_against_the_superseded_version(tmp_path):
    """端到端：提案里的 `resource.diff` → 接受 → 落到轨迹最新一行。

    走完整 propose/accept 链而不是直接调 repository —— 中间任何一环把 `diff` 丢掉
    （DTO extra=forbid / 归一层不认这个键 / service 忘了摘出来）都只会在这里露出来。
    """
    from src.matters.run_service import MatterRunService

    path = tmp_path / "e2e.db"
    SyncStore(str(path))
    clock = {"now": 1_900_000_000_000}
    body = {"text": FIRST_TEXT}
    service = MatterRunService(MatterRepository(path), clock_ms=lambda: clock["now"])
    service.url_fetcher = lambda url: {
        "url": url, "final_url": url, "status": httpx.codes.OK,
        "content_type": next(iter(URL_FETCH_ALLOWED_CONTENT_TYPES)),
        "title": "Spec", "text": body["text"], "truncated": False,
    }
    created = service.create_matter(
        {"title": "端到端"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    url = "https://example.test/spec"
    linked = service.add_resource(
        public_id,
        {"provider": "web", "external_key": url, "kind": "url", "canonical_url": url},
        expected_version=created["version"],
        idempotency_key="link",
        source="desktop_ui",
    )
    resource_id = linked["resources"][0]["resource"]["id"]

    service.fetch_url_resource(public_id, resource_id)
    _advance_and_refetch(service, public_id, resource_id, clock, body, SECOND_TEXT)

    run = service.enqueue_run(
        public_id,
        expected_version=service.get_matter(public_id)["matter"]["version"],
        idempotency_key="run-1",
        source="desktop_ui",
    )["run"]
    assert service.mark_started(run["id"])
    proposed = service.propose_update(
        public_id,
        run["id"],
        {
            "summary": "规格更新了",
            "changes": [{
                "id": "chg_res",
                "kind": "resource",
                "operation": "add",
                "resource": {
                    "provider": "web", "kind": "url", "external_key": url,
                    "canonical_url": url, "title": "Spec",
                    "summary": "第二版把交付挪到 10 月首周。",
                    "diff": "回调重试 3 → 5 次，交付窗口 9 月第二周 → 10 月首周。",
                },
                "text": "供应商更新了规格",
                "sources": [],
            }],
        },
    )
    assert proposed["dropped"] == []
    service.accept_update(
        public_id,
        proposed["update_id"],
        selected_change_ids=None,
        expected_version=service.get_matter(public_id)["matter"]["version"],
        idempotency_key="acc-1",
        source="desktop_ui",
    )

    trail = service.list_resource_versions(public_id, resource_id)["items"]
    assert len(trail) == 1
    assert trail[0]["diff_text"] == "回调重试 3 → 5 次，交付窗口 9 月第二周 → 10 月首周。"
    # 归档的仍是**上一版**的摘要，新摘要落在 resource 行上（两处不串味）。
    with service.repository.connect() as conn:
        assert service.repository.get_resource(conn, resource_id)["sum"] == (
            "第二版把交付挪到 10 月首周。"
        )


def test_trail_requires_the_resource_to_be_linked_to_this_matter(env):
    service, public_id, resource_id, _, _ = env
    other = service.create_matter(
        {"title": "别的事项"}, idempotency_key="create-2", source="desktop_ui"
    )
    with pytest.raises(MatterError) as excinfo:
        service.list_resource_versions(other["matter"]["public_id"], resource_id)
    assert excinfo.value.code == "E_CHILD_NOT_FOUND"

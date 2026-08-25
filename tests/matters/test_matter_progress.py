"""curated 进展 lane（task 08-25-matter-progress-curated，Lane A 后端内核）。

进展是**独立于操作日志**的 curated 条目：目标 / 里程碑 / 关键进展 / 关键信号 / 决议。
本文件钉五件事：

1. **CRUD + 审计** —— 三条写入口都经 service 单写面，每次写在操作日志留一条事件；
2. **epoch 毫秒三道门** —— `happened_at` 收到秒值恒拒，**不静默 ×1000**（§2.2）；
3. **CAS / auto-rebase** —— 追加是 `SCOPE_NOTHING`（stale base 不算冲突），行编辑是行级
   scope（改两条不同的进展不冲突，改同一条冲突）；
4. **提案链** —— 跟进 run 只有提案通道：`kind='progress'` 的 change 落成 actor=agent 的
   行；kind / title / 时间单位不合规的在 **propose 侧**就被剔除（agent 当轮能自纠）；
5. **读面** —— `get_matter(include=['progress'])` 与导出的「进展」小节。
"""

from __future__ import annotations

import sqlite3

import pytest

from src.mail.sync_store import SyncStore
from src.matters.events import (
    PROGRESS_ADDED,
    PROGRESS_REMOVED,
    PROGRESS_RESTORED,
    PROGRESS_UPDATED,
)
from src.matters.export import export_matter, export_matter_markdown
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.matters.service import Actor, MatterError, MatterService

NOW = 1_800_000_000_000
#: 同一个时刻的 epoch **秒** —— 0813 A3 那个把 2026 年显示成 1970 年的形状。
NOW_SECONDS = NOW // 1000


@pytest.fixture
def service(tmp_path):
    path = tmp_path / "progress.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(path), clock_ms=lambda: NOW)


@pytest.fixture
def services(tmp_path):
    path = tmp_path / "progress-run.db"
    SyncStore(str(path))
    repo = MatterRepository(str(path))
    return (
        MatterService(repo, clock_ms=lambda: NOW),
        MatterRunService(repo, clock_ms=lambda: NOW),
    )


def _mutation(version: int, key: str) -> dict[str, object]:
    return {
        "expected_version": version,
        "idempotency_key": key,
        "source": "desktop_ui",
    }


def _matter(service: MatterService, key: str = "create-1") -> dict:
    return service.create_matter(
        {"title": "意大利 CBC 交付"}, idempotency_key=key, source="desktop_ui"
    )["matter"]


def _add(service: MatterService, public_id: str, version: int, key: str, **overrides):
    data = {
        "kind": "progress",
        "title": "Simon 回邮确认 Q4 预算",
        **overrides,
    }
    return service.add_progress(public_id, data, **_mutation(version, key))


def _event_kinds(service: MatterService, public_id: str) -> list[str]:
    return [entry["kind"] for entry in service.timeline(public_id, cursor=None, limit=50)["items"]]


# ============================================================
# 1 — CRUD + 审计事件
# ============================================================


def test_add_update_delete_restore_round_trip_and_audit_trail(service):
    matter = _matter(service)
    public_id = matter["public_id"]

    added = _add(service, public_id, matter["version"], "p-add", body="预算按 Q4 走。")
    progress_id = added["progress"]["id"]
    assert added["progress"]["kind"] == "progress"
    assert added["progress"]["body"] == "预算按 Q4 走。"
    assert added["progress"]["actor_kind"] == "user"
    # 不给 happened_at = 「刚发生」。
    assert added["progress"]["happened_at"] == NOW
    assert added["progress"]["refs"] == []

    updated = service.update_progress(
        public_id,
        progress_id,
        {"kind": "decision", "title": "Q4 预算已定"},
        **_mutation(added["version"], "p-update"),
    )
    assert (updated["progress"]["kind"], updated["progress"]["title"]) == (
        "decision",
        "Q4 预算已定",
    )

    removed = service.delete_progress(
        public_id, progress_id, **_mutation(updated["version"], "p-delete")
    )
    assert removed["progress"]["deleted_at"] == NOW
    assert service.list_progress(public_id) == []
    assert len(service.list_progress(public_id, include_deleted=True)) == 1

    restored = service.restore_progress(
        public_id, progress_id, **_mutation(removed["version"], "p-restore")
    )
    assert restored["progress"]["deleted_at"] is None
    assert [entry["id"] for entry in service.list_progress(public_id)] == [progress_id]

    # 🔴 进展是 curated lane，但它的**维护动作**照样进操作日志。
    assert _event_kinds(service, public_id) == [
        PROGRESS_RESTORED,
        PROGRESS_REMOVED,
        PROGRESS_UPDATED,
        PROGRESS_ADDED,
        "matter_created",
    ]


def test_audit_events_carry_the_progress_id_but_not_the_body(service):
    """操作日志回答「谁动了哪一条」；正文只有一个家（进展行本身）。"""
    matter = _matter(service)
    added = _add(
        service, matter["public_id"], matter["version"], "p-add", body="很长的一段正文" * 20
    )
    event = service.timeline(matter["public_id"], cursor=None, limit=1)["items"][0]
    assert event["kind"] == PROGRESS_ADDED
    assert event["payload"]["progress_id"] == added["progress"]["id"]
    assert event["payload"]["title"].startswith("Simon 回邮确认")
    assert "body" not in event["payload"]
    assert "narrative" not in event["payload"]


def test_replay_of_the_same_key_is_a_no_op_and_returns_the_same_progress(service):
    matter = _matter(service)
    first = _add(service, matter["public_id"], matter["version"], "p-add")
    again = _add(service, matter["public_id"], matter["version"], "p-add")
    assert again["event_ids"] == first["event_ids"]
    assert again["progress"]["id"] == first["progress"]["id"]
    assert len(service.list_progress(matter["public_id"])) == 1


def test_narrative_time_is_independent_of_record_time(service):
    """补记上周的事：`happened_at` 往回填，`created_at` 还是现在，列表按前者排。"""
    matter = _matter(service)
    version = matter["version"]
    recent = _add(
        service, matter["public_id"], version, "p-recent",
        title="今天的进展", happened_at=NOW,
    )
    older = _add(
        service, matter["public_id"], recent["version"], "p-older",
        title="上周发生的事", happened_at=NOW - 7 * 24 * 3600 * 1000,
    )
    assert older["progress"]["created_at"] == NOW
    assert [entry["title"] for entry in service.list_progress(matter["public_id"])] == [
        "今天的进展",
        "上周发生的事",
    ]


# ============================================================
# 2 — 值域与单位
# ============================================================


@pytest.mark.parametrize(
    ("overrides", "why"),
    [
        ({"kind": "milestone_reached"}, "kind 不在五类词表里"),
        ({"title": "   "}, "主句空白"),
        ({"title": "x" * 501}, "主句超长"),
        ({"refs": "email:1"}, "refs 不是数组"),
        ({"refs": ["email:1"]}, "refs 元素不是对象"),
        ({"refs": [{"message_id": "<a@b>"}]}, "refs 缺 type"),
    ],
)
def test_invalid_progress_is_rejected_at_the_write_face(service, overrides, why):
    matter = _matter(service)
    with pytest.raises(MatterError) as exc:
        _add(service, matter["public_id"], matter["version"], "p-bad", **overrides)
    assert exc.value.code == "E_INVALID_ARG", why
    assert service.list_progress(matter["public_id"]) == []


def test_epoch_seconds_happened_at_is_refused_not_silently_multiplied(service):
    """🔴 §2.2：秒值恒拒。静默 ×1000 会把上游的单位错永久藏住（UI 恒显示 1970）。"""
    matter = _matter(service)
    with pytest.raises(MatterError) as exc:
        _add(
            service, matter["public_id"], matter["version"], "p-sec",
            happened_at=NOW_SECONDS,
        )
    assert exc.value.code == "E_INVALID_ARG"
    assert "epoch seconds" in str(exc.value)
    assert service.list_progress(matter["public_id"]) == []


def test_editing_happened_at_goes_through_the_same_gate(service):
    """编辑面是同一道门 —— 新建挡住了、编辑放行 = 门只守了一半。"""
    matter = _matter(service)
    added = _add(service, matter["public_id"], matter["version"], "p-add")
    with pytest.raises(MatterError) as exc:
        service.update_progress(
            matter["public_id"],
            added["progress"]["id"],
            {"happened_at": NOW_SECONDS},
            **_mutation(added["version"], "p-edit-sec"),
        )
    assert exc.value.code == "E_INVALID_ARG"
    assert service.list_progress(matter["public_id"])[0]["happened_at"] == NOW


def test_unknown_patch_field_is_refused_instead_of_silently_dropped(service):
    matter = _matter(service)
    added = _add(service, matter["public_id"], matter["version"], "p-add")
    with pytest.raises(MatterError) as exc:
        service.update_progress(
            matter["public_id"],
            added["progress"]["id"],
            {"actor_kind": "agent"},
            **_mutation(added["version"], "p-forge"),
        )
    assert exc.value.code == "E_INVALID_ARG"
    assert service.list_progress(matter["public_id"])[0]["actor_kind"] == "user"


def test_refs_survive_the_round_trip(service):
    matter = _matter(service)
    refs = [
        {"type": "email", "message_id": "<a@b.test>"},
        {"type": "url", "url": "https://example.test/spec"},
    ]
    added = _add(service, matter["public_id"], matter["version"], "p-refs", refs=refs)
    assert added["progress"]["refs"] == refs
    assert service.list_progress(matter["public_id"])[0]["refs"] == refs


# ============================================================
# 3 — CAS / auto-rebase
# ============================================================


def test_appending_progress_never_conflicts_with_a_stale_base(service):
    """追加 = `SCOPE_NOTHING`：并发记两条进展不该互相把对方的乐观锁撞掉。"""
    matter = _matter(service)
    base = matter["version"]
    first = _add(service, matter["public_id"], base, "p-1", title="第一条")
    # 第二笔拿的是**同一个**旧版本号（两个客户端同时打开这个事项）。
    second = _add(service, matter["public_id"], base, "p-2", title="第二条")
    assert second["version"] == first["version"] + 1
    assert {entry["title"] for entry in service.list_progress(matter["public_id"])} == {
        "第一条",
        "第二条",
    }


def test_editing_two_different_progress_rows_does_not_conflict(service):
    matter = _matter(service)
    one = _add(service, matter["public_id"], matter["version"], "p-1", title="第一条")
    two = _add(service, matter["public_id"], one["version"], "p-2", title="第二条")
    base = two["version"]

    service.update_progress(
        matter["public_id"], one["progress"]["id"], {"title": "第一条 改"},
        **_mutation(base, "edit-1"),
    )
    # 同一个 base，但打的是另一行 —— 版本账本里那一笔 scope 不重叠 ⇒ auto-rebase。
    service.update_progress(
        matter["public_id"], two["progress"]["id"], {"title": "第二条 改"},
        **_mutation(base, "edit-2"),
    )
    assert {entry["title"] for entry in service.list_progress(matter["public_id"])} == {
        "第一条 改",
        "第二条 改",
    }


def test_editing_the_same_progress_row_twice_is_a_real_conflict(service):
    matter = _matter(service)
    one = _add(service, matter["public_id"], matter["version"], "p-1")
    base = one["version"]
    service.update_progress(
        matter["public_id"], one["progress"]["id"], {"title": "赢的那个"},
        **_mutation(base, "edit-1"),
    )
    with pytest.raises(MatterError) as exc:
        service.update_progress(
            matter["public_id"], one["progress"]["id"], {"title": "输的那个"},
            **_mutation(base, "edit-2"),
        )
    assert exc.value.code == "E_VERSION_CONFLICT"
    assert service.list_progress(matter["public_id"])[0]["title"] == "赢的那个"


# ============================================================
# 4 — 提案链（跟进 run 的唯一通道）
# ============================================================


def _progress_change(change_id: str, **spec):
    return {
        "id": change_id,
        "kind": "progress",
        "progress": {"kind": "milestone", "title": "首批设备已到场", **spec},
        "sources": [],
    }


def _propose(service, run_service, matter, changes, *, key="run-1"):
    run = run_service.enqueue_run(
        matter["public_id"],
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        idempotency_key=key,
        source="test",
    )["run"]
    run_service.mark_started(run["id"])
    return run_service.propose_update(
        matter["public_id"], run["id"], {"summary": "s", "changes": changes}
    )


def test_accepted_progress_change_lands_as_an_agent_authored_row(services):
    service, run_service = services
    matter = _matter(service)
    proposal = _propose(
        service, run_service, matter,
        [_progress_change("c1", body="现场清点无缺件。", happened_at=NOW - 3600_000)],
    )
    assert proposal["dropped"] == []

    service.accept_update(
        matter["public_id"], proposal["update_id"],
        idempotency_key="accept-1", source="matter_review",
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        actor=Actor(kind="user", actor_id="owner"),
    )

    entries = service.list_progress(matter["public_id"])
    assert len(entries) == 1
    assert entries[0]["kind"] == "milestone"
    assert entries[0]["title"] == "首批设备已到场"
    assert entries[0]["body"] == "现场清点无缺件。"
    assert entries[0]["happened_at"] == NOW - 3600_000
    # 🔴 内容是 Agent 写的 → 行的 actor 是 agent；owner 只是放行。
    assert entries[0]["actor_kind"] == "agent"
    # 审计事件那一侧记的是**放行的人**，两件事各自如实。
    event = next(
        entry for entry in service.timeline(matter["public_id"], cursor=None, limit=20)["items"]
        if entry["kind"] == PROGRESS_ADDED
    )
    assert event["actor_kind"] == "user"
    assert event["actor_id"] == "owner"
    assert event["payload"]["via_update_id"] == proposal["update_id"]


def test_pending_progress_proposal_is_not_written_until_accepted(services):
    """🔴 结构红线：定时跟进 run 没有进展写工具，提案在 owner 拍板前一个字都不落库。"""
    service, run_service = services
    matter = _matter(service)
    _propose(service, run_service, matter, [_progress_change("c1")])
    assert service.list_progress(matter["public_id"]) == []


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        ({"id": "c1", "kind": "progress", "sources": []}, "progress_spec_missing"),
        (_progress_change("c1", kind="rumor"), "progress_kind_invalid"),
        (_progress_change("c1", title="  "), "progress_title_missing"),
        (_progress_change("c1", happened_at=NOW_SECONDS), "timestamp_not_epoch_ms"),
        # 坏 ref（缺 type）若留到 accept 才被 normalize_progress_refs 掀掉，
        # 报错落在 owner 的整次接受上 —— 判据必须与落行同源、在 propose 侧先剔。
        (_progress_change("c1", refs=[{"message_id": "x"}]), "progress_refs_invalid"),
    ],
)
def test_malformed_progress_changes_are_dropped_at_propose_time(services, change, reason):
    """propose 侧 fail-closed 剔除 —— agent 当轮就能从 dropped 明细里自纠。"""
    service, run_service = services
    matter = _matter(service)
    proposal = _propose(service, run_service, matter, [change])
    assert [entry["reason"] for entry in proposal["dropped"]] == [reason]
    detail = service.get_update_detail(matter["public_id"], proposal["update_id"])
    assert detail["update"]["changes"] == []


def test_progress_proposal_is_pure_append_and_survives_unrelated_writes(services):
    """`kind=progress` 不触及任何既有对象 ⇒ owner 评审期间改别的东西不该把它作废。"""
    service, run_service = services
    matter = _matter(service)
    proposal = _propose(service, run_service, matter, [_progress_change("c1")])

    service.patch_matter(
        matter["public_id"], {"priority": "p0"},
        **_mutation(
            service.get_matter(matter["public_id"])["matter"]["version"], "unrelated"
        ),
    )
    service.accept_update(
        matter["public_id"], proposal["update_id"],
        idempotency_key="accept-1", source="matter_review",
        expected_version=service.get_matter(matter["public_id"])["matter"]["version"],
        actor=Actor(kind="user", actor_id="owner"),
    )
    assert len(service.list_progress(matter["public_id"])) == 1


# ============================================================
# 5 — 读面：detail include 与导出
# ============================================================


def test_detail_include_serves_curated_progress_without_the_deleted_ones(service):
    matter = _matter(service)
    kept = _add(service, matter["public_id"], matter["version"], "p-1", title="留着的")
    gone = _add(service, matter["public_id"], kept["version"], "p-2", title="删掉的")
    service.delete_progress(
        matter["public_id"], gone["progress"]["id"],
        **_mutation(gone["version"], "p-del"),
    )

    detail = service.get_matter(matter["public_id"], include=["progress"])
    assert [entry["title"] for entry in detail["progress"]] == ["留着的"]
    # 没要就不给（include 是显式的）。
    assert "progress" not in service.get_matter(matter["public_id"])


def test_export_carries_a_progress_section_in_narrative_order(service):
    matter = _matter(service)
    first = _add(
        service, matter["public_id"], matter["version"], "p-1",
        kind="goal", title="先立目标", happened_at=NOW - 2 * 86_400_000,
    )
    _add(
        service, matter["public_id"], first["version"], "p-2",
        kind="milestone", title="再到里程碑", body="现场清点无缺件。", happened_at=NOW,
    )

    data = export_matter(service, matter["public_id"])
    # 🔴 导出是给人从头读一遍的：正序（界面是倒序）。
    assert [entry["title"] for entry in data["progress"]] == ["先立目标", "再到里程碑"]
    assert data["progress"][0]["kind"] == "goal"

    markdown = export_matter_markdown(service, matter["public_id"])
    assert "## 进展" in markdown
    assert markdown.index("先立目标") < markdown.index("再到里程碑")
    assert "现场清点无缺件。" in markdown


def test_context_snapshot_projects_the_recent_progress_newest_first(service):
    """Lane B —— 事项对话与跟进 run 共用的快照面：看不见进展就会把记过的事再记一遍。

    有界投影，判据逐条：条数封顶 10、软删的不进、正文截到 500、`refs` **有意缺席**
    （证据链是给人点开验证的 UI 载荷；模型拿到一串 id 只会转手抄进提案的 sources，
    而那里有服务端独立校验，抄来的引用整条被丢）。
    """
    from src.matters.service import SNAPSHOT_PROGRESS_LIMIT

    matter = _matter(service)
    version = matter["version"]
    for index in range(SNAPSHOT_PROGRESS_LIMIT + 2):
        result = _add(
            service, matter["public_id"], version, f"p-{index}",
            title=f"第 {index} 条",
            body="正文" * 400,
            happened_at=NOW - (index * 86_400_000),
            refs=[{"type": "url", "url": "https://example.test/evidence"}],
        )
        version = result["version"]
    dropped = _add(
        service, matter["public_id"], version, "p-gone", title="删掉的",
        happened_at=NOW + 86_400_000,
    )
    service.delete_progress(
        matter["public_id"], dropped["progress"]["id"],
        **_mutation(dropped["version"], "p-gone-del"),
    )

    progress = service.context_snapshot(matter["public_id"])["progress"]
    assert [entry["title"] for entry in progress] == [
        f"第 {index} 条" for index in range(SNAPSHOT_PROGRESS_LIMIT)
    ]
    assert len(progress[0]["body"]) == 500
    assert set(progress[0]) == {"kind", "title", "body", "happened_at", "actor_kind"}


def test_progress_rows_do_not_leak_into_the_search_projection(service):
    """v1 有意不做：检索面按 items / notes / stakeholders 三个桶组织，进展不进第四个桶。"""
    matter = _matter(service)
    _add(service, matter["public_id"], matter["version"], "p-1", title="独一无二的检索词 zzqq")
    with sqlite3.connect(service.repository.db_path) as conn:
        hit = conn.execute(
            "SELECT COUNT(*) FROM matter_search_document WHERE items_text LIKE '%zzqq%' "
            "OR notes_text LIKE '%zzqq%' OR description LIKE '%zzqq%'"
        ).fetchone()[0]
    assert hit == 0


# ============================================================
# 6 — REST 面（形状照 item 端点）
# ============================================================


@pytest.fixture
def http(tmp_path):
    import os
    from types import SimpleNamespace

    os.environ.setdefault("MAILAGENT_API_AUTH_DISABLED", "true")
    os.environ.setdefault("MAILAGENT_API_DEV", "true")
    os.environ.setdefault("MAILAGENT_API_HOST", "127.0.0.1")
    from fastapi.testclient import TestClient

    from src.api.app import app
    from src.api.auth import verify_cf_access
    from src.api.deps import get_settings
    from src.api.routers.matters import get_matter_service

    path = tmp_path / "progress-api.db"
    SyncStore(str(path))
    app.dependency_overrides[verify_cf_access] = lambda: None
    app.dependency_overrides[get_settings] = lambda: SimpleNamespace(
        sync_store_db_path=str(path)
    )
    app.dependency_overrides[get_matter_service] = lambda: MatterService(
        MatterRepository(path)
    )
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def _rest_matter(http) -> dict:
    created = http.post(
        "/api/matters",
        json={
            "title": "REST 事项",
            "mutation": {"source": "desktop_ui", "idempotency_key": "create"},
        },
    )
    assert created.status_code == 201, created.text
    return created.json()["data"]["matter"]


def test_progress_rest_crud_round_trip(http):
    matter = _rest_matter(http)
    public_id = matter["public_id"]

    created = http.post(
        f"/api/matters/{public_id}/progress",
        json={
            "kind": "signal",
            "title": "对方法务卡在合规条款",
            "body": "预计拖两周。",
            "refs": [{"type": "email", "message_id": "<a@b.test>"}],
            "mutation": {
                "source": "desktop_ui",
                "idempotency_key": "rest-add",
                "expected_version": matter["version"],
            },
        },
    )
    assert created.status_code == 201, created.text
    entry = created.json()["data"]["progress"]
    assert entry["kind"] == "signal"
    assert entry["refs"] == [{"type": "email", "message_id": "<a@b.test>"}]
    version = created.json()["data"]["version"]

    listed = http.get(f"/api/matters/{public_id}/progress")
    assert [row["id"] for row in listed.json()["data"]["items"]] == [entry["id"]]

    patched = http.patch(
        f"/api/matters/{public_id}/progress/{entry['id']}",
        json={
            "title": "合规条款已谈拢",
            "kind": "decision",
            "mutation": {
                "source": "desktop_ui",
                "idempotency_key": "rest-patch",
                "expected_version": version,
            },
        },
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["data"]["progress"]["kind"] == "decision"
    version = patched.json()["data"]["version"]

    removed = http.request(
        "DELETE",
        f"/api/matters/{public_id}/progress/{entry['id']}",
        json={
            "mutation": {
                "source": "desktop_ui",
                "idempotency_key": "rest-delete",
                "expected_version": version,
            }
        },
    )
    assert removed.status_code == 200, removed.text
    assert http.get(f"/api/matters/{public_id}/progress").json()["data"]["items"] == []
    version = removed.json()["data"]["version"]

    restored = http.post(
        f"/api/matters/{public_id}/progress/{entry['id']}/restore",
        json={
            "mutation": {
                "source": "desktop_ui",
                "idempotency_key": "rest-restore",
                "expected_version": version,
            }
        },
    )
    assert restored.status_code == 200, restored.text
    assert len(http.get(f"/api/matters/{public_id}/progress").json()["data"]["items"]) == 1


def test_progress_rest_refuses_unknown_kind_and_epoch_seconds(http):
    matter = _rest_matter(http)
    public_id = matter["public_id"]

    # 词表越界在 pydantic 边界就 422（枚举引 models 单源，不手抄）。
    bad_kind = http.post(
        f"/api/matters/{public_id}/progress",
        json={
            "kind": "rumor",
            "title": "x",
            "mutation": {
                "source": "desktop_ui",
                "idempotency_key": "bad-kind",
                "expected_version": matter["version"],
            },
        },
    )
    assert bad_kind.status_code == 422, bad_kind.text

    # 秒值是**合法整数**，pydantic 拦不住 —— 由 service 的 epoch-ms 门拒（400）。
    bad_ts = http.post(
        f"/api/matters/{public_id}/progress",
        json={
            "kind": "progress",
            "title": "x",
            "happened_at": NOW_SECONDS,
            "mutation": {
                "source": "desktop_ui",
                "idempotency_key": "bad-ts",
                "expected_version": matter["version"],
            },
        },
    )
    assert bad_ts.status_code == 400, bad_ts.text
    assert http.get(f"/api/matters/{public_id}/progress").json()["data"]["items"] == []

"""11-03 反馈：Agent 提案里两种真实出现过的形状让「接受」整份失败。

1. 完成标志多包一层 ``{"goal_checks": [...]}`` —— 归一函数遍历到键名字符串，报
   ``goal check must be an object``。
2. 改既有行动项写 ``target.field="title"`` + 字符串 ``after`` —— 旧代码把字符串一律
   当 status 校验，新标题被拒成 ``invalid status``。

另外两条：坏字段值在**提案入库时**就剔除（Agent 当轮可见，不留给 owner），以及拒绝
允许不写原因。
"""

from __future__ import annotations

from src.mail.sync_store import SyncStore
from src.matters.repository import MatterRepository
from src.matters.run_service import MatterRunService
from src.matters.service import Actor, MatterService

NOW = 1_760_000_000_000
ME = Actor(kind="user", actor_id="me")


def _services(tmp_path):
    path = tmp_path / "shapes.db"
    SyncStore(str(path))
    repo = MatterRepository(str(path))
    return MatterService(repo, clock_ms=lambda: NOW), MatterRunService(repo, clock_ms=lambda: NOW)


def _version(service, matter):
    return service.get_matter(matter["public_id"])["matter"]["version"]


def _propose(service, run_service, matter, changes, *, key="run-1"):
    run = run_service.enqueue_run(
        matter["public_id"], expected_version=_version(service, matter),
        idempotency_key=key, source="test",
    )["run"]
    run_service.mark_started(run["id"])
    return run_service.propose_update(
        matter["public_id"], run["id"], {"summary": "s", "changes": changes}
    )


def _accept(service, matter, update_id):
    return service.accept_update(
        matter["public_id"], update_id, idempotency_key="a1", source="test",
        expected_version=_version(service, matter), actor=ME,
    )


def _field(change_id, field, after):
    return {
        "id": change_id, "kind": "field",
        "target": {"entity": "matter", "field": field},
        "operation": "replace", "after": after, "sources": [],
    }


def test_wrapped_goal_checks_are_accepted(tmp_path):
    service, run_service = _services(tmp_path)
    matter = service.create_matter({"title": "t"}, idempotency_key="c", source="test")["matter"]
    checks = [{"t": "会议已召开", "done": True}, {"t": "规划对齐", "done": False}]
    proposal = _propose(
        service, run_service, matter, [_field("g", "goal_checks", {"goal_checks": checks})]
    )
    assert proposal["dropped"] == []
    _accept(service, matter, proposal["update_id"])
    assert service.get_matter(matter["public_id"])["matter"]["goal_checks"] == checks


def test_action_title_change_with_string_after_updates_the_title(tmp_path):
    service, run_service = _services(tmp_path)
    matter = service.create_matter({"title": "t"}, idempotency_key="c", source="test")["matter"]
    item = service.create_item(
        matter["public_id"], {"kind": "action", "title": "旧标题"},
        expected_version=_version(service, matter), idempotency_key="i", source="test",
    )["item"]
    change = {
        "id": "act", "kind": "action",
        "target": {"entity": "item", "id": item["id"], "field": "title"},
        "operation": "replace", "before": "旧标题", "after": "新标题：三选一决定去向",
        "sources": [],
    }
    proposal = _propose(service, run_service, matter, [change])
    assert proposal["dropped"] == []
    _accept(service, matter, proposal["update_id"])
    items = service.list_items(matter["public_id"])
    updated = next(i for i in items if i["id"] == item["id"])
    assert updated["title"] == "新标题：三选一决定去向"
    assert updated["status"] == "open"


def test_invalid_field_values_are_dropped_at_propose_time(tmp_path):
    service, run_service = _services(tmp_path)
    matter = service.create_matter({"title": "t"}, idempotency_key="c", source="test")["matter"]
    proposal = _propose(
        service, run_service, matter,
        [
            _field("bad-health", "health", "very_bad"),
            _field("bad-checks", "goal_checks", ["not-an-object"]),
            _field("ok-health", "health", "at_risk"),
        ],
    )
    assert {d["id"] for d in proposal["dropped"]} == {"bad-health", "bad-checks"}
    _accept(service, matter, proposal["update_id"])
    assert service.get_matter(matter["public_id"])["matter"]["health"] == "at_risk"


def test_reject_without_reason(tmp_path):
    service, run_service = _services(tmp_path)
    matter = service.create_matter({"title": "t"}, idempotency_key="c", source="test")["matter"]
    proposal = _propose(service, run_service, matter, [_field("h", "health", "at_risk")])
    result = service.reject_update(
        matter["public_id"], proposal["update_id"], reason="  ",
        expected_version=_version(service, matter), idempotency_key="r", source="test", actor=ME,
    )
    assert result["update"]["review_status"] == "rejected"

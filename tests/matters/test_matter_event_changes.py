"""时间线事件的「值级」变更投影 + 绑定事件去重。

背景（owner dogfood 0812）：时间线看起来像 audit log，因为事件 payload 只存了
**字段名**（`{"fields": ["status"]}`），"状态 进行中 → 等待中"这种句子物理上写不出来。
本文件钉死两件事：

1. `changes` 契约 —— 业务字段带原始前后像、长文本截断、`from` 键在/不在语义不同、
   老行（无 `changes` 键）照旧可读。
2. `patch_matter` 不再对同一次绑定修改写两条 `happened_at` 与 `fields` 完全相同的事件。

🔴 append-only：本批只改**新写入**的形状，历史行一律不回填、不改写。
"""

from __future__ import annotations

import json

import pytest

from src.mail.sync_store import SyncStore
from src.matters import service as service_module
from src.matters.event_changes import (
    CHANGE_TEXT_MAX_CHARS,
    MATTER_CHANGE_FIELDS,
    MATTER_STRUCTURED_FIELDS,
    build_changes,
)
from src.matters.repository import MatterRepository
from src.matters.service import MatterService


@pytest.fixture
def service(tmp_path) -> MatterService:
    path = tmp_path / "matter-event-changes.db"
    SyncStore(str(path))
    return MatterService(MatterRepository(path), clock_ms=lambda: 1_700_000_000_000)


def mutation(version: int, key: str) -> dict:
    return {
        "expected_version": version,
        "idempotency_key": key,
        "source": "desktop_ui",
    }


def timeline(service: MatterService, public_id: str) -> list[dict]:
    """按写入顺序（id 升序）返回事件行，payload 已解析。"""
    with service.repository.connect() as conn:
        matter = service.repository.get_matter(conn, public_id)
        rows = conn.execute(
            "SELECT id,kind,happened_at,payload_json FROM matter_event "
            "WHERE matter_id=? ORDER BY id",
            (matter["id"],),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "kind": row["kind"],
            "happened_at": row["happened_at"],
            "payload": json.loads(row["payload_json"] or "{}"),
        }
        for row in rows
    ]


def event_of(events: list[dict], kind: str) -> dict:
    matches = [event for event in events if event["kind"] == kind]
    assert matches, f"no {kind} event in {[e['kind'] for e in events]}"
    return matches[-1]


def changes_by_field(payload: dict) -> dict[str, dict]:
    return {entry["field"]: entry for entry in payload["changes"]}


def new_matter(service: MatterService, **data) -> str:
    created = service.create_matter(
        {"title": "Matter", **data}, idempotency_key="create", source="desktop_ui"
    )
    return created["matter"]["public_id"]


# --------------------------------------------------------------------------
# 1. 业务字段 from→to
# --------------------------------------------------------------------------


def test_business_fields_land_raw_from_to(service):
    public_id = new_matter(service, priority="p1", status="inbox")
    service.patch_matter(
        public_id,
        {"status": "active", "priority": "p0", "health": "at_risk"},
        **mutation(1, "patch"),
    )
    payload = event_of(timeline(service, public_id), "matter_updated")["payload"]
    # `fields` 保留（老前端与老行继续可读）
    assert payload["fields"] == ["health", "priority", "status"]
    assert changes_by_field(payload) == {
        "status": {"field": "status", "from": "inbox", "to": "active"},
        "priority": {"field": "priority", "from": "p1", "to": "p0"},
        "health": {"field": "health", "from": "unknown", "to": "at_risk"},
    }


def test_values_are_枚举字面量_not_localized_text(service):
    """后端塞中文会同时污染 en-US 与 API 契约 —— 文案是前端 i18n 的事。"""
    public_id = new_matter(service)
    service.patch_matter(public_id, {"status": "waiting"}, **mutation(1, "patch"))
    entry = changes_by_field(
        event_of(timeline(service, public_id), "matter_updated")["payload"]
    )["status"]
    assert entry["to"] == "waiting"
    assert all(ord(char) < 128 for char in entry["to"])


def test_timestamp_stays_numeric(service):
    public_id = new_matter(service)
    service.patch_matter(public_id, {"due_at": 1_800_000_000_000}, **mutation(1, "due"))
    entry = changes_by_field(
        event_of(timeline(service, public_id), "matter_updated")["payload"]
    )["due_at"]
    assert entry["from"] is None
    assert entry["to"] == 1_800_000_000_000


def test_tags_list_carries_both_sides(service):
    public_id = new_matter(service, tags=["alpha"])
    service.patch_matter(
        public_id, {"tags": ["alpha", "beta"]}, **mutation(1, "tags")
    )
    entry = changes_by_field(
        event_of(timeline(service, public_id), "matter_updated")["payload"]
    )["tags"]
    assert entry["from"] == ["alpha"]
    assert entry["to"] == ["alpha", "beta"]


def test_unchanged_field_is_not_a_change(service):
    """"状态 进行中 → 进行中" 正是 owner 说的 audit-log 噪音。字段名仍留在 fields 里。"""
    public_id = new_matter(service, status="inbox")
    service.patch_matter(
        public_id, {"status": "inbox", "priority": "p0"}, **mutation(1, "patch")
    )
    payload = event_of(timeline(service, public_id), "matter_updated")["payload"]
    assert payload["fields"] == ["priority", "status"]
    assert [entry["field"] for entry in payload["changes"]] == ["priority"]


# --------------------------------------------------------------------------
# 2. 长文本截断
# --------------------------------------------------------------------------


def test_long_text_is_truncated_and_flagged(service):
    public_id = new_matter(service)
    long_summary = "摘" * 500
    service.patch_matter(
        public_id, {"current_summary": long_summary}, **mutation(1, "sum")
    )
    entry = changes_by_field(
        event_of(timeline(service, public_id), "matter_updated")["payload"]
    )["current_summary"]
    assert entry["to"] == long_summary[:CHANGE_TEXT_MAX_CHARS]
    assert len(entry["to"]) == CHANGE_TEXT_MAX_CHARS
    # 只有 `to` 被截断 —— `from` 侧（None）没被截，不许打标记
    assert entry["to_truncated"] is True
    assert "from_truncated" not in entry


def test_truncation_flags_are_per_side(service):
    """🔴 合成一个 `truncated` 布尔会让前端说谎。

    前端只能靠「哪侧长度等于两侧最大值」反推是谁被截了；旧值恰好 CHANGE_TEXT_MAX_CHARS
    字、新值多一个字被截到同样长度时，两侧长度**相同** ⇒ 前端给两边都加省略号，谎称旧值
    也被截断。契约 = `from_truncated` / `to_truncated` 各自只在那一侧真被截时出现。
    """
    public_id = new_matter(service)
    exact = "旧" * CHANGE_TEXT_MAX_CHARS
    longer = "新" * (CHANGE_TEXT_MAX_CHARS + 1)
    version = service.patch_matter(
        public_id, {"current_summary": exact}, **mutation(1, "exact")
    )["version"]
    service.patch_matter(
        public_id, {"current_summary": longer}, **mutation(version, "longer")
    )
    entry = changes_by_field(
        event_of(timeline(service, public_id), "matter_updated")["payload"]
    )["current_summary"]
    assert len(entry["from"]) == len(entry["to"]) == CHANGE_TEXT_MAX_CHARS
    assert entry["to_truncated"] is True
    assert "from_truncated" not in entry  # 旧值恰好到限额，一个字都没丢
    assert "truncated" not in entry  # 老键不再随新行发出（见模块 docstring 纪律 2/4）


def test_short_text_carries_no_truncated_flag(service):
    public_id = new_matter(service)
    service.patch_matter(public_id, {"title": "短标题"}, **mutation(1, "title"))
    entry = changes_by_field(
        event_of(timeline(service, public_id), "matter_updated")["payload"]
    )["title"]
    assert entry == {"field": "title", "from": "Matter", "to": "短标题"}


def test_two_long_texts_sharing_a_prefix_still_count_as_a_change(service):
    """相等判据必须用**截断前**的原始值，否则前 120 字相同的长文本会被误判成没变。"""
    public_id = new_matter(service)
    first = "同" * CHANGE_TEXT_MAX_CHARS + "尾巴甲"
    second = "同" * CHANGE_TEXT_MAX_CHARS + "尾巴乙"
    version = service.patch_matter(
        public_id, {"current_summary": first}, **mutation(1, "a")
    )["version"]
    service.patch_matter(public_id, {"current_summary": second}, **mutation(version, "b"))
    entry = changes_by_field(
        event_of(timeline(service, public_id), "matter_updated")["payload"]
    )["current_summary"]
    assert entry["from_truncated"] is True and entry["to_truncated"] is True
    assert entry["from"] == entry["to"]  # 投影后前 120 字一样，但这条变化仍被记下


# --------------------------------------------------------------------------
# 2b. 非有限浮点（NaN / Infinity）
# --------------------------------------------------------------------------


def test_non_finite_float_is_skipped_instead_of_rolling_back_the_write(service):
    """契约 = **跳过**这条 change（字段名仍在 `fields` 里），不是报错。

    `json.dumps` 默认会把 NaN/Infinity 输出成**非标准** JSON 字面量，
    `CHECK (json_valid(payload_json))` 当场拒收 —— 而此时业务更新已经写完，只有事件那一句
    失败 ⇒ **整笔事务回滚**，一个参数问题被放大成 500。投影层不许把一次写入弄失败。
    """
    public_id = new_matter(service)
    created = service.create_item(
        public_id, {"kind": "action", "title": "催回执"}, **mutation(1, "item")
    )
    item_id = created["item"]["id"]
    result = service.update_item(
        public_id,
        item_id,
        {"due_at": float("inf"), "title": "改过的标题"},
        **mutation(created["version"], "inf"),
    )
    assert result["item"]["title"] == "改过的标题"  # 业务更新照常落地
    payload = event_of(timeline(service, public_id), "item_updated")["payload"]
    assert payload["fields"] == ["due_at", "title"]  # 字段名仍在
    assert [entry["field"] for entry in payload["changes"]] == ["title"]


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_float_is_not_narratable_anywhere(bad):
    """标量与列表元素两个位置都得挡住（列表走 `_project` 的递归分支）。"""
    assert (
        build_changes(["due_at"], None, {"due_at": bad}, allowed=MATTER_CHANGE_FIELDS)
        == []
    )
    assert (
        build_changes(["tags"], None, {"tags": ["a", bad]}, allowed=MATTER_CHANGE_FIELDS)
        == []
    )
    # 前像非有限、后像正常 —— 同样跳过（与 dict 前像同规则）
    assert (
        build_changes(
            ["due_at"], {"due_at": bad}, {"due_at": 1}, allowed=MATTER_CHANGE_FIELDS
        )
        == []
    )


def test_non_finite_float_in_a_json_column_is_a_400_not_a_500(service):
    """最终防线：`_dump(allow_nan=False)`。

    `waiting_context` / `checklist` / 提案 change 的 `after` 都是 `dict[str, Any]`，
    REST 边界不校验里面的标量，而 JSON 解析器默认就认 `NaN`/`Infinity` 三个字面量。
    没有这道闸，非有限浮点会写出非法 JSON → CHECK 拒收 → 整笔事务回滚成 500。
    """
    public_id = new_matter(service)
    with pytest.raises(service_module.MatterError) as excinfo:
        service.patch_matter(
            public_id,
            {"waiting_context": {"who": "NexPay", "sla_days": float("nan")}},
            **mutation(1, "ctx"),
        )
    assert excinfo.value.code == "E_INVALID_ARG"


# --------------------------------------------------------------------------
# 3. null vs 字段不存在
# --------------------------------------------------------------------------


def test_null_before_is_a_present_from_key(service):
    """首次设置：`from` 键**在**且为 null = "之前确实是空"。"""
    public_id = new_matter(service)
    service.patch_matter(public_id, {"matter_type": "采购"}, **mutation(1, "type"))
    entry = changes_by_field(
        event_of(timeline(service, public_id), "matter_updated")["payload"]
    )["matter_type"]
    assert "from" in entry and entry["from"] is None
    assert entry["to"] == "采购"


def test_missing_before_omits_the_from_key():
    """前像不可知（新建对象）⇒ `from` 键**不在**，不许伪装成 null。"""
    changes = build_changes(
        ["status"], None, {"status": "active"}, allowed=MATTER_CHANGE_FIELDS
    )
    assert changes == [{"field": "status", "to": "active"}]
    assert "from" not in changes[0]


def test_clearing_a_value_lands_to_null(service):
    public_id = new_matter(service, matter_type="采购")
    service.patch_matter(public_id, {"matter_type": None}, **mutation(1, "clear"))
    entry = changes_by_field(
        event_of(timeline(service, public_id), "matter_updated")["payload"]
    )["matter_type"]
    assert entry == {"field": "matter_type", "from": "采购", "to": None}


# --------------------------------------------------------------------------
# 4. 结构化大对象不进 changes
# --------------------------------------------------------------------------


def test_structured_fields_stay_out_of_changes(service):
    """schedule_json / goal_checks / waiting_context 的"前后值"是一坨 JSON，
    写不出句子，塞进事件表只会让它膨胀 —— 只留在 `fields` 里。"""
    public_id = new_matter(service)
    service.patch_matter(
        public_id,
        {
            "goal_checks": [{"t": "合规回执到手", "done": False}],
            "waiting_context": {"who": "NexPay"},
            "status": "waiting",
        },
        **mutation(1, "structured"),
    )
    payload = event_of(timeline(service, public_id), "matter_updated")["payload"]
    assert set(payload["fields"]) == {"goal_checks", "waiting_context", "status"}
    assert [entry["field"] for entry in payload["changes"]] == ["status"]


def test_every_patch_field_is_either_narratable_or_explicitly_structured():
    """加一个可 patch 字段却没决定它进不进 changes ⇒ 红。"""
    patchable = (
        service_module.DIRECT_PATCH_FIELDS
        | service_module.MANUAL_UPDATE_FIELDS
        | service_module.BINDING_PATCH_FIELDS
    )
    assert MATTER_CHANGE_FIELDS | MATTER_STRUCTURED_FIELDS == patchable
    assert not (MATTER_CHANGE_FIELDS & MATTER_STRUCTURED_FIELDS)


# --------------------------------------------------------------------------
# 5. 绑定事件去重
# --------------------------------------------------------------------------


def test_binding_only_patch_writes_exactly_one_event(service):
    """活库铁证：id=34 matter_updated 与 id=35 agent_binding_changed 的 happened_at
    与 fields 完全相同 ⇒ UI 上两行在讲同一件事。"""
    public_id = new_matter(service)
    result = service.patch_matter(
        public_id,
        {"agent_enabled": False, "matter_instructions": "盯紧合规回执"},
        **mutation(1, "bind"),
    )
    assert len(result["event_ids"]) == 1
    events = [
        event
        for event in timeline(service, public_id)
        if event["kind"] in ("matter_updated", "agent_binding_changed")
    ]
    assert [event["kind"] for event in events] == ["agent_binding_changed"]
    payload = events[0]["payload"]
    assert payload["fields"] == ["agent_enabled", "matter_instructions"]
    assert changes_by_field(payload)["agent_enabled"] == {
        "field": "agent_enabled",
        "from": 1,
        "to": 0,
    }


def test_mixed_patch_splits_fields_between_the_two_events(service):
    """两条事件的 `fields` 必须不相交 —— 这就是去重的判据。"""
    public_id = new_matter(service)
    result = service.patch_matter(
        public_id,
        {"status": "active", "agent_enabled": False},
        **mutation(1, "mixed"),
    )
    assert len(result["event_ids"]) == 2
    events = timeline(service, public_id)
    plain = event_of(events, "matter_updated")["payload"]
    binding = event_of(events, "agent_binding_changed")["payload"]
    assert plain["fields"] == ["status"]
    assert binding["fields"] == ["agent_enabled"]
    assert not set(plain["fields"]) & set(binding["fields"])
    assert [entry["field"] for entry in plain["changes"]] == ["status"]
    assert [entry["field"] for entry in binding["changes"]] == ["agent_enabled"]


def test_binding_only_patch_is_still_idempotent(service):
    """主事件的 kind 变了，replay 落点也得跟着变 —— 否则重放会重复写一条。"""
    public_id = new_matter(service)
    first = service.patch_matter(
        public_id, {"agent_enabled": False}, **mutation(1, "bind")
    )
    replay = service.patch_matter(
        public_id, {"agent_enabled": False}, **mutation(1, "bind")
    )
    assert replay["event_ids"] == first["event_ids"]
    kinds = [event["kind"] for event in timeline(service, public_id)]
    assert kinds.count("agent_binding_changed") == 1
    assert kinds.count("matter_updated") == 0


def test_non_binding_patch_still_writes_only_matter_updated(service):
    public_id = new_matter(service)
    result = service.patch_matter(public_id, {"title": "改名"}, **mutation(1, "t"))
    assert len(result["event_ids"]) == 1
    kinds = [event["kind"] for event in timeline(service, public_id)]
    assert kinds.count("matter_updated") == 1
    assert kinds.count("agent_binding_changed") == 0


# --------------------------------------------------------------------------
# 6. 老行（无 changes 键）不炸
# --------------------------------------------------------------------------


def test_legacy_rows_without_changes_key_are_still_readable(service):
    """append-only：历史行有意不回填。读侧（timeline / context_snapshot）必须照旧工作。"""
    public_id = new_matter(service)
    with service.repository.transaction() as conn:
        matter = service.repository.get_matter(conn, public_id)
        conn.execute(
            "INSERT INTO matter_event(matter_id,kind,happened_at,actor_kind,source,"
            "dedupe_key,payload_json,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (
                matter["id"],
                "matter_updated",
                1_700_000_000_001,
                "user",
                "desktop_ui",
                "legacy-row",
                json.dumps({"fields": ["status", "priority"]}),
                1_700_000_000_001,
            ),
        )
    legacy = event_of(timeline(service, public_id), "matter_updated")
    assert "changes" not in legacy["payload"]
    assert legacy["payload"]["fields"] == ["status", "priority"]
    # 读路径不因缺键而炸
    assert service.timeline(public_id, cursor=None, limit=100)["items"]
    assert service.context_snapshot(public_id)["events"]


# --------------------------------------------------------------------------
# 7. item / resource / stakeholder 的句子标识
# --------------------------------------------------------------------------


def test_item_events_carry_title_and_changes(service):
    public_id = new_matter(service)
    created = service.create_item(
        public_id,
        {"kind": "question", "title": "补充协议是否需要新加坡实体共同签署？"},
        **mutation(1, "item"),
    )
    item_id = created["item"]["id"]
    payload = event_of(timeline(service, public_id), "item_created")["payload"]
    assert payload["title"] == "补充协议是否需要新加坡实体共同签署？"
    assert payload["kind"] == "question"

    service.update_item(
        public_id, item_id, {"title": "改过的标题"}, **mutation(created["version"], "upd")
    )
    payload = event_of(timeline(service, public_id), "item_updated")["payload"]
    assert payload["title"] == "改过的标题"
    assert changes_by_field(payload)["title"] == {
        "field": "title",
        "from": "补充协议是否需要新加坡实体共同签署？",
        "to": "改过的标题",
    }


def test_item_delete_carries_identity_but_no_narratable_change(service):
    """delete/restore 的 patch 只有 deleted_at ⇒ changes 空数组，由事件 kind 自己叙述。"""
    public_id = new_matter(service)
    created = service.create_item(
        public_id, {"kind": "action", "title": "催合规回执"}, **mutation(1, "item")
    )
    service.delete_item(
        public_id, created["item"]["id"], **mutation(created["version"], "del")
    )
    payload = event_of(timeline(service, public_id), "item_deleted")["payload"]
    assert payload["title"] == "催合规回执"
    assert payload["changes"] == []


def test_resource_events_carry_resource_name(service):
    public_id = new_matter(service)
    added = service.add_resource(
        public_id,
        {
            "kind": "url",
            "provider": "web",
            "external_key": "https://example.test/spec",
            "title": "《二期接入技术方案》",
            "canonical_url": "https://example.test/spec",
        },
        **mutation(1, "res"),
    )
    payload = event_of(timeline(service, public_id), "resource_linked")["payload"]
    assert payload["title"] == "《二期接入技术方案》"
    assert payload["resource_kind"] == "url"

    resource_id = added["resources"][0]["resource"]["id"]
    service.unlink_resource(
        public_id, resource_id, **mutation(added["version"], "unlink")
    )
    payload = event_of(timeline(service, public_id), "resource_unlinked")["payload"]
    assert payload["title"] == "《二期接入技术方案》"


def test_stakeholder_events_carry_display_name_and_changes(service):
    public_id = new_matter(service)
    added = service.create_stakeholder(
        public_id,
        {"display_name": "张三", "email": "Zhang@Example.test", "role": "商务"},
        **mutation(1, "sh"),
    )
    payload = event_of(timeline(service, public_id), "stakeholder_added")["payload"]
    assert payload["display_name"] == "张三"
    # 新建 ⇒ 没有前像 ⇒ 只有 to
    assert changes_by_field(payload)["role"] == {"field": "role", "to": "商务"}

    service.update_stakeholder(
        public_id,
        added["stakeholder"]["id"],
        {"role": "法务", "is_waiting_on": True},
        **mutation(added["version"], "sh2"),
    )
    payload = event_of(timeline(service, public_id), "stakeholder_updated")["payload"]
    assert payload["display_name"] == "张三"
    assert changes_by_field(payload)["role"] == {
        "field": "role",
        "from": "商务",
        "to": "法务",
    }
    # email 有意不进 changes（PII，事件表不需要再存一份才能写出句子）
    assert "email" not in changes_by_field(payload)


def test_stakeholder_payload_never_carries_email(service):
    public_id = new_matter(service)
    added = service.create_stakeholder(
        public_id,
        {"display_name": "李四", "email": "li@example.test"},
        **mutation(1, "sh"),
    )
    assert added["stakeholder"]["email_normalized"] == "li@example.test"
    payload = event_of(timeline(service, public_id), "stakeholder_added")["payload"]
    assert "example.test" not in json.dumps(payload, ensure_ascii=False)


# --------------------------------------------------------------------------
# 8. 接受提案的扇出事件同样带值
# --------------------------------------------------------------------------


def test_accepted_proposal_fanout_carries_from_to(tmp_path):
    """owner 最在意的那句 "状态 进行中 → 等待中" 大多来自接受提案，不是手改。"""
    from src.matters.run_service import MatterRunService

    path = tmp_path / "accept-changes.db"
    SyncStore(str(path))
    run_service = MatterRunService(MatterRepository(path), clock_ms=lambda: 55_000)
    created = run_service.create_matter(
        {"title": "Fanout"}, idempotency_key="create", source="desktop_ui"
    )
    public_id = created["matter"]["public_id"]
    run = run_service.enqueue_run(
        public_id,
        expected_version=created["version"],
        idempotency_key="run-1",
        source="desktop_ui",
    )["run"]
    assert run_service.mark_started(run["id"])
    update_id = run_service.propose_update(
        public_id,
        run["id"],
        {
            "summary": "提案",
            "changes": [
                {
                    "id": "chg_01",
                    "kind": "field",
                    "target": {"entity": "matter", "field": "status"},
                    "operation": "replace",
                    "after": "waiting",
                    "sources": [],
                },
                {
                    "id": "chg_02",
                    "kind": "action",
                    "text": "催 NexPay 合规回执",
                    "sources": [],
                },
            ],
        },
    )["update_id"]
    run_service.accept_update(
        public_id,
        update_id,
        expected_version=run_service.get_matter(public_id)["matter"]["version"],
        idempotency_key="acc-1",
        source="desktop_ui",
    )
    events = timeline(run_service, public_id)
    fanout = event_of(events, "matter_updated")["payload"]
    assert fanout["via_update_id"] == update_id
    assert changes_by_field(fanout)["status"] == {
        "field": "status",
        "from": "inbox",
        "to": "waiting",
    }
    created_item = event_of(events, "item_created")["payload"]
    assert created_item["title"] == "催 NexPay 合规回执"

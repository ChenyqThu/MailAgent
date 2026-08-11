"""P6-B D6/D15/D16：四种 trigger 的解析、marker 兼容与 fire 幂等。"""

from __future__ import annotations

import json

import pytest

from src.matters.triggers import (
    CONDITION_TRIGGER_TYPES,
    EVENT_TRIGGER_TYPES,
    TriggerError,
    default_schedule_entry,
    dump_trigger_set,
    idempotency_key,
    is_legacy_shape,
    marker_key,
    normalize_trigger_json,
    parse_trigger_set,
)

V1_SCHEDULE = {
    "kind": "schedule",
    "rule": {
        "freq": "daily", "interval": 1, "weekdays": [1], "monthMode": "date",
        "monthDay": 1, "ordinal": 1, "weekday": 1, "hour": 9, "minute": 0, "clamp": False,
    },
    "anchor": "2026-08-01",
    "timezone": "UTC",
}


def test_v1_single_object_maps_to_one_entry_without_rewriting_db():
    entries = parse_trigger_set(json.dumps(V1_SCHEDULE), seed="7")
    assert len(entries) == 1
    assert entries[0].kind == "schedule"
    assert entries[0].enabled is True
    assert is_legacy_shape(json.dumps(V1_SCHEDULE)) is True


def test_v1_upconverted_id_is_stable_across_reads():
    """🔴 marker 键由 trigger id 组成：id 每次读都变 ⇒ 每 tick 都认为"从没 fire 过"。"""
    first = parse_trigger_set(json.dumps(V1_SCHEDULE), seed="7")[0]
    second = parse_trigger_set(json.dumps(V1_SCHEDULE), seed="7")[0]
    assert first.id == second.id


def test_legacy_row_keeps_old_marker_and_idempotency_keys():
    """升级不许换键 —— 换了等于「从没 fire 过」，会立刻补跑一次。"""
    entry = parse_trigger_set(json.dumps(V1_SCHEDULE), seed="7")[0]
    assert marker_key(7, entry, legacy=True) == "matter.schedule.last_fire.7"
    assert (
        idempotency_key(7, entry, "2026-08-09T09:00:00+00:00", legacy=True)
        == "matter_followup:7:schedule:2026-08-09T09:00:00+00:00"
    )


def test_v2_entries_get_per_trigger_marker_keys():
    """🔴 两条 trigger 不得共用 marker：共用时先 fire 的会把另一条永久判成已跑过。"""
    envelope = {
        "v": 2,
        "triggers": [
            {**V1_SCHEDULE, "id": "mtr_aaa", "enabled": True},
            {"id": "mtr_bbb", "kind": "condition", "enabled": True,
             "condition": "health_down"},
        ],
    }
    entries = parse_trigger_set(envelope, seed="7")
    assert len(entries) == 2
    keys = {marker_key(7, e, legacy=False) for e in entries}
    assert keys == {
        "matter.trigger.last_fire.7.mtr_aaa",
        "matter.trigger.last_fire.7.mtr_bbb",
    }


def test_unsupported_event_and_condition_values_are_rejected():
    """D15：只收录能映射到既有判据的项 —— 设计稿里的另外三项必须被拒，
    而不是存下来变成一条永不触发的配置。"""
    for bad in (
        {"kind": "event", "event_type": "meeting_ended"},
        {"kind": "condition", "condition": "no_progress_5d"},
        {"kind": "condition", "condition": "deadline_near"},
    ):
        with pytest.raises(TriggerError):
            parse_trigger_set({"v": 2, "triggers": [{**bad, "id": "x", "enabled": True}]})


def test_supported_option_sets_match_decision_d15():
    assert set(EVENT_TRIGGER_TYPES) == {"resource_linked_mail", "resource_doc_updated"}
    assert set(CONDITION_TRIGGER_TYPES) == {
        "action_overdue", "health_down", "wait_overdue"
    }


def test_malformed_shapes_fail_closed():
    for bad in ("not json", {"v": 2, "triggers": "nope"}, [{"kind": "nope"}], 42):
        with pytest.raises(TriggerError):
            parse_trigger_set(bad)


def test_schedule_entry_requires_object_rule():
    with pytest.raises(TriggerError):
        parse_trigger_set({"kind": "schedule", "rule": "daily", "anchor": "2026-08-01",
                           "timezone": "UTC"})


def test_duplicate_ids_rejected():
    with pytest.raises(TriggerError):
        parse_trigger_set({
            "v": 2,
            "triggers": [
                {"id": "same", "kind": "manual", "enabled": True},
                {"id": "same", "kind": "manual", "enabled": True},
            ],
        })


def test_normalize_produces_v2_envelope_and_empty_becomes_none():
    normalized = normalize_trigger_json(V1_SCHEDULE, seed="7")
    assert normalized["v"] == 2
    assert len(normalized["triggers"]) == 1
    assert normalize_trigger_json(None) is None
    assert normalize_trigger_json({"v": 2, "triggers": []}) is None


def test_default_schedule_entry_is_every_three_days_at_nine():
    entry = default_schedule_entry(anchor="2026-08-11", timezone_name="America/Los_Angeles")
    assert entry["rule"]["freq"] == "daily"
    assert entry["rule"]["interval"] == 3
    assert entry["rule"]["hour"] == 9
    assert entry["rule"]["minute"] == 0
    # 走一遍解析，保证默认值本身合法（否则新建事项会写进一条配不出来的排程）
    parsed = parse_trigger_set([entry], seed="new")
    assert parsed[0].kind == "schedule"
    assert dump_trigger_set(parsed)["v"] == 2

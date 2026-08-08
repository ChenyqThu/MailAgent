import json

import pytest

from src.agents.trigger import (
    CalendarBeforeStartTrigger,
    CalendarEventChangeTrigger,
    EmailFilterTrigger,
    TriggerValidationError,
    normalize_agent_config_patch,
    normalize_trigger_patch,
    parse_trigger_set,
)


def _email(trigger_id="trg_one", **extra):
    return {
        "id": trigger_id,
        "enabled": True,
        "kind": "email_filter",
        "subject_pattern": "DMS",
        **extra,
    }


def _set(*entries):
    return {"v": 2, "triggers": list(entries)}


def test_v1_wraps_single_legacy_entry():
    entries = parse_trigger_set({"v": 1, "kind": "email_filter", "folders": ["收件箱"]})
    assert len(entries) == 1
    assert entries[0].id is None
    assert entries[0].enabled is True


def test_empty_v2_set_is_valid():
    assert parse_trigger_set(_set()) == ()


@pytest.mark.parametrize(
    "trigger_id",
    [None, 1, "bad", "trg_UPPER", "trg_dash-x", "trg_" + "a" * 29],
)
def test_v2_id_validation(trigger_id):
    with pytest.raises(TriggerValidationError):
        parse_trigger_set(_set(_email(trigger_id)))


def test_v2_duplicate_ids_rejected():
    with pytest.raises(TriggerValidationError, match="duplicate"):
        parse_trigger_set(_set(_email(), _email()))


@pytest.mark.parametrize("enabled", [0, 1, "true", None])
def test_enabled_is_strict_boolean(enabled):
    with pytest.raises(TriggerValidationError, match="boolean"):
        parse_trigger_set(_set({**_email(), "enabled": enabled}))


def test_unknown_kind_and_version_rejected():
    with pytest.raises(TriggerValidationError, match="unknown trigger kind"):
        parse_trigger_set(_set({"id": "trg_x", "enabled": True, "kind": "webhook"}))
    with pytest.raises(TriggerValidationError, match="expect 1 or 2"):
        parse_trigger_set({"v": 3, "triggers": []})


def test_thread_ids_are_email_predicate_and_validated():
    entry = parse_trigger_set(
        _set({"id": "trg_thread", "enabled": True, "kind": "email_filter", "thread_ids": ["abc"]})
    )[0]
    assert isinstance(entry.trigger, EmailFilterTrigger)
    assert entry.trigger.thread_ids == ("abc",)
    with pytest.raises(TriggerValidationError, match="list of strings"):
        parse_trigger_set(_set({"id": "trg_x", "enabled": True, "kind": "email_filter", "thread_ids": [1]}))
    with pytest.raises(TriggerValidationError, match="too many"):
        parse_trigger_set(_set({"id": "trg_x", "enabled": True, "kind": "email_filter", "thread_ids": [str(i) for i in range(51)]}))


@pytest.mark.parametrize(
    "entry",
    [
        _email(subject_pattern="("),
        {"id": "trg_cron", "enabled": True, "kind": "cron", "cron": "garbage"},
        {"id": "trg_cron", "enabled": True, "kind": "cron", "cron": "0 9 * * *", "timezone": "Mars/Olympus"},
    ],
)
def test_v2_inherits_v1_deep_validation(entry):
    with pytest.raises(TriggerValidationError):
        parse_trigger_set(_set(entry))


def test_normalization_adds_ids_and_preserves_single_same_kind_id(monkeypatch):
    monkeypatch.setattr("src.agents.trigger.trigger_v2_enabled", lambda: True)
    stored = _set(_email("trg_stable"))
    normalized = normalize_trigger_patch(
        {"v": 1, "kind": "email_filter", "subject_pattern": "new"},
        json.dumps(stored),
    )
    assert normalized["v"] == 2
    assert normalized["triggers"][0]["id"] == "trg_stable"
    assert normalized["triggers"][0]["subject_pattern"] == "new"


def test_project_progress_patch_is_not_upconverted(monkeypatch):
    monkeypatch.setattr("src.agents.trigger.trigger_v2_enabled", lambda: True)
    raw = {"trigger": {"v": 1, "kind": "email_filter", "subject_pattern": "项目"}}
    assert normalize_agent_config_patch(raw, agent_type="project_progress") == raw


def test_flag_off_rejects_v2_write(monkeypatch):
    monkeypatch.setattr("src.agents.trigger.trigger_v2_enabled", lambda: False)
    with pytest.raises(TriggerValidationError, match="unsupported trigger version"):
        normalize_agent_config_patch({"trigger": _set()}, agent_type="custom")


@pytest.mark.parametrize("version", [1, 2])
def test_calendar_kinds_parse(version):
    change = {"v": 1, "kind": "calendar_event_change", "title_pattern": "Plan"}
    before = {"v": 1, "kind": "calendar_before_start", "lead_seconds": 86400}
    raw_change = change if version == 1 else _set({"id": "trg_cal", "enabled": True, **change, "v": 1})
    raw_before = before if version == 1 else _set({"id": "trg_before", "enabled": True, **before, "v": 1})
    assert isinstance(parse_trigger_set(raw_change)[0].trigger, CalendarEventChangeTrigger)
    assert isinstance(parse_trigger_set(raw_before)[0].trigger, CalendarBeforeStartTrigger)


@pytest.mark.parametrize("lead", [None, 59, 2_592_001, 60.0, True])
def test_calendar_before_start_rejects_bad_lead(lead):
    payload = {"v": 1, "kind": "calendar_before_start"}
    if lead is not None:
        payload["lead_seconds"] = lead
    with pytest.raises(TriggerValidationError, match="lead_seconds"):
        parse_trigger_set(payload)


def test_calendar_keys_are_rejected_on_non_calendar_v2_entry():
    with pytest.raises(TriggerValidationError, match="only valid for calendar"):
        parse_trigger_set(_set({**_email(), "calendar_ids": ["Work"]}))


def test_calendar_flag_off_rejects_writes_but_parse_still_accepts(monkeypatch):
    raw = {"v": 1, "kind": "calendar_event_change"}
    assert isinstance(parse_trigger_set(raw)[0].trigger, CalendarEventChangeTrigger)
    monkeypatch.setattr("src.agents.trigger.calendar_trigger_enabled", lambda: False)
    with pytest.raises(TriggerValidationError, match="calendar triggers are disabled"):
        normalize_agent_config_patch({"trigger": raw}, agent_type="custom")

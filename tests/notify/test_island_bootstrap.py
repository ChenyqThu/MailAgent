"""单测：island_bootstrap — idempotent + 不覆盖用户改动."""

from __future__ import annotations

import json
from pathlib import Path

from src.notify import island_bootstrap


def test_first_time_writes_all_three_files(tmp_path: Path):
    results = island_bootstrap.ensure_plugin_assets(tmp_path / "plugin")
    assert all(results.values()) is True
    plugin = tmp_path / "plugin"
    assert (plugin / "manifest.json").exists()
    assert (plugin / "locales" / "zh-CN" / "island.json").exists()
    assert (plugin / "locales" / "en-US" / "island.json").exists()


def test_manifest_contains_expected_events(tmp_path: Path):
    island_bootstrap.ensure_plugin_assets(tmp_path / "plugin")
    manifest = json.loads((tmp_path / "plugin" / "manifest.json").read_text())
    assert manifest["brand"] == "mail"
    expected = {"MailReceived", "LLMReviewed", "LLMReviewedUrgent",
                "MailCompleted", "SyncFailed", "DeadLetterAccum"}
    assert expected.issubset(set(manifest["events"]))


def test_second_call_does_not_overwrite(tmp_path: Path):
    """用户改了 manifest，再次 bootstrap 必须 idempotent，不覆盖."""
    plugin = tmp_path / "plugin"
    island_bootstrap.ensure_plugin_assets(plugin)
    manifest_path = plugin / "manifest.json"
    manifest_path.write_text('{"custom": true}', encoding="utf-8")

    results = island_bootstrap.ensure_plugin_assets(plugin)
    assert results[str(manifest_path)] is False
    assert json.loads(manifest_path.read_text()) == {"custom": True}


def test_locales_have_known_keys(tmp_path: Path):
    island_bootstrap.ensure_plugin_assets(tmp_path / "plugin")
    zh = json.loads((tmp_path / "plugin" / "locales" / "zh-CN" / "island.json").read_text())
    en = json.loads((tmp_path / "plugin" / "locales" / "en-US" / "island.json").read_text())
    common_keys = {
        "mail.received.title", "mail.urgent.title", "mail.completed.title",
        "mail.action.openMail", "mail.action.createDraft",
        "mail.action.snooze1h", "mail.action.markDone",
    }
    assert common_keys.issubset(set(zh))
    assert common_keys.issubset(set(en))

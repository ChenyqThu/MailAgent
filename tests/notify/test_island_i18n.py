"""单测：island_i18n loader (mtime cache + reload + var format)."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from src.notify import island_i18n


@pytest.fixture
def isolated_home(tmp_path: Path, monkeypatch):
    """改写 LOCALES_DIR 指向 tmp_path 下，避免动用户家目录."""
    locales_dir = tmp_path / ".mailagent" / "plugins" / "ping_island" / "locales"
    monkeypatch.setattr(island_i18n, "LOCALES_DIR", locales_dir)
    monkeypatch.delenv("PING_ISLAND_LANG", raising=False)
    monkeypatch.delenv("LANG", raising=False)
    island_i18n.reload_locale()
    yield locales_dir
    island_i18n.reload_locale()


def _write_locale(dir_: Path, lang: str, data: dict) -> Path:
    path = dir_ / lang / "island.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


def test_t_returns_key_when_missing(isolated_home):
    assert island_i18n.t("nonexistent.key") == "nonexistent.key"


def test_t_renders_variables(isolated_home, monkeypatch):
    _write_locale(isolated_home, "zh-CN", {"mail.received.title": "新邮件 / {{sender}}"})
    monkeypatch.setenv("PING_ISLAND_LANG", "zh-CN")
    island_i18n.reload_locale()
    out = island_i18n.t("mail.received.title", sender="John")
    assert out == "新邮件 / John"


def test_t_falls_back_to_default_lang(isolated_home, monkeypatch):
    _write_locale(isolated_home, "en-US", {"mail.received.title": "New / {{sender}}"})
    monkeypatch.setenv("PING_ISLAND_LANG", "zh-CN")
    # zh-CN 文件不存在 → 退到 en-US
    island_i18n.reload_locale()
    assert island_i18n.t("mail.received.title", sender="A") == "New / A"


def test_mtime_cache_invalidation(isolated_home, monkeypatch):
    """REVIEW-LOG M-14: 编辑 locale 文件后，下次 t() 自动重载，不需手动 reload."""
    path = _write_locale(isolated_home, "en-US", {"k": "v1"})
    monkeypatch.setenv("PING_ISLAND_LANG", "en-US")
    island_i18n.reload_locale()
    assert island_i18n.t("k") == "v1"

    # 改文件 + 调整 mtime 让缓存失效（即使秒级时间一样也要变）
    path.write_text(json.dumps({"k": "v2"}), encoding="utf-8")
    new_mtime = time.time() + 5
    os.utime(path, (new_mtime, new_mtime))
    assert island_i18n.t("k") == "v2"


def test_brace_literal_in_template_does_not_raise(isolated_home, monkeypatch):
    """邮件主题里出现 ``{Order #123}`` 字面量时，format 不能 KeyError."""
    _write_locale(isolated_home, "en-US", {
        "x": "Subject: {a} contains {{name}}",  # ``{a}`` 是字面量，``{{name}}`` 是变量
    })
    monkeypatch.setenv("PING_ISLAND_LANG", "en-US")
    island_i18n.reload_locale()
    out = island_i18n.t("x", name="Alice")
    assert "{a}" in out
    assert "Alice" in out


def test_resolve_lang_handles_system(monkeypatch):
    monkeypatch.setenv("PING_ISLAND_LANG", "system")
    monkeypatch.setenv("LANG", "zh_CN.UTF-8")
    assert island_i18n.resolve_lang() == "zh-CN"

    monkeypatch.setenv("LANG", "en_US.UTF-8")
    assert island_i18n.resolve_lang() == "en-US"

    monkeypatch.setenv("LANG", "fr_FR.UTF-8")
    assert island_i18n.resolve_lang() == "en-US"  # 兜底

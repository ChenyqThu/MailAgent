from __future__ import annotations

import pytest

from src.reports.wire import config_patch_to_db, resolve_agent


def test_description_strip_empty_and_projection():
    assert config_patch_to_db({"description": "  hello  "})["description"] == "hello"
    assert config_patch_to_db({"description": "   "})["description"] is None
    assert config_patch_to_db({"description": None})["description"] is None
    row = {"id": "a", "type": "custom", "enabled": 1, "title": "A", "description": "hello"}
    assert resolve_agent(row)["description"] == "hello"


def test_description_rejects_non_string_and_too_long():
    with pytest.raises(ValueError):
        config_patch_to_db({"description": 1})
    with pytest.raises(ValueError):
        config_patch_to_db({"description": "x" * 1001})

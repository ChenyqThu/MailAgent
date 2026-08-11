from __future__ import annotations

import pytest

from src.matters.resource_identity import MatterError, normalize_resource_key


def test_normalize_mailagent_resource_keys():
    assert normalize_resource_key("mailagent", "email", "123") == "email:123"
    assert normalize_resource_key("mailagent", "email", "email:123") == "email:123"
    assert normalize_resource_key("mailagent", "thread", "thread-abc") == "thread:thread-abc"
    assert normalize_resource_key("mailagent", "thread", "thread:thread-abc") == "thread:thread-abc"


@pytest.mark.parametrize(
    ("kind", "external_key"),
    (("email", "abc"), ("email", "thread:123"), ("thread", "email:123")),
)
def test_normalize_rejects_invalid_mailagent_resource_keys(kind, external_key):
    with pytest.raises(MatterError) as exc_info:
        normalize_resource_key("mailagent", kind, external_key)
    assert exc_info.value.code == "E_INVALID_ARG"


def test_normalize_leaves_non_mailagent_keys_unchanged():
    assert normalize_resource_key("notion", "email", "page:abc") == "page:abc"

"""SkillManifest v2 校验（S2 W2）—— script⇒零工具、secret 名 reserved deny、v1 向后兼容。

纯 pydantic 单测，不碰 app / DB。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.skills.models import MANIFEST_VERSION_V2, SkillPackageManifest
from src.skills.secret_names import is_reserved_secret_name, validate_secret_name


def test_valid_script_manifest():
    m = SkillPackageManifest(
        type="script",
        name="dms-approve",
        version="1.2",
        secrets=[{"name": "DMS_TOKEN", "description": "api token"}],
        entry_hint="python3 main.py",
    )
    assert m.manifest_version == MANIFEST_VERSION_V2
    assert m.tools == []
    assert m.secrets[0].name == "DMS_TOKEN"


def test_script_with_tools_rejected():
    """type=='script' ⇒ tools==[] 机械保证（不做动态一等工具注册）。"""
    with pytest.raises(ValidationError):
        SkillPackageManifest(type="script", name="x", tools=[{"name": "t"}])


def test_document_manifest_may_have_tools():
    """非 script（document/existing-tool/mcp）不受零工具约束。"""
    m = SkillPackageManifest(type="existing-tool", name="notes", tools=[{"name": "email_get", "bind": "existing"}])
    assert len(m.tools) == 1


@pytest.mark.parametrize(
    "bad_name",
    [
        "token",  # lowercase
        "1TOKEN",  # leading digit
        "MY.TOKEN",  # dot
        "MY-TOKEN",  # dash
        "PATH",  # would override exec env
        "HOME",
        "SHELL",
        "LC_ALL",  # LC_ prefix (allow-list base → cannot override)
        "NODE_OPTIONS",  # exec hijack
        "PYTHONPATH",
        "DYLD_INSERT_LIBRARIES",  # DYLD_ prefix
        "MAILAGENT_BACKEND",  # MAILAGENT_ prefix
        "AWS_SECRET_ACCESS_KEY",  # AWS_ prefix
        "NOTION_TOKEN",  # global credential
        "HTTPS_PROXY",
        "REQUESTS_CA_BUNDLE",
    ],
)
def test_illegal_secret_name_rejected(bad_name):
    with pytest.raises(ValidationError):
        SkillPackageManifest(type="script", name="x", secrets=[{"name": bad_name}])


@pytest.mark.parametrize("good_name", ["DMS_TOKEN", "MY_API_KEY", "SVC1_TOKEN", "X"])
def test_legal_secret_name_accepted(good_name):
    m = SkillPackageManifest(type="script", name="x", secrets=[{"name": good_name}])
    assert m.secrets[0].name == good_name


def test_duplicate_secret_name_rejected():
    with pytest.raises(ValidationError):
        SkillPackageManifest(
            type="script", name="x", secrets=[{"name": "DMS_TOKEN"}, {"name": "DMS_TOKEN"}]
        )


def test_extra_field_rejected():
    """供应链 manifest 拒未知字段（防投毒经额外字段夹带）。"""
    with pytest.raises(ValidationError):
        SkillPackageManifest(type="document", name="x", bogus_field=1)


def test_missing_type_rejected():
    """type 必填（v2 包必须声明）。"""
    with pytest.raises(ValidationError):
        SkillPackageManifest(name="x")


def test_secret_name_helpers():
    assert validate_secret_name("DMS_TOKEN") is None
    assert validate_secret_name("PATH") is not None
    assert validate_secret_name("token") is not None
    assert is_reserved_secret_name("PATH") is True
    assert is_reserved_secret_name("MAILAGENT_X") is True
    assert is_reserved_secret_name("DMS_TOKEN") is False

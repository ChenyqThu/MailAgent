from __future__ import annotations

import pytest

from src.contacts.org_frame import (
    OrgFrame,
    department_in_frame,
    normalize_department_path,
    organization_in_frame,
    parse_org_frame,
    render_org_frame,
)


SAMPLE = """# 公司
TP-Link System | tp-link.com.hk | 总部
TP-Link | tp-link.com, omadanetworks.com
TP-Link Canada | | 子公司

# 部门框架
EBG / ENBU / 产品部
商用产品研发处 / 系统部
"""


def test_parse_org_frame_normal_sample_and_compact_render():
    frame = parse_org_frame(SAMPLE)
    assert [(item.name, item.domains, item.note) for item in frame.companies] == [
        ("TP-Link System", ("tp-link.com.hk",), "总部"),
        ("TP-Link", ("tp-link.com", "omadanetworks.com"), ""),
        ("TP-Link Canada", (), "子公司"),
    ]
    assert frame.department_paths == (
        ("EBG", "ENBU", "产品部"),
        ("商用产品研发处", "系统部"),
    )
    assert "# Companies" in render_org_frame(frame)
    assert "EBG / ENBU / 产品部" in render_org_frame(frame)


def test_parse_org_frame_ignores_outside_and_malformed_lines():
    frame = parse_org_frame(
        "outside\n# 公司列表\n| missing name\nBare Name Co\n"
        "- Valid Co | valid.example | note\n# unknown\nIgnored Co | ignored.example\n"
        "# Departments extra\nA\nA / / B\n1 / 2 / 3 / 4 / 5 / 6\n"
    )
    # 裸名行（无 | 分列）也是有效公司；首列为空 / 段外 / unknown 段的行忽略。
    assert [item.name for item in frame.companies] == ["Bare Name Co", "Valid Co"]
    assert frame.companies[0].domains == ()
    # 单级路径有效（「A」= A 下自由展开）；空段收敛；超过 5 级丢弃。
    assert frame.department_paths == (("A",), ("A", "B"))


@pytest.mark.parametrize(
    ("company_heading", "department_heading"),
    [
        ("# 公司", "# 部门框架"),
        ("## 组织架构", "## Departments"),
        ("# Companies List", "# department paths"),
    ],
)
def test_parse_org_frame_heading_variants(company_heading, department_heading):
    frame = parse_org_frame(
        f"{company_heading}\nAcme | acme.example\n{department_heading}\nA / B\n"
    )
    assert frame.companies[0].name == "Acme"
    assert frame.department_paths == (("A", "B"),)


def test_empty_or_invalid_frame_is_empty():
    assert parse_org_frame("").is_empty
    assert parse_org_frame("no headings\nAcme | example.com").is_empty


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("A / B / C", True),
        ("A", True),
        ("X / Y", False),
        ("  a  /  b ", True),
    ],
)
def test_department_prefix_validation(value, expected):
    frame = parse_org_frame("# Departments\nA / B\n")
    assert department_in_frame(frame, value) is expected


def test_organization_validation_and_empty_frame_fail_open():
    frame = parse_org_frame("# Companies\nTP-Link | tp-link.com\n")
    assert organization_in_frame(frame, " tp-link ") is True
    assert organization_in_frame(frame, "TP-Link System") is False
    assert organization_in_frame(OrgFrame(), "anything") is True
    assert department_in_frame(OrgFrame(), "anything") is True


def test_normalize_department_path_only_rewrites_slash_spacing():
    assert normalize_department_path("A/B") == "A / B"
    assert normalize_department_path("A  /  B") == "A / B"
    assert normalize_department_path("A - B") == "A - B"

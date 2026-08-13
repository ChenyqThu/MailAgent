"""function/seniority 确定性词表派生 (task 08-13 WP1, PRD §3.2 Q13)。

词表保守: 高置信中英职衔关键词才映射, 不命中 = None (分组进「未分组」是预期)。
"""

from __future__ import annotations

import pytest

from src.contacts.taxonomy import (
    CONTACT_FUNCTION_VALUES,
    CONTACT_SENIORITY_VALUES,
    derive_function,
    derive_seniority,
)


@pytest.mark.parametrize("title,expected", [
    ("VP of Engineering", "vp"),
    ("Vice President, Sales", "vp"),
    ("SVP Product", "vp"),
    ("副总裁", "vp"),
    ("首席技术官", "vp"),
    ("Director of Data", "director"),
    ("产品总监", "director"),
    ("Tech Lead", "lead"),
    ("Head of Delivery", "lead"),
    ("项目负责人", "lead"),
    ("Senior Product Manager", "manager"),
    ("Engineering Manager", "manager"),
    ("交付经理", "manager"),
    ("Software Engineer", "staff"),
    ("法务专员", "staff"),
    ("数据分析工程师", "staff"),
])
def test_derive_seniority_word_table(title, expected):
    assert derive_seniority(title) == expected


@pytest.mark.parametrize("title", [
    None, "", "   ",
    "Ninja",              # 词表外不硬凑
    "AVP",                # 'vp' 词边界: 不把 AVP 误判成 vp
])
def test_derive_seniority_conservative_none(title):
    assert derive_seniority(title) is None


@pytest.mark.parametrize("title,expected", [
    ("Project Manager", "pm"),          # pm 在 product 前
    ("项目经理", "pm"),
    ("Product Manager", "product"),
    ("产品总监", "product"),
    ("Security Engineer", "security"),  # 域词先于 tech 兜底
    ("合规经理", "compliance"),
    ("Legal Counsel", "legal"),
    ("采购专员", "procurement"),
    ("Data Analyst", "data"),
    ("交付负责人", "delivery"),
    ("Software Engineer", "tech"),
    ("研发总监", "tech"),
])
def test_derive_function_word_table(title, expected):
    assert derive_function(title) == expected


@pytest.mark.parametrize("title", [None, "", "Chef", "魔法师"])
def test_derive_function_conservative_none(title):
    assert derive_function(title) is None


def test_derived_values_stay_inside_enum_single_source():
    """派生产出 ⊆ CHECK 值域 (枚举单源自洽; DDL 经 sql_check_clause 引同一常量)。"""
    samples = [
        "VP of Engineering", "Director", "Tech Lead", "Manager", "Engineer",
        "Project Manager", "Product Manager", "Security Engineer", "合规经理",
        "Legal Counsel", "采购专员", "Data Analyst", "交付负责人", "研发总监",
    ]
    for title in samples:
        seniority = derive_seniority(title)
        function = derive_function(title)
        assert seniority is None or seniority in CONTACT_SENIORITY_VALUES
        assert function is None or function in CONTACT_FUNCTION_VALUES

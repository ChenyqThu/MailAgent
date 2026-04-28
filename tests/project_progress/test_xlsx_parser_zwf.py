"""xlsx_parser v2 (4 sheet zwf) 单元测试."""

from datetime import date
from pathlib import Path

import pytest

from src.project_progress.xlsx_parser import (
    SheetKind, classify_sheet, parse_xlsx_v2, parse_xlsx,
)


FIXTURE_ZWF = Path(__file__).parent / "fixtures" / "sample_zwf_4sheet.xlsx"
FIXTURE_LEGACY = Path(__file__).parent / "fixtures" / "sample_enbu.xlsx"

skip_if_no_zwf = pytest.mark.skipif(
    not FIXTURE_ZWF.exists(),
    reason="fixture missing: run tests/project_progress/fixtures/build_zwf.py",
)
skip_if_no_legacy = pytest.mark.skipif(
    not FIXTURE_LEGACY.exists(),
    reason="legacy fixture missing",
)


# ----- 1. sheet routing -----

def test_classify_ongoing_double_space():
    assert classify_sheet("Project  Ongoing") == SheetKind.ONGOING


def test_classify_ongoing_single_space():
    assert classify_sheet("Project Ongoing") == SheetKind.ONGOING


def test_classify_shipped_with_year():
    assert classify_sheet("2026-Project Shipped") == SheetKind.SHIPPED
    assert classify_sheet("2027-Project Shipped") == SheetKind.SHIPPED


def test_classify_shipped_without_year():
    assert classify_sheet("Project Shipped") == SheetKind.SHIPPED


def test_classify_suspended():
    assert classify_sheet("Project Suspended") == SheetKind.SUSPENDED


def test_classify_guide_returns_none():
    assert classify_sheet("Filling-in & Reading Guide") is None


def test_classify_unknown_returns_none():
    assert classify_sheet("Random Sheet") is None
    assert classify_sheet("") is None


# ----- 2. zwf 4-sheet parse -----

@skip_if_no_zwf
def test_parse_zwf_all_sheets():
    res = parse_xlsx_v2(FIXTURE_ZWF, "sample_zwf_4sheet-20260420.xlsx")
    assert res.week_tag == "2026-W17"
    # 三个 sheet 都解析了
    assert len(res.sheets_parsed) == 3
    assert "Project  Ongoing" in res.sheets_parsed
    assert "2026-Project Shipped" in res.sheets_parsed
    assert "Project Suspended" in res.sheets_parsed
    # Filling-in Guide 跳过 (不在 sheets_parsed 里)
    assert "Filling-in & Reading Guide" not in res.sheets_parsed


@skip_if_no_zwf
def test_parse_zwf_each_sheet_kind_present():
    res = parse_xlsx_v2(FIXTURE_ZWF, "sample_zwf_4sheet-20260420.xlsx")
    kinds = {p.current_sheet for p in res.projects}
    assert SheetKind.ONGOING in kinds
    assert SheetKind.SHIPPED in kinds
    assert SheetKind.SUSPENDED in kinds


@skip_if_no_zwf
def test_parse_zwf_only_enbu():
    res = parse_xlsx_v2(FIXTURE_ZWF, "sample_zwf_4sheet-20260420.xlsx")
    # 每个 sheet 抽 8 ENBU = 24 总 (但 zwf 数据某些 sheet 可能 ENBU < 8)
    assert res.projects_total > 0
    for p in res.projects:
        assert p.bu == "TPS-ENBU", f"non-ENBU leaked: {p.bu}"


@skip_if_no_zwf
def test_parse_zwf_sheet_stats_distinct():
    res = parse_xlsx_v2(FIXTURE_ZWF, "sample_zwf_4sheet-20260420.xlsx")
    # 至少 3 个 kind 的 stats 都有
    assert SheetKind.ONGOING in res.sheet_stats
    assert SheetKind.SHIPPED in res.sheet_stats
    assert SheetKind.SUSPENDED in res.sheet_stats
    total = sum(res.sheet_stats.values())
    assert total == res.projects_total


@skip_if_no_zwf
def test_parse_zwf_only_ongoing_sheet():
    """sheets={ONGOING} → 只解析 Ongoing, Shipped/Suspended 跳过."""
    res = parse_xlsx_v2(
        FIXTURE_ZWF,
        "sample_zwf_4sheet-20260420.xlsx",
        sheets={SheetKind.ONGOING},
    )
    for p in res.projects:
        assert p.current_sheet == SheetKind.ONGOING


# ----- 3. 母子关系仅 Ongoing 内 -----

@skip_if_no_zwf
def test_parent_child_only_within_ongoing():
    res = parse_xlsx_v2(FIXTURE_ZWF, "sample_zwf_4sheet-20260420.xlsx")
    for p in res.projects:
        if p.current_sheet != SheetKind.ONGOING:
            assert p.is_parent is False
            assert p.parent_external_id is None, (
                f"non-ongoing row should not have parent: "
                f"sheet={p.current_sheet} pn={p.project_name} pm={p.product_model}"
            )


# ----- 4. zwf 新字段写入 ProjectRow -----

@skip_if_no_zwf
def test_zwf_new_fields_populated():
    """zwf xlsx 应能解析出 establishment_date / desired_ship / current_status 等."""
    res = parse_xlsx_v2(FIXTURE_ZWF, "sample_zwf_4sheet-20260420.xlsx")
    # 至少有一行某些新字段被填了 (zwf xlsx 有的填了, 有的是 'TBD' 解析为 None)
    has_est = any(p.establishment_date is not None for p in res.projects)
    has_curr_status = any(p.current_status for p in res.projects)
    assert has_est, "expect some rows with establishment_date populated"
    assert has_curr_status, "expect some Sheet 2/3 rows with current_status"


# ----- 5. 中文容错 (Suspended Priority 中文 / PM 中文不抛错) -----

@skip_if_no_zwf
def test_chinese_values_in_suspended_no_error():
    res = parse_xlsx_v2(FIXTURE_ZWF, "sample_zwf_4sheet-20260420.xlsx")
    # 直接读出来不抛错就是过 — 中文 PM '桂潇' / Priority '否' 等会落到 priority_raw / pm
    susp = [p for p in res.projects if p.current_sheet == SheetKind.SUSPENDED]
    # Suspended 行可能有中文值, 至少不抛错
    for p in susp:
        # priority_raw 可以是 'N' / '否' / None
        assert p.priority_raw is None or isinstance(p.priority_raw, str)
        assert isinstance(p.pm, str)


# ----- 6. legacy parse_xlsx (单 sheet v1) 仍工作 -----

@skip_if_no_legacy
def test_legacy_v1_single_sheet_still_works():
    """parse_xlsx() 旧 API 默认仅解析 ONGOING (兼容旧 fixture)."""
    res = parse_xlsx(FIXTURE_LEGACY, "sample_enbu-20260420.xlsx")
    assert res.projects_total > 0
    # 所有 row 都是 ONGOING
    for p in res.projects:
        assert p.current_sheet == SheetKind.ONGOING


@skip_if_no_legacy
def test_legacy_v1_no_new_fields():
    """旧 v1 xlsx 没有 zwf 新字段, 解析后这些字段为 None / ''."""
    res = parse_xlsx(FIXTURE_LEGACY, "sample_enbu-20260420.xlsx")
    for p in res.projects:
        assert p.establishment_date is None
        assert p.desired_ship_date is None
        assert p.actual_ship_date is None
        assert p.suspension_date is None
        assert p.current_status == ""


# ----- 7. external_id 跨 sheet 正确处理 -----

@skip_if_no_zwf
def test_external_id_unique_across_sheets():
    res = parse_xlsx_v2(FIXTURE_ZWF, "sample_zwf_4sheet-20260420.xlsx")
    ext_ids = [p.external_id for p in res.projects]
    # 跨 sheet 同 (Project Name, Product Model) 几乎不会重叠 — 一个项目要么 Ongoing 要么 Shipped
    # 即使有, slug 碰撞处理会加 hash 后缀保证 unique
    assert len(ext_ids) == len(set(ext_ids))


# ----- 8. 日期容错: 'TBD' / '/' / '待定' 不抛错 -----

@skip_if_no_zwf
def test_dirty_date_values_not_crash():
    """xlsx 文本如 'TBD', 'Finished', '/', '待定' 不应导致 parse 失败."""
    # 直接 parse 不抛错就 OK
    res = parse_xlsx_v2(FIXTURE_ZWF, "sample_zwf_4sheet-20260420.xlsx")
    assert res is not None
    # 这些 dirty 值应被解析为 None (不被解释为有效 date)
    for p in res.projects:
        for d_field in (p.establishment_date, p.desired_ship_date,
                        p.estimated_ship_date, p.actual_ship_date,
                        p.suspension_date):
            assert d_field is None or isinstance(d_field, date)

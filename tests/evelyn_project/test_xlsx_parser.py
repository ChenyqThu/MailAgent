"""xlsx_parser.py 单元测试 - 用 Evelyn 真实附件的 20 行 ENBU 子集"""

from datetime import date
from pathlib import Path
from typing import List

import pytest

from src.evelyn_project.xlsx_parser import ProjectRow, parse_xlsx

FIXTURE = Path(__file__).parent / "fixtures" / "sample_enbu.xlsx"


skip_if_no_fixture = pytest.mark.skipif(
    not FIXTURE.exists(), reason="fixture missing: run tests/evelyn_project/fixtures/build.py"
)


@skip_if_no_fixture
def test_parse_basic():
    result = parse_xlsx(FIXTURE, "sample_enbu-20260420.xlsx")
    assert result.xlsx_md5
    assert result.sheet_name == "Project  Ongoing"
    assert result.filter_bu == "TPS-ENBU"
    assert result.filtered_rows > 0
    # 每行都是 ENBU
    for p in result.projects:
        assert p.bu == "TPS-ENBU"
    # 至少有一个项目
    assert result.projects_total >= 1


@skip_if_no_fixture
def test_week_tag_inferred_from_filename():
    result = parse_xlsx(FIXTURE, "sample_enbu-20260420.xlsx")
    assert result.week_tag == "2026-W17"


@skip_if_no_fixture
def test_external_id_unique():
    result = parse_xlsx(FIXTURE, "sample_enbu-20260420.xlsx")
    ext_ids = [p.external_id for p in result.projects]
    assert len(ext_ids) == len(set(ext_ids)), "external_id should be unique within a parse"


@skip_if_no_fixture
def test_every_row_has_product_model():
    result = parse_xlsx(FIXTURE, "sample_enbu-20260420.xlsx")
    # 每行都有 product_model（本版：一行一页，不再聚合）
    assert all(p.product_model for p in result.projects)


@skip_if_no_fixture
def test_row_level_no_aggregation():
    result = parse_xlsx(FIXTURE, "sample_enbu-20260420.xlsx")
    # fixture 20 行 ENBU → 20 个 ProjectRow（1:1）
    assert result.projects_total == result.filtered_rows


@skip_if_no_fixture
def test_parent_child_consistency():
    result = parse_xlsx(FIXTURE, "sample_enbu-20260420.xlsx")
    ext_ids = {p.external_id for p in result.projects}
    ext_to_row = {p.external_id: p for p in result.projects}
    # 所有子任务的 parent_external_id 都指向一个存在且 is_parent=True 的 row
    for p in result.projects:
        if p.parent_external_id is None:
            continue
        assert p.parent_external_id in ext_ids
        assert ext_to_row[p.parent_external_id].is_parent


@skip_if_no_fixture
def test_reference_date_override():
    result = parse_xlsx(
        FIXTURE,
        "sample_enbu-20260420.xlsx",
        reference_date_override=date(2026, 4, 13),
    )
    assert result.reference_date == date(2026, 4, 13)
    assert result.week_tag == "2026-W16"


@skip_if_no_fixture
def test_filter_bu_customizable():
    # 不匹配任何 BU → 0 项目
    result = parse_xlsx(FIXTURE, "sample_enbu-20260420.xlsx", filter_bu="NO_SUCH_BU")
    assert result.projects_total == 0
    assert result.filtered_rows == 0

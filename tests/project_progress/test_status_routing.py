"""Status 三态路由测试 (build_properties + status_for_row)."""

from datetime import date
from src.project_progress.notion_sync import (
    KNOWN_DB_PROPS,
    PROP_STATUS, PROP_PROJECT_START,
    STATUS_IN_PROGRESS, STATUS_DONE, STATUS_SUSPENDED,
    build_properties, status_for_row,
)
from src.project_progress.xlsx_parser import ProjectRow, SheetKind


def _row(kind: SheetKind, **kwargs) -> ProjectRow:
    return ProjectRow(
        project_name=kwargs.pop("project_name", "X"),
        product_model=kwargs.pop("product_model", "Y"),
        external_id=kwargs.pop("external_id", "x"),
        bu=kwargs.pop("bu", "TPS-ENBU"),
        current_sheet=kind,
        priority_raw=kwargs.pop("priority_raw", "N"),
        **kwargs,
    )


# ----- status_for_row 6 种组合 -----

def test_ongoing_create_writes_in_progress():
    assert status_for_row(_row(SheetKind.ONGOING), is_create=True) == STATUS_IN_PROGRESS


def test_ongoing_update_returns_none():
    """update 路径不写 Status 以保留手改值."""
    assert status_for_row(_row(SheetKind.ONGOING), is_create=False) is None


def test_shipped_always_force_done():
    assert status_for_row(_row(SheetKind.SHIPPED), is_create=True) == STATUS_DONE
    assert status_for_row(_row(SheetKind.SHIPPED), is_create=False) == STATUS_DONE


def test_suspended_always_force_suspended():
    assert status_for_row(_row(SheetKind.SUSPENDED), is_create=True) == STATUS_SUSPENDED
    assert status_for_row(_row(SheetKind.SUSPENDED), is_create=False) == STATUS_SUSPENDED


# ----- build_properties Status 写入对应 force_status -----

def test_build_props_ongoing_create_writes_status():
    KNOWN_DB_PROPS.clear()  # 不限 schema
    row = _row(SheetKind.ONGOING)
    props = build_properties(row, week_tag="2026-W17", is_create=True,
                              force_status=STATUS_IN_PROGRESS)
    assert props[PROP_STATUS] == {"status": {"name": STATUS_IN_PROGRESS}}


def test_build_props_ongoing_update_skips_status():
    KNOWN_DB_PROPS.clear()
    row = _row(SheetKind.ONGOING)
    props = build_properties(row, week_tag="2026-W17", is_create=False,
                              force_status=None)
    assert PROP_STATUS not in props


def test_build_props_shipped_writes_done():
    KNOWN_DB_PROPS.clear()
    row = _row(SheetKind.SHIPPED, actual_ship_date=date(2026, 2, 12))
    props = build_properties(row, week_tag="2026-W17", is_create=False,
                              force_status=STATUS_DONE)
    assert props[PROP_STATUS] == {"status": {"name": STATUS_DONE}}


def test_build_props_suspended_writes_suspended():
    KNOWN_DB_PROPS.clear()
    row = _row(SheetKind.SUSPENDED, suspension_date=date(2025, 10, 24))
    props = build_properties(row, week_tag="2026-W17", is_create=False,
                              force_status=STATUS_SUSPENDED)
    assert props[PROP_STATUS] == {"status": {"name": STATUS_SUSPENDED}}


# ----- 项目开始时间: create 时优先用 establishment_date -----

def test_project_start_prefers_establishment_date():
    KNOWN_DB_PROPS.clear()
    row = _row(SheetKind.ONGOING, establishment_date=date(2026, 3, 25))
    # progress_blocks 留空 → earliest_progress_date = None
    props = build_properties(row, week_tag="2026-W17", is_create=True,
                              force_status=STATUS_IN_PROGRESS)
    assert props[PROP_PROJECT_START] == {"date": {"start": "2026-03-25"}}


def test_project_start_skipped_on_update():
    """update 路径不写 PROJECT_START 以保留手改."""
    KNOWN_DB_PROPS.clear()
    row = _row(SheetKind.ONGOING, establishment_date=date(2026, 3, 25))
    props = build_properties(row, week_tag="2026-W17", is_create=False,
                              force_status=None)
    assert PROP_PROJECT_START not in props


# ----- KNOWN_DB_PROPS 限制下: 缺失字段被 _safe_set 静默 skip -----

def test_safe_set_drops_missing_schema_fields():
    KNOWN_DB_PROPS.clear()
    KNOWN_DB_PROPS.update([
        "项目名称", "external_id", "本周数据期", "BU", "Status",
        # 缺 立项时间 / 期望交期 / 进度异常 等新字段
    ])
    row = _row(
        SheetKind.SHIPPED,
        actual_ship_date=date(2026, 2, 12),
        establishment_date=date(2026, 1, 1),
        desired_ship_date=date(2026, 5, 30),
        reasons_for_delay="testing failure",
        current_status="Delivery",
    )
    props = build_properties(
        row, week_tag="2026-W17", is_create=False, force_status=STATUS_DONE,
    )
    # 新字段都不在 (因为 schema 缺)
    for missing in ("立项时间", "期望交期", "实际出货", "进度异常", "当前状态"):
        assert missing not in props
    # 核心字段在
    assert "项目名称" in props
    assert PROP_STATUS in props


def test_safe_set_writes_when_known_props_empty():
    """KNOWN_DB_PROPS 空 (尚未 bootstrap) → 全部写入 (走旧路径)."""
    KNOWN_DB_PROPS.clear()
    row = _row(
        SheetKind.SUSPENDED,
        suspension_date=date(2025, 10, 24),
        current_status="Suspended",
    )
    props = build_properties(
        row, week_tag="2026-W17", is_create=False, force_status=STATUS_SUSPENDED,
    )
    assert "暂停时间" in props
    assert "当前状态" in props

"""progress_parser.py 单元测试"""

from datetime import date

from src.project_progress.progress_parser import (
    ProgressBlock,
    format_block_markdown,
    format_all_history_markdown,
    iso_week_of,
    iso_week_range,
    parse_progress,
    pick_this_week,
)


def test_parse_bracket_mmdd():
    raw = "[04/17] Testing.\n[04/10] Issued."
    blocks = parse_progress(raw)
    assert len(blocks) == 2
    assert blocks[0].month == 4 and blocks[0].day == 17 and blocks[0].year is None
    assert blocks[1].month == 4 and blocks[1].day == 10


def test_parse_full_width_brackets():
    raw = "（4.17）稳定性测试。\n（3.20）Stability testing"
    blocks = parse_progress(raw)
    assert len(blocks) == 2
    assert blocks[0].month == 4 and blocks[0].day == 17
    assert "稳定性测试" in blocks[0].body


def test_parse_four_digit_year():
    raw = "[01/16/2026] Order placed.\n(12.12) baseline model."
    blocks = parse_progress(raw)
    assert blocks[0].year == 2026
    assert blocks[1].year is None
    assert blocks[1].month == 12


def test_parse_none_empty():
    assert parse_progress(None) == []
    assert parse_progress("") == []
    assert parse_progress("-") == []
    assert parse_progress("/") == []


def test_parse_no_date_head_returns_single_block():
    blocks = parse_progress("some unstructured text\nanother line")
    assert len(blocks) == 1
    assert blocks[0].month == 0 and blocks[0].day == 0


def test_head_key_padded():
    b = ProgressBlock(month=4, day=7, year=None, body="x")
    assert b.head_key == "[04/07]"
    b2 = ProgressBlock(month=1, day=16, year=2026, body="x")
    assert b2.head_key == "[01/16/2026]"


def test_iso_week_round_trip():
    assert iso_week_of(date(2026, 4, 20)) == "2026-W17"
    monday, sunday = iso_week_range("2026-W17")
    assert monday == date(2026, 4, 20)
    assert sunday == date(2026, 4, 26)


def test_pick_this_week_basic():
    blocks = parse_progress("[04/17] Testing.\n[04/10] Issued.")
    picked = pick_this_week(blocks, date(2026, 4, 20))  # W17 = 4/20 - 4/26
    assert picked == []  # 两个块都在之前的周

    picked2 = pick_this_week(blocks, date(2026, 4, 16))  # W16 = 4/13 - 4/19
    assert len(picked2) == 1 and picked2[0].day == 17


def test_pick_this_week_year_rollover():
    # xlsx 1/15 的邮件里看到 [12/28]（去年）
    blocks = parse_progress("[12/28] Old note\n[01/10] New note")
    ref = date(2026, 1, 15)  # W3 2026 = 1/12-1/18
    picked = pick_this_week(blocks, ref)
    # [12/28] → 2025-12-28 → 跨年到去年，不在 W3 2026
    # [01/10] → 2026-01-10 → W2 2026，不在 W3
    assert picked == []


def test_format_block_markdown():
    b = ProgressBlock(month=4, day=17, year=None, body="测试中")
    md = format_block_markdown(b, "2026-W17")
    assert "### 2026-W17 [04/17]" in md
    assert "测试中" in md


def test_format_all_history():
    blocks = parse_progress("[04/17] Testing.\n[04/10] Issued.")
    md = format_all_history_markdown(blocks, date(2026, 4, 17))
    # 两块都应 render，heading 带正确的 ISO 周 tag
    assert "### 2026-W16 [04/17]" in md  # 4/17 = W16
    assert "### 2026-W15 [04/10]" in md  # 4/10 = W15

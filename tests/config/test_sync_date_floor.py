"""Notion 日期地板 —— SYNC_DATE_MODE 的 relative / fixed / 非法值行为闸（task 09-11）。

地板是**两处 Notion 判定共用**的单源（`src.config.parse_sync_start_date`）：

  - watcher 的 Notion 日期门（`NewWatcher._notion_date_floor`）
  - init 对账的 `store_only_before_date` 分桶（`InitialSync._build_comparison`）

各写一份 = 界面承诺的日期与实际入库行为分裂，所以这里把两个调用点一起钉。

🔴 davmail 的 IMAP 取信下界（`DavMailBackend._imap_date_floor`）**不在**这个单源里：
那是取信闸（窗口外的邮件根本不进本地库），不能跟着 relative 模式滚动。它的闸在
`tests/mail/backend/test_davmail_backend.py::test_imap_fetch_floor_does_not_roll_with_relative_mode`。

"今天"一律注入：滚动地板的判据不能依赖真实时钟（也不能等跨天）。
"""

import os
import time
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
from loguru import logger

from src.config import parse_sync_start_date

#: 注入的"今天" —— 选一个非月初的日子，回看 14 天会跨月（跨月算错当场红）。
TODAY = date(2026, 9, 11)


def _cfg(**over):
    """三个键的最小配置面（值与 config.py 的默认值一致）。"""
    base = dict(
        sync_date_mode="relative",
        sync_start_date="2026-01-01",
        sync_lookback_days=14,
    )
    base.update(over)
    return SimpleNamespace(**base)


def _local_midnight(day: date) -> datetime:
    return datetime.combine(day, datetime.min.time()).astimezone()


@contextmanager
def _captured_warnings():
    """loguru 的 WARNING 落点（stdlib caplog 抓不到 loguru）。"""
    msgs: list[str] = []
    sink_id = logger.add(lambda m: msgs.append(str(m)), level="WARNING")
    try:
        yield msgs
    finally:
        logger.remove(sink_id)


@pytest.fixture()
def la_timezone():
    """把进程本地时区切到 America/Los_Angeles（非北京，且 9 月处于夏令时）。"""
    old = os.environ.get("TZ")
    os.environ["TZ"] = "America/Los_Angeles"
    time.tzset()
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = old
        time.tzset()


# ---------------------------------------------------------------------------
# relative：滚动地板
# ---------------------------------------------------------------------------


def test_relative_floor_is_local_midnight_lookback_days_back():
    floor = parse_sync_start_date(_cfg(), today=TODAY)

    assert floor.date() == date(2026, 8, 28)            # 09-11 − 14 天，跨月
    assert (floor.hour, floor.minute, floor.second) == (0, 0, 0)
    assert floor.tzinfo is not None                      # 带时区，能和邮件日期直接比


def test_relative_gate_passes_13_days_old_and_blocks_15_days_old():
    """PRD 验收：回看 14 天时 13 天前的推 Notion、15 天前的只存本地。"""
    floor = parse_sync_start_date(_cfg(), today=TODAY)

    thirteen_days_old = _local_midnight(TODAY - timedelta(days=13)) + timedelta(hours=9)
    fifteen_days_old = _local_midnight(TODAY - timedelta(days=15)) + timedelta(hours=9)

    assert thirteen_days_old >= floor                    # 推 Notion
    assert fifteen_days_old < floor                      # 只存本地


def test_relative_floor_rolls_forward_when_today_advances():
    """地板逐日前移 —— 进程长跑跨天后不能还用启动那天的地板。"""
    today_floor = parse_sync_start_date(_cfg(), today=TODAY)
    tomorrow_floor = parse_sync_start_date(_cfg(), today=TODAY + timedelta(days=1))

    assert today_floor.date() == date(2026, 8, 28)
    assert tomorrow_floor.date() == date(2026, 8, 29)


def test_relative_ignores_the_fixed_start_date():
    """relative 下 SYNC_START_DATE 是哑配置，改它不该动地板。"""
    floor = parse_sync_start_date(_cfg(sync_start_date="2020-01-01"), today=TODAY)

    assert floor.date() == date(2026, 8, 28)


# ---------------------------------------------------------------------------
# fixed：钉住起始日
# ---------------------------------------------------------------------------


def test_fixed_floor_is_the_start_date_and_ignores_lookback():
    cfg = _cfg(sync_date_mode="fixed", sync_start_date="2026-03-15")

    floor = parse_sync_start_date(cfg, today=TODAY)

    assert floor.date() == date(2026, 3, 15)
    assert (floor.hour, floor.minute, floor.second) == (0, 0, 0)
    # 回看天数在 fixed 下是哑配置
    cfg.sync_lookback_days = 999
    assert parse_sync_start_date(cfg, today=TODAY) == floor


# ---------------------------------------------------------------------------
# 非法 / 缺失：返回 None（不按日期过滤）+ warning，不抛异常
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "over",
    [
        pytest.param(dict(sync_date_mode="rolling"), id="unknown-mode"),
        pytest.param(dict(sync_date_mode=""), id="empty-mode"),
        pytest.param(dict(sync_date_mode=None), id="none-mode"),
        pytest.param(
            dict(sync_date_mode="fixed", sync_start_date="2026-13-99"),
            id="bad-start-date",
        ),
        pytest.param(
            dict(sync_date_mode="fixed", sync_start_date="03/15/2026"),
            id="wrong-date-format",
        ),
        pytest.param(
            dict(sync_date_mode="relative", sync_lookback_days="abc"),
            id="non-numeric-lookback",
        ),
        pytest.param(
            dict(sync_date_mode="relative", sync_lookback_days=-1),
            id="negative-lookback",
        ),
    ],
)
def test_invalid_values_return_none_with_a_warning(over):
    with _captured_warnings() as warnings:
        assert parse_sync_start_date(_cfg(**over), today=TODAY) is None

    assert warnings, "非法配置必须留 warning（静默 None = 用户完全看不出配错了）"


def test_fixed_with_empty_start_date_returns_none():
    assert parse_sync_start_date(
        _cfg(sync_date_mode="fixed", sync_start_date=""), today=TODAY
    ) is None


def test_mode_value_is_case_and_space_tolerant():
    floor = parse_sync_start_date(_cfg(sync_date_mode="  Relative "), today=TODAY)

    assert floor.date() == date(2026, 8, 28)


# ---------------------------------------------------------------------------
# 时区：本机本地，不是写死的北京
# ---------------------------------------------------------------------------


def test_floor_is_local_midnight_outside_beijing(la_timezone):
    la = ZoneInfo("America/Los_Angeles")

    relative_floor = parse_sync_start_date(_cfg(), today=TODAY)
    fixed_floor = parse_sync_start_date(_cfg(sync_date_mode="fixed"), today=TODAY)

    # 2026-08-28 是夏令时 (PDT, −07:00)
    assert (relative_floor.hour, relative_floor.minute) == (0, 0)
    assert relative_floor.utcoffset() == datetime(2026, 8, 28, tzinfo=la).utcoffset()
    assert relative_floor.utcoffset() == timedelta(hours=-7)
    # 2026-01-01 是标准时 (PST, −08:00) —— 同一台机器上两个地板的偏移不同，
    # 说明取的是"那一天"的本地偏移而不是某个写死的常量。
    assert (fixed_floor.hour, fixed_floor.minute) == (0, 0)
    assert fixed_floor.utcoffset() == datetime(2026, 1, 1, tzinfo=la).utcoffset()
    assert fixed_floor.utcoffset() == timedelta(hours=-8)


# ---------------------------------------------------------------------------
# 三处调用点同源
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["relative", "fixed"])
def test_both_notion_call_sites_resolve_to_the_same_floor(mode, monkeypatch):
    from src.config import config as singleton
    from src.init.initial_sync import InitialSync
    from src.mail.new_watcher import NewWatcher

    monkeypatch.setattr(singleton, "sync_date_mode", mode)
    monkeypatch.setattr(singleton, "sync_lookback_days", 14)
    monkeypatch.setattr(singleton, "sync_start_date", "2026-01-01")
    expected = parse_sync_start_date(singleton)
    assert expected is not None

    # ① watcher 的 Notion 日期门
    watcher = NewWatcher.__new__(NewWatcher)
    assert watcher._notion_date_floor() == expected

    # ② init 对账的 store_only_before_date 分桶
    init = InitialSync.__new__(InitialSync)
    init.report = SimpleNamespace(comparison={})
    older = (expected - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S")
    newer = (expected + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S")
    init._build_comparison(
        {"<old@x>": {"date_received": older}, "<new@x>": {"date_received": newer}},
        {},
        {"<old@x>", "<new@x>"},
        set(),
    )
    assert init.report.comparison["store_only_before_date"] == ["<old@x>"]
    assert init.report.comparison["store_only"] == ["<new@x>"]


def test_watcher_floor_is_recomputed_on_every_call(monkeypatch):
    """地板不能在 __init__ 快照 —— 长跑进程跨天后会一直用启动那天的地板。"""
    from src.config import config as singleton
    from src.mail.new_watcher import NewWatcher

    monkeypatch.setattr(singleton, "sync_date_mode", "relative")
    monkeypatch.setattr(singleton, "sync_lookback_days", 14)
    watcher = NewWatcher.__new__(NewWatcher)

    first = watcher._notion_date_floor()
    monkeypatch.setattr(singleton, "sync_lookback_days", 30)
    second = watcher._notion_date_floor()

    assert (first.date() - second.date()).days == 16

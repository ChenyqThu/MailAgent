"""单测: get_collection_ctag — element 路径优先 + tuple fallback + WARNING 降频.

task 06-10 (prd Fix 2c): venv 的 caldav 3.2.0 没有 ``Calendar.get_ctag``, 且老
tuple 传参在 3.x 内部炸 ``'tuple' object has no attribute 'xmlelement'`` → ctag
恒 None → worker ctag 增量检测形同虚设 + 每 ~70s WARNING 刷屏 (20h 1046 条)。
修后: 第一优先 BaseElement 子类 PROPFIND (真机 DavMail 实测 OK), fallback 旧
tuple 写法, 同 (calendar, 错误类型) 失败只 WARNING 一次后降 debug。
"""
from __future__ import annotations

from typing import Any, List

import pytest
from loguru import logger

from src.calendar_sync import caldav_reader as cr
from src.calendar_sync.caldav_reader import CalDAVReader

CTAG_KEY = "{http://calendarserver.org/ns/}getctag"


class _FakeCal:
    """get_properties 按入参形态分流: tuple list = 老 API 路径, 否则 element 路径.

    *_result 传 dict = 正常返回; 传 Exception 实例 = raise。
    """

    def __init__(self, name: str, *, element_result: Any, tuple_result: Any):
        self.name = name
        self.element_result = element_result
        self.tuple_result = tuple_result
        self.element_calls = 0
        self.tuple_calls = 0

    def get_properties(self, props):
        if isinstance(props[0], tuple):
            self.tuple_calls += 1
            result = self.tuple_result
        else:
            self.element_calls += 1
            result = self.element_result
        if isinstance(result, Exception):
            raise result
        return result


class _FakePrincipal:
    def __init__(self, cals: List[_FakeCal]):
        self._cals = cals

    def calendars(self) -> List[_FakeCal]:
        return self._cals


def _make_reader(cal: _FakeCal) -> CalDAVReader:
    # __new__ 绕开 __init__ (后者需要 Config + cipher key); _connect 看到
    # _principal 非 None 直接短路返回。
    reader = CalDAVReader.__new__(CalDAVReader)
    reader._principal = _FakePrincipal([cal])
    return reader


@pytest.fixture(autouse=True)
def _reset_warn_state():
    """模块级降频集合跨 test 隔离."""
    cr._ctag_warned.clear()
    yield
    cr._ctag_warned.clear()


@pytest.fixture
def log_records():
    records: List[dict] = []
    sink_id = logger.add(lambda m: records.append(m.record), level="DEBUG")
    yield records
    logger.remove(sink_id)


def _by_level(records, level: str):
    return [
        r for r in records
        if r["level"].name == level and "getctag" in str(r["message"])
    ]


def test_element_path_first_priority():
    cal = _FakeCal(
        "Calendar",
        element_result={CTAG_KEY: "MjAyNi0wNi0xMA=="},
        tuple_result=AssertionError("tuple 路径不应被调用"),
    )
    reader = _make_reader(cal)
    assert reader.get_collection_ctag("Calendar") == "MjAyNi0wNi0xMA=="
    assert cal.element_calls == 1
    assert cal.tuple_calls == 0


def test_tuple_fallback_when_element_path_raises():
    cal = _FakeCal(
        "Calendar",
        element_result=TypeError("element path broken"),
        tuple_result={("DAV:", "getctag"): "ctag-from-tuple"},
    )
    reader = _make_reader(cal)
    assert reader.get_collection_ctag("Calendar") == "ctag-from-tuple"
    assert cal.element_calls == 1
    assert cal.tuple_calls == 1


def test_both_paths_fail_returns_none_and_warns_once(log_records):
    cal = _FakeCal(
        "Calendar",
        element_result=TypeError("element broken"),
        tuple_result=AttributeError("'tuple' object has no attribute 'xmlelement'"),
    )
    reader = _make_reader(cal)
    assert reader.get_collection_ctag("Calendar") is None
    assert reader.get_collection_ctag("Calendar") is None  # 第二次同类失败

    assert len(_by_level(log_records, "WARNING")) == 1, "同类失败只 WARNING 一次"
    assert len(_by_level(log_records, "DEBUG")) == 1, "后续同类失败降 debug"


def test_recovery_logs_info_clears_state_and_rearms(log_records):
    cal = _FakeCal(
        "Calendar",
        element_result=TypeError("element broken"),
        tuple_result=AttributeError("tuple broken"),
    )
    reader = _make_reader(cal)
    assert reader.get_collection_ctag("Calendar") is None
    assert len(_by_level(log_records, "WARNING")) == 1

    # 恢复成功 → INFO recovered + 清除降频标记
    cal.element_result = {CTAG_KEY: "ctag-recovered"}
    assert reader.get_collection_ctag("Calendar") == "ctag-recovered"
    infos = [
        r for r in log_records
        if r["level"].name == "INFO" and "recovered" in str(r["message"])
    ]
    assert len(infos) == 1
    assert not cr._ctag_warned

    # 再次失败 → 重新 WARNING 一次 (标记已清除)
    cal.element_result = TypeError("broken again")
    assert reader.get_collection_ctag("Calendar") is None
    assert len(_by_level(log_records, "WARNING")) == 2


def test_empty_values_on_both_paths_warns_once(log_records):
    cal = _FakeCal(
        "Calendar",
        element_result={CTAG_KEY: None},
        tuple_result={("DAV:", "getctag"): None},
    )
    reader = _make_reader(cal)
    assert reader.get_collection_ctag("Calendar") is None
    assert reader.get_collection_ctag("Calendar") is None
    assert len(_by_level(log_records, "WARNING")) == 1


def test_calendar_not_found_returns_none():
    cal = _FakeCal("Other", element_result={}, tuple_result={})
    reader = _make_reader(cal)
    assert reader.get_collection_ctag("Missing") is None
    assert cal.element_calls == 0

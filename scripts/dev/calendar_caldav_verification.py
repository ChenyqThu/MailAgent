"""#9 真日历验证 harness — CalDAV writer 对真 Exchange (经 DavMail 桥) 的 round-trip 验证.

epic 阶段 3.2 (owner D5 已授权). 只操作本 harness 自建的测试事件:
- UID 前缀 ``mailagent-caltest-<ISO时间戳>-<序号>`` (进程内 patch generate_uid 实现,
  writer 生产路径不变)
- SUMMARY 前缀 ``[MailAgent 测试] ``
- 主流程 try/finally: finally 按注册 UID 逐一删除 + 按前缀重新枚举断言 0 (清理验证);
  中途异常也走到清理.

场景 (--scenario 单跑 / all 全跑):
- detached   ① update_occurrence (改这次) round-trip
- split      ② split_series (改未来) 老 master 截断 + 新 master 就位
- allday     ③ 全天事件 VALUE=DATE 创建 + update 保持全天
- count      ④ COUNT 型 RRULE 创建 + expander 展开数一致
- xprops     ⑤ X-属性 / VALARM 剥离检查 (纯观察, 不判 FAIL)
- splitfail  ⑥ split 第二步失败演练 (monkeypatch PUT 抛异常, 验证服务器端回滚)
- rsvp       ⑦ iTIP REPLY → PARTSTAT 链 (发 1 封真邮件, all 默认不含, 需 --with-rsvp)

用法 (worktree 根目录, 主仓 venv):
    venv/bin/python scripts/dev/calendar_caldav_verification.py                 # 全跑 (不含 rsvp)
    venv/bin/python scripts/dev/calendar_caldav_verification.py --with-rsvp    # 全跑 + rsvp
    venv/bin/python scripts/dev/calendar_caldav_verification.py --scenario split
    venv/bin/python scripts/dev/calendar_caldav_verification.py --keep         # 调试: 跳过清理

注意: 本机 davmail-poc 的 CalDAV 端口是 1081 (davmail.properties `davmail.caldavPort`),
生产 userData .env 有 `DAVMAIL_CALDAV_PORT=1081` 但仓库 .env 没有 (config 默认 1080
连不上) — 跑本 harness 需 `DAVMAIL_CALDAV_PORT=1081` 环境变量前缀.
"""
from __future__ import annotations

import argparse
import sys
import time
import traceback
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.calendar_sync import caldav_writer as writer_mod
from src.calendar_sync.caldav_writer import CalDAVWriter, _to_utc, build_vevent
from src.calendar_sync.expander import expand_in_window

UID_PREFIX = "mailagent-caltest-"
SUMMARY_PREFIX = "[MailAgent 测试] "

# 服务端 (Exchange 经 DavMail) 写后读回的最长等待
READBACK_TIMEOUT_SEC = 30
READBACK_INTERVAL_SEC = 3
# RSVP → Exchange Calendar Assistant 异步处理 PARTSTAT 的观察窗口
RSVP_OBSERVE_TIMEOUT_SEC = 120


@dataclass
class Check:
    name: str
    ok: Optional[bool]  # None = 纯观察 (OBS), 不参与 PASS/FAIL
    detail: str = ""


@dataclass
class ScenarioResult:
    scenario: str
    checks: List[Check] = field(default_factory=list)
    error: str = ""

    @property
    def passed(self) -> bool:
        if self.error:
            return False
        return all(c.ok is not False for c in self.checks)

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append(Check(name, bool(ok), detail))
        mark = "PASS" if ok else "FAIL"
        print(f"    [{mark}] {name}" + (f" — {detail}" if detail else ""))

    def observe(self, name: str, detail: str) -> None:
        self.checks.append(Check(name, None, detail))
        print(f"    [OBS ] {name} — {detail}")


class Harness:
    """连接 + UID 注册 + 读回/清理公共设施."""

    def __init__(self, calendar_name: Optional[str], base_offset_days: int):
        from src.config import config
        self.cfg = config
        self.calendar_name = calendar_name
        self.writer = CalDAVWriter(config)
        self.run_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        self._uid_seq = 0
        self.created_uids: List[str] = []
        self.rsvp_emails_sent = 0
        # 场景各占一天, 全部放到未来 base_offset_days 起, 避开 owner 真日程密集区
        self.base = datetime.now(timezone.utc).replace(
            hour=1, minute=0, second=0, microsecond=0
        ) + timedelta(days=base_offset_days)

    # ---- UID 管控 ------------------------------------------------

    def next_uid(self) -> str:
        self._uid_seq += 1
        uid = f"{UID_PREFIX}{self.run_stamp}-{self._uid_seq}@mailagent.local"
        self.created_uids.append(uid)
        return uid

    def patched_generate_uid(self):
        """进程内 patch writer 的 generate_uid → 走 harness 注册的前缀 UID.

        create_event / split_series 内部生成的 UID (含 split 新 master) 全部
        进 created_uids, finally 清理不漏.
        """
        return mock.patch.object(writer_mod, "generate_uid", self.next_uid)

    # ---- 读回 ----------------------------------------------------

    def read_back(self, ical_uid: str, *, must_exist: bool = True):
        """按 UID 从服务端读回 caldav Event 对象 (带重试, Exchange 写后可见有延迟).

        Returns (cal, evt); must_exist=False 且超时未见时返回 (None, None).
        """
        deadline = time.time() + READBACK_TIMEOUT_SEC
        while True:
            cal, evt = self.writer._find_event_by_uid(ical_uid, self.calendar_name)
            if evt is not None:
                return cal, evt
            if time.time() >= deadline:
                if must_exist:
                    raise RuntimeError(f"服务端读回超时: uid={ical_uid!r}")
                return None, None
            time.sleep(READBACK_INTERVAL_SEC)

    @staticmethod
    def vevents_of(evt) -> list:
        return list(getattr(evt.vobject_instance, "vevent_list", []) or [])

    @staticmethod
    def master_of(evt):
        for ve in Harness.vevents_of(evt):
            if not (hasattr(ve, "recurrence_id") and ve.recurrence_id):
                return ve
        return None

    # ---- 清理 ----------------------------------------------------

    def cleanup(self) -> Tuple[int, int, List[str]]:
        """按注册 UID 逐一删除 → 按前缀枚举删孤儿 (历史被 kill 的 run) → 断言 0.

        只会删 UID/SUMMARY 带 harness 前缀的自建测试事件.

        Returns (deleted, leftover_count, leftover_uids).
        """
        deleted = 0
        for uid in self.created_uids:
            try:
                cal, evt = self.writer._find_event_by_uid(uid, self.calendar_name)
                if evt is not None:
                    evt.delete()
                    deleted += 1
            except Exception as e:
                print(f"    [WARN] 清理 uid={uid!r} 失败: {e}")
        # 前缀枚举孤儿 (本 run 注册之外的历史残留) 一并删
        for uid in self.enumerate_test_uids():
            try:
                cal, evt = self.writer._find_event_by_uid(uid, self.calendar_name)
                if evt is not None:
                    evt.delete()
                    deleted += 1
                    print(f"    [INFO] 删除孤儿测试事件 uid={uid!r}")
            except Exception as e:
                print(f"    [WARN] 清理孤儿 uid={uid!r} 失败: {e}")
        # 删除后按前缀重新枚举, 断言 0 (清理验证)
        leftovers = self.enumerate_test_uids()
        return deleted, len(leftovers), leftovers

    def enumerate_test_uids(self) -> List[str]:
        """时间窗口枚举全部日历, 收集 UID 前缀命中的事件 (清理验证 + 残留巡检)."""
        found: List[str] = []
        principal = self.writer._connect()
        win_start = self.base - timedelta(days=40)
        win_end = self.base + timedelta(days=40)
        for cal in principal.calendars():
            if self.calendar_name and str(cal.name) != self.calendar_name:
                continue
            try:
                raws = cal.search(start=win_start, end=win_end, event=True, expand=False)
            except Exception as e:
                print(f"    [WARN] 枚举 calendar {cal.name!r} 失败: {e}")
                continue
            for raw in raws:
                try:
                    for ve in getattr(raw.vobject_instance, "vevent_list", []) or []:
                        uid = getattr(getattr(ve, "uid", None), "value", "") or ""
                        summary = getattr(getattr(ve, "summary", None), "value", "") or ""
                        if uid.startswith(UID_PREFIX) or summary.startswith(SUMMARY_PREFIX):
                            if uid not in found:
                                found.append(uid)
                except Exception:
                    continue
        return found


# ============================================================
# helpers
# ============================================================

def _rrule_parts(rrule: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for p in (rrule or "").split(";"):
        if "=" in p:
            k, v = p.split("=", 1)
            out[k.strip().upper()] = v.strip().upper()
    return out


def _expand(dtstart: datetime, dtend: Optional[datetime], rrule: str,
            win_start: datetime, win_end: datetime) -> List[Tuple[datetime, datetime]]:
    return expand_in_window(
        dtstart=dtstart, dtend=dtend, rrule=rrule,
        exdates_iso=[], rdates_iso=[],
        window_start=win_start, window_end=win_end,
    )


def _fmt_occs(occs: List[Tuple[datetime, datetime]]) -> str:
    return ", ".join(s.strftime("%m-%d %H:%M") for s, _ in occs)


# ============================================================
# 场景 ① detached override (改这次)
# ============================================================

def scenario_detached(h: Harness) -> ScenarioResult:
    # 用 WEEKLY 而非 DAILY: Exchange 对 DAILY 系列的 occurrence 挪小时级时间
    # 抛 ErrorOccurrenceCrossingBoundary (修改后的 occurrence 不得与相邻
    # occurrence 同日期, DAILY 日期稠密必撞), 且 DavMail 吞错误只 WARN 照返
    # 200 — 见验证报告. WEEKLY + 当天挪 2h 才是「改这次」主流用例.
    r = ScenarioResult("detached")
    dtstart = h.base
    dtend = dtstart + timedelta(minutes=30)
    with h.patched_generate_uid():
        created = h.writer.create_event(
            summary=SUMMARY_PREFIX + "detached-master",
            dtstart_utc=dtstart, dtend_utc=dtend,
            rrule="FREQ=WEEKLY;COUNT=5",
            calendar_name=h.calendar_name,
        )
    uid = created["ical_uid"]
    _, evt = h.read_back(uid)
    r.check("create 读回", evt is not None, f"uid={uid}")

    occ3 = dtstart + timedelta(days=14)
    new_start = occ3 + timedelta(hours=2)
    h.writer.update_occurrence(
        ical_uid=uid, recurrence_id_utc=occ3,
        dtstart_utc=new_start,
        summary=SUMMARY_PREFIX + "detached-已改这次",
        calendar_name=h.calendar_name,
    )

    # 读回: master RRULE 不变 + override VEVENT 就位
    deadline = time.time() + READBACK_TIMEOUT_SEC
    override = None
    master = None
    while time.time() < deadline and override is None:
        _, evt = h.read_back(uid)
        master = h.master_of(evt)
        for ve in h.vevents_of(evt):
            if hasattr(ve, "recurrence_id") and ve.recurrence_id:
                try:
                    if _to_utc(ve.recurrence_id.value) == occ3:
                        override = ve
                except (TypeError, ValueError):
                    continue
        if override is None:
            time.sleep(READBACK_INTERVAL_SEC)

    r.check("master 仍在且 RRULE 保留", master is not None and
            bool(getattr(getattr(master, "rrule", None), "value", "")),
            f"rrule={getattr(getattr(master, 'rrule', None), 'value', None)!r}")
    r.check("override VEVENT 就位 (RECURRENCE-ID 匹配)", override is not None,
            f"目标 occurrence={occ3.isoformat()}")
    if override is not None:
        got_start = _to_utc(override.dtstart.value)
        r.check("override DTSTART = 新时间", got_start == new_start,
                f"期望 {new_start.isoformat()}, 读回 {got_start.isoformat()}")
        got_summary = getattr(getattr(override, "summary", None), "value", "")
        r.check("override SUMMARY = 新标题",
                got_summary == SUMMARY_PREFIX + "detached-已改这次",
                f"读回 {got_summary!r}")
    return r


# ============================================================
# 场景 ② split_series (改未来)
# ============================================================

def scenario_split(h: Harness) -> ScenarioResult:
    r = ScenarioResult("split")
    dtstart = h.base + timedelta(days=7)
    dtend = dtstart + timedelta(hours=1)
    with h.patched_generate_uid():
        created = h.writer.create_event(
            summary=SUMMARY_PREFIX + "split-master",
            dtstart_utc=dtstart, dtend_utc=dtend,
            rrule="FREQ=DAILY;COUNT=8",
            calendar_name=h.calendar_name,
        )
    old_uid = created["ical_uid"]
    h.read_back(old_uid)

    split_at = dtstart + timedelta(days=3)  # 第 4 次 occurrence 起改未来
    with h.patched_generate_uid():
        result = h.writer.split_series(
            ical_uid=old_uid, split_recurrence_id_utc=split_at,
            summary=SUMMARY_PREFIX + "split-新系列",
            calendar_name=h.calendar_name,
        )
    new_uid = result["new_ical_uid"]

    # 老 master: RRULE 截断 (语义判定 — 展开后全部 occurrence < split 点且数量=3)
    _, old_evt = h.read_back(old_uid)
    old_master = h.master_of(old_evt)
    old_rrule = getattr(getattr(old_master, "rrule", None), "value", "") if old_master else ""
    parts = _rrule_parts(old_rrule)
    r.observe("老 master 读回 RRULE 字面值", repr(old_rrule))
    win = (dtstart - timedelta(days=1), dtstart + timedelta(days=30))
    old_occs = _expand(_to_utc(old_master.dtstart.value), None, old_rrule, *win) if old_master else []
    r.check("老 master RRULE 截断: 展开数 = 3 (split 前)", len(old_occs) == 3,
            f"展开 {len(old_occs)} 个: {_fmt_occs(old_occs)}")
    r.check("老 master 无 occurrence >= split 点",
            all(s < split_at for s, _ in old_occs),
            f"split_at={split_at.isoformat()}")
    r.check("老 master RRULE 无 COUNT (COUNT→UNTIL)", "COUNT" not in parts,
            f"parts={parts}")

    # 新 master: 就位, DTSTART = split 点, RRULE 去 UNTIL/COUNT
    _, new_evt = h.read_back(new_uid)
    new_master = h.master_of(new_evt)
    r.check("新 master 就位", new_master is not None, f"uid={new_uid}")
    if new_master is not None:
        got_start = _to_utc(new_master.dtstart.value)
        r.check("新 master DTSTART = split 点", got_start == split_at,
                f"读回 {got_start.isoformat()}")
        new_rrule = getattr(getattr(new_master, "rrule", None), "value", "")
        new_parts = _rrule_parts(new_rrule)
        r.observe("新 master 读回 RRULE 字面值", repr(new_rrule))
        r.check("新 master RRULE 保留 FREQ 且无 UNTIL/COUNT (文档化 caveat: 变无限)",
                new_parts.get("FREQ") == "DAILY"
                and "UNTIL" not in new_parts and "COUNT" not in new_parts,
                f"parts={new_parts}")
        got_summary = getattr(getattr(new_master, "summary", None), "value", "")
        r.check("新 master SUMMARY = 新标题",
                got_summary == SUMMARY_PREFIX + "split-新系列",
                f"读回 {got_summary!r}")
    return r


# ============================================================
# 场景 ③ 全天事件 (VALUE=DATE)
# ============================================================

def scenario_allday(h: Harness) -> ScenarioResult:
    r = ScenarioResult("allday")
    day = (h.base + timedelta(days=14)).replace(hour=0)
    with h.patched_generate_uid():
        created = h.writer.create_event(
            summary=SUMMARY_PREFIX + "allday-创建",
            dtstart_utc=day, dtend_utc=day + timedelta(days=1),  # exclusive end
            is_all_day=True,
            calendar_name=h.calendar_name,
        )
    uid = created["ical_uid"]
    _, evt = h.read_back(uid)
    master = h.master_of(evt)

    def _is_date(v: Any) -> bool:
        return isinstance(v, date) and not isinstance(v, datetime)

    got_start = master.dtstart.value if master and hasattr(master, "dtstart") else None
    r.check("读回 DTSTART 是 VALUE=DATE (date 非 datetime)", _is_date(got_start),
            f"读回类型 {type(got_start).__name__}, 值 {got_start!r}")
    r.check("读回日期一致", _is_date(got_start) and got_start == day.date(),
            f"期望 {day.date()}")

    # update 路径: 只改标题, 全天状态必须保持 (is_all_day=None 时的保护)
    h.writer.update_event(
        ical_uid=uid, summary=SUMMARY_PREFIX + "allday-已更新",
        calendar_name=h.calendar_name,
    )
    deadline = time.time() + READBACK_TIMEOUT_SEC
    got2_start, got2_summary = None, ""
    while time.time() < deadline:
        _, evt2 = h.read_back(uid)
        m2 = h.master_of(evt2)
        got2_start = m2.dtstart.value if m2 and hasattr(m2, "dtstart") else None
        got2_summary = getattr(getattr(m2, "summary", None), "value", "") if m2 else ""
        if got2_summary == SUMMARY_PREFIX + "allday-已更新":
            break
        time.sleep(READBACK_INTERVAL_SEC)
    r.check("update 后 SUMMARY 生效", got2_summary == SUMMARY_PREFIX + "allday-已更新",
            f"读回 {got2_summary!r}")
    r.check("update 后仍是全天 (VALUE=DATE 保持)", _is_date(got2_start),
            f"读回类型 {type(got2_start).__name__}, 值 {got2_start!r}")
    return r


# ============================================================
# 场景 ④ COUNT 型 RRULE + 展开数一致
# ============================================================

def scenario_count(h: Harness) -> ScenarioResult:
    r = ScenarioResult("count")
    dtstart = h.base + timedelta(days=21)
    dtend = dtstart + timedelta(hours=1)
    rrule_in = "FREQ=DAILY;COUNT=4"
    with h.patched_generate_uid():
        created = h.writer.create_event(
            summary=SUMMARY_PREFIX + "count-系列",
            dtstart_utc=dtstart, dtend_utc=dtend,
            rrule=rrule_in,
            calendar_name=h.calendar_name,
        )
    uid = created["ical_uid"]
    _, evt = h.read_back(uid)
    master = h.master_of(evt)
    got_rrule = getattr(getattr(master, "rrule", None), "value", "") if master else ""
    r.observe("服务端读回 RRULE 字面值 (是否 normalize COUNT)", repr(got_rrule))
    r.check("读回 RRULE 非空", bool(got_rrule), "")

    win = (dtstart - timedelta(days=1), dtstart + timedelta(days=30))
    got_start = _to_utc(master.dtstart.value) if master else dtstart
    occs_server = _expand(got_start, _to_utc(master.dtend.value) if master and hasattr(master, "dtend") else None,
                          got_rrule, *win)
    occs_local = _expand(dtstart, dtend, rrule_in, *win)
    r.check("展开数一致: 服务端 RRULE 展开 == 本地 4 个",
            len(occs_server) == 4 and len(occs_local) == 4,
            f"服务端 {len(occs_server)} ({_fmt_occs(occs_server)}), 本地 {len(occs_local)}")
    r.check("occurrence 时刻逐一一致",
            [s for s, _ in occs_server] == [s for s, _ in occs_local],
            "")
    return r


# ============================================================
# 场景 ⑤ X-属性 / VALARM 剥离检查 (纯观察)
# ============================================================

X_PROPS = ("X-MICROSOFT-CDO-BUSYSTATUS", "X-MAILAGENT-TEST")


def _survey_extras(evt) -> Dict[str, Any]:
    """看读回资源里 X-props / VALARM 的存活情况 (以 raw 文本判断, vobject 对
    未知属性的暴露方式不稳)."""
    raw = (evt.data or "") if evt is not None else ""
    upper = raw.upper()
    return {
        "x_props": {p: (p in upper) for p in X_PROPS},
        "valarm": "BEGIN:VALARM" in upper,
    }


def scenario_xprops(h: Harness) -> ScenarioResult:
    r = ScenarioResult("xprops")
    dtstart = h.base + timedelta(days=28)
    uid = h.next_uid()
    base_body = build_vevent(
        ical_uid=uid,
        summary=SUMMARY_PREFIX + "xprops-探针",
        dtstart_utc=dtstart, dtend_utc=dtstart + timedelta(hours=1),
        organizer_email=h.cfg.user_email,
    )
    # 注入 X-props + VALARM (在 END:VEVENT 前插)
    inject = (
        "X-MICROSOFT-CDO-BUSYSTATUS:BUSY\r\n"
        "X-MAILAGENT-TEST:probe-value-roundtrip\r\n"
        "BEGIN:VALARM\r\n"
        "ACTION:DISPLAY\r\n"
        "DESCRIPTION:MailAgent test alarm\r\n"
        "TRIGGER:-PT15M\r\n"
        "END:VALARM\r\n"
    )
    body = base_body.replace("END:VEVENT", inject + "END:VEVENT", 1)
    cal = h.writer._pick_calendar(h.calendar_name)
    cal.save_event(body)

    _, evt1 = h.read_back(uid)
    before = _survey_extras(evt1)
    r.observe("Exchange round-trip 后 X-props 存活", str(before["x_props"]))
    r.observe("Exchange round-trip 后 VALARM 存活", str(before["valarm"]))

    # 我们的 update 路径 (整体重建 PUT) 之后, 这些块是否被剥掉
    h.writer.update_event(
        ical_uid=uid, location="已更新-触发整体重建",
        calendar_name=h.calendar_name,
    )
    deadline = time.time() + READBACK_TIMEOUT_SEC
    after = None
    while time.time() < deadline:
        _, evt2 = h.read_back(uid)
        m2 = h.master_of(evt2)
        loc = getattr(getattr(m2, "location", None), "value", "") if m2 else ""
        if loc == "已更新-触发整体重建":
            after = _survey_extras(evt2)
            break
        time.sleep(READBACK_INTERVAL_SEC)
    r.check("update_event 生效 (location 写入)", after is not None, "")
    if after is not None:
        r.observe("writer.update_event 后 X-props 存活", str(after["x_props"]))
        r.observe("writer.update_event 后 VALARM 存活", str(after["valarm"]))
        lost = [p for p in X_PROPS if before["x_props"].get(p) and not after["x_props"].get(p)]
        if lost or (before["valarm"] and not after["valarm"]):
            r.observe(
                "结论: writer 更新路径剥离非白名单块 (真 bug 候选, 报主 session)",
                f"丢失 X-props={lost}, VALARM 丢失={before['valarm'] and not after['valarm']}",
            )
        else:
            r.observe("结论: 未观察到剥离 (或 Exchange 本身已不保留)", "")
    return r


# ============================================================
# 场景 ⑥ split 第二步失败演练 (补偿回滚验证)
# ============================================================

def scenario_splitfail(h: Harness) -> ScenarioResult:
    r = ScenarioResult("splitfail")
    dtstart = h.base + timedelta(days=35)
    with h.patched_generate_uid():
        created = h.writer.create_event(
            summary=SUMMARY_PREFIX + "splitfail-master",
            dtstart_utc=dtstart, dtend_utc=dtstart + timedelta(hours=1),
            rrule="FREQ=DAILY;COUNT=6",
            calendar_name=h.calendar_name,
        )
    uid = created["ical_uid"]
    _, evt0 = h.read_back(uid)
    master0 = h.master_of(evt0)
    rrule0 = getattr(getattr(master0, "rrule", None), "value", "")
    win = (dtstart - timedelta(days=1), dtstart + timedelta(days=30))
    occs0 = _expand(_to_utc(master0.dtstart.value), None, rrule0, *win)
    r.check("演练前置: 服务端 RRULE 展开 6 个", len(occs0) == 6,
            f"rrule={rrule0!r}, 展开 {len(occs0)}")

    split_at = dtstart + timedelta(days=3)
    cal_cls = type(h.writer._pick_calendar(h.calendar_name))
    raised = None
    # 第 1 步截断走 evt.save() (Event 对象), 第 2 步新系列走 cal.save_event
    # (Calendar 对象) — 只 patch Calendar.save_event 精确打第 2 步.
    with h.patched_generate_uid():
        with mock.patch.object(
            cal_cls, "save_event",
            side_effect=RuntimeError("injected: 演练第二步 PUT 失败"),
        ):
            try:
                h.writer.split_series(
                    ical_uid=uid, split_recurrence_id_utc=split_at,
                    calendar_name=h.calendar_name,
                )
            except RuntimeError as e:
                raised = e
    r.check("第二步失败向上抛 RuntimeError", raised is not None, str(raised)[:160])
    r.check("异常信息声明已回滚", raised is not None and "已回滚" in str(raised), "")

    # 服务器端读回: 老 master RRULE 恢复原状 (「改未来」没有变「删未来」)
    deadline = time.time() + READBACK_TIMEOUT_SEC
    ok_restore = False
    rrule1, n1 = "", -1
    while time.time() < deadline and not ok_restore:
        _, evt1 = h.read_back(uid)
        master1 = h.master_of(evt1)
        rrule1 = getattr(getattr(master1, "rrule", None), "value", "") if master1 else ""
        occs1 = _expand(_to_utc(master1.dtstart.value), None, rrule1, *win) if master1 else []
        n1 = len(occs1)
        ok_restore = n1 == 6 and all(
            a[0] == b[0] for a, b in zip(occs0, occs1)
        )
        if not ok_restore:
            time.sleep(READBACK_INTERVAL_SEC)
    r.check("服务器端老 master RRULE 已恢复 (展开 6 个且时刻一致)", ok_restore,
            f"回滚后 rrule={rrule1!r}, 展开 {n1}")
    return r


# ============================================================
# 场景 ⑦ RSVP 回执 PARTSTAT 链 (发 1 封真 iTIP REPLY)
# ============================================================

def scenario_rsvp(h: Harness) -> ScenarioResult:
    import tempfile

    from src.calendar_sync.caldav_reader import CalendarEvent
    from src.calendar_sync.repository import CalendarEventRepository
    from src.calendar_sync.rsvp import send_rsvp
    from src.mail.sync_store import SyncStore

    r = ScenarioResult("rsvp")
    dtstart = h.base + timedelta(days=40)
    dtend = dtstart + timedelta(hours=1)
    me = h.cfg.user_email
    with h.patched_generate_uid():
        created = h.writer.create_event(
            summary=SUMMARY_PREFIX + "rsvp-链路",
            dtstart_utc=dtstart, dtend_utc=dtend,
            attendees=[{"email": me, "name": "MailAgent Test Self"}],
            calendar_name=h.calendar_name,
        )
    uid = created["ical_uid"]
    _, evt0 = h.read_back(uid)
    master0 = h.master_of(evt0)
    atts0 = writer_mod._extract_attendees_from_vevent(master0) if master0 else []
    self0 = next((a for a in atts0 if a["email"].lower() == me.lower()), None)
    r.observe("发 REPLY 前服务端 ATTENDEE(self) PARTSTAT",
              str(self0.get("partstat") if self0 else "attendee 未读到"))

    # 临时 SQLite (绝不碰生产 DB): SyncStore 建 schema → 手工灌 1 行 → send_rsvp
    with tempfile.TemporaryDirectory(prefix="mailagent-caltest-rsvp-") as td:
        db_path = str(Path(td) / "caltest.db")
        SyncStore(db_path)
        repo = CalendarEventRepository(db_path, pool=False)
        repo.upsert_from_caldav_event(
            CalendarEvent(
                summary=SUMMARY_PREFIX + "rsvp-链路",
                start=dtstart, end=dtend,
                organizer=me, attendees=[me],
                ical_uid=uid, sequence=0,
                calendar_name=str(created.get("calendar_name") or ""),
            ),
            source="caldav",
        )
        result = send_rsvp(
            repo, h.cfg, ical_uid=uid, response_status="ACCEPTED",
            source="caldav",
        )
        h.rsvp_emails_sent += 1
        repo.close()
    r.check("iTIP REPLY 发送成功 (action=sent)", result.get("action") == "sent",
            f"to={result.get('to_email')} (self-organized, 共发 {h.rsvp_emails_sent} 封)")

    # 观察窗口: Exchange Calendar Assistant 异步更新 PARTSTAT
    deadline = time.time() + RSVP_OBSERVE_TIMEOUT_SEC
    final_partstat = None
    while time.time() < deadline:
        _, evt1 = h.read_back(uid)
        master1 = h.master_of(evt1)
        atts1 = writer_mod._extract_attendees_from_vevent(master1) if master1 else []
        self1 = next((a for a in atts1 if a["email"].lower() == me.lower()), None)
        final_partstat = self1.get("partstat") if self1 else None
        if final_partstat == "ACCEPTED":
            break
        time.sleep(5)
    r.observe(
        "REPLY 后服务端 ATTENDEE(self) PARTSTAT (D1 文案依据)",
        f"{final_partstat!r} (观察窗口 {RSVP_OBSERVE_TIMEOUT_SEC}s; "
        f"self-organized 事件的 Exchange 实际行为, 写进验证报告)",
    )
    r.check("RSVP 链闭环: REPLY 发出且事件仍可读回", final_partstat is not None
            or master1 is not None, "PARTSTAT 演进为观察项, 不判 FAIL")
    return r


# ============================================================
# main
# ============================================================

SCENARIOS = {
    "detached": scenario_detached,
    "split": scenario_split,
    "allday": scenario_allday,
    "count": scenario_count,
    "xprops": scenario_xprops,
    "splitfail": scenario_splitfail,
    "rsvp": scenario_rsvp,
}

SCENARIOS_ORDER = ["detached", "split", "allday", "count", "xprops", "splitfail", "rsvp"]


def main() -> int:
    # 实测 (run 20260714T204959Z): caldav 传给 niquests 的 timeout=30 protect 不到
    # 响应 body 读 — niquests send() 内 r.content → urllib3-future hface
    # __exchange_until → sock.recv(blocksize) 是**裸阻塞 recv**, DavMail/EWS 线程
    # 挂起时 harness 永久卡死. socket 层默认超时对该 recv 生效, 兜底.
    import socket
    socket.setdefaulttimeout(120)
    try:
        sys.stdout.reconfigure(line_buffering=True)  # 管道下别憋输出 (被 kill 时不丢)
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="#9 真日历 CalDAV round-trip 验证 harness")
    ap.add_argument("--scenario", choices=[*SCENARIOS, "all", "cleanup"], default="all",
                    help="单场景 / all (all 默认不含 rsvp) / cleanup (纯清扫前缀残留)")
    ap.add_argument("--with-rsvp", action="store_true",
                    help="all 时附带 rsvp 场景 (发 1 封真 iTIP REPLY 邮件)")
    ap.add_argument("--calendar", default=None, help="目标日历名 (默认第一个)")
    ap.add_argument("--base-offset-days", type=int, default=45,
                    help="测试事件放到未来 N 天起 (默认 45)")
    ap.add_argument("--keep", action="store_true", help="调试: 跳过清理")
    args = ap.parse_args()

    if args.scenario == "all":
        names = [n for n in SCENARIOS_ORDER if n != "rsvp" or args.with_rsvp]
    elif args.scenario == "cleanup":
        names = []  # 纯清扫: 不跑场景, 直接走 finally 的前缀枚举删除
    else:
        names = [args.scenario]

    h = Harness(args.calendar, args.base_offset_days)
    print(f"== #9 真日历验证 run={h.run_stamp} base={h.base.isoformat()} "
          f"scenarios={names} calendar={args.calendar or '(第一个)'} ==")

    results: List[ScenarioResult] = []
    try:
        for name in names:
            print(f"\n-- 场景 {name} --")
            try:
                results.append(SCENARIOS[name](h))
            except Exception:
                r = ScenarioResult(name, error=traceback.format_exc())
                results.append(r)
                print(f"    [ERR ] 场景异常:\n{r.error}")
    finally:
        if args.keep:
            print("\n[keep] 跳过清理 — 记得手工删除测试事件!")
            print(f"[keep] 本 run UIDs: {h.created_uids}")
        else:
            print("\n-- 清理 (finally) --")
            deleted, leftover_n, leftover = h.cleanup()
            print(f"    删除 {deleted} 个; 前缀重新枚举残留 = {leftover_n}"
                  + (f" 残留 UIDs: {leftover}" if leftover else " (清理验证通过)"))

    print("\n== 摘要 ==")
    all_ok = True
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        all_ok = all_ok and r.passed
        n_checks = sum(1 for c in r.checks if c.ok is not None)
        n_obs = sum(1 for c in r.checks if c.ok is None)
        print(f"  [{status}] {r.scenario} ({n_checks} checks, {n_obs} obs)")
        for c in r.checks:
            if c.ok is False:
                print(f"          FAIL: {c.name} — {c.detail}")
        if r.error:
            print(f"          ERROR: {r.error.splitlines()[-1]}")
    print(f"\nRSVP 邮件发出: {h.rsvp_emails_sent} 封 (纪律 ≤1)")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

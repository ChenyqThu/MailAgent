"""CalDAV reader — 通过 DavMail 1080 端口读 Outlook 服务端日历.

Phase C.2 (plan §"Phase C — CalDAV enrichment"): 给 LLM agent 提供"今日/本周日程"
context. 不替代 src/calendar_notion/sync.py 的 .ics 解析路径 (那个 attendees +
attendee response 是邮件特化), CalDAV 是 enrichment 数据源 — 拿用户在 Outlook 端直接
创建的 / 别人没邀请你的 / 共享日历的会议 (v3 .ics 拿不到).

依赖: pip install caldav  (lazy import — 未装时 import 时 raise ImportError)
启用: cfg.llm_caldav_context_enabled=true + DavMail 1080 端口 online

PoC 实测 (davmail-poc/test_caldav.py):
- 12 events 拉取 OK, 跨时区时间 + 组织者/与会者/位置完整
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Optional

from loguru import logger

if TYPE_CHECKING:
    from src.config import Config


def _safe_value(vevent: Any, attr: str, default: str = "") -> str:
    """从 vobject vEvent 安全拿一个属性的 ``.value``, 全部失败 fallback default.

    review HIGH #6: 原来用 ``getattr(vevent, attr, None).value`` 在 vobject
    属性是 list (多 SUMMARY) / 空 SUMMARY / 不存在 等场景会 AttributeError 被外
    层 try/except 整 event 静默吞. 改成显式 try + 多 case 处理.
    """
    if not hasattr(vevent, attr):
        return default
    try:
        prop = getattr(vevent, attr)
        # vobject 有时返回 list (多值 property), 取第一个
        if isinstance(prop, list):
            prop = prop[0] if prop else None
        if prop is None:
            return default
        val = getattr(prop, "value", None)
        if val is None:
            return default
        if isinstance(val, list):
            val = val[0] if val else ""
        return str(val) if val else default
    except Exception:
        return default


def _coerce_aware(dt: Any) -> Optional[datetime]:
    """date / datetime → tz-aware datetime (UTC). 失败 None.

    review MEDIUM: 跨 date/datetime 混合场景 (e.g. dtstart=datetime, dtend=date) 旧
    代码 ``e.end - e.start`` 会 TypeError 被静默 catch. 统一归一一次.
    """
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    if isinstance(dt, date):
        return datetime.combine(dt, datetime.min.time(), timezone.utc)
    return None


@dataclass
class CalendarEvent:
    """从 CalDAV 拿到的单个 event.

    Phase 1 扩展 (plan §1.2): 在原 LLM-friendly 简化形式基础上加 ical_uid /
    sequence / rrule / exdates / rdates / status / response_status / recurrence_id /
    attendees_detail 字段, 让 worker / repository 能完整落库到 calendar_event 表.
    保留 to_llm_brief() 向后兼容 LLM agent 的 build_llm_caldav_context 入口.
    """

    # 原 LLM-brief 必须字段
    summary: str  # 标题
    start: datetime  # 起始时间 (含 tz)
    end: datetime
    location: str = ""
    organizer: str = ""  # mailto: 已剥
    attendees: list[str] = field(default_factory=list)  # 仅 email list (兼容老代码)
    url: str = ""  # Teams/Zoom link 等 (从 description / x-property 提取)
    is_all_day: bool = False
    description: str = ""  # 原始描述, 可能含会议链接

    # Phase 1 SSoT 扩展字段 (默认值保持向后兼容)
    ical_uid: str = ""  # VEVENT UID (RFC 5545); 空表示 vobject 解析失败 fallback
    sequence: int = 0  # iTIP SEQUENCE; 高 sequence 覆盖低 sequence (反向 sync 决策)
    recurrence_id: Optional[str] = None  # 非空 = 单次跳脱 occurrence (RECURRENCE-ID)
    rrule: str = ""  # RFC 5545 RRULE 原始字符串 (主事件才有, occurrence 为空)
    exdates: list[str] = field(default_factory=list)  # JSON-serializable ISO strings
    rdates: list[str] = field(default_factory=list)
    status: str = ""  # CONFIRMED / TENTATIVE / CANCELLED
    response_status: str = ""  # 当前用户 PARTSTAT (ACCEPTED / DECLINED / TENTATIVE / NEEDS-ACTION)
    attendees_detail: list[dict] = field(default_factory=list)
    # ↑ 完整 attendee 信息 [{email, name, response, role}], attendees 字段是简化版
    calendar_name: str = ""  # CalDAV calendar 名 (多日历支持)
    ics_raw: str = ""  # 原始 VEVENT 文本 (debug + 反向写 fallback)

    def to_llm_brief(self) -> str:
        """给 LLM 用的紧凑表示 (单行)."""
        ts = self.start.strftime("%m-%d %H:%M")
        dur = (self.end - self.start).total_seconds() / 60
        attendee_count = len(self.attendees)
        loc = f" @ {self.location}" if self.location else ""
        meet_link = " 🎦" if self.url or "teams.microsoft.com" in self.description.lower() else ""
        return (
            f"{ts} ({int(dur)}min) {self.summary}{loc} "
            f"[organizer={self.organizer or '?'}, {attendee_count} attendees]{meet_link}"
        )


class CalDAVReader:
    """CalDAV 客户端 — 启动时 lazy 连接, 按需 list events."""

    def __init__(self, cfg: "Config"):
        self.cfg = cfg
        self.host = getattr(cfg, "davmail_imap_host", "") or "127.0.0.1"
        self.port = int(getattr(cfg, "davmail_caldav_port", 0) or 1080)
        self.user = cfg.user_email
        # cipher key 跟 IMAP/SMTP 共享 (DavMail StringEncryptor 同一 password). 走
        # imap_client.get_cipher_key 而非自己硬编码 fallback (review MEDIUM: 消除
        # 第二处 PoC 默认值硬编码).
        from src.mail.backend.imap_client import get_cipher_key
        self.password = get_cipher_key(cfg)
        self._client = None
        self._principal = None

    def _connect(self):
        """Lazy connect, 失败抛 ImportError (caldav 未装) 或 RuntimeError (连接/auth 失败)."""
        if self._principal is not None:
            return self._principal

        try:
            import caldav  # noqa
        except ImportError as e:
            raise ImportError(
                "caldav lib not installed. 启用 CalDAV reader 需: pip install caldav"
            ) from e

        base_url = f"http://{self.host}:{self.port}/"
        logger.info(f"[caldav-reader] connecting {base_url} as {self.user!r}")
        try:
            self._client = caldav.DAVClient(
                url=base_url, username=self.user, password=self.password,
            )
            self._principal = self._client.principal()
        except Exception as e:
            raise RuntimeError(f"CalDAV connect failed: {e}") from e
        return self._principal

    def list_calendars(self) -> list[str]:
        """列出所有 calendar 名 (调试用)."""
        principal = self._connect()
        return [str(cal.name) for cal in principal.calendars()]

    def list_events(
        self,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
    ) -> list[CalendarEvent]:
        """拉指定时间窗口的 events. 默认: 今天 0:00 → 7 天后.

        跨多个 calendar 都查, 合并返回 + 按 start 排序.
        """
        if start is None:
            start = datetime.now(timezone.utc).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
        if end is None:
            end = start + timedelta(days=7)

        principal = self._connect()
        all_events: list[CalendarEvent] = []
        for cal in principal.calendars():
            try:
                raw_events = cal.search(start=start, end=end, event=True, expand=True)
            except Exception as e:
                logger.warning(f"[caldav-reader] cal {cal.name!r} search failed: {e}")
                continue
            cal_name = str(cal.name) if cal.name else ""
            for evt in raw_events:
                parsed = self._parse_event(
                    evt, calendar_name=cal_name, user_email=self.user
                )
                if parsed:
                    all_events.append(parsed)

        # Filter window — caldav.search(expand=True) 可能展开 recurring rule 到远期,
        # 不严格 respect end 参数. 这里硬过滤一次保证 LLM context 只看到指定窗口内.
        def _in_window(e: CalendarEvent) -> bool:
            es = e.start
            if es.tzinfo is None:
                es = es.replace(tzinfo=timezone.utc)
            else:
                es = es.astimezone(timezone.utc)
            return start <= es < end

        all_events = [e for e in all_events if _in_window(e)]
        # _parse_event 保证 e.start tz-aware, 不再做 fallback (MEDIUM: 删 dead branch).
        all_events.sort(key=lambda e: e.start.astimezone(timezone.utc))
        return all_events

    def list_today_events(self) -> list[CalendarEvent]:
        """今天 0:00 → 23:59 内的 events."""
        start = datetime.now(timezone.utc).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        end = start + timedelta(days=1)
        return self.list_events(start, end)

    def list_week_events(self) -> list[CalendarEvent]:
        """未来 7 天的 events (含今天)."""
        return self.list_events()

    # ============================================================
    # Phase 1 SSoT 扩展: ctag / sync-token / list with calendar filter
    # ============================================================

    def list_events_with_full_detail(
        self,
        start: Optional[datetime] = None,
        end: Optional[datetime] = None,
        *,
        calendar_name: Optional[str] = None,
    ) -> list[CalendarEvent]:
        """list_events 的 SSoT 版本: 可过滤单个 calendar.

        语义跟 ``list_events`` 一样, 但允许 ``calendar_name`` 只查指定日历
        (worker 按 calendar 逐个 sync 用). 留空 = 全部 calendar.

        Phase 1 注: 字段抽取等同于 list_events (新 _parse_event 已经默认填全字段);
        这个方法的存在意义是给 worker 一个明确的"按 calendar 单独跑"的入口.
        """
        if start is None:
            start = datetime.now(timezone.utc).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
        if end is None:
            end = start + timedelta(days=7)

        principal = self._connect()
        all_events: list[CalendarEvent] = []
        for cal in principal.calendars():
            cal_name = str(cal.name) if cal.name else ""
            if calendar_name is not None and cal_name != calendar_name:
                continue
            try:
                raw_events = cal.search(start=start, end=end, event=True, expand=True)
            except Exception as e:
                logger.warning(f"[caldav-reader] cal {cal_name!r} search failed: {e}")
                continue
            for evt in raw_events:
                parsed = self._parse_event(
                    evt, calendar_name=cal_name, user_email=self.user
                )
                if parsed:
                    all_events.append(parsed)

        def _in_window(e: CalendarEvent) -> bool:
            es = e.start
            if es.tzinfo is None:
                es = es.replace(tzinfo=timezone.utc)
            else:
                es = es.astimezone(timezone.utc)
            return start <= es < end

        all_events = [e for e in all_events if _in_window(e)]
        all_events.sort(key=lambda e: e.start.astimezone(timezone.utc))
        return all_events

    def get_collection_ctag(self, calendar_name: str) -> Optional[str]:
        """拉指定 calendar 的 RFC 4791 CTag (整库变更检测).

        Worker 主循环每 60s 调一次, 跟存的 ctag 比对 — 没变跳过全量 search,
        变了才走 sync_collection / 全窗口 re-read. 失败返回 None (worker 降级
        到 polling).

        实现: caldav lib 在 `Calendar` 对象上暴露 `get_ctag()` 方法 (内部走
        PROPFIND `{urn:ietf:params:xml:ns:caldav}getctag`). 不同 lib 版本签名
        可能微变, 用 hasattr probe.
        """
        principal = self._connect()
        for cal in principal.calendars():
            cal_name = str(cal.name) if cal.name else ""
            if cal_name != calendar_name:
                continue
            # caldav lib >=1.3 cal.get_ctag() 直返字符串, 但实测某些 ARM mac /
            # 老 DavMail 组合下抛 'tuple' object has no attribute 'xmlelement'
            # (lib 内部 _query() 返回 tuple, get_ctag 假设是单值). 先 try, 失败
            # fall through 到 PROPFIND.
            if hasattr(cal, "get_ctag"):
                try:
                    return cal.get_ctag()
                except Exception as e:
                    logger.debug(
                        f"[caldav-reader] cal.get_ctag({cal_name!r}) raised "
                        f"({e}); fallback to PROPFIND"
                    )
            # Fallback: PROPFIND on the calendar collection
            try:
                props = cal.get_properties(
                    [("DAV:", "getctag"), ("urn:ietf:params:xml:ns:caldav", "getctag")]
                )
                for v in props.values():
                    if v:
                        return str(v)
                return None
            except Exception as e:
                logger.warning(
                    f"[caldav-reader] PROPFIND getctag({cal_name!r}) failed: {e}"
                )
                return None
        logger.warning(f"[caldav-reader] calendar not found: {calendar_name!r}")
        return None

    def sync_collection(
        self, calendar_name: str, sync_token: Optional[str] = None
    ) -> tuple[list[CalendarEvent], list[str], Optional[str]]:
        """RFC 6578 sync-collection REPORT — 拿增量变更.

        Args:
            calendar_name: 要 sync 的 calendar 名.
            sync_token: 上一轮的 token; 留空 = 全量初始化.

        Returns:
            (changed_events, deleted_uids, new_sync_token).
            - changed_events: 新增 / 修改的 events.
            - deleted_uids: 服务端删除的 ical_uid list (worker 用来 soft-delete).
            - new_sync_token: 这一轮的 token, worker 存起来下一轮用. None = lib 不支持.

        DavMail / Outlook 支持度: DavMail 6.7 对 sync-collection 支持有限,
        实测可能返回 HTTP 501 / 空 token. 调用方应该判 new_sync_token is None
        → 降级到 ctag 全窗口 re-read.
        """
        principal = self._connect()
        for cal in principal.calendars():
            cal_name = str(cal.name) if cal.name else ""
            if cal_name != calendar_name:
                continue
            # caldav 1.3+ 暴露 cal.objects_by_sync_token(token); 不支持时 raise.
            if not hasattr(cal, "objects_by_sync_token"):
                logger.debug(
                    "[caldav-reader] caldav lib lacks objects_by_sync_token; "
                    "降级到 ctag re-read"
                )
                return [], [], None
            try:
                result = cal.objects_by_sync_token(sync_token=sync_token)
                changed_objs = getattr(result, "objects", None) or []
                deleted_objs = getattr(result, "deleted_objects", None) or []
                new_token = getattr(result, "sync_token", None)
            except Exception as e:
                logger.warning(
                    f"[caldav-reader] sync_collection({cal_name!r}) failed: {e} "
                    f"— 降级到 ctag re-read"
                )
                return [], [], None

            changed_events: list[CalendarEvent] = []
            for obj in changed_objs:
                parsed = self._parse_event(
                    obj, calendar_name=cal_name, user_email=self.user
                )
                if parsed:
                    changed_events.append(parsed)

            deleted_uids: list[str] = []
            for obj in deleted_objs:
                # deleted_objects 可能只给 URL/href, 试图从 vobject 拿 UID
                try:
                    if hasattr(obj, "vobject_instance") and obj.vobject_instance:
                        uid = _safe_value(obj.vobject_instance.vevent, "uid", "")
                        if uid:
                            deleted_uids.append(uid)
                except Exception:
                    continue

            return changed_events, deleted_uids, new_token
        logger.warning(f"[caldav-reader] calendar not found: {calendar_name!r}")
        return [], [], None

    def list_calendar_names_for_sync(self) -> list[str]:
        """枚举所有 calendar 名称, 给 worker 用 (跟 list_calendars 同义但语义清晰)."""
        return self.list_calendars()

    def _parse_event(
        self, raw_event, *, calendar_name: str = "", user_email: str = ""
    ) -> Optional[CalendarEvent]:
        """caldav.Event → CalendarEvent dataclass.

        Phase 1 扩展 (plan §1.2): 抽 ical_uid / sequence / rrule / exdates / rdates /
        status / response_status / recurrence_id / attendees_detail, 让 worker 能
        完整落 calendar_event 表. 抽不到的字段都 default 空值 (向后兼容老调用方).

        user_email: 当前用户邮箱, 用来从 ATTENDEE list 里挑出"自己"的 PARTSTAT 当
        response_status. 留空则 response_status 永远是 "" (LLM 用例不需要).

        修复 (review HIGH #6 + MEDIUM, 保留):
        - summary/location/organizer/url/description 全部用 ``_safe_value`` 防御.
        - dtstart/dtend 混合 date/datetime 统一通过 ``_coerce_aware`` 归一.
        - all_day 判定看原始 dtstart 类型 (date 而非 datetime).
        """
        try:
            vobj = raw_event.vobject_instance
            if vobj is None:
                return None
            vevent = vobj.vevent
            summary = _safe_value(vevent, "summary", "")

            dtstart_raw = None
            dtend_raw = None
            if hasattr(vevent, "dtstart"):
                try:
                    dtstart_raw = vevent.dtstart.value
                except Exception:
                    dtstart_raw = None
            if hasattr(vevent, "dtend"):
                try:
                    dtend_raw = vevent.dtend.value
                except Exception:
                    dtend_raw = None
            if dtstart_raw is None:
                return None
            is_all_day = not isinstance(dtstart_raw, datetime)
            dtstart = _coerce_aware(dtstart_raw)
            # dtend 缺失常见 (RFC 5545 允许), 用 dtstart + 1h 兜底
            dtend = _coerce_aware(dtend_raw) if dtend_raw is not None else None
            if dtstart is None:
                return None
            if dtend is None:
                dtend = dtstart + timedelta(hours=1)

            location = _safe_value(vevent, "location", "")
            organizer_raw = _safe_value(vevent, "organizer", "")
            organizer = organizer_raw.replace("mailto:", "") if organizer_raw else ""

            # Phase 1: SSoT 字段抽取 — ical_uid / sequence / rrule / status / recurrence_id
            ical_uid = _safe_value(vevent, "uid", "")
            sequence_str = _safe_value(vevent, "sequence", "0")
            try:
                sequence = int(sequence_str) if sequence_str else 0
            except (ValueError, TypeError):
                sequence = 0
            rrule = _safe_value(vevent, "rrule", "")
            status = _safe_value(vevent, "status", "").upper()

            # RECURRENCE-ID: 子事件 occurrence 跳脱标识 (主事件为空)
            recurrence_id: Optional[str] = None
            if hasattr(vevent, "recurrence_id"):
                try:
                    rid_raw = vevent.recurrence_id.value
                    rid_dt = _coerce_aware(rid_raw)
                    if rid_dt is not None:
                        recurrence_id = rid_dt.isoformat()
                except Exception:
                    pass

            # EXDATE / RDATE — 多值 property, 可能是单个 datetime 或 list
            exdates: list[str] = []
            rdates: list[str] = []
            try:
                if hasattr(vevent, "exdate_list"):
                    for ex in vevent.exdate_list:
                        try:
                            v = ex.value
                            if isinstance(v, list):
                                for item in v:
                                    dt = _coerce_aware(item)
                                    if dt is not None:
                                        exdates.append(dt.isoformat())
                            else:
                                dt = _coerce_aware(v)
                                if dt is not None:
                                    exdates.append(dt.isoformat())
                        except Exception:
                            continue
                if hasattr(vevent, "rdate_list"):
                    for rd in vevent.rdate_list:
                        try:
                            v = rd.value
                            if isinstance(v, list):
                                for item in v:
                                    dt = _coerce_aware(item)
                                    if dt is not None:
                                        rdates.append(dt.isoformat())
                            else:
                                dt = _coerce_aware(v)
                                if dt is not None:
                                    rdates.append(dt.isoformat())
                        except Exception:
                            continue
            except Exception:
                pass

            # ATTENDEE: 简化 email list + 完整 detail list (含 PARTSTAT / CN / ROLE).
            # response_status: 从 attendees 里匹配 user_email 的 PARTSTAT.
            attendees: list[str] = []
            attendees_detail: list[dict] = []
            response_status = ""
            try:
                att_list = []
                if hasattr(vevent, "attendee_list"):
                    att_list = list(vevent.attendee_list)
                elif hasattr(vevent, "attendee"):
                    att_list = [vevent.attendee]
                for att in att_list:
                    try:
                        email = str(att.value).replace("mailto:", "").strip()
                    except Exception:
                        continue
                    if not email:
                        continue
                    # 简化 list 去重
                    if email.lower() not in (a.lower() for a in attendees):
                        attendees.append(email)
                    # 完整 detail (params CN / PARTSTAT / ROLE)
                    params = getattr(att, "params", {}) or {}
                    def _pget(key: str) -> str:
                        v = params.get(key)
                        if isinstance(v, list):
                            v = v[0] if v else ""
                        return str(v) if v else ""
                    detail = {
                        "email": email,
                        "name": _pget("CN"),
                        "response": _pget("PARTSTAT").upper(),
                        "role": _pget("ROLE").upper(),
                    }
                    attendees_detail.append(detail)
                    if (
                        user_email
                        and email.lower() == user_email.lower()
                        and detail["response"]
                    ):
                        response_status = detail["response"]
            except Exception:
                pass

            description = _safe_value(vevent, "description", "")
            url = _safe_value(vevent, "url", "")
            if not url and "teams.microsoft.com" in description.lower():
                m = re.search(r"https?://[^\s<>\"']+", description)
                if m:
                    url = m.group(0)

            # ics_raw: 序列化 vEvent 回 ICS 文本 (debug + 反向写 fallback)
            ics_raw = ""
            try:
                ics_raw = vobj.serialize()
            except Exception:
                pass

            return CalendarEvent(
                summary=summary, start=dtstart, end=dtend,
                location=location, organizer=organizer, attendees=attendees,
                url=url, is_all_day=is_all_day, description=description,
                ical_uid=ical_uid, sequence=sequence, recurrence_id=recurrence_id,
                rrule=rrule, exdates=exdates, rdates=rdates,
                status=status, response_status=response_status,
                attendees_detail=attendees_detail,
                calendar_name=calendar_name, ics_raw=ics_raw,
            )
        except Exception as e:
            logger.warning(f"[caldav-reader] parse event failed: {e}")
            return None


def build_llm_caldav_context(cfg: "Config", *, horizon: str = "today") -> str:
    """供 src/llm_agent/processor.py 调用 — 拿一段格式化的日程 context 字符串.

    horizon: 'today' | 'week'

    Returns:
        多行字符串, 每行一个 event brief; 空时返回 ''. 调用方决定是否拼到 prompt.
        失败 (caldav 未装 / DavMail 不可用) 返回空字符串 + log warning (LLM prompt 不变).
    """
    if not getattr(cfg, "llm_caldav_context_enabled", False):
        return ""
    try:
        reader = CalDAVReader(cfg)
        if horizon == "today":
            events = reader.list_today_events()
        else:
            events = reader.list_week_events()
        if not events:
            return ""
        return "\n".join(e.to_llm_brief() for e in events)
    except Exception as e:
        logger.warning(f"[caldav-reader] build_llm_caldav_context failed (degrade): {e}")
        return ""

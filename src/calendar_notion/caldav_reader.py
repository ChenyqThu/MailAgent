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

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Optional

from loguru import logger

if TYPE_CHECKING:
    from src.config import Config


@dataclass
class CalendarEvent:
    """从 CalDAV 拿到的单个 event (LLM-friendly 简化形式)."""

    summary: str  # 标题
    start: datetime  # 起始时间 (含 tz)
    end: datetime
    location: str = ""
    organizer: str = ""
    attendees: list[str] = field(default_factory=list)
    url: str = ""  # Teams/Zoom link 等 (从 description / x-property 提取)
    is_all_day: bool = False
    description: str = ""  # 原始描述, 可能含会议链接

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
        # cipher key 跟 IMAP/SMTP 共享 (DavMail StringEncryptor 同一 password)
        self.password = (
            getattr(cfg, "davmail_cipher_key", "") or "mailagent-poc-shared-key"
        )
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
            for evt in raw_events:
                parsed = self._parse_event(evt)
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
        all_events.sort(key=lambda e: e.start.astimezone(timezone.utc) if e.start.tzinfo else e.start.replace(tzinfo=timezone.utc))
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

    def _parse_event(self, raw_event) -> Optional[CalendarEvent]:
        """caldav.Event → CalendarEvent dataclass."""
        try:
            vobj = raw_event.vobject_instance
            if vobj is None:
                return None
            vevent = vobj.vevent
            summary = str(getattr(vevent, "summary", None).value if hasattr(vevent, "summary") else "")
            dtstart = vevent.dtstart.value if hasattr(vevent, "dtstart") else None
            dtend = vevent.dtend.value if hasattr(vevent, "dtend") else None
            if dtstart is None or dtend is None:
                return None
            is_all_day = not isinstance(dtstart, datetime)
            if is_all_day:
                # date → datetime (00:00 UTC)
                dtstart = datetime.combine(dtstart, datetime.min.time(), timezone.utc)
                dtend = datetime.combine(dtend, datetime.min.time(), timezone.utc)
            elif dtstart.tzinfo is None:
                dtstart = dtstart.replace(tzinfo=timezone.utc)
            if isinstance(dtend, datetime) and dtend.tzinfo is None:
                dtend = dtend.replace(tzinfo=timezone.utc)

            location = ""
            if hasattr(vevent, "location") and vevent.location.value:
                location = str(vevent.location.value)
            organizer = ""
            if hasattr(vevent, "organizer") and vevent.organizer.value:
                organizer = str(vevent.organizer.value).replace("mailto:", "")

            attendees = []
            if hasattr(vevent, "attendee_list"):
                for att in vevent.attendee_list:
                    val = str(att.value).replace("mailto:", "")
                    if val and val.lower() not in attendees:
                        attendees.append(val)
            elif hasattr(vevent, "attendee"):
                val = str(vevent.attendee.value).replace("mailto:", "")
                attendees.append(val)

            description = str(vevent.description.value) if hasattr(vevent, "description") else ""
            url = ""
            if hasattr(vevent, "url") and vevent.url.value:
                url = str(vevent.url.value)
            elif "teams.microsoft.com" in description.lower():
                # 简单提取第一个 https url
                import re
                m = re.search(r"https?://[^\s<>\"']+", description)
                if m:
                    url = m.group(0)

            return CalendarEvent(
                summary=summary, start=dtstart, end=dtend,
                location=location, organizer=organizer, attendees=attendees,
                url=url, is_all_day=is_all_day, description=description,
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

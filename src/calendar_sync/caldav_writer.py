"""Phase 2.2/2.3 — CalDAV 写能力 (create / update / delete event).

跟 ``caldav_reader.py`` (只读) 平行: 通过 DavMail CalDAV (127.0.0.1:1080) 调
``caldav`` lib 把 VCALENDAR 资源 PUT / DELETE 到服务端. DavMail 内部桥接 EWS,
Exchange 端立即生效 (跟 Outlook for Mac 用户体感一致).

CalDAV vs iTIP REPLY 区别:
- iTIP REPLY (itip_reply.py): 给 organizer 发邮件回应 PARTSTAT, owner 仍是 organizer
- CalDAV PUT/DELETE (本模块): owner 直接改自己日历资源, Exchange 异步通知 attendees

API:
    >>> writer = CalDAVWriter(cfg)
    >>> result = writer.create_event(
    ...     summary="Team Sync",
    ...     dtstart_utc=datetime(2026, 5, 30, 14, tzinfo=timezone.utc),
    ...     dtend_utc=datetime(2026, 5, 30, 15, tzinfo=timezone.utc),
    ...     attendees=[{"email": "alice@x.com", "name": "Alice"}],
    ... )
    >>> writer.update_event(ical_uid=..., summary="...", ...)
    >>> writer.delete_event(ical_uid=...)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Dict, List, Optional

from loguru import logger

# 复用 itip_reply 的 RFC 5545 helpers — 跨 module import 私有是有意为之, 避免
# 重复实现 escape / time format 两次. Phase 3 cleanup 可以 promote 成 public.
from src.calendar_sync.itip_reply import _escape_text, _fmt_utc
from src.mail.backend.imap_client import get_cipher_key

if TYPE_CHECKING:
    from src.config import Config


# Sentinel for "调用方没传, 保留原值" vs 显式 None / []. 用 object identity
# 比较 (`is _UNSET`). Python 标准 "省略 vs 显式 None" 区分模式.
_UNSET: Any = object()


def generate_uid() -> str:
    """生成 unique vEvent UID (RFC 5545 §3.8.4.7)."""
    return f"mailagent-{uuid.uuid4().hex}@mailagent.local"


def build_vevent(
    *,
    ical_uid: str,
    summary: str,
    dtstart_utc: datetime,
    dtend_utc: datetime,
    organizer_email: str,
    location: Optional[str] = None,
    description: Optional[str] = None,
    attendees: Optional[List[Dict[str, Any]]] = None,
    sequence: int = 0,
    status: str = "CONFIRMED",
    now_utc: Optional[datetime] = None,
    # F3 新增 (Critical #3 + High #5): RRULE / EXDATE / RDATE / RECURRENCE-ID
    # 透传, 避免 update_event 对 recurring event 时把 series 降级单次.
    rrule: Optional[str] = None,
    exdates: Optional[List[datetime]] = None,
    rdates: Optional[List[datetime]] = None,
    recurrence_id: Optional[datetime] = None,
) -> str:
    """拼 VCALENDAR with single VEVENT for CalDAV PUT.

    Args:
        ical_uid: vEvent UID (RFC 5545; new event 用 generate_uid(), update 用原 UID)
        summary: 事件标题
        dtstart_utc / dtend_utc: 起止时间 (UTC datetime)
        organizer_email: 当前用户邮箱 (owner)
        location: 地点 (optional)
        description: 详情 (optional)
        attendees: List of {email, name?, role?} dict
        sequence: SEQUENCE (RFC 5545 §3.8.7.4); update 时 +1
        status: ``CONFIRMED`` / ``TENTATIVE`` / ``CANCELLED``
        now_utc: 测试 fixture (固定 DTSTAMP)

    Returns:
        VCALENDAR 文本 (RFC 5545 CRLF 行尾)

    Raises:
        ValueError: ical_uid / summary / organizer_email 为空, 或 status 非法
    """
    if not (ical_uid or "").strip():
        raise ValueError("ical_uid is required")
    if not (summary or "").strip():
        raise ValueError("summary is required")
    if not (organizer_email or "").strip():
        raise ValueError("organizer_email is required (CalDAV owner)")
    if status not in ("CONFIRMED", "TENTATIVE", "CANCELLED"):
        raise ValueError(
            f"status must be CONFIRMED/TENTATIVE/CANCELLED, got {status!r}"
        )

    dtstamp = _fmt_utc(now_utc or datetime.now(timezone.utc))
    dtstart = _fmt_utc(dtstart_utc)
    dtend = _fmt_utc(dtend_utc)

    lines = [
        "BEGIN:VCALENDAR",
        "PRODID:-//MailAgent//Phase2.2 CalDAV writer//EN",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        f"UID:{ical_uid}",
        f"DTSTAMP:{dtstamp}",
        f"DTSTART:{dtstart}",
        f"DTEND:{dtend}",
        f"SEQUENCE:{sequence}",
        f"SUMMARY:{_escape_text(summary)}",
        f"ORGANIZER:mailto:{organizer_email}",
        f"STATUS:{status}",
    ]
    if location and location.strip():
        lines.append(f"LOCATION:{_escape_text(location)}")
    if description and description.strip():
        lines.append(f"DESCRIPTION:{_escape_text(description)}")
    for a in attendees or []:
        if not isinstance(a, dict):
            continue
        email = (a.get("email") or "").strip()
        if not email:
            continue
        # F19 (Opus Medium) — 透传 PARTSTAT / ROLE / RSVP / CN, 不再 hardcode
        # NEEDS-ACTION. F3 修了"清空 attendees" 但 hardcode NEEDS-ACTION 把
        # 已 ACCEPTED 的 attendee 状态打回 → Exchange 重发邀请 → 用户感知
        # 双重邀请邮件. 这里 caller (update_event) 从原 vevent 透传 partstat,
        # 新增 attendee 没指定 partstat 走 default NEEDS-ACTION.
        partstat = (a.get("partstat") or "NEEDS-ACTION").strip().upper()
        rsvp = (a.get("rsvp") or "TRUE").strip().upper()
        role = (a.get("role") or "").strip().upper()
        name = a.get("name")
        params = [f"PARTSTAT={partstat}", f"RSVP={rsvp}"]
        if role:
            params.insert(0, f"ROLE={role}")
        if name and isinstance(name, str) and name.strip():
            params.append(f'CN="{name.replace(chr(34), "").strip()}"')
        lines.append(
            f"ATTENDEE;{';'.join(params)}:mailto:{email}"
        )

    # F3: RRULE / EXDATE / RDATE / RECURRENCE-ID — update_event 透传时必须
    # 一并 PUT, 否则 Exchange 把 recurring series 降级单次 (未来 occurrences
    # 全删).
    if rrule and rrule.strip():
        lines.append(f"RRULE:{rrule.strip()}")
    for exd in exdates or []:
        lines.append(f"EXDATE:{_fmt_utc(exd)}")
    for rd in rdates or []:
        lines.append(f"RDATE:{_fmt_utc(rd)}")
    if recurrence_id is not None:
        lines.append(f"RECURRENCE-ID:{_fmt_utc(recurrence_id)}")

    lines.extend(["END:VEVENT", "END:VCALENDAR"])
    return "\r\n".join(lines) + "\r\n"


def _extract_attendees_from_vevent(v: Any) -> List[Dict[str, Any]]:
    """从 vobject vevent 提取 attendees → ``[{email, name?, partstat?, role?, rsvp?}]``.

    F19 (Opus Medium): 含 PARTSTAT / ROLE / RSVP / CN 全 params. update_event
    透传时保留原 attendee 状态 (已 ACCEPTED 不被打回 NEEDS-ACTION → 防 Exchange
    重发邀请).
    """
    out: List[Dict[str, Any]] = []
    raw_list = getattr(v, "attendee_list", None) or []
    for att in raw_list:
        raw = (getattr(att, "value", "") or "").strip()
        email = raw[7:].strip() if raw.lower().startswith("mailto:") else raw
        if not email or "@" not in email:
            continue
        params = getattr(att, "params", {}) or {}

        def _first(key: str) -> Optional[str]:
            val = params.get(key) or params.get(key.lower())
            if isinstance(val, list) and val:
                return val[0]
            if isinstance(val, str):
                return val
            return None

        item: Dict[str, Any] = {"email": email, "name": _first("CN")}
        partstat = _first("PARTSTAT")
        role = _first("ROLE")
        rsvp = _first("RSVP")
        if partstat:
            item["partstat"] = partstat.upper()
        if role:
            item["role"] = role.upper()
        if rsvp:
            item["rsvp"] = rsvp.upper()
        out.append(item)
    return out


def _extract_datetimes_from_vevent_field(v: Any, field: str) -> List[datetime]:
    """从 vobject vevent 提取 EXDATE / RDATE 列表 → UTC datetimes.

    每个 ``exdate``/``rdate`` 节点的 ``.value`` 可能是单 datetime, 也可能是
    list (RFC 5545 允许同行多 value comma 分隔). 都归一成 flat list of UTC.
    """
    out: List[datetime] = []
    raw_list = getattr(v, f"{field}_list", None) or []
    for node in raw_list:
        val = getattr(node, "value", None)
        if val is None:
            continue
        if isinstance(val, list):
            for d in val:
                try:
                    out.append(_to_utc(d))
                except (TypeError, ValueError):
                    continue
        else:
            try:
                out.append(_to_utc(val))
            except (TypeError, ValueError):
                continue
    return out


class CalDAVWriter:
    """CalDAV 写客户端 — DavMail bridge → EWS create/update/delete event."""

    def __init__(self, cfg: "Config"):
        self.cfg = cfg
        self.host = getattr(cfg, "davmail_imap_host", "") or "127.0.0.1"
        self.port = int(getattr(cfg, "davmail_caldav_port", 0) or 1080)
        self.user = cfg.user_email
        self.password = get_cipher_key(cfg)
        self._client = None
        self._principal = None

    def _connect(self):
        """Lazy connect, 复用 reader 的 pattern."""
        if self._principal is not None:
            return self._principal
        try:
            import caldav  # noqa
        except ImportError as e:
            raise ImportError(
                "caldav lib not installed. 启用 CalDAV writer 需: pip install caldav"
            ) from e
        base_url = f"http://{self.host}:{self.port}/"
        logger.info(f"[caldav-writer] connecting {base_url} as {self.user!r}")
        try:
            self._client = caldav.DAVClient(
                url=base_url, username=self.user, password=self.password,
            )
            self._principal = self._client.principal()
        except Exception as e:
            raise RuntimeError(f"CalDAV connect failed: {e}") from e
        return self._principal

    def _pick_calendar(self, calendar_name: Optional[str]):
        """按名找 calendar; 留空 = 第一个 (Outlook 默认日历)."""
        principal = self._connect()
        cals = list(principal.calendars())
        if not cals:
            raise RuntimeError(
                "No calendars found via CalDAV — DavMail bridge may be misconfigured"
            )
        if calendar_name:
            for c in cals:
                if str(c.name) == calendar_name:
                    return c
            raise ValueError(
                f"calendar not found: {calendar_name!r}; available: "
                f"{[str(c.name) for c in cals]}"
            )
        return cals[0]

    def _find_event_by_uid(self, ical_uid: str, calendar_name: Optional[str] = None):
        """按 UID 找现有 event. 跨所有 calendars 查 (calendar_name 限定优先)."""
        principal = self._connect()
        if calendar_name:
            cals = [self._pick_calendar(calendar_name)]
        else:
            cals = list(principal.calendars())
        for cal in cals:
            try:
                evt = cal.event_by_uid(ical_uid)
                if evt is not None:
                    return cal, evt
            except Exception:
                # caldav lib raises NotFoundError 当 UID 不存在; 继续下一个 cal
                continue
        return None, None

    # --------------------------------------------------------
    # Public ops
    # --------------------------------------------------------

    def create_event(
        self,
        *,
        summary: str,
        dtstart_utc: datetime,
        dtend_utc: datetime,
        location: Optional[str] = None,
        description: Optional[str] = None,
        attendees: Optional[List[Dict[str, Any]]] = None,
        calendar_name: Optional[str] = None,
        status: str = "CONFIRMED",
    ) -> Dict[str, Any]:
        """CalDAV PUT 创建新事件.

        Returns:
            ``{action: 'created', ical_uid, calendar_name, dtstart_iso, dtend_iso}``
        """
        ical_uid = generate_uid()
        body = build_vevent(
            ical_uid=ical_uid,
            summary=summary,
            dtstart_utc=dtstart_utc,
            dtend_utc=dtend_utc,
            organizer_email=self.user,
            location=location,
            description=description,
            attendees=attendees,
            sequence=0,
            status=status,
        )
        cal = self._pick_calendar(calendar_name)
        try:
            cal.save_event(body)
        except Exception as e:
            raise RuntimeError(f"CalDAV PUT failed for new event: {e}") from e
        logger.info(
            f"[caldav-writer] created event uid={ical_uid} "
            f"summary={summary!r} calendar={cal.name!r}"
        )
        return {
            "action": "created",
            "ical_uid": ical_uid,
            "calendar_name": str(cal.name) if cal.name else None,
            "dtstart_iso": dtstart_utc.isoformat(),
            "dtend_iso": dtend_utc.isoformat(),
        }

    def update_event(
        self,
        *,
        ical_uid: str,
        summary: Optional[str] = None,
        dtstart_utc: Optional[datetime] = None,
        dtend_utc: Optional[datetime] = None,
        location: Optional[str] = None,
        description: Optional[str] = None,
        attendees: Any = _UNSET,
        status: Optional[str] = None,
        calendar_name: Optional[str] = None,
        sequence_bump: bool = True,
    ) -> Dict[str, Any]:
        """CalDAV PUT update 现有 event. 不传的字段保留原值.

        策略: 把原 VEVENT 字段 (含 attendees + RRULE + EXDATE + RDATE +
        RECURRENCE-ID) 读出, 修改后整体 PUT (CalDAV PUT 全替换语义).

        attendees 语义 (F3 修复):
        - **省略** (默认 ``_UNSET``) → **保留**原 attendees (新行为, 数据安全)
        - 显式 ``[]`` → 清空 attendees (caller 明确意图)
        - 显式 ``[{...}]`` → 替换

        老代码 ``attendees=None`` 默认值, 不传时 build_vevent 不输出 ATTENDEE
        行, PUT 全替换语义把 Exchange 端**原 attendees 全部清空** → 静默数据
        损坏. F3 用 sentinel 关闭这个洞.

        Returns:
            ``{action, ical_uid, calendar_name, dtstart_iso, dtend_iso, sequence}``

        Raises:
            ValueError: UID not found
        """
        cal, evt = self._find_event_by_uid(ical_uid, calendar_name)
        if evt is None:
            raise ValueError(f"event not found by UID: {ical_uid!r}")

        # 解析原 vobject 拿 fallback 值
        v = evt.vobject_instance.vevent
        orig_summary = (
            v.summary.value if hasattr(v, "summary") and v.summary else ""
        )
        orig_dtstart = v.dtstart.value if hasattr(v, "dtstart") else None
        orig_dtend = v.dtend.value if hasattr(v, "dtend") else orig_dtstart
        orig_location = (
            v.location.value if hasattr(v, "location") and v.location else None
        )
        orig_description = (
            v.description.value
            if hasattr(v, "description") and v.description else None
        )
        orig_sequence = int(
            v.sequence.value if hasattr(v, "sequence") and v.sequence else 0
        )
        orig_status = (
            v.status.value if hasattr(v, "status") and v.status else "CONFIRMED"
        )
        # F3 — attendees + recurrence 相关字段透传
        orig_attendees = _extract_attendees_from_vevent(v)
        orig_rrule = (
            v.rrule.value if hasattr(v, "rrule") and v.rrule else None
        )
        orig_exdates = _extract_datetimes_from_vevent_field(v, "exdate")
        orig_rdates = _extract_datetimes_from_vevent_field(v, "rdate")
        orig_recurrence_id_raw = (
            v.recurrence_id.value
            if hasattr(v, "recurrence_id") and v.recurrence_id else None
        )
        orig_recurrence_id = (
            _to_utc(orig_recurrence_id_raw) if orig_recurrence_id_raw is not None else None
        )

        # 合并 — 显式 None = 保留 (绝大多数 Optional 字段), 显式值 = 覆盖
        new_summary = summary if summary is not None else orig_summary
        new_dtstart = dtstart_utc if dtstart_utc is not None else _to_utc(orig_dtstart)
        new_dtend = dtend_utc if dtend_utc is not None else _to_utc(orig_dtend)
        new_location = location if location is not None else orig_location
        new_description = description if description is not None else orig_description
        new_status = status if status is not None else orig_status
        new_sequence = orig_sequence + 1 if sequence_bump else orig_sequence
        # attendees 用 sentinel 区分 "省略保留" vs "显式 [] 清空"
        new_attendees = orig_attendees if attendees is _UNSET else (attendees or [])

        body = build_vevent(
            ical_uid=ical_uid,
            summary=new_summary,
            dtstart_utc=new_dtstart,
            dtend_utc=new_dtend,
            organizer_email=self.user,
            location=new_location,
            description=new_description,
            attendees=new_attendees,
            sequence=new_sequence,
            status=new_status,
            # F3 — recurring event 透传 RRULE/EXDATE/RDATE/RECURRENCE-ID
            rrule=orig_rrule,
            exdates=orig_exdates,
            rdates=orig_rdates,
            recurrence_id=orig_recurrence_id,
        )
        evt.data = body
        try:
            evt.save()
        except Exception as e:
            raise RuntimeError(f"CalDAV PUT failed for update {ical_uid!r}: {e}") from e
        logger.info(
            f"[caldav-writer] updated event uid={ical_uid} "
            f"sequence={new_sequence} calendar={cal.name!r}"
        )
        return {
            "action": "updated",
            "ical_uid": ical_uid,
            "calendar_name": str(cal.name) if cal.name else None,
            "dtstart_iso": new_dtstart.isoformat(),
            "dtend_iso": new_dtend.isoformat(),
            "sequence": new_sequence,
        }

    def delete_event(
        self,
        *,
        ical_uid: str,
        calendar_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """CalDAV DELETE 删除 event.

        Returns:
            ``{action: 'deleted', ical_uid, calendar_name}``

        Raises:
            ValueError: UID not found
        """
        cal, evt = self._find_event_by_uid(ical_uid, calendar_name)
        if evt is None:
            raise ValueError(f"event not found by UID: {ical_uid!r}")
        try:
            evt.delete()
        except Exception as e:
            raise RuntimeError(f"CalDAV DELETE failed for {ical_uid!r}: {e}") from e
        logger.info(
            f"[caldav-writer] deleted event uid={ical_uid} calendar={cal.name!r}"
        )
        return {
            "action": "deleted",
            "ical_uid": ical_uid,
            "calendar_name": str(cal.name) if cal.name else None,
        }


def _to_utc(dt: Any) -> datetime:
    """Helper: vobject 解析出的 dtstart/dtend 可能是 datetime 或 date; 归一 UTC datetime."""
    from datetime import date as _date
    if isinstance(dt, datetime):
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    if isinstance(dt, _date):
        return datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc)
    raise TypeError(f"can't convert {type(dt).__name__} to UTC datetime: {dt!r}")

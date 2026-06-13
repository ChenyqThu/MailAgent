"""Search Query DSL v1 parser.

本模块只做 query string → 结构化查询的宽容解析，以及字段过滤器的
参数化 SQL 谓词生成。FTS5 文本片段最终如何套用 CJK smart transform，
由 ``email_repository`` 负责，避免和既有搜索实现形成循环依赖。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
import re
from typing import Any, Literal, Optional


@dataclass(frozen=True)
class TextTerm:
    """一个全文检索 unit。"""

    value: str
    is_phrase: bool = False
    force_quoted: bool = False


@dataclass(frozen=True)
class FilterPredicate:
    """参数化 SQL 谓词片段。

    ``sql`` 只包含占位符，参数全部放在 ``params``。片段默认使用
    ``email_metadata`` 的别名 ``m``。
    """

    sql: str
    params: tuple[Any, ...] = ()


@dataclass
class ParsedSearchQuery:
    """Search Query DSL v1 的解析结果。"""

    original_query: str
    fts_terms: list[TextTerm] = field(default_factory=list)
    fts_or_groups: list[list[TextTerm]] = field(default_factory=list)
    neg_fts_terms: list[TextTerm] = field(default_factory=list)
    filters: list[FilterPredicate] = field(default_factory=list)
    or_filter_groups: list[list[FilterPredicate]] = field(default_factory=list)
    neg_filters: list[FilterPredicate] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    is_plain_passthrough: bool = False


@dataclass(frozen=True)
class _Unit:
    kind: Literal["text", "filter"]
    value: TextTerm | FilterPredicate
    negated: bool = False


_FIELD_RE = re.compile(r"^([A-Za-z_]+):(.*)$")
_DATE_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_RELATIVE_RE = re.compile(r"^([1-9]\d*)([dwmy])$", re.IGNORECASE)

_FIELD_ALIASES: dict[str, str] = {
    "from": "from",
    "to": "to",
    "cc": "cc",
    "subject": "subject",
    "mailbox": "mailbox",
    "in": "mailbox",
    "after": "after",
    "since": "after",
    "before": "before",
    "until": "before",
    "date": "date",
    "on": "date",
    "newer_than": "newer_than",
    "older_than": "older_than",
    "is": "is",
    "has": "has",
    "priority": "priority",
}

_MAILBOX_ALIASES: dict[str, str] = {
    "inbox": "收件箱",
    "sent": "发件箱",
    "archive": "存档",
    "drafts": "草稿箱",
}

_IS_FILTERS: dict[str, FilterPredicate] = {
    "read": FilterPredicate("COALESCE(m.is_read, 0) = ?", (1,)),
    "unread": FilterPredicate("COALESCE(m.is_read, 0) = ?", (0,)),
    "flagged": FilterPredicate("COALESCE(m.is_flagged, 0) = ?", (1,)),
    "unflagged": FilterPredicate("COALESCE(m.is_flagged, 0) = ?", (0,)),
    "pinned": FilterPredicate("COALESCE(m.is_pinned, 0) = ?", (1,)),
    "important": FilterPredicate("COALESCE(m.is_important, 0) = ?", (1,)),
}

_PRIORITY_ALIASES: dict[str, str] = {
    "urgent": "紧急",
    "紧急": "紧急",
    "important": "重要",
    "重要": "重要",
    "normal": "一般",
    "一般": "一般",
    "low": "低",
    "低": "低",
}


def parse_search_query(
    query: str,
    *,
    now: Optional[datetime | str] = None,
    tz_offset_minutes: Optional[int] = None,
) -> ParsedSearchQuery:
    """解析 Search Query DSL v1。

    Parser 永不抛异常；无法理解的输入最多退化为普通文本搜索。
    """

    original_query = query or ""
    try:
        local_tz = _local_timezone(tz_offset_minutes)
        now_dt = _coerce_now(now, local_tz)
        tokens, warnings = _tokenize(original_query)
        parsed = ParsedSearchQuery(original_query=original_query, warnings=warnings)
        if not tokens:
            parsed.is_plain_passthrough = True
            return parsed

        elements: list[_Unit | str] = []
        saw_syntax = False
        for token in tokens:
            if token == "OR":
                elements.append("OR")
                saw_syntax = True
                continue
            unit, token_saw_syntax = _classify_token(
                token,
                warnings=parsed.warnings,
                now_dt=now_dt,
                local_tz=local_tz,
            )
            saw_syntax = saw_syntax or token_saw_syntax
            if unit is not None:
                elements.append(unit)

        _apply_or_groups(elements, parsed)
        parsed.is_plain_passthrough = _is_plain_passthrough(parsed, saw_syntax)
        return parsed
    except Exception:
        return ParsedSearchQuery(
            original_query=original_query,
            fts_terms=[TextTerm(original_query)] if original_query else [],
            warnings=["parse_error"],
            is_plain_passthrough=True,
        )


def build_structured_filter_predicates(
    *,
    mailbox: Optional[str] = None,
    since_date: Optional[str] = None,
    until_date: Optional[str] = None,
    now: Optional[datetime | str] = None,
    tz_offset_minutes: Optional[int] = None,
) -> tuple[list[FilterPredicate], list[str]]:
    """把旧入口的结构化参数编译成和 DSL 相同的谓词。"""

    warnings: list[str] = []
    predicates: list[FilterPredicate] = []
    local_tz = _local_timezone(tz_offset_minutes)
    _coerce_now(now, local_tz)  # 保持 now 注入校验路径一致；当前结构化参数不用它。

    if mailbox:
        predicates.append(FilterPredicate("m.mailbox = ?", (mailbox,)))
    if since_date:
        pred = _date_predicate("after", since_date, warnings, local_tz)
        if pred is not None:
            predicates.append(pred)
    if until_date:
        pred = _date_predicate("before", until_date, warnings, local_tz)
        if pred is not None:
            predicates.append(pred)
    return predicates, warnings


def escape_like_value(value: str) -> str:
    """转义 LIKE pattern 中的通配符。"""

    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _tokenize(query: str) -> tuple[list[str], list[str]]:
    tokens: list[str] = []
    warnings: list[str] = []
    buf: list[str] = []
    in_quote = False

    for c in query:
        if c == '"':
            in_quote = not in_quote
            buf.append(c)
            continue
        if c.isspace() and not in_quote:
            if buf:
                tokens.append("".join(buf))
                buf = []
            continue
        buf.append(c)

    if buf:
        tokens.append("".join(buf))

    if in_quote:
        warnings.append("unclosed_quote")
        return query.split(), warnings
    return tokens, warnings


def _classify_token(
    token: str,
    *,
    warnings: list[str],
    now_dt: datetime,
    local_tz: timezone,
) -> tuple[Optional[_Unit], bool]:
    negated = False
    body = token
    saw_syntax = False
    if body.startswith("-") and len(body) > 1:
        negated = True
        body = body[1:]
        saw_syntax = True

    field_match = _FIELD_RE.match(body)
    if field_match:
        field_name = field_match.group(1).lower()
        raw_value = field_match.group(2)
        canonical = _FIELD_ALIASES.get(field_name)
        if canonical is None:
            return _Unit(
                "text",
                TextTerm(body, force_quoted=True),
                negated=negated,
            ), True

        saw_syntax = True
        value = _strip_outer_quotes(raw_value)
        if value == "":
            warnings.append(f"empty_value:{field_name}")
            return None, saw_syntax
        predicate = _build_filter_predicate(
            canonical,
            value,
            warnings=warnings,
            now_dt=now_dt,
            local_tz=local_tz,
        )
        if predicate is None:
            return None, saw_syntax
        return _Unit("filter", predicate, negated=negated), saw_syntax

    if _is_quoted(body):
        value = _strip_outer_quotes(body)
        if value == "":
            warnings.append("empty_text")
            return None, saw_syntax
        return _Unit("text", TextTerm(value, is_phrase=True), negated=negated), saw_syntax

    return _Unit("text", TextTerm(body), negated=negated), saw_syntax


def _apply_or_groups(elements: list[_Unit | str], parsed: ParsedSearchQuery) -> None:
    i = 0
    while i < len(elements):
        element = elements[i]
        if element == "OR":
            parsed.warnings.append("dangling_or")
            i += 1
            continue

        assert isinstance(element, _Unit)
        if i + 1 < len(elements) and elements[i + 1] == "OR":
            chain = [element]
            j = i
            dangling = False
            while j + 1 < len(elements) and elements[j + 1] == "OR":
                if j + 2 >= len(elements) or elements[j + 2] == "OR":
                    dangling = True
                    j += 1
                    break
                rhs = elements[j + 2]
                assert isinstance(rhs, _Unit)
                chain.append(rhs)
                j += 2

            invalid_reason = _or_invalid_reason(chain)
            if dangling:
                parsed.warnings.append("dangling_or")
            if invalid_reason is not None:
                parsed.warnings.append(invalid_reason)
                for unit in chain:
                    _append_unit(parsed, unit)
            elif chain[0].kind == "text":
                parsed.fts_or_groups.append([
                    unit.value for unit in chain if isinstance(unit.value, TextTerm)
                ])
            else:
                parsed.or_filter_groups.append([
                    unit.value for unit in chain if isinstance(unit.value, FilterPredicate)
                ])
            i = j + 1
            continue

        _append_unit(parsed, element)
        i += 1


def _or_invalid_reason(chain: list[_Unit]) -> Optional[str]:
    if any(unit.negated for unit in chain):
        return "unsupported_or:negated"
    first_kind = chain[0].kind
    if any(unit.kind != first_kind for unit in chain):
        return "unsupported_or:cross_class"
    return None


def _append_unit(parsed: ParsedSearchQuery, unit: _Unit) -> None:
    if unit.kind == "text":
        term = unit.value
        assert isinstance(term, TextTerm)
        if unit.negated:
            parsed.neg_fts_terms.append(term)
        else:
            parsed.fts_terms.append(term)
        return

    predicate = unit.value
    assert isinstance(predicate, FilterPredicate)
    if unit.negated:
        parsed.neg_filters.append(predicate)
    else:
        parsed.filters.append(predicate)


def _is_plain_passthrough(parsed: ParsedSearchQuery, saw_syntax: bool) -> bool:
    return (
        not saw_syntax
        and not parsed.filters
        and not parsed.or_filter_groups
        and not parsed.neg_filters
        and not parsed.fts_or_groups
        and not parsed.neg_fts_terms
    )


def _build_filter_predicate(
    field: str,
    value: str,
    *,
    warnings: list[str],
    now_dt: datetime,
    local_tz: timezone,
) -> Optional[FilterPredicate]:
    if field == "from":
        pattern = _like_pattern(value)
        return FilterPredicate(
            "(COALESCE(m.sender, '') LIKE ? ESCAPE '\\' "
            "OR COALESCE(m.sender_name, '') LIKE ? ESCAPE '\\')",
            (pattern, pattern),
        )
    if field == "to":
        return _like_predicate("m.to_addr", value)
    if field == "cc":
        return _like_predicate("m.cc_addr", value)
    if field == "subject":
        return _like_predicate("m.subject", value)
    if field == "mailbox":
        mailbox_value = _MAILBOX_ALIASES.get(value.lower(), value)
        return _like_predicate("m.mailbox", mailbox_value)
    if field in ("after", "before"):
        return _date_predicate(field, value, warnings, local_tz)
    if field == "date":
        start = _coerce_search_datetime(value, local_tz, end_of_day=False)
        end = _coerce_search_datetime(value, local_tz, end_of_day=True)
        if start is None or end is None:
            warnings.append(f"invalid_date:{field}:{value}")
            return None
        return FilterPredicate(
            "datetime(m.date_received) >= datetime(?) "
            "AND datetime(m.date_received) < datetime(?)",
            (_to_utc_sqlite_value(start), _to_utc_sqlite_value(end)),
        )
    if field in ("newer_than", "older_than"):
        return _relative_date_predicate(field, value, warnings, now_dt)
    if field == "is":
        predicate = _IS_FILTERS.get(value.lower())
        if predicate is None:
            warnings.append(f"unknown_value:is:{value}")
        return predicate
    if field == "has":
        if value.lower() != "attachment":
            warnings.append(f"unknown_value:has:{value}")
            return None
        return FilterPredicate(
            "EXISTS (SELECT 1 FROM email_attachment a "
            "WHERE a.internal_id = m.internal_id AND COALESCE(a.is_inline, 0) = 0)"
        )
    if field == "priority":
        return _like_predicate("m.ai_priority", _PRIORITY_ALIASES.get(value.lower(), value))
    return None


def _like_predicate(column: str, value: str) -> FilterPredicate:
    return FilterPredicate(
        f"COALESCE({column}, '') LIKE ? ESCAPE '\\'",
        (_like_pattern(value),),
    )


def _like_pattern(value: str) -> str:
    return f"%{escape_like_value(value)}%"


def _date_predicate(
    field: str,
    value: str,
    warnings: list[str],
    local_tz: timezone,
) -> Optional[FilterPredicate]:
    dt = _coerce_search_datetime(value, local_tz, end_of_day=(field == "before"))
    if dt is None:
        warnings.append(f"invalid_date:{field}:{value}")
        return None
    op = ">=" if field == "after" else "<"
    return FilterPredicate(
        f"datetime(m.date_received) {op} datetime(?)",
        (_to_utc_sqlite_value(dt),),
    )


def _relative_date_predicate(
    field: str,
    value: str,
    warnings: list[str],
    now_dt: datetime,
) -> Optional[FilterPredicate]:
    match = _RELATIVE_RE.match(value)
    if not match:
        warnings.append(f"invalid_relative_date:{field}:{value}")
        return None
    count = int(match.group(1))
    unit = match.group(2).lower()
    days_by_unit = {"d": 1, "w": 7, "m": 30, "y": 365}
    threshold = now_dt - timedelta(days=count * days_by_unit[unit])
    op = ">=" if field == "newer_than" else "<"
    return FilterPredicate(
        f"datetime(m.date_received) {op} datetime(?)",
        (_to_utc_sqlite_value(threshold),),
    )


def _coerce_search_datetime(
    value: str,
    local_tz: timezone,
    *,
    end_of_day: bool,
) -> Optional[datetime]:
    raw = value.strip()
    try:
        if _DATE_ONLY_RE.match(raw):
            d = date.fromisoformat(raw)
            dt = datetime.combine(d, time.min, tzinfo=local_tz)
            if end_of_day:
                dt += timedelta(days=1)
            return dt

        normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
        dt = datetime.fromisoformat(normalized)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=local_tz)
        return dt
    except ValueError:
        return None


def _coerce_now(now: Optional[datetime | str], local_tz: timezone) -> datetime:
    if now is None:
        return datetime.now(local_tz)
    if isinstance(now, datetime):
        return now.replace(tzinfo=local_tz) if now.tzinfo is None else now.astimezone(local_tz)
    coerced = _coerce_search_datetime(str(now), local_tz, end_of_day=False)
    return coerced.astimezone(local_tz) if coerced is not None else datetime.now(local_tz)


def _local_timezone(tz_offset_minutes: Optional[int]) -> timezone:
    if tz_offset_minutes is not None:
        return timezone(timedelta(minutes=tz_offset_minutes))
    offset = datetime.now().astimezone().utcoffset()
    return timezone(offset or timedelta())


def _to_utc_sqlite_value(dt: datetime) -> str:
    aware = dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
    return aware.astimezone(timezone.utc).isoformat(timespec="seconds")


def _is_quoted(value: str) -> bool:
    return len(value) >= 2 and value[0] == '"' and value[-1] == '"'


def _strip_outer_quotes(value: str) -> str:
    if _is_quoted(value):
        return value[1:-1]
    return value


from __future__ import annotations

from src.repository.search_query import (
    TextTerm,
    _tokenize,
    escape_like_value,
    parse_search_query,
)


def test_tokenize_keeps_quoted_spaces():
    tokens, warnings = _tokenize('from:"Alice Zhang" "weekly report" redis')

    assert tokens == ['from:"Alice Zhang"', '"weekly report"', "redis"]
    assert warnings == []


def test_unclosed_quote_warns_and_splits_plainly():
    tokens, warnings = _tokenize('"weekly report')

    assert tokens == ['"weekly', "report"]
    assert warnings == ["unclosed_quote"]


def test_plain_text_query_is_fast_path_passthrough():
    parsed = parse_search_query("redis timeout")

    assert parsed.is_plain_passthrough is True
    assert parsed.fts_terms == [TextTerm("redis"), TextTerm("timeout")]


def test_quoted_field_value_and_text_term():
    parsed = parse_search_query('from:"Alice Zhang" redis')

    assert parsed.is_plain_passthrough is False
    assert parsed.fts_terms == [TextTerm("redis")]
    assert len(parsed.filters) == 1
    assert parsed.filters[0].params == ("%Alice Zhang%", "%Alice Zhang%")


def test_negative_field_and_phrase_terms():
    parsed = parse_search_query('-from:noreply -"weekly report"')

    assert parsed.neg_filters[0].params == ("%noreply%", "%noreply%")
    assert parsed.neg_fts_terms == [TextTerm("weekly report", is_phrase=True)]


def test_or_groups_field_and_text():
    field_parsed = parse_search_query("from:alice OR from:bob")
    text_parsed = parse_search_query("redis OR timeout")

    assert len(field_parsed.or_filter_groups) == 1
    assert [p.params[0] for p in field_parsed.or_filter_groups[0]] == ["%alice%", "%bob%"]
    assert text_parsed.fts_or_groups == [[TextTerm("redis"), TextTerm("timeout")]]


def test_cross_class_or_downgrades_to_and_with_warning():
    parsed = parse_search_query("from:alice OR redis")

    assert parsed.warnings == ["unsupported_or:cross_class"]
    assert len(parsed.filters) == 1
    assert parsed.fts_terms == [TextTerm("redis")]


def test_unknown_field_downgrades_to_quoted_text_compile_path():
    parsed = parse_search_query("foo:bar")

    assert parsed.is_plain_passthrough is False
    assert parsed.fts_terms == [TextTerm("foo:bar", force_quoted=True)]
    assert parsed.warnings == []


def test_empty_and_unknown_values_warn_and_drop():
    empty = parse_search_query("from:")
    unknown_is = parse_search_query("is:archived")

    assert empty.filters == []
    assert empty.warnings == ["empty_value:from"]
    assert unknown_is.filters == []
    assert unknown_is.warnings == ["unknown_value:is:archived"]


def test_date_only_values_are_local_day_boundaries_in_utc():
    parsed = parse_search_query(
        "after:2026-06-01 before:2026-06-01",
        now="2026-06-13T12:00:00",
        tz_offset_minutes=480,
    )

    assert parsed.filters[0].params == ("2026-05-31T16:00:00+00:00",)
    assert parsed.filters[1].params == ("2026-06-01T16:00:00+00:00",)


def test_relative_date_uses_injected_now_and_timezone():
    parsed = parse_search_query(
        "newer_than:7d",
        now="2026-06-13T12:00:00",
        tz_offset_minutes=480,
    )

    assert parsed.filters[0].params == ("2026-06-06T04:00:00+00:00",)


def test_relative_date_invalid_unit_warns_and_drops():
    # 'n' 不是合法单位（review 修掉 regex 多余的 n，防 days_by_unit KeyError
    # 把整个 query 炸回 passthrough）；非法单位应只丢弃该 token + warning。
    parsed = parse_search_query("newer_than:7n redis")

    assert parsed.filters == []
    assert parsed.warnings == ["invalid_relative_date:newer_than:7n"]
    assert [t.value for t in parsed.fts_terms] == ["redis"]


def test_like_escape_and_parameterization_for_injection_payload():
    payload = "x%' OR 1=1 --_"
    parsed = parse_search_query(f'subject:"{payload}"')
    predicate = parsed.filters[0]

    assert payload not in predicate.sql
    assert "?" in predicate.sql
    assert predicate.params == (f"%{escape_like_value(payload)}%",)
    assert predicate.params[0] == "%x\\%' OR 1=1 --\\_%"

"""Tests for md_to_rich_text conversion (no network)."""

from src.llm_agent.md_to_rich_text import md_to_rich_text


def test_empty():
    assert md_to_rich_text("") == []


def test_plain():
    out = md_to_rich_text("hello")
    assert out == [{"type": "text", "text": {"content": "hello"}}]


def test_bold():
    out = md_to_rich_text("**bold**")
    assert len(out) == 1
    assert out[0]["text"]["content"] == "bold"
    assert out[0]["annotations"]["bold"] is True


def test_italic_star():
    out = md_to_rich_text("*italic*")
    assert out[0]["annotations"].get("italic") is True


def test_italic_underscore():
    out = md_to_rich_text("_italic_")
    assert out[0]["annotations"].get("italic") is True


def test_strike():
    out = md_to_rich_text("~~strike~~")
    assert out[0]["annotations"].get("strikethrough") is True


def test_code():
    out = md_to_rich_text("`code`")
    assert out[0]["annotations"].get("code") is True


def test_link():
    out = md_to_rich_text("[text](https://example.com)")
    assert out[0]["text"].get("link", {}).get("url") == "https://example.com"
    assert out[0]["text"]["content"] == "text"


def test_mixed_plain_and_bold():
    out = md_to_rich_text("plain **bold** more")
    assert len(out) == 3
    assert out[0]["text"]["content"] == "plain "
    assert out[1]["annotations"]["bold"] is True
    assert out[2]["text"]["content"] == " more"


def test_signature_block_preserves_newlines():
    md = "Body\n\n----\nBest,\nLucien"
    out = md_to_rich_text(md)
    joined = "".join(x["text"]["content"] for x in out)
    assert "----\nBest,\nLucien" in joined


def test_long_text_split():
    md = "a" * 3500
    out = md_to_rich_text(md)
    assert len(out) >= 2, "long text should split into multiple segments"
    total = sum(len(x["text"]["content"]) for x in out)
    assert total == 3500


def test_list_as_plain_prefix():
    """We don't convert markdown lists to Notion list blocks (rich_text can't)."""
    md = "line 1\n- item a\n- item b"
    out = md_to_rich_text(md)
    joined = "".join(x["text"]["content"] for x in out)
    assert "- item a" in joined
    assert "- item b" in joined


def test_code_inline_only_no_block():
    """Single backticks only; triple backticks are intentionally unsupported."""
    out = md_to_rich_text("inline `x` then `y`")
    codes = [x for x in out if x.get("annotations", {}).get("code")]
    assert len(codes) == 2

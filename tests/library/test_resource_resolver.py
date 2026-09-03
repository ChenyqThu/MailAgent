"""闸 — matters ← library 的存在性 / 摘要回调。

这道回调唯一的作用是挡住模型编造的 file id（`resource_proposal` 会拿它验提案），
所以「读不到就放行」等于把它整条关掉。本文件钉住三件事：不存在 → None、
`status != 'present'` → None、`with_text=False` 一支**不读正文**。
"""

from __future__ import annotations

import pytest

from src.library.resource_resolver import _frontmatter_summary, make_library_file_resolver


class _FakeService:
    def __init__(self, rows, text=""):
        self._rows = rows
        self._text = text
        self.file_text_calls = 0

    def files(self, file_ids):
        return [r for r in self._rows if r["id"] in file_ids]

    def file_text(self, file_id, *, max_bytes=None):
        self.file_text_calls += 1
        return {"markdown": self._text}


def _resolver(svc):
    return make_library_file_resolver(lambda: svc)


def test_missing_row_resolves_to_none():
    assert _resolver(_FakeService([]))(7) is None


@pytest.mark.parametrize("status", ["missing", "trashed"])
def test_non_present_status_resolves_to_none(status):
    svc = _FakeService([{"id": 7, "status": status}])
    assert _resolver(svc)(7) is None


def test_present_row_resolves_and_does_not_read_body_without_with_text():
    svc = _FakeService([{"id": 7, "status": "present", "filename": "a.md"}], text="正文")
    out = _resolver(svc)(7)
    assert out is not None and out["filename"] == "a.md"
    # 🔴 存在性判定是逐行调用的（列表投影每份资料一次），这一支绝不许读正文。
    assert svc.file_text_calls == 0
    assert "text" not in out


def test_with_text_returns_body_and_frontmatter_summary():
    svc = _FakeService(
        [{"id": 7, "status": "present"}],
        text="---\nsummary: 一句话摘要\n---\n正文若干",
    )
    out = _resolver(svc)(7, with_text=True)
    assert svc.file_text_calls == 1
    assert out["text"].endswith("正文若干")
    assert out["summary"] == "一句话摘要"


def test_extraction_failure_degrades_instead_of_raising():
    class _Boom(_FakeService):
        def file_text(self, file_id, *, max_bytes=None):
            raise RuntimeError("extractor down")

    out = _resolver(_Boom([{"id": 7, "status": "present"}]))(7, with_text=True)
    assert out is not None and out["text"] == ""


@pytest.mark.parametrize(
    "markdown,expected",
    [
        ("---\nsummary: A\n---\nx", "A"),
        ("---\ndescription: 'B'\n---\nx", "B"),
        ("---\ntitle: T\n---\nx", None),
        ("没有 frontmatter", None),
        ("---\nsummary: A\n还没闭合", None),
        ("---\nsummary:\n---\nx", None),
    ],
)
def test_frontmatter_summary_shapes(markdown, expected):
    assert _frontmatter_summary(markdown) == expected

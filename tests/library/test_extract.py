"""按需抽取：kind 映射 / 白名单纯文本变体与 html 的就地读取 / placeholder 不抽 / source_hash 过期重抽。"""

from __future__ import annotations

import os

import pytest

from src.library.extract import initial_text_status, kind_for_filename
from src.library.service import LibraryService


@pytest.mark.parametrize(
    "name, kind",
    [
        ("a.md", "markdown"), ("a.markdown", "markdown"), ("a.HTML", "html"), ("a.htm", "html"), ("a.pdf", "pdf"),
        ("a.docx", "office"), ("a.pptx", "office"), ("a.xlsx", "office"), ("a.doc", "office"),
        ("a.png", "image"), ("a.jpeg", "image"), ("a.txt", "text"), ("a.csv", "text"), ("a.json", "text"),
        ("a.yaml", "text"), ("a.numbers.icloud", "placeholder"), ("a.zip", "other"), ("noext", "other"),
    ],
)
def test_kind_for_filename(name: str, kind: str) -> None:
    assert kind_for_filename(name) == kind


def test_initial_text_status() -> None:
    assert initial_text_status("markdown") == "pending"
    assert initial_text_status("pdf") == "pending"
    assert initial_text_status("other") == "unsupported"
    assert initial_text_status("placeholder") == "unsupported"


@pytest.fixture()
def svc(tmp_path) -> LibraryService:
    return LibraryService(str(tmp_path / "library.db"), str(tmp_path / "library"))


def test_text_fallbacks_for_allowlisted_variants_and_html(svc: LibraryService) -> None:
    md = svc.create_file("agent-docs/n.markdown", b"# Title\n\nbody words")
    js = svc.create_file("agent-docs/d.json", b'{"key": "needle-json"}')
    html = svc.create_file("agent-docs/p.html", b"<html><body><h1>Head</h1><p>needle html</p><script>x()</script></body></html>")
    t_md = svc.file_text(md["id"])
    assert t_md["text_status"] == "extracted" and t_md["extractor"] == "plaintext" and "body words" in t_md["markdown"]
    t_js = svc.file_text(js["id"])
    assert t_js["extractor"] == "plaintext" and "needle-json" in t_js["markdown"]
    t_html = svc.file_text(html["id"])
    assert t_html["extractor"] == "html" and "needle html" in t_html["markdown"] and "x()" not in t_html["markdown"]
    assert [h["id"] for h in svc.search("needle-json")["hits"]] == [js["id"]]


def test_placeholder_and_binary_are_not_extracted(svc: LibraryService) -> None:
    ph = svc.create_file("my-docs/big.numbers.icloud", b"")
    assert ph["kind"] == "placeholder" and ph["text_status"] == "unsupported"
    t = svc.file_text(ph["id"])
    assert t["markdown"] is None and t["text_status"] == "unsupported"
    binary = svc.create_file("my-docs/blob.zip", b"PK\x03\x04junk")
    t = svc.file_text(binary["id"])
    assert t["markdown"] is None and t["text_status"] == "unsupported"


def test_stale_source_hash_triggers_re_extraction(svc: LibraryService) -> None:
    f = svc.create_file("my-docs/s.md", b"first version")
    t1 = svc.file_text(f["id"])
    assert t1["source_hash"] == f["content_hash"] and t1["stale"] is False
    path = os.path.join(svc.root_path, "my-docs", "s.md")
    with open(path, "w") as fh:
        fh.write("second version")
    os.utime(path, (f["mtime"] + 100, f["mtime"] + 100))
    t2 = svc.file_text(f["id"])
    assert t2["markdown"] == "second version" and t2["source_hash"] == t2["content_hash"] and t2["stale"] is False
    assert t2["source_hash"] != t1["source_hash"]
    assert [h["id"] for h in svc.search("second version")["hits"]] == [f["id"]]
    assert svc.search("first version")["hits"] == []

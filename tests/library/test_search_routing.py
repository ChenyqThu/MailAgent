"""搜索路由的四条 CJK 纪律 + 两表 snippet（design §9.1，照抄邮件核）。"""

from __future__ import annotations

import pytest

from src.library.db import LibraryDb
from src.library.repository import LibraryRepository

_DOCS = {
    # id: (rel_path, text, mtime)
    1: ("my-docs/ops.md", "redis timeout review for the cache cluster", 10.0),
    2: ("my-docs/周报.md", "本周完成 研发项目deadline汇报 与 排期", 20.0),
    3: ("my-docs/kafka-notes.md", "lag investigation on consumer group", 30.0),
    4: ("my-docs/汇报模板.md", "空模板", 40.0),
    5: ("my-docs/gone.md", "redis leftovers", 50.0),  # trashed → 不出结果
}


@pytest.fixture()
def repo(tmp_path) -> LibraryRepository:
    repo = LibraryRepository(LibraryDb(str(tmp_path / "library.db")))
    with repo.db.transaction() as conn:
        for fid, (rel, text, mtime) in _DOCS.items():
            parent, _, name = rel.rpartition("/")
            repo.insert_file(
                conn, id=fid, mount_id=0, rel_path=rel, rel_key=rel.casefold(), parent_path=parent, filename=name,
                kind="markdown", size_bytes=len(text), mtime=mtime, content_hash=f"h{fid}", source="user",
                status="trashed" if fid == 5 else "present", text_status="extracted", created_at=1.0, updated_at=1.0,
            )
            repo.upsert_text(conn, fid, filename=name, text=text, extractor="plaintext", source_hash=f"h{fid}", truncated=False)
    return repo


def _ids(result) -> list[int]:
    return [h["id"] for h in result.hits]


def test_single_cjk_char_is_intercepted_with_warning(repo: LibraryRepository) -> None:
    conn = repo.db.connect()
    try:
        r = repo.search(conn, "研")
        assert r.hits == [] and r.warnings == ["cjk_too_short:研"] and r.mode == "too_short"
    finally:
        conn.close()


def test_two_chars_go_like_without_bm25_ordered_by_mtime(repo: LibraryRepository) -> None:
    conn = repo.db.connect()
    try:
        r = repo.search(conn, "汇报")
        assert r.mode == "like"
        assert _ids(r) == [4, 2]  # mtime 降序：40 > 20；trashed 的 5 不在
        assert all(h["rank"] is None for h in r.hits)
        assert r.hits[0]["match"] == "filename" and r.hits[1]["match"] == "text"
        assert "汇报" in r.hits[1]["snippet"]
        latin = repo.search(conn, "ka")
        assert latin.mode == "like" and _ids(latin) == [3]
    finally:
        conn.close()


def test_cjk_three_plus_chars_match_whole_string_on_trigram(repo: LibraryRepository) -> None:
    conn = repo.db.connect()
    try:
        r = repo.search(conn, "项目deadline汇报")  # CJK + latin 混合整串不拆段
        assert r.mode == "trigram" and _ids(r) == [2]
        assert isinstance(r.hits[0]["rank"], float)
        assert "[" in r.hits[0]["snippet"] and "deadline" in r.hits[0]["snippet"]
        by_name = repo.search(conn, "汇报模")
        assert by_name.mode == "trigram" and _ids(by_name) == [4]
        assert by_name.hits[0]["match"] == "filename"
    finally:
        conn.close()


def test_latin_goes_porter_with_filename_weight_and_snippet(repo: LibraryRepository) -> None:
    conn = repo.db.connect()
    try:
        r = repo.search(conn, "redis timeout")
        assert r.mode == "porter" and _ids(r) == [1]  # trashed 5 排除
        # 整串是一个短语 → snippet 把整个短语一起高亮
        assert isinstance(r.hits[0]["rank"], float) and "[redis timeout]" in r.hits[0]["snippet"]
        by_name = repo.search(conn, "kafka")
        assert _ids(by_name) == [3] and by_name.hits[0]["match"] == "filename"
        # porter 词干：reviewing → review
        assert _ids(repo.search(conn, "reviewing")) == [1]
    finally:
        conn.close()


def test_empty_and_whitespace_queries_return_nothing(repo: LibraryRepository) -> None:
    conn = repo.db.connect()
    try:
        assert repo.search(conn, "   ").mode == "empty"
        assert repo.search(conn, "").hits == []
    finally:
        conn.close()

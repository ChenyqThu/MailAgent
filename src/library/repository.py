"""``library.db`` 的查询面 + 邮件附件投影（跨库读 ``sync_store.db``）。

只做 SQL，不做业务判断（写侧规则全在 ``service.py``）。搜索的四条 CJK 纪律照抄邮件核
（``src/repository/email_repository.py`` 的 ``_route_text_term``）与 ``matter_fts`` 的 30 行范式
（``src/matters/repository.py::_fts_query / _escape_like``）：

  ① 含 CJK 走 trigram 表；② 1 字拦截 + warning，不返结果；③ 2 字（CJK 或拉丁）走 LIKE、无 bm25、
  ``rank`` 为 None 按 mtime 排；④ ≥3 字整串 MATCH 短语，**不拆** CJK / latin 段。
  无 CJK 走 porter 表 ``bm25(library_fts, 1.0, 5.0)``（text 1.0 / filename 5.0，对齐邮件 subject 权重）。
  两表都出 ``snippet()``。

投影是**跨库读**：对 ``sync_store.db`` 开自己的短连接（与 ``EmailRepository._connect`` 同姿态），
不在 ``library.db`` 里 ATTACH。🔴 ``WHERE is_inline = 0``（不过滤 = 三万张内嵌图）；过滤参数同时匹配
文件名与「来源」列（主题 + 发件人，F4）。
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any, Optional

from src.library.constants import (
    FOLDER_PAGE_SIZE,
    HISTORY_MAX_PER_FILE,
    HISTORY_MAX_TOTAL_BYTES,
    SEARCH_RRF_K,
)
from src.library.db import LibraryDb
from src.repository.email_repository import _is_cjk_char

_FILE_COLUMNS = (
    "id", "mount_id", "rel_path", "rel_key", "parent_path", "filename", "kind", "size_bytes", "mtime",
    "content_hash", "source", "source_ref", "created_by", "status", "text_status", "created_at", "updated_at",
)
_MOUNT_COLUMNS = ("id", "label", "abs_path", "mode", "status", "added_at")

#: 文件夹排序（design §2.3 四种）；``{dir}`` 由调用方填 ASC / DESC。
FOLDER_SORTS = {
    "name": "filename COLLATE NOCASE {dir}, id ASC",
    "size": "size_bytes {dir}, filename COLLATE NOCASE ASC",
    "type": "kind {dir}, filename COLLATE NOCASE ASC",
    "date": "mtime {dir}, filename COLLATE NOCASE ASC",
}

#: 投影按月分组的表达式（``date_received`` 是 ``'YYYY-MM-DD hh:mm:ss'`` 文本；无日期落 ``unknown``）。
_PROJECTION_MONTH_SQL = "CASE WHEN m.date_received IS NULL OR m.date_received = '' THEN 'unknown' ELSE substr(m.date_received, 1, 7) END"
#: 投影行的列（列表与单行共用；``month`` 由 SQL 算，Python 侧不重复分组逻辑）。
_PROJECTION_ITEM_COLUMNS = (
    "a.id AS attachment_id, a.internal_id, a.filename, a.content_type, a.size_bytes, a.created_at,"
    " (a.local_path IS NOT NULL) AS has_file, m.subject, m.sender, m.sender_name, m.date_received,"
    f" t.status AS text_status, {_PROJECTION_MONTH_SQL} AS month"
)


@dataclass
class SearchResult:
    hits: list[dict[str, Any]]
    warnings: list[str] = field(default_factory=list)
    mode: str = "empty"  # empty | too_short | like | trigram | porter


def rrf_fuse(lanes: dict[str, list[int]], *, limit: int, k: int = SEARCH_RRF_K) -> list[tuple[int, float, str]]:
    """Reciprocal Rank Fusion：每条 lane 内按位次记 ``1/(k + pos)`` 求和。

    🔴 ``k`` 与 ``src/repository/email_repository.py::_RRF_K`` 同值（那边是 ``60.0``）—— 邮件核与资料库
    的融合口径不该分裂。返回 ``(file_id, score, lane)``，``lane`` 是 ``'fts' | 'vec' | 'both'``。
    """
    scores: dict[int, float] = {}
    seen: dict[int, set[str]] = {}
    for lane, ids in lanes.items():
        for pos, fid in enumerate(ids):
            scores[fid] = scores.get(fid, 0.0) + 1.0 / (k + pos)
            seen.setdefault(fid, set()).add(lane)
    order = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    out: list[tuple[int, float, str]] = []
    for fid, score in order[:limit]:
        marks = seen[fid]
        out.append((fid, score, "both" if len(marks) > 1 else next(iter(marks))))
    return out


def _has_cjk(value: str) -> bool:
    return any(_is_cjk_char(c) for c in value)


class LibraryRepository:
    def __init__(self, db: LibraryDb, sync_store_db_path: Optional[str] = None) -> None:
        self.db = db
        self.sync_store_db_path = sync_store_db_path

    # ── mounts ────────────────────────────────────────────────────────────────

    def list_mounts(self, conn: sqlite3.Connection, *, include_unmounted: bool = False) -> list[dict[str, Any]]:
        sql = "SELECT * FROM library_mount"
        if not include_unmounted:
            sql += " WHERE status != 'unmounted'"
        return [dict(r) for r in conn.execute(sql + " ORDER BY id ASC").fetchall()]

    def get_mount(self, conn: sqlite3.Connection, mount_id: int) -> Optional[dict[str, Any]]:
        row = conn.execute("SELECT * FROM library_mount WHERE id=?", (int(mount_id),)).fetchone()
        return dict(row) if row else None

    def get_mount_by_label(self, conn: sqlite3.Connection, label: str) -> Optional[dict[str, Any]]:
        row = conn.execute("SELECT * FROM library_mount WHERE label=?", (label,)).fetchone()
        return dict(row) if row else None

    def get_mount_by_path(self, conn: sqlite3.Connection, abs_path: str) -> Optional[dict[str, Any]]:
        row = conn.execute("SELECT * FROM library_mount WHERE abs_path=?", (abs_path,)).fetchone()
        return dict(row) if row else None

    def insert_mount(self, conn: sqlite3.Connection, *, label: str, abs_path: str, mode: str, added_at: float) -> int:
        cur = conn.execute(
            "INSERT INTO library_mount (label, abs_path, mode, status, added_at) VALUES (?, ?, ?, 'ok', ?)",
            (label, abs_path, mode, added_at),
        )
        return int(cur.lastrowid)

    def update_mount(self, conn: sqlite3.Connection, mount_id: int, **fields: Any) -> None:
        self._update("library_mount", conn, mount_id, _MOUNT_COLUMNS, fields)

    # ── files ─────────────────────────────────────────────────────────────────

    def get_file(self, conn: sqlite3.Connection, file_id: int) -> Optional[dict[str, Any]]:
        row = conn.execute("SELECT * FROM library_file WHERE id=?", (int(file_id),)).fetchone()
        return dict(row) if row else None

    def get_files(self, conn: sqlite3.Connection, file_ids: list[int]) -> list[dict[str, Any]]:
        if not file_ids:
            return []
        marks = ",".join("?" for _ in file_ids)
        rows = conn.execute(f"SELECT * FROM library_file WHERE id IN ({marks})", [int(i) for i in file_ids]).fetchall()
        return [dict(r) for r in rows]

    def get_file_by_key(self, conn: sqlite3.Connection, mount_id: int, rel_key: str) -> Optional[dict[str, Any]]:
        row = conn.execute(
            "SELECT * FROM library_file WHERE mount_id=? AND rel_key=?", (int(mount_id), rel_key)
        ).fetchone()
        return dict(row) if row else None

    def insert_file(self, conn: sqlite3.Connection, **cols: Any) -> int:
        unknown = set(cols) - set(_FILE_COLUMNS)
        if unknown:
            raise ValueError(f"unknown library_file columns: {sorted(unknown)}")
        names = list(cols)
        cur = conn.execute(
            f"INSERT INTO library_file ({', '.join(names)}) VALUES ({', '.join('?' for _ in names)})",
            [cols[n] for n in names],
        )
        return int(cur.lastrowid)

    def update_file(self, conn: sqlite3.Connection, file_id: int, **fields: Any) -> None:
        self._update("library_file", conn, file_id, _FILE_COLUMNS, fields)

    def delete_file(self, conn: sqlite3.Connection, file_id: int) -> None:
        """永久删除（purge）：行 + 历史 + 文本（FTS 由 trigger 清）。"""
        conn.execute("DELETE FROM library_history WHERE file_id=?", (int(file_id),))
        conn.execute("DELETE FROM library_chunk WHERE file_id=?", (int(file_id),))
        conn.execute("DELETE FROM library_text WHERE file_id=?", (int(file_id),))
        conn.execute("DELETE FROM library_file WHERE id=?", (int(file_id),))

    def list_folder(
        self,
        conn: sqlite3.Connection,
        mount_id: int,
        parent_path: str,
        *,
        offset: int = 0,
        limit: int = FOLDER_PAGE_SIZE,
        q: Optional[str] = None,
        sort: str = "name",
        direction: str = "asc",
    ) -> tuple[list[dict[str, Any]], int]:
        """一个文件夹里的文件行（不含 ``trashed``），服务端排序后分页（分页之后客户端只能排当前页）。"""
        if sort not in FOLDER_SORTS or direction not in ("asc", "desc"):
            raise ValueError(f"invalid sort/direction: {sort}/{direction}")
        where = "mount_id=? AND parent_path=? AND status != 'trashed'"
        params: list[Any] = [int(mount_id), parent_path]
        if q:
            where += " AND filename LIKE ? ESCAPE '\\'"
            params.append(f"%{self._escape_like(q)}%")
        total = int(conn.execute(f"SELECT COUNT(*) FROM library_file WHERE {where}", params).fetchone()[0])
        order = FOLDER_SORTS[sort].format(dir=direction.upper())
        rows = conn.execute(
            f"SELECT * FROM library_file WHERE {where} ORDER BY {order} LIMIT ? OFFSET ?",
            [*params, int(limit), int(offset)],
        ).fetchall()
        return [dict(r) for r in rows], total

    def recent_files(self, conn: sqlite3.Connection, *, limit: int = 20) -> list[dict[str, Any]]:
        """跨全部根按 mtime 取最近改动的文件（不含 trashed / missing）。

        「最近」必须跨根且不限层级——拿 ``list_folder`` 拼是错的，它按 ``parent_path`` 精确取
        直接子项，既不跨根也不递归，结果只覆盖各根顶层，用户存在子目录里的文件不会出现，
        看到的人会据此断定库里没有它。宁可少一个入口，也不给一张会撒谎的「最近」。
        """
        rows = conn.execute(
            "SELECT * FROM library_file WHERE status = 'present' "
            "ORDER BY COALESCE(mtime, updated_at) DESC LIMIT ?",
            [max(1, int(limit))],
        ).fetchall()
        return [dict(r) for r in rows]

    def folder_counts(self, conn: sqlite3.Connection) -> dict[tuple[int, str], int]:
        """每个 (mount_id, parent_path) 的 present 文件数（树节点角标一次查全）。"""
        rows = conn.execute(
            "SELECT mount_id, parent_path, COUNT(*) AS n FROM library_file WHERE status='present' GROUP BY mount_id, parent_path"
        ).fetchall()
        return {(int(r["mount_id"]), str(r["parent_path"])): int(r["n"]) for r in rows}

    def list_folder_rows(self, conn: sqlite3.Connection, mount_id: int, parent_path: str) -> list[dict[str, Any]]:
        """对账用：该文件夹的全部非 trashed 行（含 missing）。"""
        rows = conn.execute(
            "SELECT * FROM library_file WHERE mount_id=? AND parent_path=? AND status != 'trashed'",
            (int(mount_id), parent_path),
        ).fetchall()
        return [dict(r) for r in rows]

    def list_mount_rows(self, conn: sqlite3.Connection, mount_id: int) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT * FROM library_file WHERE mount_id=? AND status != 'trashed'", (int(mount_id),)
        ).fetchall()
        return [dict(r) for r in rows]

    def list_trash(
        self, conn: sqlite3.Connection, *, offset: int = 0, limit: int = FOLDER_PAGE_SIZE
    ) -> tuple[list[dict[str, Any]], int]:
        total = int(conn.execute("SELECT COUNT(*) FROM library_file WHERE status='trashed'").fetchone()[0])
        rows = conn.execute(
            "SELECT * FROM library_file WHERE status='trashed' ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
            (int(limit), int(offset)),
        ).fetchall()
        return [dict(r) for r in rows], total

    def list_trashed_rows(self, conn: sqlite3.Connection) -> list[dict[str, Any]]:
        return [dict(r) for r in conn.execute("SELECT * FROM library_file WHERE status='trashed'").fetchall()]

    def folder_paths(self, conn: sqlite3.Connection, mount_id: int) -> set[str]:
        """索引里出现过的文件夹路径（补齐磁盘扫描漏掉的 ``missing`` 行所在目录）。"""
        rows = conn.execute(
            "SELECT DISTINCT parent_path FROM library_file WHERE mount_id=? AND status != 'trashed'",
            (int(mount_id),),
        ).fetchall()
        return {str(r[0]) for r in rows}

    def count_files(self, conn: sqlite3.Connection, mount_id: Optional[int] = None) -> int:
        if mount_id is None:
            return int(conn.execute("SELECT COUNT(*) FROM library_file WHERE status='present'").fetchone()[0])
        return int(
            conn.execute(
                "SELECT COUNT(*) FROM library_file WHERE mount_id=? AND status='present'", (int(mount_id),)
            ).fetchone()[0]
        )

    def list_pending_extraction(self, conn: sqlite3.Connection, *, limit: int) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT * FROM library_file WHERE status='present' AND text_status='pending' ORDER BY id ASC LIMIT ?",
            (int(limit),),
        ).fetchall()
        return [dict(r) for r in rows]

    # ── history ───────────────────────────────────────────────────────────────

    def insert_history(
        self,
        conn: sqlite3.Connection,
        *,
        file_id: int,
        old_hash: Optional[str],
        new_hash: str,
        content_snapshot: str,
        changed_by: str,
        change_note: Optional[str],
        created_at: float,
        session_id: Optional[int] = None,
        message_id: Optional[int] = None,
    ) -> int:
        cur = conn.execute(
            "INSERT INTO library_history (file_id, old_hash, new_hash, content_snapshot, changed_by, change_note,"
            " session_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (int(file_id), old_hash, new_hash, content_snapshot, changed_by, change_note, session_id, message_id, created_at),
        )
        return int(cur.lastrowid)

    def list_history(self, conn: sqlite3.Connection, file_id: int, *, limit: int = HISTORY_MAX_PER_FILE) -> list[dict[str, Any]]:
        """不带快照正文（``snapshot_bytes`` 代替），最新在前。"""
        rows = conn.execute(
            "SELECT id, file_id, old_hash, new_hash, changed_by, change_note, session_id, message_id, created_at,"
            " length(CAST(content_snapshot AS BLOB)) AS snapshot_bytes"
            " FROM library_history WHERE file_id=? ORDER BY id DESC LIMIT ?",
            (int(file_id), int(limit)),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_history(self, conn: sqlite3.Connection, history_id: int) -> Optional[dict[str, Any]]:
        row = conn.execute("SELECT * FROM library_history WHERE id=?", (int(history_id),)).fetchone()
        return dict(row) if row else None

    def prune_history(self, conn: sqlite3.Connection, file_id: int) -> int:
        """每文件最近 ``HISTORY_MAX_PER_FILE`` 条 + 全库快照总量 ``HISTORY_MAX_TOTAL_BYTES``（超出按最旧裁）。"""
        removed = conn.execute(
            "DELETE FROM library_history WHERE file_id=? AND id NOT IN"
            " (SELECT id FROM library_history WHERE file_id=? ORDER BY id DESC LIMIT ?)",
            (int(file_id), int(file_id), HISTORY_MAX_PER_FILE),
        ).rowcount
        total = int(
            conn.execute("SELECT COALESCE(SUM(length(CAST(content_snapshot AS BLOB))), 0) FROM library_history").fetchone()[0]
        )
        excess = total - HISTORY_MAX_TOTAL_BYTES
        if excess > 0:
            victims: list[int] = []
            for row in conn.execute(
                "SELECT id, length(CAST(content_snapshot AS BLOB)) AS n FROM library_history ORDER BY id ASC"
            ).fetchall():
                if excess <= 0:
                    break
                victims.append(int(row["id"]))
                excess -= int(row["n"])
            if victims:
                marks = ",".join("?" for _ in victims)
                removed += conn.execute(f"DELETE FROM library_history WHERE id IN ({marks})", victims).rowcount
        return int(removed or 0)

    # ── text ──────────────────────────────────────────────────────────────────

    def get_text(self, conn: sqlite3.Connection, file_id: int) -> Optional[dict[str, Any]]:
        row = conn.execute("SELECT * FROM library_text WHERE file_id=?", (int(file_id),)).fetchone()
        return dict(row) if row else None

    def upsert_text(
        self,
        conn: sqlite3.Connection,
        file_id: int,
        *,
        filename: str,
        text: str,
        extractor: str,
        source_hash: str,
        truncated: bool,
        extracted_at: Optional[float] = None,
    ) -> None:
        import time

        conn.execute(
            "INSERT INTO library_text (file_id, filename, text_content, extractor, source_hash, truncated, extracted_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(file_id) DO UPDATE SET filename=excluded.filename, text_content=excluded.text_content,"
            " extractor=excluded.extractor, source_hash=excluded.source_hash, truncated=excluded.truncated,"
            " extracted_at=excluded.extracted_at",
            (int(file_id), filename, text, extractor, source_hash, 1 if truncated else 0, extracted_at or time.time()),
        )

    def delete_text(self, conn: sqlite3.Connection, file_id: int) -> None:
        conn.execute("DELETE FROM library_text WHERE file_id=?", (int(file_id),))

    # ── search ────────────────────────────────────────────────────────────────

    @staticmethod
    def _escape_like(value: str) -> str:
        return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    @staticmethod
    def _fts_query(value: str) -> str:
        return '"' + value.replace('"', '""') + '"'

    @staticmethod
    def _snippet(text: str, query: str) -> str:
        compact = " ".join(text.split())
        index = compact.lower().find(query.lower())
        start = max(0, index - 40) if index >= 0 else 0
        return compact[start:start + 120]

    def search(self, conn: sqlite3.Connection, query: str, *, limit: int = 20) -> SearchResult:
        q = " ".join(str(query or "").split())
        if not q:
            return SearchResult([], [], "empty")
        cjk = _has_cjk(q)
        if cjk and len(q) == 1:
            return SearchResult([], [f"cjk_too_short:{q}"], "too_short")
        if len(q) < 3:
            like = f"%{self._escape_like(q)}%"
            rows = conn.execute(
                "SELECT f.*, t.text_content AS _text FROM library_text t JOIN library_file f ON f.id = t.file_id"
                " WHERE f.status = 'present' AND (t.text_content LIKE ? ESCAPE '\\' OR t.filename LIKE ? ESCAPE '\\')"
                " ORDER BY f.mtime DESC, f.id DESC LIMIT ?",
                (like, like, int(limit)),
            ).fetchall()
            hits = []
            for r in rows:
                d = dict(r)
                text = str(d.pop("_text") or "")
                in_name = q.lower() in str(d["filename"]).lower()
                d["snippet"] = self._snippet(text, q) if q.lower() in text.lower() else ""
                d["rank"] = None
                d["match"] = "filename" if in_name else "text"
                hits.append(d)
            return SearchResult(hits, [], "like")
        table = "library_fts_trigram" if cjk else "library_fts"
        rank_expr = "rank" if cjk else "bm25(library_fts, 1.0, 5.0)"
        # trigram 的一个 token 只有 3 个字符，同样的 token 预算给它要放大，否则整串命中被截在中间。
        tokens = 48 if cjk else 12
        rows = conn.execute(
            f"SELECT f.*, snippet({table}, 0, '[', ']', '…', {tokens}) AS _snip_text,"
            f" snippet({table}, 1, '[', ']', '', {tokens}) AS _snip_name, {rank_expr} AS _rank"
            f" FROM {table} JOIN library_file f ON f.id = {table}.rowid"
            f" WHERE {table} MATCH ? AND f.status = 'present' ORDER BY _rank ASC, f.mtime DESC LIMIT ?",
            (self._fts_query(q), int(limit)),
        ).fetchall()
        hits = []
        for r in rows:
            d = dict(r)
            snip_text = str(d.pop("_snip_text") or "")
            snip_name = str(d.pop("_snip_name") or "")
            d["rank"] = float(d.pop("_rank"))
            d["snippet"] = snip_text if "[" in snip_text else ""
            d["match"] = "filename" if "[" in snip_name else "text"
            hits.append(d)
        return SearchResult(hits, [], "trigram" if cjk else "porter")

    # ── 向量（语义 lane，design §9.1）───────────────────────────────────────

    def chunk_vectors_by_hash(self, conn: sqlite3.Connection, file_id: int, model: str) -> dict[str, bytes]:
        """该文件已存的 ``{text_hash: vec}`` —— 重嵌时按 hash 复用，**只嵌变化的块**。"""
        rows = conn.execute(
            "SELECT text_hash, vec FROM library_chunk WHERE file_id=? AND model=?", (int(file_id), model)
        ).fetchall()
        return {str(r["text_hash"]): bytes(r["vec"]) for r in rows}

    def replace_chunks(self, conn: sqlite3.Connection, file_id: int, model: str, rows: list[dict[str, Any]]) -> None:
        """整文件替换（先删后插）。行的 idx / 偏移可能变而 hash 没变，写便宜、嵌昂贵，故不做行级 diff。"""
        conn.execute("DELETE FROM library_chunk WHERE file_id=? AND model=?", (int(file_id), model))
        if not rows:
            return
        conn.executemany(
            "INSERT INTO library_chunk (file_id, model, idx, char_start, char_end, text_hash, source_hash, vec, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (int(file_id), model, int(r["idx"]), int(r["char_start"]), int(r["char_end"]),
                 str(r["text_hash"]), str(r["source_hash"]), r["vec"], float(r["created_at"]))
                for r in rows
            ],
        )

    def delete_chunks(self, conn: sqlite3.Connection, *, file_id: Optional[int] = None, model: Optional[str] = None) -> int:
        where, params = [], []
        if file_id is not None:
            where.append("file_id=?")
            params.append(int(file_id))
        if model is not None:
            where.append("model=?")
            params.append(model)
        sql = "DELETE FROM library_chunk" + (" WHERE " + " AND ".join(where) if where else "")
        return int(conn.execute(sql, params).rowcount or 0)

    def count_chunks(self, conn: sqlite3.Connection, model: str) -> int:
        return int(conn.execute("SELECT COUNT(*) FROM library_chunk WHERE model=?", (model,)).fetchone()[0])

    def vector_signature(self, conn: sqlite3.Connection, model: str) -> tuple[int, int, float]:
        """向量矩阵的廉价指纹（进程内缓存的失效判据）：行数 + 最大 rowid + 最新写入时刻。"""
        row = conn.execute(
            "SELECT COUNT(*), COALESCE(MAX(rowid), 0), COALESCE(MAX(created_at), 0.0) FROM library_chunk WHERE model=?",
            (model,),
        ).fetchone()
        return int(row[0]), int(row[1]), float(row[2])

    def load_vectors(self, conn: sqlite3.Connection, model: str) -> tuple[list[int], list[int], list[int], list[bytes]]:
        """全量向量（只含 present 的文件）：``(file_ids, char_starts, char_ends, blobs)``，行序即矩阵行序。"""
        rows = conn.execute(
            "SELECT c.file_id, c.char_start, c.char_end, c.vec FROM library_chunk c"
            " JOIN library_file f ON f.id = c.file_id"
            " WHERE c.model=? AND f.status='present' ORDER BY c.file_id, c.idx",
            (model,),
        ).fetchall()
        return (
            [int(r["file_id"]) for r in rows],
            [int(r["char_start"]) for r in rows],
            [int(r["char_end"]) for r in rows],
            [bytes(r["vec"]) for r in rows],
        )

    #: 「按当前正文嵌过了没有」——判据是 ``library_chunk.source_hash == library_text.source_hash``。
    #: 🔴 空正文切不出块 ⇒ 永远留不下 chunk 行，不排除掉就会被每一轮重新领走（不是 sentinel 行的活）。
    _NEEDS_EMBED_WHERE = (
        " FROM library_text t JOIN library_file f ON f.id = t.file_id"
        " WHERE f.status='present' AND NOT EXISTS ("
        "   SELECT 1 FROM library_chunk c WHERE c.file_id = t.file_id AND c.model = ? AND c.source_hash = t.source_hash)"
        " AND length(trim(t.text_content)) > 0"
    )

    def files_needing_embed(self, conn: sqlite3.Connection, model: str, *, limit: int) -> list[dict[str, Any]]:
        rows = conn.execute(
            "SELECT t.file_id, t.filename, t.source_hash" + self._NEEDS_EMBED_WHERE + " ORDER BY t.file_id ASC LIMIT ?",
            (model, int(limit)),
        ).fetchall()
        return [dict(r) for r in rows]

    def count_files_needing_embed(self, conn: sqlite3.Connection, model: str) -> int:
        return int(conn.execute("SELECT COUNT(*)" + self._NEEDS_EMBED_WHERE, (model,)).fetchone()[0])

    def count_embeddable_files(self, conn: sqlite3.Connection) -> int:
        """有抽取文本的 present 文件数（索引进度的分母）。"""
        return int(
            conn.execute(
                "SELECT COUNT(*) FROM library_text t JOIN library_file f ON f.id = t.file_id"
                " WHERE f.status='present' AND length(trim(t.text_content)) > 0"
            ).fetchone()[0]
        )

    def text_snippet(self, conn: sqlite3.Connection, file_id: int, start: int, end: int, *, pad: int = 40) -> str:
        """按块偏移从 ``library_text`` 取一段（向量命中的 snippet —— FTS 那条腿没跑，snippet() 用不了）。"""
        row = conn.execute("SELECT text_content FROM library_text WHERE file_id=?", (int(file_id),)).fetchone()
        if row is None:
            return ""
        text = str(row["text_content"] or "")
        lo = max(0, int(start) - pad)
        return " ".join(text[lo:int(end)].split())[:160]

    # ── 邮件附件投影（跨库读 sync_store.db）──────────────────────────────────

    def _sync_conn(self) -> sqlite3.Connection:
        if not self.sync_store_db_path:
            raise RuntimeError("projection needs sync_store_db_path")
        conn = sqlite3.connect(str(self.sync_store_db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        return conn

    def projection_months(self) -> list[dict[str, Any]]:
        conn = self._sync_conn()
        try:
            rows = conn.execute(
                f"SELECT {_PROJECTION_MONTH_SQL} AS month, COUNT(*) AS count"
                " FROM email_attachment a LEFT JOIN email_metadata m ON m.internal_id = a.internal_id"
                " WHERE a.is_inline = 0 GROUP BY month ORDER BY month DESC"
            ).fetchall()
            return [{"month": str(r["month"]), "count": int(r["count"])} for r in rows]
        finally:
            conn.close()

    def projection_files(
        self, month: str, *, q: Optional[str] = None, offset: int = 0, limit: int = FOLDER_PAGE_SIZE
    ) -> tuple[list[dict[str, Any]], int]:
        """某月的非内嵌附件；``q`` 同时匹配文件名与来源列（主题 / 发件人 / 发件人名，F4）。"""
        where = f"a.is_inline = 0 AND {_PROJECTION_MONTH_SQL} = ?"
        params: list[Any] = [month]
        if q:
            like = f"%{self._escape_like(q)}%"
            where += (
                " AND (a.filename LIKE ? ESCAPE '\\' OR m.subject LIKE ? ESCAPE '\\'"
                " OR m.sender LIKE ? ESCAPE '\\' OR m.sender_name LIKE ? ESCAPE '\\')"
            )
            params.extend([like, like, like, like])
        base = (
            " FROM email_attachment a LEFT JOIN email_metadata m ON m.internal_id = a.internal_id"
            " LEFT JOIN email_attachment_text t ON t.attachment_id = a.id"
            f" WHERE {where}"
        )
        conn = self._sync_conn()
        try:
            total = int(conn.execute(f"SELECT COUNT(*) {base}", params).fetchone()[0])
            rows = conn.execute(
                f"SELECT {_PROJECTION_ITEM_COLUMNS}{base} ORDER BY m.date_received DESC, a.id DESC LIMIT ? OFFSET ?",
                [*params, int(limit), int(offset)],
            ).fetchall()
            return [dict(r) for r in rows], total
        finally:
            conn.close()

    def projection_attachment(self, attachment_id: int) -> Optional[dict[str, Any]]:
        """单个投影行 + ``email_attachment_text`` 已抽好的文本（零成本，不重抽）。内嵌图不算投影行。"""
        conn = self._sync_conn()
        try:
            row = conn.execute(
                f"SELECT {_PROJECTION_ITEM_COLUMNS}, t.text_content, t.extractor, t.truncated AS text_truncated,"
                " t.error_message"
                " FROM email_attachment a LEFT JOIN email_metadata m ON m.internal_id = a.internal_id"
                " LEFT JOIN email_attachment_text t ON t.attachment_id = a.id"
                " WHERE a.id = ? AND a.is_inline = 0",
                (int(attachment_id),),
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    # ── helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _update(table: str, conn: sqlite3.Connection, row_id: int, allowed: tuple[str, ...], fields: dict[str, Any]) -> None:
        if not fields:
            return
        unknown = set(fields) - set(allowed)
        if unknown:
            raise ValueError(f"unknown {table} columns: {sorted(unknown)}")
        names = list(fields)
        conn.execute(
            f"UPDATE {table} SET {', '.join(f'{n}=?' for n in names)} WHERE id=?",
            [*(fields[n] for n in names), int(row_id)],
        )

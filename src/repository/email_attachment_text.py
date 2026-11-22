"""Attachment text extraction queue and search mixin for EmailRepository."""

from __future__ import annotations

import sqlite3
import time
from typing import Optional, Sequence

from loguru import logger

from src.repository.cjk_bigram import is_pure_cjk_bigram
from src.repository.email_models import (
    AttachmentSearchHit,
    AttachmentTextRecord,
    _quote_fts_token,
    _route_text_term,
    smart_query_transform,
)
from src.repository.search_query import (
    FilterPredicate,
    build_structured_filter_predicates,
    escape_like_value,
)


class _EmailAttachmentTextMixin:
    """Attachment extraction job queue and attachment full-text search methods."""

    def enqueue_attachment_text_extraction(self, attachment_id: int) -> None:
        """commit_email_with_body 后调 — 把附件登记为 pending 等 worker 抽.

        幂等: 已有行就不动 (INSERT OR IGNORE). worker 处理失败时另外维护
        retry_count + next_retry_at, 不在这里 reset.
        """
        conn = self._connect()
        now = time.time()
        try:
            conn.execute(
                """INSERT OR IGNORE INTO email_attachment_text
                   (attachment_id, text_content, text_size_bytes, extractor,
                    status, retry_count, created_at, updated_at)
                   VALUES (?, NULL, 0, 'pending', 'pending', 0, ?, ?)""",
                (attachment_id, now, now),
            )
            conn.commit()
        finally:
            conn.close()

    def commit_attachment_text(
        self,
        attachment_id: int,
        text: str,
        extractor: str,
        *,
        status: str = 'extracted',
        error_message: Optional[str] = None,
        truncated: bool = False,
    ) -> None:
        """worker / extractor 完成后调 — upsert email_attachment_text 行.

        FTS5 索引通过 trigger 自动维护: status='extracted' + text 非空时
        进 email_attachment_fts; 其他 status 不索引.
        """
        if status not in ('pending', 'extracted', 'failed', 'unsupported'):
            raise ValueError(f"invalid status: {status!r}")

        conn = self._connect()
        now = time.time()
        text_bytes = len(text.encode('utf-8')) if text else 0
        text_payload = text if (text and status == 'extracted') else None
        extracted_at = now if status == 'extracted' else None
        try:
            # 保留原 created_at (如果存在) 让审计 / 重试统计准
            row = conn.execute(
                "SELECT created_at FROM email_attachment_text WHERE attachment_id = ?",
                (attachment_id,),
            ).fetchone()
            created_at = row['created_at'] if row else now

            conn.execute(
                """INSERT OR REPLACE INTO email_attachment_text
                   (attachment_id, text_content, text_size_bytes, extractor,
                    status, error_message, retry_count, next_retry_at,
                    extracted_at, truncated, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)""",
                (
                    attachment_id, text_payload, text_bytes, extractor,
                    status, error_message, extracted_at,
                    1 if truncated else 0,
                    created_at, now,
                ),
            )
            self._upsert_attachment_cjk2(conn, attachment_id, text_payload, status)
            conn.commit()
        finally:
            conn.close()

    def get_attachment_text(self, attachment_id: int) -> Optional[AttachmentTextRecord]:
        conn = self._connect()
        try:
            row = conn.execute(
                """SELECT attachment_id, text_content, text_size_bytes, extractor,
                          status, error_message, retry_count, next_retry_at,
                          extracted_at, truncated, created_at, updated_at
                     FROM email_attachment_text WHERE attachment_id = ?""",
                (attachment_id,),
            ).fetchone()
            if not row:
                return None
            return AttachmentTextRecord(
                attachment_id=row['attachment_id'],
                text_content=row['text_content'],
                text_size_bytes=row['text_size_bytes'] or 0,
                extractor=row['extractor'],
                status=row['status'],
                error_message=row['error_message'],
                retry_count=row['retry_count'] or 0,
                next_retry_at=row['next_retry_at'],
                extracted_at=row['extracted_at'],
                truncated=bool(row['truncated']),
                created_at=row['created_at'],
                updated_at=row['updated_at'],
            )
        finally:
            conn.close()

    def list_pending_attachment_extractions(self, *, limit: int = 20) -> list[int]:
        """worker poll 用: 取 pending + retry-ready 的 attachment_id list."""
        if limit <= 0:
            return []
        conn = self._connect()
        now = time.time()
        try:
            rows = conn.execute(
                """SELECT attachment_id FROM email_attachment_text
                   WHERE status = 'pending'
                      OR (status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at <= ?)
                   ORDER BY created_at ASC
                   LIMIT ?""",
                (now, limit),
            ).fetchall()
            return [r['attachment_id'] for r in rows]
        finally:
            conn.close()

    # 重试退避表: 1min, 5min, 15min, 1h, 2h (跟 sync_store.email_metadata 一致)
    _ATTACHMENT_TEXT_RETRY_BACKOFFS = (60.0, 300.0, 900.0, 3600.0, 7200.0)

    def mark_attachment_text_failure(
        self,
        attachment_id: int,
        error_message: str,
        *,
        max_retries: int = 5,
    ) -> None:
        """worker 失败时调 — 递增 retry_count, 算 next_retry_at; 超 max 标 failed (无 retry)."""
        conn = self._connect()
        now = time.time()
        try:
            row = conn.execute(
                "SELECT retry_count FROM email_attachment_text WHERE attachment_id = ?",
                (attachment_id,),
            ).fetchone()
            if not row:
                # 首次失败前应该已经 enqueue, 这里没行就补一行
                conn.execute(
                    """INSERT INTO email_attachment_text
                       (attachment_id, text_content, text_size_bytes, extractor,
                        status, error_message, retry_count, next_retry_at,
                        truncated, created_at, updated_at)
                       VALUES (?, NULL, 0, 'none', 'failed', ?, 1, ?, 0, ?, ?)""",
                    (
                        attachment_id, error_message,
                        now + self._ATTACHMENT_TEXT_RETRY_BACKOFFS[0],
                        now, now,
                    ),
                )
            else:
                new_count = (row['retry_count'] or 0) + 1
                if new_count >= max_retries:
                    next_retry = None  # dead - 不再重试
                else:
                    backoff_idx = min(new_count - 1, len(self._ATTACHMENT_TEXT_RETRY_BACKOFFS) - 1)
                    next_retry = now + self._ATTACHMENT_TEXT_RETRY_BACKOFFS[backoff_idx]
                conn.execute(
                    """UPDATE email_attachment_text
                       SET status = 'failed', error_message = ?,
                           retry_count = ?, next_retry_at = ?, updated_at = ?
                       WHERE attachment_id = ?""",
                    (error_message, new_count, next_retry, now, attachment_id),
                )
            conn.commit()
        finally:
            conn.close()

    def requeue_unsupported_attachment_texts(
        self, *, dry_run: bool = False
    ) -> dict:
        """把历史 unsupported / failed 附件文本行拨回 pending, 让 worker 用新 extractor 重跑（批次4 PR-H）。

        新增 OCR（图片）/ 老格式（.doc/.ppt/.xls）extractor 后, 存量已判 ``unsupported``
        的历史行不会被 ``--include-missing``（``LEFT JOIN ... IS NULL``）或
        ``enqueue_attachment_text_extraction``（``INSERT OR IGNORE`` 幂等）重新捕获 ——
        本方法是唯一把它们从终态拨回 ``pending`` 的显式路径。

        圈选（绕开 error_message 字符串锚点, 按 status × 扩展名直接圈）:
            - ``status='unsupported' AND 扩展名 ∈ (OCR 图片集 ∪ 老格式集)``
            - ``status='failed'      AND 扩展名 = '.pdf'``（19 行全重跑; 1 个加密 PDF
              再 failed 一次无害）
        → ``UPDATE ... SET status='pending', retry_count=0, next_retry_at=NULL,
        error_message=NULL, updated_at=?``。扩展名集 **import 自 attachment_text.py 单源**
        （禁止第二份硬编码）。``enqueue_attachment_text_extraction`` 的 INSERT OR IGNORE
        **一行不动**。

        Args:
            dry_run: True → 只数不写（CLI ``--dry-run``）。

        Returns:
            dict: ``{unsupported_images, unsupported_legacy, failed_pdf, total, dry_run}``。
        """
        from src.converter.attachment_text import (
            LEGACY_OFFICE_EXTENSIONS,
            OCR_IMAGE_EXTENSIONS,
        )

        image_exts = sorted(OCR_IMAGE_EXTENSIONS)
        legacy_exts = sorted(LEGACY_OFFICE_EXTENSIONS)

        conn = self._connect()
        now = time.time()
        try:
            def _count_unsupported(exts: list[str]) -> int:
                if not exts:
                    return 0
                like_clause = " OR ".join("lower(a.filename) LIKE ?" for _ in exts)
                params = [f"%{e}" for e in exts]
                row = conn.execute(
                    f"""SELECT COUNT(*) FROM email_attachment_text t
                          JOIN email_attachment a ON a.id = t.attachment_id
                         WHERE t.status = 'unsupported' AND ({like_clause})""",
                    params,
                ).fetchone()
                return int(row[0])

            unsupported_images = _count_unsupported(image_exts)
            unsupported_legacy = _count_unsupported(legacy_exts)
            failed_pdf = int(
                conn.execute(
                    """SELECT COUNT(*) FROM email_attachment_text t
                         JOIN email_attachment a ON a.id = t.attachment_id
                        WHERE t.status = 'failed'
                          AND lower(a.filename) LIKE '%.pdf'"""
                ).fetchone()[0]
            )

            result = {
                "unsupported_images": unsupported_images,
                "unsupported_legacy": unsupported_legacy,
                "failed_pdf": failed_pdf,
                "total": unsupported_images + unsupported_legacy + failed_pdf,
                "dry_run": dry_run,
            }
            if dry_run:
                return result

            all_exts = image_exts + legacy_exts
            like_clause = " OR ".join("lower(a.filename) LIKE ?" for _ in all_exts)
            like_params = [f"%{e}" for e in all_exts]
            conn.execute(
                f"""UPDATE email_attachment_text
                       SET status = 'pending', retry_count = 0,
                           next_retry_at = NULL, error_message = NULL,
                           updated_at = ?
                     WHERE attachment_id IN (
                       SELECT t.attachment_id FROM email_attachment_text t
                         JOIN email_attachment a ON a.id = t.attachment_id
                        WHERE (t.status = 'unsupported' AND ({like_clause}))
                           OR (t.status = 'failed'
                               AND lower(a.filename) LIKE '%.pdf')
                     )""",
                [now, *like_params],
            )
            conn.commit()
            return result
        finally:
            conn.close()

    #: 这些是**已成功抽取**的行 —— 与上面那个方法圈的 unsupported/failed 正好相反。
    #: `pdf_ocr` / `vision_ocr` / `plaintext` **有意不在任何组里**：OCR 两条 anydoc 根本
    #: 不做（它不做 OCR），plaintext 直读已是最忠实产出。
    ANYDOC_BACKFILL_BY_LANE = {
        'office': ('docx', 'pptx', 'xlsx'),
        'legacy': ('soffice_bridge',),
        'pdf': ('pypdf',),
    }

    #: 全集（跨全部 lane）。**回填时不要直接用它** —— 用 `anydoc_backfill_extractors()`，
    #: 否则会把 lane 没开的行也拨回 pending、再原样抽回旧 extractor，白跑一轮。
    ANYDOC_BACKFILL_EXTRACTORS = tuple(
        e for group in ANYDOC_BACKFILL_BY_LANE.values() for e in group
    )

    @classmethod
    def anydoc_backfill_extractors(cls) -> tuple:
        """当前**启用的 lane** 对应的待回填 extractor 集合。

        🔴 跟随 lane 而不是用全集：pdf lane 默认关，若把 572 条 `pypdf` 行一起拨回
        pending，worker 会原样再用 pypdf 抽一遍 —— 纯浪费，还把真正该回填的行挤到后面。
        owner 哪天开了 pdf lane，同一条命令会自动带上它们。
        """
        from src.converter import anydoc_extract

        lanes = anydoc_extract.enabled_lanes()
        return tuple(
            e
            for lane, group in cls.ANYDOC_BACKFILL_BY_LANE.items()
            if lane in lanes
            for e in group
        )

    def requeue_extractor_attachment_texts(
        self, extractors: Sequence[str], *, dry_run: bool = False, limit: Optional[int] = None
    ) -> dict:
        """把指定 extractor 抽出来的**已成功**行拨回 pending，让新 extractor 重跑。

        与 `requeue_unsupported_attachment_texts` 的区别：那个捞的是终态失败的行
        （unsupported / failed），这个捞的是 `status='extracted'` 但用**旧 extractor**
        抽的行 —— 换代（task 08-10 anydoc）之后回填存量用。

        🔴 **拨回 pending 不会丢已有文本**：`text_content` 一列不动，只重置调度字段。
        万一新 extractor 反而失败，worker 会走 `mark_attachment_text_failure` 的退避，
        旧文本仍在库里、FTS 仍可搜 —— 「有旧文本」不会被降级成「没有文本」。

        Args:
            extractors: 圈选的 extractor 名（见 `ANYDOC_BACKFILL_EXTRACTORS`）。空 → no-op。
            dry_run: True → 只数不写。
            limit: 每次最多拨回多少行（分批回填；None = 不限）。挑最旧的先拨
                （`updated_at ASC`），这样反复跑能稳定推进而不是每次都抓同一批。

        Returns:
            dict: ``{by_extractor: {name: count}, total, requeued, dry_run}``。
            `total` 是符合条件的总行数，`requeued` 是本次实际拨回的（受 limit 约束）。
        """
        names = [e for e in dict.fromkeys(extractors) if e]
        if not names:
            return {"by_extractor": {}, "total": 0, "requeued": 0, "dry_run": dry_run}

        placeholders = ",".join("?" for _ in names)
        conn = self._connect()
        now = time.time()
        try:
            by_extractor = {
                str(row[0]): int(row[1])
                for row in conn.execute(
                    f"""SELECT extractor, COUNT(*) FROM email_attachment_text
                         WHERE status = 'extracted' AND extractor IN ({placeholders})
                         GROUP BY extractor""",
                    names,
                ).fetchall()
            }
            total = sum(by_extractor.values())
            requeued = total if limit is None else min(total, max(0, limit))
            result = {
                "by_extractor": by_extractor,
                "total": total,
                "requeued": 0 if dry_run else requeued,
                "dry_run": dry_run,
            }
            if dry_run or requeued == 0:
                return result

            limit_clause = "" if limit is None else " ORDER BY updated_at ASC LIMIT ?"
            params: list[object] = [now, *names]
            if limit is not None:
                params.append(requeued)
            conn.execute(
                f"""UPDATE email_attachment_text
                       SET status = 'pending', retry_count = 0,
                           next_retry_at = NULL, error_message = NULL,
                           updated_at = ?
                     WHERE attachment_id IN (
                       SELECT attachment_id FROM email_attachment_text
                        WHERE status = 'extracted' AND extractor IN ({placeholders})
                        {limit_clause}
                     )""",
                params,
            )
            conn.commit()
            return result
        finally:
            conn.close()

    # 老 email_attachment_fts (unicode61) SELECT 骨架 —— raw / flag-off / v38 缺表降级共用
    # (与批次3 迁移前 search_attachment_texts 逐字节等价, 只是 MATCH 串来源参数化)。
    _ATTACHMENT_UNICODE61_SELECT = """
            SELECT a.id           AS attachment_id,
                   a.internal_id  AS internal_id,
                   COALESCE(a.filename, '')      AS filename,
                   a.content_type AS content_type,
                   COALESCE(m.subject, '')       AS email_subject,
                   COALESCE(m.sender, '')        AS email_sender,
                   m.date_received               AS email_date,
                   m.mailbox                     AS email_mailbox,
                   m.notion_page_id              AS notion_page_id,
                   snippet(email_attachment_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                   bm25(email_attachment_fts)    AS rank
              FROM email_attachment_fts
              JOIN email_attachment a ON a.id = email_attachment_fts.rowid
              JOIN email_metadata m ON m.internal_id = a.internal_id
             WHERE email_attachment_fts MATCH ?
    """

    def search_attachment_texts(
        self,
        query: str,
        *,
        raw: bool = False,
        limit: int = 30,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
    ) -> list[AttachmentSearchHit]:
        """FTS5 搜附件文本 + JOIN 拼邮件上下文.

        **批次3 PR-E — 路由内化 (Option A)**: 镜像 ``search_email_bodies_with_meta`` 的
        「raw query + 模式进函数、函数内路由」既定模式。此前本函数是遗留的 caller-side
        transform 异类 —— 6 直调点各自在调用**前** ``smart_query_transform`` 再传进来,
        内核收到已变换 FTS 表达式, split+路由对 CJK 是垃圾。本批一并归正: 调用方传
        **原始自然 query** + ``raw`` 标志, 变换/路由全在内核。

        - ``raw=True`` (CLI ``--raw`` / 用户手写 FTS5 语法): 直通老 ``email_attachment_fts``
          unicode61 MATCH, **逐字节不变** —— 用户显式写表达式就尊重表达式, 不做 trigram 路由。
        - ``raw=False`` (smart, 默认): 内核收原始 query。
            - ``trigram_enabled`` 且 v39 表在 → trigram 路由 (``_search_attachment_trigram``):
              ``query.split()`` 各 term 过 ``_route_text_term``, ≥3 任意文种 / trigram-match
              合成单 MATCH 表达式 (跨 filename + text_content 两列 → 中文子串/文件名同路),
              2 字 CJK / 短拉丁 <3 走 ``(filename OR text_content) LIKE`` 谓词, 1 字 CJK 丢弃。
            - flag off / v38 缺表 (D2 案 B) → 内核自己 ``smart_query_transform`` + 老 unicode61
              (与迁移前 smart 路径最终 SQL + MATCH 串**逐字节等价**, 变换只是从调用方挪进内核)。

        粒度 = 附件级 (同邮件多附件各自出现, 不复用 ``_dedupe_attachment_rows`` 的 email 级
        去重)。has_more limit+1 探针在路由层完成, 本函数 ``limit`` 无上限校验 (多传 1 不受影响)。
        """
        if not query or not query.strip():
            return []
        if limit <= 0:
            return []

        # NS-6: 附件路径的 mailbox/date 过滤复用 body 主搜索的统一谓词构造
        # (build_structured_filter_predicates) → since/until 走与 DSL 相同的 tz 归一
        # `datetime(m.date_received) >= datetime(?)` (until 带 end-of-day 语义), 让
        # `has:attachment redis` (fused 路径) 与直接附件搜索对同一 since/until 给一致边界,
        # 不再裸 ISO 字符串比较 (旧实现时区混存数据边界错位)。
        filters, _ = build_structured_filter_predicates(
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
        )

        conn = self._connect()
        try:
            if raw:
                # 用户手写 FTS5: 直通老 unicode61 MATCH, 逐字节不变 (不做 trigram 路由)。
                return self._search_attachment_unicode61(
                    conn, query, filters=filters, limit=limit
                )
            if self.trigram_enabled and self._attachment_trigram_table_present(conn):
                # D1: 原始自然 query 走内核内 trigram 路由 (中文子串 / 文件名)。
                return self._search_attachment_trigram(
                    conn, query, filters=filters, limit=limit
                )
            # D2 案 B: flag off / v38 缺表 → 内核内 smart_query_transform + 老 unicode61
            # (与迁移前 smart 路径逐字节等价; 缺表不 fail-closed 空, 端点是独立检索端点、
            # 老 email_attachment_fts 恒在恒可查, 与批次1 lane 降级先例同向)。
            return self._search_attachment_unicode61(
                conn, smart_query_transform(query), filters=filters, limit=limit
            )
        finally:
            conn.close()

    @staticmethod
    def _attachment_trigram_table_present(conn: sqlite3.Connection) -> bool:
        """v39 附件 trigram 表是否存在 (旧库 v38 无 → D2 案 B 降级到老 unicode61 判据)。"""
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'email_attachment_fts_trigram'"
        ).fetchone()
        return row is not None

    @staticmethod
    def _attachment_hit_from_row(
        r: sqlite3.Row, *, snippet: str, rank: Optional[float]
    ) -> AttachmentSearchHit:
        """sqlite3.Row → AttachmentSearchHit (unicode61 / trigram 两路共用的物化)。"""
        page_id = r["notion_page_id"]
        notion_url = (
            f"https://www.notion.so/{page_id.replace('-', '')}" if page_id else None
        )
        return AttachmentSearchHit(
            attachment_id=r["attachment_id"],
            internal_id=r["internal_id"],
            filename=r["filename"],
            content_type=r["content_type"],
            snippet=snippet,
            rank=rank,
            email_subject=r["email_subject"],
            email_sender=r["email_sender"],
            email_date=r["email_date"],
            email_mailbox=r["email_mailbox"],
            notion_page_id=page_id,
            notion_url=notion_url,
        )

    def _search_attachment_unicode61(
        self,
        conn: sqlite3.Connection,
        match_expr: str,
        *,
        filters: list[FilterPredicate],
        limit: int,
    ) -> list[AttachmentSearchHit]:
        """老 email_attachment_fts (unicode61) MATCH 路径 —— raw / flag-off / v38 缺表降级共用。

        与批次3 迁移前的 search_attachment_texts 逐字节等价 (只是 MATCH 串来源参数化:
        raw → query 原样, smart flag-off → smart_query_transform(query))。FTS5 语法错误
        吞掉返回 [] 的既有行为保留 (D2)。
        """
        sql = self._ATTACHMENT_UNICODE61_SELECT
        params: list = [match_expr]
        for predicate in filters:
            sql += f" AND ({predicate.sql})"
            params.extend(predicate.params)
        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)
        try:
            rows = conn.execute(sql, params).fetchall()
        except sqlite3.OperationalError as e:
            logger.warning(
                f"search_attachment_texts: invalid FTS5 query {match_expr!r}: {e}"
            )
            return []
        return [
            self._attachment_hit_from_row(
                r, snippet=r["snippet"] or "", rank=float(r["rank"])
            )
            for r in rows
        ]

    def _search_attachment_trigram(
        self,
        conn: sqlite3.Connection,
        query: str,
        *,
        filters: list[FilterPredicate],
        limit: int,
    ) -> list[AttachmentSearchHit]:
        """D1 trigram 路由: 原始自然 query 按空格拆 term 逐个过 _route_text_term, 附件级单表组合。

        - MATCH 型 term (trigram-match / unicode≥3): 各自 ``_quote_fts_token`` 后以空格
          (FTS5 隐式 AND) 合成**一个** ``email_attachment_fts_trigram`` MATCH 表达式 (默认
          跨 filename + text_content 两列 → 文件名/正文子串同路, 镜像 ``_attachment_content_predicate``)。
        - LIKE 型 term (2 字 CJK / 短拉丁 <3): 各编译成同表上的 ``(filename LIKE ? OR
          text_content LIKE ?)`` ESCAPE AND 谓词 (MATCH <3 字符无召回, LIKE 兜底)。
        - 1 字 CJK term 丢弃 (端点无 warnings 通道); 全丢弃 → 返回 []。
        - rank: 有 MATCH → ``bm25`` 升序; 纯 LIKE 无 bm25 → ``date_received DESC`` + rank=None。
        - snippet: 有 MATCH → ``snippet(..., 1, ...)`` (text_content 是第 2 列, 列号 1),
          为空 fallback text_content 前 80 字符; 纯 LIKE → 直接 text_content 前 80 字符。

        粒度 = 附件级 (同邮件多附件各自出现, **不** 复用 ``_dedupe_attachment_rows`` 的
        email 级去重, 调研 §3.3)。表恒在 (调用前已 ``_attachment_trigram_table_present``
        判定); 此处 OperationalError = FTS5 语法错误 (phrase 已转义, 罕见) → 返回 [] (保留
        既有语法错误吞行为)。
        """
        match_phrases: list[str] = []
        like_cores: list[str] = []
        for term in query.split():
            route = _route_text_term(term)
            if route.route == "too_short":
                continue
            core = route.trigram_core if route.route == "trigram" else route.original
            is_match = (route.route == "trigram" and route.trigram_mode == "match") or (
                route.route == "unicode" and len(route.original) >= 3
            )
            if is_match:
                match_phrases.append(_quote_fts_token(core))
            else:
                like_cores.append(core)
        if not match_phrases and not like_cores:
            return []

        where_clauses: list[str] = []
        params: list = []
        if match_phrases:
            # 空格 = FTS5 隐式 AND, 合成单一跨两列 MATCH 表达式。
            where_clauses.append("email_attachment_fts_trigram MATCH ?")
            params.append(" ".join(match_phrases))
        use_cjk2 = self._cjk2_ready(conn)
        for core in like_cores:
            if use_cjk2 and is_pure_cjk_bigram(core):
                where_clauses.append(
                    "email_attachment_fts_trigram.rowid IN ("
                    "SELECT rowid FROM email_attachment_fts_cjk2 "
                    "WHERE email_attachment_fts_cjk2 MATCH ?)"
                )
                params.append(_quote_fts_token(core))
            else:
                like = f"%{escape_like_value(core)}%"
                where_clauses.append(
                    "(email_attachment_fts_trigram.filename LIKE ? ESCAPE '\\' "
                    "OR email_attachment_fts_trigram.text_content LIKE ? ESCAPE '\\')"
                )
                params.extend([like, like])
        for predicate in filters:
            where_clauses.append(f"({predicate.sql})")
            params.extend(predicate.params)

        if match_phrases:
            snippet_expr = (
                "snippet(email_attachment_fts_trigram, 1, '<mark>', '</mark>', '...', 16)"
            )
            rank_expr = "bm25(email_attachment_fts_trigram)"
            order_by = "rank"
        else:
            # 纯 LIKE: 无 bm25 → snippet 直接 fallback, rank NULL, 按日期倒序。
            snippet_expr = "NULL"
            rank_expr = "NULL"
            order_by = "datetime(m.date_received) DESC"

        sql = (
            "SELECT a.id AS attachment_id, a.internal_id AS internal_id, "
            "COALESCE(a.filename, '') AS filename, a.content_type AS content_type, "
            "COALESCE(m.subject, '') AS email_subject, "
            "COALESCE(m.sender, '') AS email_sender, "
            "m.date_received AS email_date, m.mailbox AS email_mailbox, "
            "m.notion_page_id AS notion_page_id, "
            f"{snippet_expr} AS snippet, "
            "substr(COALESCE(email_attachment_fts_trigram.text_content, ''), 1, 80) "
            "AS snippet_fallback, "
            f"{rank_expr} AS rank "
            "FROM email_attachment_fts_trigram "
            "JOIN email_attachment a ON a.id = email_attachment_fts_trigram.rowid "
            "JOIN email_metadata m ON m.internal_id = a.internal_id "
            f"WHERE {' AND '.join(where_clauses)} "
            f"ORDER BY {order_by} LIMIT ?"
        )
        params.append(limit)
        try:
            rows = conn.execute(sql, params).fetchall()
        except sqlite3.OperationalError as e:
            logger.warning(
                f"search_attachment_texts(trigram): invalid query {query!r}: {e}"
            )
            return []
        hits: list[AttachmentSearchHit] = []
        for r in rows:
            snip = r["snippet"] or r["snippet_fallback"] or ""
            rank_val = None if r["rank"] is None else float(r["rank"])
            hits.append(self._attachment_hit_from_row(r, snippet=snip, rank=rank_val))
        return hits

    def search_attachment_texts_smart(
        self,
        query: str,
        *,
        limit: int = 30,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
    ) -> list[AttachmentSearchHit]:
        """Smart wrapper of search_attachment_texts.

        批次3 PR-E 路由内化后, 变换/路由已在 ``search_attachment_texts`` 内核 (raw=False)
        完成 —— 本 wrapper 不再自己 ``smart_query_transform`` (那会造成双重变换)。保留此
        方法仅为其唯一调用方 (reports ``_search_attachments``) 的签名/语义不变。
        """
        return self.search_attachment_texts(
            query,
            raw=False,
            limit=limit,
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
        )

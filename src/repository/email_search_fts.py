"""Unified FTS5, RRF fusion, and coverage search mixin for EmailRepository."""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timezone
from typing import Optional

from loguru import logger

from src.repository.email_models import (
    _RRF_FETCH_MAX,
    _RRF_FETCH_MIN_EXTRA,
    _RRF_FETCH_MULTIPLIER,
    _RRF_K,
    EmailSearchHit,
    EmailSearchResult,
    _MergedCandidate,
    _SearchLane,
    _count_cjk_chars,
    _quote_fts_token,
    smart_query_transform,
)
from src.repository.search_query import (
    FilterPredicate,
    ParsedSearchQuery,
    build_structured_filter_predicates,
    parse_search_query,
)


class _EmailSearchFtsMixin:
    """Public search entrypoints and FTS5/RRF search pipeline for EmailRepository."""

    def search_email_bodies(
        self,
        query: str,
        *,
        limit: int = 50,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
    ) -> list[EmailSearchHit]:
        """FTS5 全文搜索邮件正文 + subject + sender（raw FTS5 入口）.

        Args:
            query: FTS5 query 语法 —— 短语用引号，AND/OR/NOT 大写，前缀用 `term*`。
                示例：'"project plan"', 'redis AND timeout', 'meeting NOT canceled'
            limit: 最多返回多少条（caller 责任 cap，repo 不再约束上限）
            mailbox: 仅返回该 mailbox 的邮件（'收件箱' / '发件箱'）
            since_date / until_date: 'YYYY-MM-DD'，按本地时区解释；内部用
                SQLite datetime() 归一时区后比较。

        Returns:
            EmailSearchHit list，按 bm25 升序（最相关在前）。
            空查询 / 无命中 / FTS 语法错误均返回 []（语法错误会 logger.warning）。
        """
        return self._search_email_bodies_raw(
            query,
            limit=limit,
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
        )

    def search_email_bodies_with_meta(
        self, query: str, *, mode: str = "smart", limit: int = 50,
        mailbox: Optional[str] = None, since_date: Optional[str] = None,
        until_date: Optional[str] = None, now: Optional[str] = None,
        tz_offset_minutes: Optional[int] = None, matter_id: Optional[int] = None,
    ) -> EmailSearchResult:
        kwargs = dict(mode=mode, limit=limit, mailbox=mailbox, since_date=since_date,
                      until_date=until_date, now=now, tz_offset_minutes=tz_offset_minutes,
                      matter_id=matter_id)
        result = self._search_email_bodies_with_meta(query, **kwargs)
        result.coverage = self.search_body_coverage(query, **kwargs)
        result.effective_filters = {
            "query": query, "mode": kwargs.get("mode", "smart"),
            "mailbox": kwargs.get("mailbox"), "since": kwargs.get("since_date"),
            "until": kwargs.get("until_date"), "matter_id": kwargs.get("matter_id"),
            "exclude_drafts": False,
        }
        return result

    def search_body_coverage(self, query: str, **kwargs) -> dict:
        """Metadata candidates only, never evidence that a missing body matches query.

        Complex expressions deliberately report unknown. Index presence is checked
        against actual body channels, independently of Notion/sync status.
        """
        parsed = parse_search_query(query, now=kwargs.get("now"),
                                    tz_offset_minutes=kwargs.get("tz_offset_minutes"))
        unknown = (kwargs.get("mode") == "raw" or parsed.warnings
                   or parsed.fts_or_groups or parsed.or_filter_groups
                   or parsed.neg_filters or parsed.neg_fts_terms
                   or parsed.attachment_terms or parsed.neg_attachment_terms)
        filters, warnings = build_structured_filter_predicates(
            mailbox=kwargs.get("mailbox"), since_date=kwargs.get("since_date"),
            until_date=kwargs.get("until_date"), now=kwargs.get("now"),
            tz_offset_minutes=kwargs.get("tz_offset_minutes"))
        unknown = bool(unknown or warnings)
        # Attachment predicates depend on fetched content and cannot bound missing bodies.
        safe_filters = [p for p in parsed.filters if "email_attachment" not in p.sql]
        unknown = unknown or len(safe_filters) != len(parsed.filters)
        if not unknown:
            filters = [*filters, *safe_filters]
        self._append_matter_filter(filters, kwargs.get("matter_id"))
        scope = "unknown" if unknown else ("metadata_candidates" if filters else "global")
        params: list = []
        where = self._append_metadata_predicates(" WHERE 1=1", params, filters)
        channels = ["email_body_fts"]
        if self.trigram_enabled and _count_cjk_chars(query) > 0:
            channels.append("email_body_fts_trigram")
        conn = self._connect()
        # Coverage is supplementary. Bound its cost on large historical stores;
        # an interrupted audit must not discard already successful search hits.
        deadline = time.monotonic() + 0.25
        conn.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
        try:
            available = {r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
            if "email_body" not in available:
                return {"scope": "unknown", "candidate_count": 0, "body_missing": 0,
                        "body_unsearchable": 0, "channels": channels,
                        "complete": False, "samples": []}
            # 不读正文列，也尽量不碰 email_body：`body_markdown IS NULL` 会把整列正文读出来
            # （1.4 万封的真实库要 9 秒），email_body 逐行点查在冷缓存下是上万次随机读大表页。
            # 先查很小的 FTS5 docsize（行在 = 该通道已索引这封），只对没索引的那些再问
            # email_body 在不在 —— CASE 保证按顺序短路。
            indexed = " AND ".join(
                f"EXISTS (SELECT 1 FROM {table}_docsize d WHERE d.id=m.internal_id)"
                if f"{table}_docsize" in available else "0" for table in channels)
            has_body = "EXISTS (SELECT 1 FROM email_body b WHERE b.internal_id=m.internal_id)"
            base = " FROM email_metadata m" + where
            row = conn.execute(
                f"SELECT COUNT(*), "
                f"COALESCE(SUM(CASE WHEN {indexed} THEN 0 WHEN {has_body} THEN 0 ELSE 1 END),0), "
                f"COALESCE(SUM(CASE WHEN {indexed} THEN 0 WHEN {has_body} THEN 1 ELSE 0 END),0)"
                + base, params).fetchone()
            samples = conn.execute(
                "SELECT m.internal_id, m.subject" + base +
                f" AND NOT ({indexed}) ORDER BY m.date_received DESC LIMIT 5",
                params).fetchall()
            return {"scope": scope, "candidate_count": row[0], "body_missing": row[1],
                    "body_unsearchable": row[2], "channels": channels,
                    "complete": not unknown and row[1] == 0 and row[2] == 0,
                    "samples": [{"internal_id": r[0], "subject": r[1]} for r in samples]}
        except sqlite3.OperationalError:
            return {"scope": "unknown", "candidate_count": 0, "body_missing": 0,
                    "body_unsearchable": 0, "channels": channels,
                    "complete": False, "samples": []}
        finally:
            conn.close()

    def _search_email_bodies_with_meta(
        self,
        query: str,
        *,
        mode: str = "smart",
        limit: int = 50,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
        now: Optional[str] = None,
        tz_offset_minutes: Optional[int] = None,
        matter_id: Optional[int] = None,
    ) -> EmailSearchResult:
        """搜索正文并返回调用方需要透传的 meta。

        ``mode='raw'`` 保持 FTS5 query 原样下放；``mode='smart'`` 先解析
        Search Query DSL v1。纯文本 query 命中 fast-path，继续走旧 smart
        transform + raw 查询路径，确保存量行为不变。
        """
        if not query or not query.strip():
            return EmailSearchResult([], query, [])
        if limit <= 0:
            return EmailSearchResult([], query, [])

        # Phase A G-A2: limit+1 探针 → 精确 has_more。每条执行路径都按 probe 取，
        # 再统一过 _finalize_search 裁回 limit + 置 has_more（返回 hits 与裁剪前
        # top-limit 逐条一致，零结果回归 —— 多取 1 条只为检测溢出）。
        probe = limit + 1

        normalized_mode = (mode or "smart").lower()
        if normalized_mode == "raw":
            structured_filters, structured_warnings = build_structured_filter_predicates(
                mailbox=mailbox,
                since_date=since_date,
                until_date=until_date,
                now=now,
                tz_offset_minutes=tz_offset_minutes,
            )
            self._append_matter_filter(structured_filters, matter_id)
            hits = self._search_email_bodies_raw(
                query,
                limit=probe,
                extra_filters=structured_filters,
            )
            return self._finalize_search(hits, query, structured_warnings, limit)

        parsed = parse_search_query(
            query,
            now=now,
            tz_offset_minutes=tz_offset_minutes,
        )
        if parsed.is_plain_passthrough:
            # T7: flag=True 且裸全文 query 含 CJK → 走 trigram 路由 (CJK 子串增强)。
            # flag=False 或纯非 CJK → 落入下面老 unicode61 fast-path (逐字节零回归)。
            if self.trigram_enabled and _count_cjk_chars(query) > 0:
                trigram_result = self._search_email_bodies_trigram(
                    query,
                    parsed=parsed,
                    limit=probe,
                    mailbox=mailbox,
                    since_date=since_date,
                    until_date=until_date,
                    now=now,
                    tz_offset_minutes=tz_offset_minutes,
                    matter_id=matter_id,
                )
                if trigram_result is not None:
                    return self._finalize_search(
                        trigram_result.hits,
                        trigram_result.transformed_query,
                        trigram_result.parse_warnings,
                        limit,
                    )
            transformed = smart_query_transform(query)
            structured_filters, structured_warnings = build_structured_filter_predicates(
                mailbox=mailbox,
                since_date=since_date,
                until_date=until_date,
                now=now,
                tz_offset_minutes=tz_offset_minutes,
            )
            self._append_matter_filter(structured_filters, matter_id)
            if transformed != query:
                logger.debug(
                    f"search_email_bodies_smart: query={query!r} → "
                    f"transformed={transformed!r}"
                )
            hits = self._search_email_bodies_fused(
                body_fts_expr=transformed,
                attachment_fts_expr=transformed,
                metadata_predicates=structured_filters,
                neg_body_fts_expr="",
                neg_attachment_fts_expr="",
                attachment_body_gate_expr="",
                sort=None,
                limit=probe,
                query_for_log=transformed,
                # PR4: 仅 plain fast-path 传原始 query → fused 内启用整 query trigram
                # 双 lane (union-only); parsed 路径不传 → 逐字节不变。
                plain_query=query,
            )
            return self._finalize_search(
                hits,
                transformed,
                [*parsed.warnings, *structured_warnings],
                limit,
            )

        hits, transformed = self._search_email_bodies_parsed(
            parsed,
            limit=probe,
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
            now=now,
            tz_offset_minutes=tz_offset_minutes,
            matter_id=matter_id,
        )
        return self._finalize_search(hits, transformed, parsed.warnings, limit)

    @staticmethod
    def _finalize_search(
        hits: list["EmailSearchHit"],
        transformed_query: str,
        warnings: list[str],
        limit: int,
    ) -> EmailSearchResult:
        """Phase A G-A2: 把 limit+1 探针结果裁回 limit 并置 has_more。

        ``hits`` 是按 ``limit + 1`` 取的候选；``len(hits) > limit`` 即代表还有更多命中
        （精确 has_more）。裁剪后的 ``hits`` 与不探针时的 top-``limit`` 逐条一致。
        """
        has_more = len(hits) > limit
        return EmailSearchResult(
            hits[:limit] if has_more else hits,
            transformed_query,
            warnings,
            has_more=has_more,
        )

    def _search_email_bodies_raw(
        self,
        query: str,
        *,
        limit: int,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
        extra_filters: Optional[list[FilterPredicate]] = None,
    ) -> list[EmailSearchHit]:
        if not query or not query.strip():
            return []
        if limit <= 0:
            return []

        # FTS5 MATCH 用占位符传字符串避免 SQL 注入（FTS 语法本身的非法字符
        # 由 SQLite 抛 OperationalError，被下面 try/except 接住）
        sql = """
            SELECT m.internal_id,
                   COALESCE(m.subject, '')        AS subject,
                   COALESCE(m.sender, '')         AS sender,
                   m.date_received,
                   m.mailbox,
                   m.notion_page_id,
                   snippet(email_body_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                   bm25(email_body_fts, 1.0, 5.0, 2.0) AS rank__AI_SELECT__
              FROM email_body_fts
              JOIN email_metadata m ON m.internal_id = email_body_fts.rowid__AI_JOIN__
             WHERE email_body_fts MATCH ?
        """
        params: list = [query]
        filters = extra_filters
        if filters is None:
            filters, _ = build_structured_filter_predicates(
                mailbox=mailbox,
                since_date=since_date,
                until_date=until_date,
            )
        for predicate in filters:
            sql += f" AND ({predicate.sql})"
            params.extend(predicate.params)
        sql += " ORDER BY rank, datetime(m.date_received) DESC LIMIT ?"
        params.append(limit)

        return self._execute_email_search(sql, params, query)

    def _search_email_bodies_parsed(
        self,
        parsed: ParsedSearchQuery,
        *,
        limit: int,
        mailbox: Optional[str],
        since_date: Optional[str],
        until_date: Optional[str],
        now: Optional[str],
        tz_offset_minutes: Optional[int],
        matter_id: Optional[int] = None,
    ) -> tuple[list[EmailSearchHit], str]:
        fts_expr = self._build_positive_fts_expr(parsed)
        neg_fts_expr = self._build_negative_fts_expr(parsed)
        # T8: 收件人列 term (to~:/cc~:/from~:) 编译成 email_recipient_fts 的 IN-子查询谓词。
        recipient_predicates = self._build_recipient_predicates(parsed)
        # P5: trigram_enabled 时, parsed 路径里的裸 CJK 词编译成 trigram IN/NOT-IN 谓词
        # (与 from:/is:/date 等过滤 AND); 同步收 1 字 CJK 拦截 warning。flag=False → 空。
        cjk_trigram_predicates: list[FilterPredicate] = []
        if self.trigram_enabled:
            cjk_trigram_predicates = self._build_cjk_trigram_predicates(parsed)
            parsed.warnings.extend(self._collect_cjk_term_warnings(parsed))
        # D1-D3: attachment: 内容检索谓词 (恒建, flag-aware 路由在 predicate 内部;
        # 1 字 CJK 拦截 warning 仅 trigram-on 收集, 与裸 CJK 词一致)。
        attachment_content_predicates = self._build_attachment_content_predicates(parsed)
        if self.trigram_enabled:
            parsed.warnings.extend(self._collect_attachment_term_warnings(parsed))
        # 排名用的正向收件人 MATCH 表达式 (recipient-only 路径用)。
        positive_recipient_expr = self._build_positive_recipient_fts_expr(parsed)
        filters, structured_warnings = build_structured_filter_predicates(
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
            now=now,
            tz_offset_minutes=tz_offset_minutes,
        )
        self._append_matter_filter(filters, matter_id)
        parsed.warnings.extend(structured_warnings)

        predicates: list[FilterPredicate] = [
            *parsed.filters,
            *self._compile_or_filter_groups(parsed.or_filter_groups),
            *filters,
            *recipient_predicates,
            *cjk_trigram_predicates,
            *attachment_content_predicates,
        ]
        predicates.extend(
            FilterPredicate(f"NOT ({predicate.sql})", predicate.params)
            for predicate in parsed.neg_filters
        )

        if not fts_expr and not neg_fts_expr and not predicates:
            return [], parsed.original_query

        params: list = []
        if fts_expr:
            hits = self._search_email_bodies_fused(
                body_fts_expr=fts_expr,
                attachment_fts_expr=self._build_attachment_positive_fts_expr(parsed),
                metadata_predicates=predicates,
                neg_body_fts_expr=neg_fts_expr,
                neg_attachment_fts_expr=self._build_attachment_negative_fts_expr(parsed),
                attachment_body_gate_expr=self._build_attachment_body_gate_expr(parsed),
                sort=parsed.sort,
                limit=limit,
                query_for_log=fts_expr,
            )
            return hits, fts_expr
        elif positive_recipient_expr and parsed.sort not in ("date", "oldest"):
            # T8 recipient-only 路径: 无正文裸词/列词, 但有正向收件人列 term → 直接查
            # email_recipient_fts MATCH 取 bm25 排名 (recipient 命中相关度)。
            # sort:date / sort:oldest 仍走下面纯过滤分支按时间排 (与 body 路径语义一致)。
            # 排名用的那条正向收件人谓词不再重复进 metadata filter (避免双查)，
            # 但其余 recipient 谓词 (负向 / 多余正向组) + 结构化谓词仍作 AND 过滤。
            other_predicates = [
                *parsed.filters,
                *self._compile_or_filter_groups(parsed.or_filter_groups),
                *filters,
                # P5: 收件人排名路径里裸 CJK 词的 trigram 约束仍要 AND (如 to~:alice 评审)。
                *cjk_trigram_predicates,
                # D1-D3: attachment: 谓词在收件人排名路径也要 AND (如 to~:alice attachment:x)。
                *attachment_content_predicates,
            ]
            other_predicates.extend(
                FilterPredicate(f"NOT ({predicate.sql})", predicate.params)
                for predicate in parsed.neg_filters
            )
            # 负向收件人 term 仍要 AND 过滤掉。
            for term in parsed.neg_fts_terms:
                if not self._is_recipient_term(term):
                    continue
                neg_expr = self._recipient_match_expr(term)
                if neg_expr:
                    other_predicates.append(FilterPredicate(
                        "m.internal_id NOT IN (SELECT rowid FROM email_recipient_fts "
                        "WHERE email_recipient_fts MATCH ?)",
                        (neg_expr,),
                    ))
            hits = self._search_recipient_fts_ranked(
                recipient_fts_expr=positive_recipient_expr,
                metadata_predicates=other_predicates,
                neg_body_fts_expr=neg_fts_expr,
                limit=limit,
                query_for_log=positive_recipient_expr,
            )
            return hits, positive_recipient_expr
        else:
            sql = """
                SELECT m.internal_id,
                       COALESCE(m.subject, '')        AS subject,
                       COALESCE(m.sender, '')         AS sender,
                       m.date_received,
                       m.mailbox,
                       m.notion_page_id,
                       ''                             AS snippet,
                       0.0                            AS rank__AI_SELECT__
                  FROM email_metadata m__AI_JOIN__
                 WHERE 1 = 1
            """
            order_by = " ORDER BY datetime(m.date_received) DESC LIMIT ?"

        for predicate in predicates:
            sql += f" AND ({predicate.sql})"
            params.extend(predicate.params)
        if neg_fts_expr:
            sql += (
                " AND m.internal_id NOT IN ("
                "SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?)"
            )
            params.append(neg_fts_expr)
        # T2: sort 覆盖。默认 order_by 已按"有 fts→相关度 / 纯过滤→时间倒序"设定。
        if parsed.sort == "date":
            order_by = " ORDER BY datetime(m.date_received) DESC LIMIT ?"
        elif parsed.sort == "oldest":
            order_by = " ORDER BY datetime(m.date_received) ASC LIMIT ?"
        elif parsed.sort == "relevance" and not fts_expr:
            order_by = " ORDER BY datetime(m.date_received) DESC LIMIT ?"
        sql += order_by
        params.append(limit)

        query_for_log = fts_expr or parsed.original_query
        transformed_query = fts_expr if fts_expr else parsed.original_query
        return self._execute_email_search(sql, params, query_for_log), transformed_query

    def _execute_email_search(
        self,
        sql: str,
        params: list,
        query_for_log: str,
    ) -> list[EmailSearchHit]:
        """跑 parsed / recipient-ranked 路径的 SELECT, 拼 EmailSearchHit。

        SQL 含 ``__AI_SELECT__`` / ``__AI_JOIN__`` 占位符 (MED-2): 开连接后据 llm_processing
        是否存在替换成 priority_raw/lang_raw 投影 + LEFT JOIN (meta_alias='m')。
        """
        conn = self._connect()
        try:
            ai_select, ai_join = self._ai_fields_select_join(conn, meta_alias="m")
            final_sql = sql.replace("__AI_SELECT__", ai_select).replace(
                "__AI_JOIN__", ai_join
            )
            try:
                rows = conn.execute(final_sql, params).fetchall()
            except sqlite3.OperationalError as e:
                # FTS5 query 语法错误（unbalanced quote / lone operator 等）
                logger.warning(
                    f"search_email_bodies: invalid FTS5 query {query_for_log!r}: {e}"
                )
                return []

            hits: list[EmailSearchHit] = []
            for r in rows:
                page_id = r["notion_page_id"]
                notion_url = (
                    f"https://www.notion.so/{page_id.replace('-', '')}"
                    if page_id else None
                )
                hits.append(EmailSearchHit(
                    internal_id=r["internal_id"],
                    subject=r["subject"],
                    sender=r["sender"],
                    date_received=r["date_received"],
                    mailbox=r["mailbox"],
                    snippet=r["snippet"] or "",
                    rank=float(r["rank"]),
                    notion_page_id=page_id,
                    notion_url=notion_url,
                    source="body",
                    filename=None,
                    ai_priority=self._row_value(r, "priority_raw"),
                    lang=self._row_value(r, "lang_raw"),
                ))
            return hits
        finally:
            conn.close()

    def _search_email_bodies_fused(
        self,
        *,
        body_fts_expr: str,
        attachment_fts_expr: str,
        metadata_predicates: list[FilterPredicate],
        neg_body_fts_expr: str,
        neg_attachment_fts_expr: str,
        attachment_body_gate_expr: str,
        sort: Optional[str],
        limit: int,
        query_for_log: str,
        plain_query: Optional[str] = None,
    ) -> list[EmailSearchHit]:
        """Search body + attachment FTS and merge by email-level RRF.

        两个候选源注册成单组 (并集语义) 的行级 lane, 交由 ``_merge_lane_groups`` 单点
        RRF 合并 (行级 lane 的 metadata 谓词已内联在 lane SQL)。lane 注册顺序
        = payload 优先级: 正文+附件同时命中时 source='body'、保留正文 snippet。

        PR4 (1a 纯英文子串 + 1f 文件名): ``plain_query`` 非 None (仅 plain fast-path
        传入; parsed 路径恒 None → 逐字节不变) 且 master trigram flag + latin flag
        均开时, 组内**union-only 追加**两条 id 级 lane (只增召回不减, AND 语义零变化):
          - body-trigram-whole: 整 query (>=3 字符) 经 _quote_fts_token 短语 MATCH
            email_body_fts_trigram —— 单词 query 获得子串模糊 (Omad→Omada), 多词
            query 获得相邻短语子串。**不做 per-term AND 重组** (会改英文多词旧语义)。
          - attachment-trigram-whole: 同短语 MATCH email_attachment_fts_trigram
            (英文附件文本/文件名子串可搜)。
        id 级 lane 无内联谓词 → 混入时合并点补统一 metadata 后置过滤 (对行级 lane id
        幂等)。None-row 候选 (仅新 lane 命中) 走 ``_materialize_id_candidates`` 物化
        (PR1 验收 LOW#1 的 None-row 分支)。plain fast-path 的 neg/gate expr 恒空,
        id 级 lane 无需负向过滤。

        ``rank`` on the returned ``EmailSearchHit`` is ``-rrf_score`` so existing
        callers that treat lower scores as more relevant keep the same ordering
        intuition even though the underlying score is no longer raw bm25.
        """
        if not body_fts_expr or limit <= 0:
            return []

        candidate_limit = self._rrf_candidate_limit(limit)
        conn = self._connect()
        try:
            body_rows = self._fetch_body_fts_rows(
                conn,
                fts_expr=body_fts_expr,
                metadata_predicates=metadata_predicates,
                neg_body_fts_expr=neg_body_fts_expr,
                sort=sort,
                limit=candidate_limit,
                query_for_log=query_for_log,
            )
            lanes = [_SearchLane("body-unicode", self._rows_to_lane_entries(body_rows))]
            if attachment_fts_expr:
                attachment_rows = self._fetch_attachment_fts_rows(
                    conn,
                    fts_expr=attachment_fts_expr,
                    metadata_predicates=metadata_predicates,
                    neg_body_fts_expr=neg_body_fts_expr,
                    neg_attachment_fts_expr=neg_attachment_fts_expr,
                    body_gate_fts_expr=attachment_body_gate_expr,
                    sort=sort,
                    limit=candidate_limit,
                    query_for_log=attachment_fts_expr,
                )
                lanes.append(_SearchLane(
                    "attachment-unicode",
                    self._rows_to_lane_entries(attachment_rows),
                ))

            # PR4: plain fast-path 的整 query trigram 双 lane (union-only 追加)。
            whole_expr = ""
            body_trigram_id_set: set[int] = set()
            attachment_info: dict[int, tuple[int, str]] = {}
            id_lane_added = False
            if (
                plain_query is not None
                and self.trigram_enabled
                and self.latin_trigram_enabled
            ):
                stripped = plain_query.strip()
                if len(stripped) >= 3:
                    whole_expr = _quote_fts_token(stripped)
                    body_trigram_ids = self._fts_match_ids(
                        conn,
                        "email_body_fts_trigram",
                        whole_expr,
                        query_for_log=stripped,
                    )
                    if body_trigram_ids:
                        lanes.append(_SearchLane(
                            "body-trigram-whole",
                            [(iid, None) for iid in body_trigram_ids],
                        ))
                        body_trigram_id_set = set(body_trigram_ids)
                        id_lane_added = True
                    attachment_entries = self._attachment_trigram_match_entries(
                        conn, whole_expr, query_for_log=stripped
                    )
                    if attachment_entries:
                        lanes.append(_SearchLane(
                            "attachment-trigram-whole",
                            [(iid, None) for iid, _, _ in attachment_entries],
                        ))
                        for iid, att_id, filename in attachment_entries:
                            attachment_info.setdefault(iid, (att_id, filename))
                        id_lane_added = True

            merged = self._merge_lane_groups(
                conn,
                [lanes],
                # id 级 lane 无内联谓词 → 混入时补统一后置过滤 (行级 lane id 幂等);
                # 纯行级 (旧形态) 不传 → 与 PR1 行为逐字节一致。
                post_filter_predicates=(
                    metadata_predicates if id_lane_added else None
                ),
                sort=sort,
                limit=limit,
            )
            # LOW#1: 行级候选走 _merged_row_to_hit; None-row 候选 (仅 id 级 lane 命中)
            # 批量补查 metadata 物化 (source/filename/snippet 见 materializer doc)。
            none_candidates = [c for c in merged if c.row is None]
            materialized = self._materialize_id_candidates(
                conn,
                none_candidates,
                snippet_expr=whole_expr,
                body_hit_ids=body_trigram_id_set,
                attachment_info=attachment_info,
            )
            hits: list[EmailSearchHit] = []
            for candidate in merged:
                if candidate.row is not None:
                    hits.append(self._merged_row_to_hit(candidate))
                    continue
                hit = materialized.get(candidate.internal_id)
                if hit is not None:
                    hits.append(hit)
            return hits
        finally:
            conn.close()

    @staticmethod
    def _rows_to_lane_entries(
        rows: list[sqlite3.Row],
    ) -> list[tuple[int, Optional[sqlite3.Row]]]:
        """行级 lane 的候选构造: SQL 已按相关度排好序, 原序进 lane。"""
        return [(int(r["internal_id"]), r) for r in rows]

    @staticmethod
    def _rrf_candidate_limit(limit: int) -> int:
        return min(
            max(limit * _RRF_FETCH_MULTIPLIER, limit + _RRF_FETCH_MIN_EXTRA),
            _RRF_FETCH_MAX,
        )

    @staticmethod
    def _fts_branch_order_by(sort: Optional[str]) -> str:
        if sort == "date":
            return "datetime(m.date_received) DESC"
        if sort == "oldest":
            return "datetime(m.date_received) ASC"
        return "rank ASC, datetime(m.date_received) DESC"

    @staticmethod
    def _append_metadata_predicates(
        sql: str,
        params: list,
        predicates: list[FilterPredicate],
    ) -> str:
        for predicate in predicates:
            sql += f" AND ({predicate.sql})"
            params.extend(predicate.params)
        return sql

    def _fetch_body_fts_rows(
        self,
        conn: sqlite3.Connection,
        *,
        fts_expr: str,
        metadata_predicates: list[FilterPredicate],
        neg_body_fts_expr: str,
        sort: Optional[str],
        limit: int,
        query_for_log: str,
    ) -> list[sqlite3.Row]:
        ai_select, ai_join = self._ai_fields_select_join(conn, meta_alias="m")
        sql = f"""
            SELECT m.internal_id,
                   COALESCE(m.subject, '')        AS subject,
                   COALESCE(m.sender, '')         AS sender,
                   m.date_received,
                   m.mailbox,
                   m.notion_page_id,
                   snippet(email_body_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                   bm25(email_body_fts, 1.0, 5.0, 2.0) AS rank,
                   'body' AS source,
                   NULL AS filename{ai_select}
              FROM email_body_fts
              JOIN email_metadata m ON m.internal_id = email_body_fts.rowid{ai_join}
             WHERE email_body_fts MATCH ?
        """
        params: list = [fts_expr]
        sql = self._append_metadata_predicates(sql, params, metadata_predicates)
        if neg_body_fts_expr:
            sql += (
                " AND m.internal_id NOT IN ("
                "SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?)"
            )
            params.append(neg_body_fts_expr)
        sql += f" ORDER BY {self._fts_branch_order_by(sort)} LIMIT ?"
        params.append(limit)
        try:
            return conn.execute(sql, params).fetchall()
        except sqlite3.OperationalError as e:
            logger.warning(
                f"search_email_bodies: invalid body FTS5 query {query_for_log!r}: {e}"
            )
            return []

    def _fetch_attachment_fts_rows(
        self,
        conn: sqlite3.Connection,
        *,
        fts_expr: str,
        metadata_predicates: list[FilterPredicate],
        neg_body_fts_expr: str,
        neg_attachment_fts_expr: str,
        body_gate_fts_expr: str,
        sort: Optional[str],
        limit: int,
        query_for_log: str,
    ) -> list[sqlite3.Row]:
        ai_select, ai_join = self._ai_fields_select_join(conn, meta_alias="m")
        sql = f"""
            SELECT m.internal_id,
                   COALESCE(m.subject, '')        AS subject,
                   COALESCE(m.sender, '')         AS sender,
                   m.date_received,
                   m.mailbox,
                   m.notion_page_id,
                   snippet(email_attachment_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                   bm25(email_attachment_fts) AS rank,
                   'attachment' AS source,
                   COALESCE(a.filename, '') AS filename{ai_select}
              FROM email_attachment_fts
              JOIN email_attachment a ON a.id = email_attachment_fts.rowid
              JOIN email_metadata m ON m.internal_id = a.internal_id{ai_join}
             WHERE email_attachment_fts MATCH ?
        """
        params: list = [fts_expr]
        sql = self._append_metadata_predicates(sql, params, metadata_predicates)
        if body_gate_fts_expr:
            sql += (
                " AND m.internal_id IN ("
                "SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?)"
            )
            params.append(body_gate_fts_expr)
        if neg_body_fts_expr:
            sql += (
                " AND m.internal_id NOT IN ("
                "SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?)"
            )
            params.append(neg_body_fts_expr)
        if neg_attachment_fts_expr:
            sql += (
                " AND a.id NOT IN ("
                "SELECT rowid FROM email_attachment_fts WHERE email_attachment_fts MATCH ?)"
            )
            params.append(neg_attachment_fts_expr)
        sql += f" ORDER BY {self._fts_branch_order_by(sort)} LIMIT ?"
        params.append(limit)
        try:
            return conn.execute(sql, params).fetchall()
        except sqlite3.OperationalError as e:
            logger.warning(
                f"search_email_bodies: attachment FTS unavailable or invalid "
                f"query {query_for_log!r}: {e}"
            )
            return []

    def _merge_lane_groups(
        self,
        conn: sqlite3.Connection,
        lane_groups: list[list[_SearchLane]],
        *,
        post_filter_predicates: Optional[list[FilterPredicate]] = None,
        sort: Optional[str] = None,
        limit: int,
    ) -> list[_MergedCandidate]:
        """plain 管线的单点 RRF 合并 + 统一 metadata 过滤 (组合语义见模块级 lane 注释)。

        ① 组内并集 / 组间 AND 交集 → 最终候选集 (fused = 单组 body ∪ attachment;
           trigram = term 间交集);
        ② 后置 metadata 过滤: ``_filter_ids_by_metadata`` 分块 (NS-3), 仅 id 级 lane
           路径需要 —— 行级 lane 谓词已内联 SQL, caller 传 None 跳过;
        ③ RRF: 每个 lane 内按「候选集中的出现位置」计 1/(_RRF_K + pos) 跨 lane 求和
           (非候选 id 不占位, 与旧 trigram 路径一致; 行级路径候选集 = 全部行, 与旧
           fused 路径一致)。scores dict 插入顺序 = 首个 lane 的候选顺序 → (score,
           date) 全等时排序稳定, tie-break 与两条旧路径一致;
        ④ 排序 (sort=None → score DESC + date DESC; 'date'/'oldest' 覆盖) + 裁 top-limit。
        """
        group_id_sets: list[set[int]] = []
        for lanes in lane_groups:
            group_ids: set[int] = set()
            for lane in lanes:
                group_ids.update(iid for iid, _ in lane.entries)
            if not group_ids:
                # 任一 AND 组无候选 → 交集必空。
                return []
            group_id_sets.append(group_ids)
        if not group_id_sets:
            return []
        eligible = set.intersection(*group_id_sets)
        if not eligible:
            return []

        if post_filter_predicates:
            eligible = self._filter_ids_by_metadata(
                conn, eligible, post_filter_predicates
            )
            if not eligible:
                return []

        scores: dict[int, float] = {}
        row_by_id: dict[int, sqlite3.Row] = {}
        for lanes in lane_groups:
            for lane in lanes:
                pos = 0
                seen: set[int] = set()
                for iid, row in lane.entries:
                    if iid not in eligible or iid in seen:
                        continue
                    seen.add(iid)
                    pos += 1
                    scores[iid] = scores.get(iid, 0.0) + 1.0 / (_RRF_K + pos)
                    if row is not None and iid not in row_by_id:
                        row_by_id[iid] = row

        # 排序所需 date: 行级 lane 直接读 row; id 级 lane 统一补查 (分块, NS-3)。
        # 缺 email_metadata 行的 id 得 None date (排序垫底), 仍占 top-limit 槽位,
        # 由物化路径丢弃 —— 与旧 trigram 行为一致。
        date_by_id: dict[int, Optional[str]] = {}
        missing = [iid for iid in scores if iid not in row_by_id]
        for chunk in self._chunk_ids(missing):
            placeholders = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"SELECT internal_id, date_received FROM email_metadata "
                f"WHERE internal_id IN ({placeholders})",
                chunk,
            ).fetchall()
            for r in rows:
                date_by_id[int(r["internal_id"])] = r["date_received"]

        def date_of(iid: int) -> Optional[str]:
            row = row_by_id.get(iid)
            if row is not None:
                return row["date_received"]
            return date_by_id.get(iid)

        candidates = list(scores.items())
        if sort == "date":
            candidates.sort(
                key=lambda kv: (
                    self._date_sort_value(date_of(kv[0]), oldest=False),
                    kv[1],
                ),
                reverse=True,
            )
        elif sort == "oldest":
            candidates.sort(
                key=lambda kv: (
                    self._date_sort_value(date_of(kv[0]), oldest=True),
                    -kv[1],
                )
            )
        else:
            candidates.sort(
                key=lambda kv: (
                    kv[1],
                    self._date_sort_value(date_of(kv[0]), oldest=False),
                ),
                reverse=True,
            )

        return [
            _MergedCandidate(
                internal_id=iid, rrf_score=score, row=row_by_id.get(iid)
            )
            for iid, score in candidates[:limit]
        ]

    def _merged_row_to_hit(self, candidate: _MergedCandidate) -> EmailSearchHit:
        """行级 lane 候选 → EmailSearchHit (fused 路径物化, row 携带全部投影)。"""
        row = candidate.row
        page_id = row["notion_page_id"]
        notion_url = (
            f"https://www.notion.so/{page_id.replace('-', '')}"
            if page_id else None
        )
        source = row["source"]
        return EmailSearchHit(
            internal_id=candidate.internal_id,
            subject=row["subject"],
            sender=row["sender"],
            date_received=row["date_received"],
            mailbox=row["mailbox"],
            snippet=row["snippet"] or "",
            rank=-float(candidate.rrf_score),
            notion_page_id=page_id,
            notion_url=notion_url,
            source=source,
            filename=row["filename"] if source == "attachment" else None,
            # MED-2: priority_raw/lang_raw 来自 email_metadata join (body/attachment 同邮件
            # 一致), serve-api 出口映射成 wire enum。
            ai_priority=self._row_value(row, "priority_raw"),
            lang=self._row_value(row, "lang_raw"),
        )

    @staticmethod
    def _date_sort_value(value: Optional[str], *, oldest: bool) -> float:
        if not value:
            return float("inf") if oldest else float("-inf")
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return float("inf") if oldest else float("-inf")
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()

    def search_email_bodies_smart(
        self,
        query: str,
        *,
        limit: int = 50,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
    ) -> list[EmailSearchHit]:
        """Smart wrapper of search_email_bodies — Search Query DSL v1 + CJK-aware.

        纯文本查询仍走旧 smart transform fast-path；含字段语法时由 parser 编译。
        """
        return self.search_email_bodies_with_meta(
            query,
            mode="smart",
            limit=limit,
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
        ).hits

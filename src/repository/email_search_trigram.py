"""Trigram, CJK2 bigram, and metadata materialization mixin for EmailRepository."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from typing import Optional

from loguru import logger

from src.repository.cjk_bigram import extract_cjk_bigrams, is_pure_cjk_bigram
from src.repository.email_models import (
    _IN_CHUNK_SIZE,
    EmailSearchHit,
    EmailSearchResult,
    _MergedCandidate,
    _SearchLane,
    _TermRoute,
    _quote_fts_token,
    build_search_plan,
    build_trigram_snippet_expr,
)
from src.repository.search_query import (
    FilterPredicate,
    ParsedSearchQuery,
    build_structured_filter_predicates,
    escape_like_value,
)


class _EmailSearchTrigramMixin:
    """Trigram, CJK2, and candidate materialization methods for EmailRepository."""

    @property
    def trigram_enabled(self) -> bool:
        """T7 CJK trigram 路由是否启用。

        构造时显式传了 ``trigram_enabled=`` → 直用；否则懒读
        ``config.search_trigram_enabled``（Phase A G-A6 起默认 True；读 config 失败 /
        缺必填 env → 退回 False，保证无 .env 的测试 / CLI 上下文不炸）。
        """
        if self._trigram_enabled_override is not None:
            return self._trigram_enabled_override
        try:
            from src.config import config as _config
            return bool(getattr(_config, "search_trigram_enabled", False))
        except Exception:
            return False

    @property
    def latin_trigram_enabled(self) -> bool:
        """PR2: 含 CJK 混合 query 中 >=3 字符拉丁 token 的双 lane 开关。

        构造时显式传了 ``latin_trigram_enabled=`` → 直用；否则懒读
        ``config.search_latin_trigram_enabled``（默认 True；读 config 失败 → False，
        镜像 ``trigram_enabled`` 的降级语义）。仅在 trigram 路由内生效
        （``trigram_enabled=True`` 且裸查含 CJK）；trigram 总开关关闭时整个
        trigram 路由不存在，本开关无意义。
        """
        if self._latin_trigram_enabled_override is not None:
            return self._latin_trigram_enabled_override
        try:
            from src.config import config as _config
            return bool(getattr(_config, "search_latin_trigram_enabled", False))
        except Exception:
            return False

    def _search_email_bodies_trigram(
        self,
        query: str,
        *,
        parsed: ParsedSearchQuery,
        limit: int,
        mailbox: Optional[str],
        since_date: Optional[str],
        until_date: Optional[str],
        now: Optional[str],
        tz_offset_minutes: Optional[int],
        matter_id: Optional[int] = None,
    ) -> Optional[EmailSearchResult]:
        """裸全文 query 的 CJK trigram 路由 (T7)。

        - 每个 term 按 ``build_search_plan`` 路由 (unicode / trigram[mode=match|like] /
          too_short); 含 CJK 的整 term 整体走 trigram 子串 (不拆段)。
        - 每个 term 产出一个 AND 组 (id 级 lane, 全召回); 组间交集 / metadata 后置过滤 /
          RRF 融合统一由 ``_merge_lane_groups`` 单点完成, ORDER BY score DESC, date DESC。
        - PR2: ``latin_trigram_enabled`` 时, unicode route 的 >=3 字符拉丁 token 组内
          追加 body-trigram 子串 lane (组内并集), 修复连写文档 (正文 'Omada固件升级')
          漏召回; flag off = 拉丁 token 回单 unicode lane (PR2 前行为, 逐字节)。
        - PR4 (1b/1f): 每个 term 组再追加 attachment-trigram lane (组内并集) —— 组语义
          =「该 term 出现在 正文 OR 附件文本 OR 文件名」; 组间 AND 语义不变 (每个 term
          至少命中邮件某处)。CJK term 的附件 lane 只受 master 门 (trigram_enabled);
          拉丁 term (>=3 字符) 的附件 lane 另受 latin flag 门 (镜像 body 双 lane)。
          候选映射 attachment_id → internal_id (JOIN email_attachment), 同邮件多附件
          命中按邮件去重 (保留 bm25 最优位次); metadata 后置过滤在合并点对附件命中
          同样生效。attachment-only 命中物化为 source='attachment' + filename。
        - 恒返回 ``EmailSearchResult``(从不返回 None); 全部 term 都被拦截 (例如纯单字
          CJK query '我') 或某 term 组无任何候选 (AND 交集为空) 时同样返回空结果 + 已
          收集的 warning (如 1 字拦截的 `cjk_too_short`), 而非 None。

        纯英文裸查 / 列级 FTS 不在此路径 (那些走 fused / parsed), 故 T6 不受影响
        (本路径只在 query 含 CJK 时被走到)。
        """
        terms = query.split()
        routes, plan_warnings = build_search_plan(terms)

        structured_filters, structured_warnings = build_structured_filter_predicates(
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
            now=now,
            tz_offset_minutes=tz_offset_minutes,
        )
        self._append_matter_filter(structured_filters, matter_id)
        warnings = [*parsed.warnings, *plan_warnings, *structured_warnings]

        # 全部 term 被拦截 (例如纯单字 CJK query '我') → 不查, 返回空 + warning。
        if not routes:
            return EmailSearchResult([], query, warnings)

        conn = self._connect()
        try:
            # 每个 term 一个 AND 组 (后续批次往组里追加附件 lane 即成小 diff)。
            # 候选全召回不截断 (NS-3: 交集前截断会丢真命中)。
            # PR2: route='unicode' 且 token >=3 字符且 latin flag 开 → 组内追加
            # body-trigram 子串 lane (组内并集: unicode61 整词/前缀命中 ∪ trigram
            # 子串命中)。修复连写文档漏召回: 正文 'Omada固件升级' (无空格) 被
            # unicode61 切成单 token → MATCH Omada 零命中 → 旧单 lane 组空 →
            # AND 交集清空整查询; 双 lane 后 trigram 子串兜住。整词命中同时出现
            # 在两条 lane → RRF 叠加 → 天然排前于仅子串命中。<3 字符拉丁 token
            # 保持单 unicode lane (trigram MATCH <3 字符无召回, 硬约束)。
            lane_groups: list[list[_SearchLane]] = []
            latin_dual = self.latin_trigram_enabled
            # PR4: body 命中 id 全集 (任一 body lane) + 附件命中信息 (internal_id →
            # (attachment_id, filename))。物化时 body 命中优先 (正文+附件同 term 双命中
            # 去重 source='body', 与 fused 路径 lane 注册顺序语义一致)。
            body_hit_ids: set[int] = set()
            attachment_info: dict[int, tuple[int, str]] = {}
            for route in routes:
                lanes: list[_SearchLane] = []
                ids = self._trigram_term_candidate_ids(
                    conn, route, query_for_log=query
                )
                if ids:
                    lanes.append(_SearchLane(
                        f"body-{route.route}", [(iid, None) for iid in ids]
                    ))
                    body_hit_ids.update(ids)
                if (
                    latin_dual
                    and route.route == "unicode"
                    and len(route.original) >= 3
                ):
                    trigram_ids = self._fts_match_ids(
                        conn,
                        "email_body_fts_trigram",
                        _quote_fts_token(route.original),
                        query_for_log=query,
                    )
                    if trigram_ids:
                        lanes.append(_SearchLane(
                            "body-trigram-latin",
                            [(iid, None) for iid in trigram_ids],
                        ))
                        body_hit_ids.update(trigram_ids)
                # PR4 (1b/1f): attachment-trigram lane (组内并集; 全召回不截断 NS-3)。
                attachment_entries = self._attachment_trigram_entries_for_route(
                    conn, route, latin_dual=latin_dual, query_for_log=query
                )
                if attachment_entries:
                    lanes.append(_SearchLane(
                        "attachment-trigram",
                        [(iid, None) for iid, _, _ in attachment_entries],
                    ))
                    for iid, att_id, filename in attachment_entries:
                        attachment_info.setdefault(iid, (att_id, filename))
                if not lanes:
                    # 该 term 组无任何候选 → AND 交集为空, 直接空结果 (warning 仍透传)。
                    return EmailSearchResult([], query, warnings)
                lane_groups.append(lanes)

            merged = self._merge_lane_groups(
                conn,
                lane_groups,
                post_filter_predicates=structured_filters,
                limit=limit,
            )
            hits = self._build_trigram_hits(
                conn,
                merged,
                routes,
                body_hit_ids=body_hit_ids,
                attachment_info=attachment_info,
            )
            return EmailSearchResult(hits, query, warnings)
        finally:
            conn.close()

    def _trigram_term_candidate_ids(
        self,
        conn: sqlite3.Connection,
        route: _TermRoute,
        *,
        query_for_log: str,
    ) -> list[int]:
        """单个 term 的有序候选 internal_id 列表。

        - route='unicode': 主表 email_body_fts MATCH (unicode_expr), bm25 升序。
        - route='trigram' mode='match': **整 term** 走并行 trigram 表 MATCH 整串短语
          (含符号/混合时必须 quote 成短语, 否则触发 FTS5 语法错误; 纯中文也安全), bm25 升序。
        - route='trigram' mode='like': 整 term (2 字 CJK) 走 trigram 表 LIKE '%整串%' 兜底。

        候选**不截断**: 多 term 之间是 AND (rowid 交集), per-term 先截断再交集会丢真命中
        (大库两宽泛词 top-N 窗口可能无交集, 但更后面有共同命中) → 每 term 全召回。
        NS-3 的「IN() 撑爆参数上限」崩溃风险改在 ``_filter_ids_by_metadata`` 分块解决
        (见该方法), 不丢任何 id。
        """
        if route.route == "unicode":
            return self._fts_match_ids(
                conn,
                "email_body_fts",
                route.unicode_expr,
                query_for_log=query_for_log,
            )

        # trigram term: 整 term 走并行 trigram 表子串检索 (不再拆段 AND)。
        if route.trigram_mode == "match":
            return self._fts_match_ids(
                conn,
                "email_body_fts_trigram",
                _quote_fts_token(route.trigram_core),
                query_for_log=query_for_log,
            )
        # trigram_mode == 'like' (2 字 CJK)
        return self._trigram_like_ids(
            conn, route.trigram_core, query_for_log=query_for_log
        )

    def _fts_match_ids(
        self,
        conn: sqlite3.Connection,
        table: str,
        fts_expr: str,
        *,
        query_for_log: str,
    ) -> list[int]:
        """对 FTS5 表 (email_body_fts / email_body_fts_trigram) MATCH, 返回 bm25 升序 rowid。"""
        if not fts_expr:
            return []
        sql = (
            f"SELECT rowid FROM {table} WHERE {table} MATCH ? "
            f"ORDER BY bm25({table}) ASC"
        )
        try:
            rows = conn.execute(sql, (fts_expr,)).fetchall()
        except sqlite3.OperationalError as e:
            logger.warning(
                f"search_email_bodies(trigram): invalid {table} MATCH "
                f"{fts_expr!r} (query={query_for_log!r}): {e}"
            )
            return []
        return [int(r["rowid"]) for r in rows]

    def _cjk2_ready(self, conn: sqlite3.Connection) -> bool:
        """2 字 CJK bigram 并行 FTS5 表是否已完成存量回填并就绪。"""
        try:
            row = conn.execute(
                "SELECT value FROM sync_state WHERE key = 'cjk2_backfill_done'"
            ).fetchone()
            if not row or row[0] != "1":
                return False
            tbl = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='email_body_fts_cjk2'"
            ).fetchone()
            return tbl is not None
        except sqlite3.OperationalError:
            return False

    @staticmethod
    def _upsert_body_cjk2(
        conn: sqlite3.Connection, internal_id: int, body_markdown: Optional[str]
    ) -> None:
        """写入或更新单封邮件的 CJK 2-gram 索引行（缺少 v75 表时静默降级）。"""
        try:
            meta = conn.execute(
                "SELECT subject, sender FROM email_metadata WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            subject = meta["subject"] if meta else ""
            sender = meta["sender"] if meta else ""
            body_bg = extract_cjk_bigrams(body_markdown)
            subj_bg = extract_cjk_bigrams(subject)
            sender_bg = extract_cjk_bigrams(sender)
            conn.execute("DELETE FROM email_body_fts_cjk2 WHERE rowid = ?", (internal_id,))
            if body_bg or subj_bg or sender_bg:
                conn.execute(
                    """INSERT INTO email_body_fts_cjk2
                       (rowid, body_bg, subject_bg, sender_bg)
                       VALUES (?, ?, ?, ?)""",
                    (internal_id, body_bg, subj_bg, sender_bg),
                )
        except sqlite3.OperationalError:
            pass

    @staticmethod
    def _upsert_attachment_cjk2(
        conn: sqlite3.Connection,
        attachment_id: int,
        text_content: Optional[str],
        status: str,
    ) -> None:
        """写入或更新单份已抽取附件的 CJK 2-gram 索引行（缺少 v75 表时静默降级）。"""
        try:
            conn.execute(
                "DELETE FROM email_attachment_fts_cjk2 WHERE rowid = ?",
                (attachment_id,),
            )
            if status != "extracted" or not text_content:
                return
            att = conn.execute(
                "SELECT filename FROM email_attachment WHERE id = ?",
                (attachment_id,),
            ).fetchone()
            filename = att["filename"] if att else ""
            fn_bg = extract_cjk_bigrams(filename)
            txt_bg = extract_cjk_bigrams(text_content)
            if fn_bg or txt_bg:
                conn.execute(
                    """INSERT INTO email_attachment_fts_cjk2
                       (rowid, filename_bg, text_bg)
                       VALUES (?, ?, ?)""",
                    (attachment_id, fn_bg, txt_bg),
                )
        except sqlite3.OperationalError:
            pass

    def _trigram_like_ids(
        self,
        conn: sqlite3.Connection,
        value: str,
        *,
        query_for_log: str,
    ) -> list[int]:
        """2 字 CJK: 优先走 email_body_fts_cjk2 bigram 倒排索引，未就绪或混合词回落 trigram LIKE。

        无 bm25, 按启发式排序: subject 命中 > sender 命中 > body 命中, 同档按 rowid DESC。
        """
        if is_pure_cjk_bigram(value) and self._cjk2_ready(conn):
            sql_cjk2 = """
                SELECT rowid,
                       CASE
                           WHEN instr(subject_bg, ?) > 0 THEN 0
                           WHEN instr(sender_bg, ?)  > 0 THEN 1
                           ELSE 2
                       END AS boost
                  FROM email_body_fts_cjk2
                 WHERE email_body_fts_cjk2 MATCH ?
                 ORDER BY boost ASC, rowid DESC
            """
            try:
                rows = conn.execute(
                    sql_cjk2, (value, value, _quote_fts_token(value))
                ).fetchall()
                return [int(r["rowid"]) for r in rows]
            except sqlite3.OperationalError as e:
                logger.warning(
                    f"search_email_bodies(cjk2): MATCH failed for "
                    f"{value!r} (query={query_for_log!r}), falling back to LIKE: {e}"
                )

        like = f"%{escape_like_value(value)}%"
        sql = """
            SELECT rowid,
                   CASE
                       WHEN subject LIKE ? ESCAPE '\\' THEN 0
                       WHEN sender  LIKE ? ESCAPE '\\' THEN 1
                       ELSE 2
                   END AS boost
              FROM email_body_fts_trigram
             WHERE body_markdown LIKE ? ESCAPE '\\'
                OR subject LIKE ? ESCAPE '\\'
                OR sender LIKE ? ESCAPE '\\'
             ORDER BY boost ASC, rowid DESC
        """
        try:
            rows = conn.execute(sql, (like, like, like, like, like)).fetchall()
        except sqlite3.OperationalError as e:
            logger.warning(
                f"search_email_bodies(trigram): LIKE fallback failed for "
                f"{value!r} (query={query_for_log!r}): {e}"
            )
            return []
        return [int(r["rowid"]) for r in rows]

    def _attachment_trigram_entries_for_route(
        self,
        conn: sqlite3.Connection,
        route: _TermRoute,
        *,
        latin_dual: bool,
        query_for_log: str,
    ) -> list[tuple[int, int, str]]:
        """单个 term 的附件 trigram lane 候选 (internal_id, attachment_id, filename)。

        路由镜像 body 侧:
          - unicode term (拉丁): >=3 字符且 latin flag 开 → MATCH 整 term 短语;
            <3 字符或 flag 关 → 无附件 lane (拉丁附件面属 1a, 受 latin 门)。
          - trigram term mode='match' (含 CJK >=3 字) → MATCH 整串短语 —— **只受
            master 门** (1b 中文附件融合, 不受 latin flag 影响)。
          - trigram term mode='like' (2 字 CJK) → filename/text_content LIKE 兜底。
        """
        if route.route == "unicode":
            if not latin_dual or len(route.original) < 3:
                return []
            return self._attachment_trigram_match_entries(
                conn, _quote_fts_token(route.original), query_for_log=query_for_log
            )
        if route.trigram_mode == "match":
            return self._attachment_trigram_match_entries(
                conn,
                _quote_fts_token(route.trigram_core),
                query_for_log=query_for_log,
            )
        # trigram_mode == 'like' (2 字 CJK)
        return self._attachment_trigram_like_entries(
            conn, route.trigram_core, query_for_log=query_for_log
        )

    def _attachment_trigram_match_entries(
        self,
        conn: sqlite3.Connection,
        fts_expr: str,
        *,
        query_for_log: str,
    ) -> list[tuple[int, int, str]]:
        """email_attachment_fts_trigram MATCH → 邮件级有序候选 (bm25 升序)。

        - MATCH 默认跨 filename + text_content 两列 → 文件名命中免费获得 (1f)。
        - 同邮件多附件命中同 term → 按 internal_id 去重, 保留 bm25 最优位次。
        - 全召回不截断 (NS-3: 交集/合并前截断会丢真命中)。
        - graceful degrade: 表缺失 (v38 旧库未迁 v39) → OperationalError 接住返回空,
          搜索不崩 (仅少附件维度)。
        """
        if not fts_expr:
            return []
        sql = """
            SELECT a.internal_id AS internal_id,
                   email_attachment_fts_trigram.rowid AS attachment_id,
                   COALESCE(a.filename, '') AS filename
              FROM email_attachment_fts_trigram
              JOIN email_attachment a ON a.id = email_attachment_fts_trigram.rowid
             WHERE email_attachment_fts_trigram MATCH ?
             ORDER BY bm25(email_attachment_fts_trigram) ASC
        """
        try:
            rows = conn.execute(sql, (fts_expr,)).fetchall()
        except sqlite3.OperationalError as e:
            logger.warning(
                f"search_email_bodies(trigram): attachment trigram FTS unavailable "
                f"or invalid MATCH {fts_expr!r} (query={query_for_log!r}): {e}"
            )
            return []
        return self._dedupe_attachment_rows(rows)

    def _attachment_trigram_like_entries(
        self,
        conn: sqlite3.Connection,
        value: str,
        *,
        query_for_log: str,
    ) -> list[tuple[int, int, str]]:
        """2 字 CJK: 优先走 email_attachment_fts_cjk2 倒排索引，未就绪或混合词回落 trigram LIKE。"""
        if (
            is_pure_cjk_bigram(value)
            and self._cjk2_ready(conn)
            and self._attachment_trigram_table_present(conn)
        ):
            sql_cjk2 = """
                SELECT a.internal_id AS internal_id,
                       email_attachment_fts_cjk2.rowid AS attachment_id,
                       COALESCE(a.filename, '') AS filename,
                       CASE
                           WHEN instr(email_attachment_fts_cjk2.filename_bg, ?) > 0 THEN 0
                           ELSE 1
                       END AS boost
                  FROM email_attachment_fts_cjk2
                  JOIN email_attachment a ON a.id = email_attachment_fts_cjk2.rowid
                 WHERE email_attachment_fts_cjk2 MATCH ?
                 ORDER BY boost ASC, email_attachment_fts_cjk2.rowid DESC
            """
            try:
                rows = conn.execute(
                    sql_cjk2, (value, _quote_fts_token(value))
                ).fetchall()
                return self._dedupe_attachment_rows(rows)
            except sqlite3.OperationalError as e:
                logger.warning(
                    f"search_email_bodies(cjk2): attachment MATCH failed for "
                    f"{value!r} (query={query_for_log!r}), falling back to LIKE: {e}"
                )

        like = f"%{escape_like_value(value)}%"
        sql = """
            SELECT a.internal_id AS internal_id,
                   email_attachment_fts_trigram.rowid AS attachment_id,
                   COALESCE(a.filename, '') AS filename,
                   CASE
                       WHEN email_attachment_fts_trigram.filename
                            LIKE ? ESCAPE '\\' THEN 0
                       ELSE 1
                   END AS boost
              FROM email_attachment_fts_trigram
              JOIN email_attachment a ON a.id = email_attachment_fts_trigram.rowid
             WHERE email_attachment_fts_trigram.filename LIKE ? ESCAPE '\\'
                OR email_attachment_fts_trigram.text_content LIKE ? ESCAPE '\\'
             ORDER BY boost ASC, email_attachment_fts_trigram.rowid DESC
        """
        try:
            rows = conn.execute(sql, (like, like, like)).fetchall()
        except sqlite3.OperationalError as e:
            logger.warning(
                f"search_email_bodies(trigram): attachment trigram LIKE fallback "
                f"failed for {value!r} (query={query_for_log!r}): {e}"
            )
            return []
        return self._dedupe_attachment_rows(rows)

    @staticmethod
    def _dedupe_attachment_rows(
        rows: list[sqlite3.Row],
    ) -> list[tuple[int, int, str]]:
        """附件行 → 邮件级候选: 同 internal_id 多附件命中保留最优位次 (首次出现)。"""
        entries: list[tuple[int, int, str]] = []
        seen: set[int] = set()
        for r in rows:
            iid = int(r["internal_id"])
            if iid in seen:
                continue
            seen.add(iid)
            entries.append((iid, int(r["attachment_id"]), r["filename"] or ""))
        return entries

    @staticmethod
    def _chunk_ids(ids: list[int], size: int = _IN_CHUNK_SIZE) -> Iterator[list[int]]:
        """把 id 列表切成 ≤size 的批 (NS-3: 防 IN(...) 超 SQLite 参数上限)。"""
        for i in range(0, len(ids), size):
            yield ids[i : i + size]

    def _llm_processing_available(self, conn: sqlite3.Connection) -> bool:
        """``llm_processing`` 表是否存在 (旧/裸/测试库可能无 → 投影降级)。实例级 memo。"""
        if self._has_llm_processing is None:
            row = conn.execute(
                "SELECT 1 FROM sqlite_master "
                "WHERE type='table' AND name='llm_processing'"
            ).fetchone()
            self._has_llm_processing = row is not None
        return self._has_llm_processing

    def _ai_priority_col_available(self, conn: sqlite3.Connection) -> bool:
        """``email_metadata.ai_priority`` (v14 列) 是否存在 (裸/旧库可能无)。实例级 memo。"""
        if self._has_ai_priority_col is None:
            cols = {
                r["name"]
                for r in conn.execute("PRAGMA table_info(email_metadata)").fetchall()
            }
            self._has_ai_priority_col = "ai_priority" in cols
        return self._has_ai_priority_col

    def _ai_fields_select_join(
        self, conn: sqlite3.Connection, *, meta_alias: str
    ) -> tuple[str, str]:
        """MED-2: 搜索命中补 ai_priority + lang 投影 (镜像旧 TS 搜索 / email_views 收编)。

        返回 ``(extra_select_sql, join_sql)``:
        - ``priority_raw`` = ``COALESCE(<m>.ai_priority, labels_json.$.priority)`` (v14 主表列
          优先, fallback labels_json), 与 email_views::list_emails_enriched 同语义。
        - ``lang_raw`` = ``labels_json.$.language`` (json_valid 守卫, 否则 malformed JSON 整
          query 崩)。
        raw 串 (emoji-中文 / 'English' 等) 在 serve-api 出口经 _map_priority/_map_language
        映射成 wire enum (与旧 TS ai_mapping.ts mapPriority/mapLanguage 一致)。
        ``llm_processing`` 表缺失 (旧/测试库) → 不 JOIN, priority_raw 退化为主表列 (或 NULL),
        lang_raw NULL。
        """
        has_llm = self._llm_processing_available(conn)
        has_ai_priority = self._ai_priority_col_available(conn)
        if has_llm:
            lang_expr = (
                "CASE WHEN json_valid(l.labels_json) "
                "THEN json_extract(l.labels_json, '$.language') END"
            )
            labels_priority = (
                "CASE WHEN json_valid(l.labels_json) "
                "THEN json_extract(l.labels_json, '$.priority') END"
            )
            join_sql = (
                f" LEFT JOIN llm_processing l "
                f"ON l.internal_id = {meta_alias}.internal_id"
            )
        else:
            lang_expr = "NULL"
            labels_priority = "NULL"
            join_sql = ""
        # 与 email_views::list_emails_enriched 同语义: 有 v14 主表列 → COALESCE fallback
        # labels_json; 无该列 (裸/旧库) → 仅 labels_priority (或 NULL)。
        if has_ai_priority:
            priority_expr = f"COALESCE({meta_alias}.ai_priority, {labels_priority})"
        else:
            priority_expr = labels_priority
        extra_select = (
            f", {priority_expr} AS priority_raw, {lang_expr} AS lang_raw"
        )
        return extra_select, join_sql

    @classmethod
    def _filter_ids_by_metadata(
        cls,
        conn: sqlite3.Connection,
        ids: set[int],
        predicates: list[FilterPredicate],
    ) -> set[int]:
        """在 email_metadata 上对候选 id 套结构化谓词 (mailbox / date), 返回允许集。

        NS-3: 候选集可能数万 (trigram 全召回), ``IN(<all ids>)`` 会超 SQLite 参数上限崩溃。
        改分块 (``_IN_CHUNK_SIZE``/批) union 结果 —— 不丢任何 id (全召回保持), 仅多跑几条
        小查询。谓词参数每批重复绑定 (谓词无 id, 量小)。
        """
        if not ids:
            return set()
        if not predicates:
            return set(ids)
        predicate_sql = "".join(f" AND ({p.sql})" for p in predicates)
        predicate_params: list = [param for p in predicates for param in p.params]
        allowed: set[int] = set()
        for chunk in cls._chunk_ids(list(ids)):
            placeholders = ",".join("?" for _ in chunk)
            sql = (
                f"SELECT m.internal_id FROM email_metadata m "
                f"WHERE m.internal_id IN ({placeholders})"
                f"{predicate_sql}"
            )
            rows = conn.execute(sql, [*chunk, *predicate_params]).fetchall()
            allowed.update(int(r["internal_id"]) for r in rows)
        return allowed

    def _build_trigram_hits(
        self,
        conn: sqlite3.Connection,
        merged: list[_MergedCandidate],
        routes: list[_TermRoute],
        *,
        body_hit_ids: set[int],
        attachment_info: dict[int, tuple[int, str]],
    ) -> list[EmailSearchHit]:
        """id 级 lane 的 top-N 候选 → 查 metadata 拼 EmailSearchHit (trigram 路径物化)。

        薄 wrapper: snippet 表达式由路由计划编译 (build_trigram_snippet_expr), 物化
        主体在 ``_materialize_id_candidates`` (与 fused 路径的 None-row 物化共用)。
        """
        by_id = self._materialize_id_candidates(
            conn,
            merged,
            snippet_expr=build_trigram_snippet_expr(routes),
            body_hit_ids=body_hit_ids,
            attachment_info=attachment_info,
        )
        return [
            by_id[c.internal_id] for c in merged if c.internal_id in by_id
        ]

    def _materialize_id_candidates(
        self,
        conn: sqlite3.Connection,
        candidates: list[_MergedCandidate],
        *,
        snippet_expr: str,
        body_hit_ids: set[int],
        attachment_info: dict[int, tuple[int, str]],
    ) -> dict[int, EmailSearchHit]:
        """id 级 lane 候选 (row=None) → 补查 metadata 物化 EmailSearchHit (按 id 索引)。

        trigram 路径 (全部候选) 与 fused 路径 (仅混入的 id 级 lane 候选, PR1 验收
        LOW#1 的 None-row 物化分支) 共用。``rank`` = ``-rrf_score`` (越小越相关),
        与行级路径出口语义一致。缺 metadata 行的 id 不入 dict (占 top-N 槽位但被
        丢弃, 与旧行为一致)。

        source 判定: body lane 命中过 (``body_hit_ids``) → source='body' (正文+附件
        同 term 双命中去重, body 优先, 与 fused 行级 lane 注册顺序语义一致); 否则
        attachment-only → source='attachment' + filename (``attachment_info``)。

        snippet:
        - body 命中: ``snippet_expr`` 在 email_body_fts_trigram 上跑 snippet() 高亮;
          表达式为空 (纯 2/1 字 CJK) 或 row 不被 MATCH (只 2 字 LIKE 命中) → fallback
          body_markdown 前 ~80 字符 (保证不恒空)。
        - attachment 命中: 同表达式在 email_attachment_fts_trigram (text_content 列)
          上跑 snippet(); MATCH 不上 → fallback 附件文本前 ~80 字; filename-only
          命中 snippet 可为无高亮前缀 (前端按 filename 徽标展示)。
        """
        if not candidates:
            return {}
        # MED-2: 补 ai_priority + lang 投影 (命令面板 EmailHitRow 渲染优先级 chip + lang pip)。
        ai_select, ai_join = self._ai_fields_select_join(conn, meta_alias="m")
        meta_by_id: dict[int, sqlite3.Row] = {}
        for chunk in self._chunk_ids([c.internal_id for c in candidates]):
            placeholders = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"""SELECT m.internal_id AS internal_id,
                           COALESCE(m.subject, '') AS subject,
                           COALESCE(m.sender, '')  AS sender,
                           m.date_received AS date_received,
                           m.mailbox AS mailbox,
                           m.notion_page_id AS notion_page_id{ai_select}
                      FROM email_metadata m{ai_join}
                     WHERE m.internal_id IN ({placeholders})""",
                chunk,
            ).fetchall()
            for r in rows:
                meta_by_id[int(r["internal_id"])] = r

        def is_attachment_only(iid: int) -> bool:
            return iid not in body_hit_ids and iid in attachment_info

        body_top_ids = [
            c.internal_id
            for c in candidates
            if c.internal_id in meta_by_id and not is_attachment_only(c.internal_id)
        ]
        snippet_by_id = self._build_trigram_snippets(conn, body_top_ids, snippet_expr)
        attachment_items = [
            (c.internal_id, attachment_info[c.internal_id][0])
            for c in candidates
            if c.internal_id in meta_by_id and is_attachment_only(c.internal_id)
        ]
        attachment_snippet_by_id = self._build_attachment_trigram_snippets(
            conn, attachment_items, snippet_expr
        )

        hits: dict[int, EmailSearchHit] = {}
        for candidate in candidates:
            r = meta_by_id.get(candidate.internal_id)
            if r is None:
                continue
            page_id = r["notion_page_id"]
            notion_url = (
                f"https://www.notion.so/{page_id.replace('-', '')}"
                if page_id else None
            )
            if is_attachment_only(candidate.internal_id):
                source = "attachment"
                filename: Optional[str] = attachment_info[candidate.internal_id][1]
                snippet = attachment_snippet_by_id.get(candidate.internal_id, "")
            else:
                source = "body"
                filename = None
                snippet = snippet_by_id.get(candidate.internal_id, "")
            hits[candidate.internal_id] = EmailSearchHit(
                internal_id=candidate.internal_id,
                subject=r["subject"],
                sender=r["sender"],
                date_received=r["date_received"],
                mailbox=r["mailbox"],
                snippet=snippet,
                rank=-float(candidate.rrf_score),
                notion_page_id=page_id,
                notion_url=notion_url,
                source=source,
                filename=filename,
                ai_priority=self._row_value(r, "priority_raw"),
                lang=self._row_value(r, "lang_raw"),
            )
        return hits

    @staticmethod
    def _row_value(row: sqlite3.Row, key: str) -> Optional[str]:
        """读 Row 的可选列 (投影降级时列可能不存在) → None 而非 KeyError。"""
        try:
            return row[key]
        except (IndexError, KeyError):
            return None

    def _build_trigram_snippets(
        self,
        conn: sqlite3.Connection,
        top_ids: list[int],
        expr: str,
    ) -> dict[int, str]:
        """给 top-N trigram body 命中生成 snippet (高亮 + fallback)。

        ① 若 snippet 表达式 ``expr`` 非空 (trigram 路径由 build_trigram_snippet_expr
           编译; fused 路径为整 query 短语): 在 email_body_fts_trigram MATCH 该表达式
           + rowid IN top, 取 snippet() 高亮片段 (含 <mark>) 映射回 id。
        ② 表达式为空, 或某 id 未被 ① 命中 (只 2 字 LIKE 命中) → fallback: 取 body_markdown
           前 ~80 字符无高亮摘要。
        snippet() 只能在带 MATCH 的查询里用; fallback 摘要不经 snippet()。
        """
        if not top_ids:
            return {}
        result: dict[int, str] = {}
        if expr:
            placeholders = ",".join("?" for _ in top_ids)
            sql = (
                f"SELECT rowid, "
                f"snippet(email_body_fts_trigram, 0, '<mark>', '</mark>', '…', 24) AS snippet "
                f"FROM email_body_fts_trigram "
                f"WHERE rowid IN ({placeholders}) AND email_body_fts_trigram MATCH ?"
            )
            try:
                rows = conn.execute(sql, (*top_ids, expr)).fetchall()
                for r in rows:
                    text = r["snippet"]
                    if text:
                        result[int(r["rowid"])] = text
            except sqlite3.OperationalError as e:
                logger.warning(
                    f"search_email_bodies(trigram): snippet MATCH failed "
                    f"({expr!r}): {e}"
                )

        missing = [iid for iid in top_ids if iid not in result]
        if missing:
            placeholders = ",".join("?" for _ in missing)
            rows = conn.execute(
                f"SELECT rowid, body_markdown FROM email_body_fts_trigram "
                f"WHERE rowid IN ({placeholders})",
                missing,
            ).fetchall()
            for r in rows:
                body = r["body_markdown"] or ""
                result[int(r["rowid"])] = body[:80]
        return result

    def _build_attachment_trigram_snippets(
        self,
        conn: sqlite3.Connection,
        items: list[tuple[int, int]],
        expr: str,
    ) -> dict[int, str]:
        """给 attachment-only 命中生成 snippet (镜像 body 侧 trigram snippet 方案)。

        ``items``: (internal_id, attachment_id)。① expr 非空 → 对
        email_attachment_fts_trigram (text_content 列, 列号 1) 跑 snippet() 高亮;
        ② MATCH 不上 (纯 2 字 LIKE 命中) 或表达式空 → fallback 附件文本前 ~80 字。
        filename-only 命中 (text 无命中词) 由 ① 返回无高亮前缀或 ② 兜底 —— snippet
        允许无 <mark> (前端按 filename 徽标展示)。表缺失 graceful degrade: 两步查询
        均接住 OperationalError (attachment lane 有候选才会走到这里, 正常不触发)。
        """
        if not items:
            return {}
        iid_by_attachment = {att_id: iid for iid, att_id in items}
        att_ids = [att_id for _, att_id in items]
        result: dict[int, str] = {}
        if expr:
            placeholders = ",".join("?" for _ in att_ids)
            sql = (
                f"SELECT rowid, "
                f"snippet(email_attachment_fts_trigram, 1, '<mark>', '</mark>', '…', 24) "
                f"AS snippet "
                f"FROM email_attachment_fts_trigram "
                f"WHERE rowid IN ({placeholders}) "
                f"AND email_attachment_fts_trigram MATCH ?"
            )
            try:
                rows = conn.execute(sql, (*att_ids, expr)).fetchall()
                for r in rows:
                    text = r["snippet"]
                    if text:
                        result[iid_by_attachment[int(r["rowid"])]] = text
            except sqlite3.OperationalError as e:
                logger.warning(
                    f"search_email_bodies(trigram): attachment snippet MATCH failed "
                    f"({expr!r}): {e}"
                )

        missing_att_ids = [
            att_id for att_id in att_ids if iid_by_attachment[att_id] not in result
        ]
        if missing_att_ids:
            placeholders = ",".join("?" for _ in missing_att_ids)
            try:
                rows = conn.execute(
                    f"SELECT rowid, text_content FROM email_attachment_fts_trigram "
                    f"WHERE rowid IN ({placeholders})",
                    missing_att_ids,
                ).fetchall()
                for r in rows:
                    text = r["text_content"] or ""
                    result[iid_by_attachment[int(r["rowid"])]] = text[:80]
            except sqlite3.OperationalError as e:
                logger.warning(
                    f"search_email_bodies(trigram): attachment snippet fallback "
                    f"failed: {e}"
                )
        return result

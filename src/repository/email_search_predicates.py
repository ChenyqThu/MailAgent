"""Structured search predicate & FTS5 compiler mixin for EmailRepository."""

from __future__ import annotations

from typing import Optional

from src.repository.email_models import (
    EmailSearchHit,
    _count_cjk_chars,
    _is_simple_natural_query,
    _quote_fts_token,
    _route_text_term,
    smart_query_transform,
)
from src.repository.search_query import (
    FilterPredicate,
    ParsedSearchQuery,
    TextTerm,
    escape_like_value,
)


class _EmailSearchPredicatesMixin:
    """Boolean AST compilation to CJK trigram / FTS5 / recipient predicates."""

    @staticmethod
    def _is_recipient_term(term: TextTerm) -> bool:
        """T8: term 是否限定到收件人表 (email_recipient_fts) 列。"""
        return term.column_table == "recipient"

    @staticmethod
    def _is_bare_fulltext_term(term: TextTerm) -> bool:
        """裸全文 term: 既非 T6 列词 (column_table='body') 也非 T8 收件人词
        (column_table='recipient')。仅这类 term 在 trigram 接管范围内。"""
        return term.column is None and term.column_table is None

    @classmethod
    def _term_has_cjk(cls, term: TextTerm) -> bool:
        return cls._is_bare_fulltext_term(term) and _count_cjk_chars(term.value) > 0

    @classmethod
    def _term_is_body_column_cjk(cls, term: TextTerm) -> bool:
        """body 列 term (T6 body:/subject~:/sender~:, column_table='body') 且值含 CJK (1g)。

        收件人列 (column_table='recipient', to~:/cc~:/from~:) 不算 —— recipient 表无
        trigram 变体 (PRD out of scope), 它们照旧走 email_recipient_fts unicode61。
        """
        return (
            term.column_table == "body"
            and term.column is not None
            and _count_cjk_chars(term.value) > 0
        )

    def _cjk_term_in_predicate(
        self, term: TextTerm, *, negate: bool
    ) -> Optional[FilterPredicate]:
        """把一个裸 CJK term 编译成 IN / NOT IN 子查询谓词 (整 term 走 trigram 子串)。

        路由复用 ``_route_text_term`` (与 plain trigram 路径同一份分类语义):
          - trigram_mode='match' (整 term >=3 字) → ``email_body_fts_trigram MATCH '<整串短语>'``
          - trigram_mode='like'  (整 term =2 字)  → trigram 表 ``(body/subject/sender LIKE '%整串%')``
          - too_short (整词 1 字 CJK) → 返回 None (caller 跳过, warning 已由 caller 收集)
        整串子串检索, 不再拆段 (与历史 bug 修复一致: 混合词 ``redis培训`` 作为连续串整体匹配)。
        负向 → 对称 NOT IN。
        """
        route = _route_text_term(term.value)
        if route.route == "too_short":
            return None

        in_kw = "NOT IN" if negate else "IN"
        if route.trigram_mode == "match":
            return FilterPredicate(
                f"m.internal_id {in_kw} (SELECT rowid FROM email_body_fts_trigram "
                f"WHERE email_body_fts_trigram MATCH ?)",
                (_quote_fts_token(route.trigram_core),),
            )
        # trigram_mode == 'like' (2 字 CJK)
        like = f"%{escape_like_value(route.trigram_core)}%"
        return FilterPredicate(
            f"m.internal_id {in_kw} (SELECT rowid FROM email_body_fts_trigram "
            f"WHERE body_markdown LIKE ? ESCAPE '\\' "
            f"OR subject LIKE ? ESCAPE '\\' "
            f"OR sender LIKE ? ESCAPE '\\')",
            (like, like, like),
        )

    def _column_cjk_term_predicate(
        self, term: TextTerm, *, negate: bool
    ) -> Optional[FilterPredicate]:
        """1g: body 列 term (body:/subject~:/sender~:) 且值含 CJK → trigram 表**同名列**
        column-filter 子查询谓词。

        列映射 body_markdown/subject/sender 与主表一致 (``term.column`` 直接就是 trigram
        表列名)。整 term 走子串检索, 与裸 CJK 词同规则:
          - trigram_mode='match' (整 term >=3 字) → ``email_body_fts_trigram MATCH '<col> : "<短语>"'``
          - trigram_mode='like'  (整 term =2 字)  → trigram 表 ``<col> LIKE '%值%'``
          - too_short (1 字) → None (caller 跳过, warning 由 _collect_cjk_term_warnings 收集)
        负向 (``-body:产品``) → 对称 NOT IN。值无 CJK 的列 term 不进此路 (caller 已过滤)。
        收件人列 (to~:/cc~:/from~:) 不进此路 —— recipient 表无 trigram 变体 (PRD out of scope)。
        """
        route = _route_text_term(term.value)
        if route.route == "too_short":
            return None
        col = term.column  # body_markdown / subject / sender (与 trigram 表列同名)
        in_kw = "NOT IN" if negate else "IN"
        if route.trigram_mode == "match":
            match_expr = f"{col} : {_quote_fts_token(route.trigram_core)}"
            return FilterPredicate(
                f"m.internal_id {in_kw} (SELECT rowid FROM email_body_fts_trigram "
                f"WHERE email_body_fts_trigram MATCH ?)",
                (match_expr,),
            )
        # trigram_mode == 'like' (2 字 CJK): 该列 LIKE 兜底。
        like = f"%{escape_like_value(route.trigram_core)}%"
        return FilterPredicate(
            f"m.internal_id {in_kw} (SELECT rowid FROM email_body_fts_trigram "
            f"WHERE {col} LIKE ? ESCAPE '\\')",
            (like,),
        )

    def _cjk_predicate_for_term(
        self, term: TextTerm, *, negate: bool
    ) -> Optional[FilterPredicate]:
        """单个正向/负向 term 的 CJK trigram 谓词。

        裸全文 CJK 词 → ``_cjk_term_in_predicate``；body 列 CJK 词 (1g) →
        ``_column_cjk_term_predicate``；其余 (非 CJK / 收件人列) → None。
        """
        if self._term_has_cjk(term):
            return self._cjk_term_in_predicate(term, negate=negate)
        if self._term_is_body_column_cjk(term):
            return self._column_cjk_term_predicate(term, negate=negate)
        return None

    def _or_group_routes_cjk_trigram(self, group: list[TextTerm]) -> bool:
        """正向全文 OR 组是否走 CJK trigram 路由 (1g)。

        条件: 组内无收件人列 term (收件人 OR 组归 _build_recipient_predicates) 且至少
        一个**裸** CJK 成员 (bare, column/column_table 均 None)。列级 CJK 成员
        (``body:产品``) 不触发 OR 组路由 —— OR 组内的列词维持 unicode61 (标量列 term 的
        1g 独立处理不下探到 OR 组内, 避免 OR 组混合列路由的复杂度)。
        trigram_enabled 由 caller 保证。
        """
        if any(self._is_recipient_term(term) for term in group):
            return False
        return any(self._term_has_cjk(term) for term in group)

    def _build_or_group_trigram_predicate(
        self, group: list[TextTerm]
    ) -> Optional[FilterPredicate]:
        """含裸 CJK 成员的正向全文 OR 组 → 单条 ``(IN ... OR IN ...)`` AND 谓词 (1g)。

        组员命中判定变宽 (子串) **只对裸 CJK 成员生效** (语义红线):
          - 裸 CJK >=3 字成员 → 合进一条 ``email_body_fts_trigram MATCH '("a") OR ("b")'`` 子查询
          - 裸 CJK =2 字成员 → 各自一条 trigram 表 ``(body/subject/sender LIKE '%词%')`` 子查询
          - 其余成员 (拉丁裸词 / 列词) → 合进一条 ``email_body_fts MATCH`` unicode61 子查询 (语义不变)
        三类子查询 SQL 级 ``OR`` 连接。整组由 caller 从 body MATCH 排除
        (_build_positive_fts_expr), 镜像裸 CJK 词的 _exclude_from_body_match 机制。
        1 字 CJK 成员被跳过 (整组仍按其余成员生效); 全部成员无召回 → None。
        """
        sql_parts: list[str] = []
        params: list = []
        trigram_match_phrases: list[str] = []
        unicode_exprs: list[str] = []
        for term in group:
            if self._term_has_cjk(term):
                route = _route_text_term(term.value)
                if route.route == "too_short":
                    continue
                if route.trigram_mode == "match":
                    trigram_match_phrases.append(_quote_fts_token(route.trigram_core))
                else:  # 'like' (2 字 CJK)
                    like = f"%{escape_like_value(route.trigram_core)}%"
                    sql_parts.append(
                        "m.internal_id IN (SELECT rowid FROM email_body_fts_trigram "
                        "WHERE body_markdown LIKE ? ESCAPE '\\' "
                        "OR subject LIKE ? ESCAPE '\\' "
                        "OR sender LIKE ? ESCAPE '\\')"
                    )
                    params.extend([like, like, like])
            else:
                expr = self._text_term_to_fts(term)
                if expr:
                    unicode_exprs.append(expr)
        if trigram_match_phrases:
            match_expr = " OR ".join(f"({p})" for p in trigram_match_phrases)
            sql_parts.append(
                "m.internal_id IN (SELECT rowid FROM email_body_fts_trigram "
                "WHERE email_body_fts_trigram MATCH ?)"
            )
            params.append(match_expr)
        if unicode_exprs:
            unicode_match = " OR ".join(f"({e})" for e in unicode_exprs)
            sql_parts.append(
                "m.internal_id IN (SELECT rowid FROM email_body_fts "
                "WHERE email_body_fts MATCH ?)"
            )
            params.append(unicode_match)
        if not sql_parts:
            return None
        return FilterPredicate("(" + " OR ".join(sql_parts) + ")", tuple(params))

    def _build_cjk_trigram_predicates(
        self, parsed: ParsedSearchQuery
    ) -> list[FilterPredicate]:
        """trigram_enabled 时, 把 parsed 路径的 CJK 词编译成 trigram IN/NOT-IN 谓词。

        覆盖三类 (均 flag-gated, flag=False → 空列表 → parsed 路径逐字节不变):
          - 独立裸全文 CJK 词 (fts_terms / neg_fts_terms, column/column_table 均 None)
          - body 列 CJK 词 (1g: body:/subject~:/sender~: 值含 CJK) → 同名列 column-filter
          - 含裸 CJK 成员的正向全文 OR 组 (1g: ``产品 OR 评审``) → 整组 (IN ... OR ...) 谓词
        收件人列 (to~:/cc~:/from~:) 不在此 —— recipient 表无 trigram 变体 (PRD out of scope)。
        graceful degrade: trigram 表缺失 (旧库未迁移) 时由 caller 的 try/except 吞掉
        该谓词 → 该词不约束结果 (不崩, 与 recipient 谓词同手法)。
        """
        predicates: list[FilterPredicate] = []
        for term in parsed.fts_terms:
            pred = self._cjk_predicate_for_term(term, negate=False)
            if pred is not None:
                predicates.append(pred)
        for term in parsed.neg_fts_terms:
            pred = self._cjk_predicate_for_term(term, negate=True)
            if pred is not None:
                predicates.append(pred)
        # 1g: 含裸 CJK 成员的正向全文 OR 组也走 trigram (整组 AND 谓词)。
        for group in parsed.fts_or_groups:
            if not self._or_group_routes_cjk_trigram(group):
                continue
            pred = self._build_or_group_trigram_predicate(group)
            if pred is not None:
                predicates.append(pred)
        return predicates

    def _collect_cjk_term_warnings(self, parsed: ParsedSearchQuery) -> list[str]:
        """收集 parsed 路径 CJK 词的 1 字拦截 warning (cjk_too_short:<字>)。

        与 plain trigram 路径 (build_search_plan) 一致: 1 字 CJK 被跳过 + 透传 warning。
        覆盖正向/负向的裸 CJK 词 + body 列 CJK 词 (1g)。OR 组成员 warning 不收
        (整组按可召回成员生效, 与既有 OR 组不产 warning 的语义一致)。
        """
        warnings: list[str] = []
        for term in (*parsed.fts_terms, *parsed.neg_fts_terms):
            if self._term_has_cjk(term) or self._term_is_body_column_cjk(term):
                warnings.extend(_route_text_term(term.value).warnings)
        return warnings

    def _attachment_content_predicate(
        self, value: str, *, negate: bool
    ) -> Optional[FilterPredicate]:
        """把一个 ``attachment:`` 值编译成附件内容 IN/NOT-IN 子查询谓词 (D3)。

        EXISTS-join 回 email (``email_attachment.id = fts.rowid`` → ``a.internal_id``):
          - trigram_enabled:
            - >=3 字符 (任意文种) → ``email_attachment_fts_trigram MATCH`` (默认跨
              filename + text_content 两列 → 文件名/正文子串同路)
            - 2 字 CJK / 短拉丁 (<3) → trigram 表 filename/text_content LIKE 兜底
              (MATCH <3 字符无召回)
            - 1 字 CJK → None (拦截; warning 由 _collect_attachment_term_warnings 收集)
          - trigram off → 降级 ``email_attachment_fts`` (unicode61, 仅 text_content) MATCH
            整词语义 (CJK 大概率 0 命中 = master-off 既有降级语义, 不含 filename 列)。
        不过滤 inline —— 镜像附件融合 lane (_attachment_trigram_match_entries), 且 inline
        附件结构性进不了 FTS (登记面只 enqueue 非 inline, trigram/unicode 表都只索引
        status='extracted')。与 has:attachment (存在性) 正交。graceful degrade: 表缺失
        (v38 旧库) → 谓词 AND 在它所在的每条候选语句里, 语句抛 OperationalError 被
        语句级 try/except 接住返回 [] → 含 attachment: 的查询**整体返回空** (fail-closed,
        不崩; **不是**「谓词静默失效=过滤放宽」)。pin: TestAttachmentTrigramLaneDegrade。
        """
        in_kw = "NOT IN" if negate else "IN"
        if not self.trigram_enabled:
            # master off: 降级 email_attachment_fts (unicode61, text_content only) 整词 MATCH。
            return FilterPredicate(
                f"m.internal_id {in_kw} (SELECT a.internal_id FROM email_attachment_fts "
                f"JOIN email_attachment a ON a.id = email_attachment_fts.rowid "
                f"WHERE email_attachment_fts MATCH ?)",
                (_quote_fts_token(value),),
            )
        route = _route_text_term(value)
        if route.route == "too_short":
            return None
        use_match = (route.route == "trigram" and route.trigram_mode == "match") or (
            route.route == "unicode" and len(route.original) >= 3
        )
        if use_match:
            phrase = _quote_fts_token(
                route.trigram_core if route.route == "trigram" else route.original
            )
            return FilterPredicate(
                f"m.internal_id {in_kw} (SELECT a.internal_id "
                f"FROM email_attachment_fts_trigram "
                f"JOIN email_attachment a ON a.id = email_attachment_fts_trigram.rowid "
                f"WHERE email_attachment_fts_trigram MATCH ?)",
                (phrase,),
            )
        # 2 字 CJK / 短拉丁: trigram 表 filename/text_content LIKE 兜底。
        core = route.trigram_core if route.route == "trigram" else route.original
        like = f"%{escape_like_value(core)}%"
        return FilterPredicate(
            f"m.internal_id {in_kw} (SELECT a.internal_id "
            f"FROM email_attachment_fts_trigram "
            f"JOIN email_attachment a ON a.id = email_attachment_fts_trigram.rowid "
            f"WHERE email_attachment_fts_trigram.filename LIKE ? ESCAPE '\\' "
            f"OR email_attachment_fts_trigram.text_content LIKE ? ESCAPE '\\')",
            (like, like),
        )

    def _build_attachment_content_predicates(
        self, parsed: ParsedSearchQuery
    ) -> list[FilterPredicate]:
        """把 parsed 路径的 attachment: 值编译成附件内容 AND/NOT 谓词 (D1-D3)。

        正向 → IN 子查询 (AND 进 predicates)；负向 (-attachment:) → NOT IN 子查询。
        1 字 CJK 值 (trigram-on) 返回 None → 跳过 (warning 另行收集)。恒建 (不受 flag
        门控): flag=on 走 trigram 路由, flag=off 走 email_attachment_fts unicode61 降级。
        """
        predicates: list[FilterPredicate] = []
        for value in parsed.attachment_terms:
            pred = self._attachment_content_predicate(value, negate=False)
            if pred is not None:
                predicates.append(pred)
        for value in parsed.neg_attachment_terms:
            pred = self._attachment_content_predicate(value, negate=True)
            if pred is not None:
                predicates.append(pred)
        return predicates

    def _collect_attachment_term_warnings(
        self, parsed: ParsedSearchQuery
    ) -> list[str]:
        """收集 attachment: 值的 1 字 CJK 拦截 warning (cjk_too_short:<字>)。

        仅 trigram-on 生效 (与裸 CJK 词一致; trigram-off 走整词 MATCH 降级, 不拦截)。
        """
        warnings: list[str] = []
        for value in (*parsed.attachment_terms, *parsed.neg_attachment_terms):
            route = _route_text_term(value)
            if route.route == "too_short":
                warnings.extend(route.warnings)
        return warnings

    def _exclude_from_body_match(self, term: TextTerm) -> bool:
        """该 term 是否要排出 email_body_fts MATCH expr。

        - 收件人列 term: 永远排除 (走 email_recipient_fts)。
        - P5: trigram_enabled 时, 裸全文 CJK 词也排除 (改走 trigram IN-子查询谓词,
          见 _build_cjk_trigram_predicates), 避免再走 unicode61 前缀 MATCH 双重/冲突。
        - 1g: trigram_enabled 时, body 列 CJK 词 (body:/subject~:/sender~:) 也排除
          (改走 trigram 同名列 column-filter 谓词)。
          flag=False → 不排除, 相关词照旧走 unicode61 (零回归)。
        """
        if self._is_recipient_term(term):
            return True
        if self.trigram_enabled and self._term_has_cjk(term):
            return True
        if self.trigram_enabled and self._term_is_body_column_cjk(term):
            return True
        return False

    def _build_positive_fts_expr(self, parsed: ParsedSearchQuery) -> str:
        # T8: 收件人列 term (to~:/cc~:/from~:) 不进 email_body_fts MATCH —— 它们走
        # email_recipient_fts 的 IN-子查询 AND 过滤 (见 _build_recipient_predicates)。
        # P5: trigram_enabled 时裸 CJK 词也排除 (走 trigram IN-子查询)。
        parts: list[str] = []
        parts.extend(
            self._text_term_to_fts(term)
            for term in parsed.fts_terms
            if not self._exclude_from_body_match(term)
        )
        for group in parsed.fts_or_groups:
            if any(self._is_recipient_term(term) for term in group):
                # OR 组里混入收件人列 term → 整组归 recipient 编译, 不进 body MATCH。
                continue
            # 1g: trigram_enabled 且组含裸 CJK 成员 → 整组走 trigram AND 谓词
            # (_build_or_group_trigram_predicate), 排出 body MATCH; 纯拉丁 OR 组
            # (无裸 CJK 成员) 不进此分支, 逐字节走 unicode61 (语义不变)。
            if self.trigram_enabled and self._or_group_routes_cjk_trigram(group):
                continue
            parts.append(self._build_fts_or_group(group))
        parts = [p for p in parts if p]
        return " AND ".join(parts)

    def _build_negative_fts_expr(self, parsed: ParsedSearchQuery) -> str:
        parts = [
            self._text_term_to_fts(term)
            for term in parsed.neg_fts_terms
            if not self._exclude_from_body_match(term)
        ]
        parts = [p for p in parts if p]
        return " OR ".join(f"({part})" for part in parts)

    def _recipient_match_expr(self, term: TextTerm) -> str:
        """单个收件人列 term 编译成 email_recipient_fts 的 MATCH 片段 `<col>:<expr>`。"""
        expr = self._text_term_to_fts_payload(term)
        if not expr or not term.column:
            return ""
        return f"{term.column} : {expr}"

    def _build_recipient_predicates(
        self, parsed: ParsedSearchQuery
    ) -> list[FilterPredicate]:
        """T8: 把收件人列 term 编译成 email_recipient_fts 的 IN-子查询 AND 谓词。

        - 正向 term / 全 recipient 的 OR 组 → ``m.internal_id IN (SELECT rowid ...)``。
        - 负向 term → ``m.internal_id NOT IN (...)`` (多负向收件人 term 各自一条 NOT IN)。
        - graceful degrade: recipient_fts 表缺失 (旧库未迁移) 时由 caller 的 try/except
          吞掉该谓词 → 该 term 不约束结果 (不崩)。
        """
        predicates: list[FilterPredicate] = []

        # 正向单 term。
        for term in parsed.fts_terms:
            if not self._is_recipient_term(term):
                continue
            expr = self._recipient_match_expr(term)
            if not expr:
                continue
            predicates.append(FilterPredicate(
                "m.internal_id IN (SELECT rowid FROM email_recipient_fts "
                "WHERE email_recipient_fts MATCH ?)",
                (expr,),
            ))

        # 正向 OR 组 (全为收件人列 term)：组内 OR 进同一个 MATCH 表达式。
        for group in parsed.fts_or_groups:
            if not any(self._is_recipient_term(term) for term in group):
                continue
            exprs = [self._recipient_match_expr(term) for term in group]
            exprs = [e for e in exprs if e]
            if not exprs:
                continue
            match_expr = " OR ".join(f"({e})" for e in exprs)
            predicates.append(FilterPredicate(
                "m.internal_id IN (SELECT rowid FROM email_recipient_fts "
                "WHERE email_recipient_fts MATCH ?)",
                (match_expr,),
            ))

        # 负向 term。
        for term in parsed.neg_fts_terms:
            if not self._is_recipient_term(term):
                continue
            expr = self._recipient_match_expr(term)
            if not expr:
                continue
            predicates.append(FilterPredicate(
                "m.internal_id NOT IN (SELECT rowid FROM email_recipient_fts "
                "WHERE email_recipient_fts MATCH ?)",
                (expr,),
            ))

        return predicates

    def _build_positive_recipient_fts_expr(self, parsed: ParsedSearchQuery) -> str:
        """把所有正向收件人列 term 合成一条 email_recipient_fts MATCH 表达式 (AND 连接)。

        供 recipient-only 路径直接对 email_recipient_fts MATCH 取 bm25 排名。
        单 term → `<col>:<expr>`；全 recipient 的 OR 组 → `((c1:e1) OR (c2:e2))`。
        无正向收件人 term → 空串 (caller 不走 recipient-only 路径)。
        """
        parts: list[str] = []
        for term in parsed.fts_terms:
            if not self._is_recipient_term(term):
                continue
            expr = self._recipient_match_expr(term)
            if expr:
                parts.append(f"({expr})")
        for group in parsed.fts_or_groups:
            if not any(self._is_recipient_term(term) for term in group):
                continue
            exprs = [self._recipient_match_expr(term) for term in group]
            exprs = [e for e in exprs if e]
            if exprs:
                parts.append("(" + " OR ".join(f"({e})" for e in exprs) + ")")
        return " AND ".join(parts)

    def _search_recipient_fts_ranked(
        self,
        *,
        recipient_fts_expr: str,
        metadata_predicates: list[FilterPredicate],
        neg_body_fts_expr: str,
        limit: int,
        query_for_log: str,
    ) -> list[EmailSearchHit]:
        """T8 recipient-only 排名路径: FROM email_recipient_fts MATCH + JOIN metadata。

        bm25 升序 (最相关在前) + date_received DESC tie-break。snippet 留空
        (收件人命中不产正文 snippet, 前端按 body 兜底)。graceful degrade:
        recipient_fts 表缺失 (旧库未迁移) → OperationalError 被接住 → 返回 []。
        """
        if not recipient_fts_expr or limit <= 0:
            return []
        sql = """
            SELECT m.internal_id,
                   COALESCE(m.subject, '')        AS subject,
                   COALESCE(m.sender, '')         AS sender,
                   m.date_received,
                   m.mailbox,
                   m.notion_page_id,
                   ''                             AS snippet,
                   bm25(email_recipient_fts)      AS rank__AI_SELECT__
              FROM email_recipient_fts
              JOIN email_metadata m ON m.internal_id = email_recipient_fts.rowid__AI_JOIN__
             WHERE email_recipient_fts MATCH ?
        """
        params: list = [recipient_fts_expr]
        for predicate in metadata_predicates:
            sql += f" AND ({predicate.sql})"
            params.extend(predicate.params)
        if neg_body_fts_expr:
            sql += (
                " AND m.internal_id NOT IN ("
                "SELECT rowid FROM email_body_fts WHERE email_body_fts MATCH ?)"
            )
            params.append(neg_body_fts_expr)
        sql += " ORDER BY rank, datetime(m.date_received) DESC LIMIT ?"
        params.append(limit)
        return self._execute_email_search(sql, params, query_for_log)

    def _build_attachment_positive_fts_expr(self, parsed: ParsedSearchQuery) -> str:
        parts: list[str] = []
        parts.extend(
            self._text_term_to_fts_payload(term)
            for term in parsed.fts_terms
            if term.column is None
        )
        for group in parsed.fts_or_groups:
            if all(term.column is None for term in group):
                parts.append(self._build_fts_or_group(group))
        parts = [p for p in parts if p]
        return " AND ".join(parts)

    def _build_attachment_body_gate_expr(self, parsed: ParsedSearchQuery) -> str:
        """Column-limited positive FTS terms become body-FTS gates for attachment hits.

        T8: 收件人列 term (email_recipient_fts) 不是 body 列 → 排除出 body gate
        (它们在 metadata_predicates 里以独立 IN-子查询约束附件命中)。
        1g: trigram_enabled 时 body 列 CJK 词 (body:/subject~:/sender~: 值含 CJK) 也排出
        body gate —— 它们已由 trigram 同名列 column-filter 谓词 (_build_cjk_trigram_predicates)
        约束**两条 lane** (body + attachment 均吃 metadata_predicates), 若再叠 unicode61
        gate 会用更严的整词/前缀语义盖掉 trigram 子串, 让 `<附件词> body:<CJK 内部子串>`
        漏掉附件命中 (镜像 _exclude_from_body_match 对 body MATCH 的排除)。flag=False →
        不排除, 列级 CJK 词照旧 unicode61 gate (零回归)。
        """
        parts: list[str] = []
        parts.extend(
            self._text_term_to_fts(term)
            for term in parsed.fts_terms
            if term.column is not None and not self._exclude_from_body_match(term)
        )
        for group in parsed.fts_or_groups:
            if group and all(
                term.column is not None and not self._is_recipient_term(term)
                for term in group
            ):
                parts.append(self._build_fts_or_group(group))
        parts = [p for p in parts if p]
        return " AND ".join(parts)

    def _build_attachment_negative_fts_expr(self, parsed: ParsedSearchQuery) -> str:
        parts = [
            self._text_term_to_fts_payload(term)
            for term in parsed.neg_fts_terms
            if term.column is None
        ]
        parts = [p for p in parts if p]
        return " OR ".join(f"({part})" for part in parts)

    def _build_fts_or_group(self, group: list[TextTerm]) -> str:
        parts = [self._text_term_to_fts(term) for term in group]
        parts = [p for p in parts if p]
        if len(parts) <= 1:
            return parts[0] if parts else ""
        return "(" + " OR ".join(f"({part})" for part in parts) + ")"

    def _text_term_to_fts(self, term: TextTerm) -> str:
        expr = self._text_term_to_fts_payload(term)
        if term.column and expr:
            return f"{term.column} : {expr}"
        return expr

    def _text_term_to_fts_payload(self, term: TextTerm) -> str:
        if term.is_phrase or term.force_quoted or not _is_simple_natural_query(term.value):
            return self._quote_fts_value(term.value)
        return smart_query_transform(term.value)

    @staticmethod
    def _quote_fts_value(value: str) -> str:
        return '"' + value.replace('"', '""') + '"'

    @staticmethod
    def _compile_or_filter_groups(
        groups: list[list[FilterPredicate]],
    ) -> list[FilterPredicate]:
        predicates: list[FilterPredicate] = []
        for group in groups:
            sql_parts: list[str] = []
            params: list = []
            for predicate in group:
                sql_parts.append(f"({predicate.sql})")
                params.extend(predicate.params)
            if sql_parts:
                predicates.append(FilterPredicate(" OR ".join(sql_parts), tuple(params)))
        return predicates

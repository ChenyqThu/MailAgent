"""EmailRepository - SQLite SSoT 邮件读写入口（v4 架构）.

设计原则:
    - 只读方法返回 dataclass，禁止暴露 sqlite3.Row 给上层
    - commit_email_with_body 是事务，metadata + body + attachments 原子提交
    - 附件二进制读写经由 AttachmentStore 子模块（不直接操作文件系统）

详见 docs/reference/architecture/architecture_v4_sqlite_ssot.md §5.
"""

from __future__ import annotations

import sqlite3
import time
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from loguru import logger

from src.repository.attachment_store import AttachmentStore
from src.repository.search_query import (
    FilterPredicate,
    ParsedSearchQuery,
    TextTerm,
    build_structured_filter_predicates,
    parse_search_query,
)


# ============================================================
# Payloads (写入)
# ============================================================

@dataclass
class BodyPayload:
    """commit_email_with_body 的 body 入参."""
    html: Optional[str]                          # 原始 HTML（cid: 已重写为相对路径）
    markdown: Optional[str]                      # HTML → Markdown
    body_format: str = "html"                    # 'html' | 'text-only' | 'empty'
    has_inline_images: bool = False
    raw_mime_sha256: Optional[str] = None        # raw MIME 哈希
    fetched_source: str = "applescript"          # 'applescript' | 'emlx' | 'notion-backfill'


@dataclass
class AttachmentPayload:
    """commit_email_with_body 的 attachment 入参（单个）."""
    filename: str
    content: bytes                               # 二进制内容（会落盘 + 算 sha256）
    content_type: Optional[str] = None
    content_id: Optional[str] = None             # MIME CID（inline image）
    is_inline: bool = False
    derived_from_filename: Optional[str] = None  # 同一封邮件里原附件的 filename；用于 derived 关联
    derived_format: Optional[str] = None         # 'pdf' | 'csv'


# ============================================================
# Records (读取)
# ============================================================

@dataclass
class AttachmentRecord:
    """email_attachment 行 + 计算字段."""
    id: int
    internal_id: int
    filename: str
    content_type: Optional[str]
    size_bytes: Optional[int]
    is_inline: bool
    content_id: Optional[str]
    local_path: Optional[str]
    sha256: Optional[str]
    derived_from: Optional[int]
    derived_format: Optional[str]
    notion_file_id: Optional[str]
    notion_block_id: Optional[str]
    created_at: float


@dataclass
class EmailBodyRecord:
    internal_id: int
    message_id: Optional[str]
    html: Optional[str]
    markdown: Optional[str]
    body_format: str
    body_size_bytes: int
    has_inline_images: bool
    raw_mime_sha256: Optional[str]
    fetched_at: float
    fetched_source: str


@dataclass
class EmailMetadataRecord:
    """email_metadata 行 dataclass 投影 (替代 Dict 出口, 用于 CLI / EmailFull)."""
    internal_id: int
    message_id: Optional[str]
    thread_id: Optional[str]
    subject: str
    sender: str
    sender_name: Optional[str]
    to_addr: str
    cc_addr: str
    date_received: Optional[str]
    mailbox: str
    is_read: bool
    is_flagged: bool
    sync_status: str
    notion_page_id: Optional[str]
    notion_thread_id: Optional[str]
    sync_error: Optional[str]
    retry_count: int
    next_retry_at: Optional[float]
    created_at: float
    updated_at: float
    # v8: 前端置顶 / pin（Mail.app 无此概念；仅本地 + Notion mirror 不写）
    is_pinned: bool = False
    pinned_at: Optional[float] = None
    # v9: 邮件原生重要性（Importance / X-Priority / X-MSMail-Priority 任一为
    # high → True）。由 reader._parse_importance 在 parse 阶段填好，前端
    # EmailRow 的 ❗ 角标读这个字段。
    is_important: bool = False

    @property
    def notion_url(self) -> Optional[str]:
        if not self.notion_page_id:
            return None
        return f"https://www.notion.so/{self.notion_page_id.replace('-', '')}"


@dataclass
class EmailFull:
    """EmailRepository.get_email_full 返回 — metadata + body + attachments 单点聚合."""
    internal_id: int
    metadata: EmailMetadataRecord
    body: Optional[EmailBodyRecord]
    attachments: list[AttachmentRecord]


@dataclass
class ThreadMember:
    """同 thread_id 的兄弟邮件投影 — _handle_thread_relations 切 SQLite SSoT 用 (R-02)."""
    internal_id: int
    page_id: Optional[str]                # email_metadata.notion_page_id
    date_received: Optional[str]
    is_synced: bool


@dataclass
class EmailSearchHit:
    """search_email_bodies 单条命中（FTS5 + metadata join）."""
    internal_id: int
    subject: str
    sender: str
    date_received: Optional[str]
    mailbox: Optional[str]
    snippet: str            # FTS5 snippet() 高亮片段（默认 <mark>...</mark>）
    rank: float             # bm25 或 -RRF 分数（越小越相关）
    notion_page_id: Optional[str] = None
    notion_url: Optional[str] = None
    source: str = "body"
    filename: Optional[str] = None


@dataclass
class EmailSearchResult:
    """带搜索 meta 的结果，用于 CLI/API/event 透传 parser warning。"""

    hits: list[EmailSearchHit]
    transformed_query: str
    parse_warnings: list[str] = field(default_factory=list)


@dataclass
class ContactSuggestion:
    """compose 收件人自动补全候选。"""

    email: str
    name: Optional[str]
    score: int
    last_seen: Optional[str]


# ============================================================
# PR-2b: 附件文本抽取 + FTS5 搜索 dataclass
# ============================================================

@dataclass
class AttachmentTextRecord:
    """email_attachment_text 行投影."""
    attachment_id: int
    text_content: Optional[str]
    text_size_bytes: int
    extractor: str
    status: str                          # 'pending' / 'extracted' / 'failed' / 'unsupported'
    error_message: Optional[str]
    retry_count: int
    next_retry_at: Optional[float]
    extracted_at: Optional[float]
    truncated: bool
    created_at: float
    updated_at: float


@dataclass
class AttachmentSearchHit:
    """search_attachment_texts 单条命中.

    FTS5 hit 后 JOIN email_attachment + email_metadata 拼邮件上下文,
    让 chat agent 直接 render '在哪封邮件的哪个附件里' 不用再多调 IPC.
    """
    attachment_id: int
    internal_id: int
    filename: str
    content_type: Optional[str]
    snippet: str
    rank: float
    email_subject: str
    email_sender: str
    email_date: Optional[str]
    email_mailbox: Optional[str]
    notion_page_id: Optional[str] = None
    notion_url: Optional[str] = None


# ============================================================
# FTS5 query smart transform — CJK-aware 自然语言 → FTS5 syntax (PR-2a)
# ============================================================
#
# Motivation: SQLite FTS5 用 unicode61 tokenizer, 连续 CJK 串当成单一 token
# ('本周产品评审' 是 1 个 token), 所以 raw query '产品' 仅命中含独立 '产品'
# token 的 doc, 漏掉 '产品评审' 这种合并 token. LLM/自然语言用户不会自己加
# `*`, 这个 wrapper 自动按字符级 AND fallback 提升中文召回.
#
# 不做的事:
# - 不引 jieba (C 扩展打包麻烦)
# - 不切 prefix 之外的 FTS5 特殊语法 (NEAR / column filter)
# - 含 punctuation / quote / wildcard 的 query 视为用户 explicit FTS5 syntax,
#   原样下放


def _is_cjk_char(c: str) -> bool:
    """检测单字符是否 CJK / 日韩 (覆盖 BMP + 扩展 A/B-F + 假名 + 谚文)."""
    if not c:
        return False
    cp = ord(c)
    if 0x4E00 <= cp <= 0x9FFF:        # CJK Unified Ideographs
        return True
    if 0x3400 <= cp <= 0x4DBF:        # CJK Extension A
        return True
    if 0x20000 <= cp <= 0x2FA1F:      # CJK Extension B-F
        return True
    if 0x3040 <= cp <= 0x30FF:        # Hiragana / Katakana
        return True
    if 0xAC00 <= cp <= 0xD7AF:        # Hangul Syllables
        return True
    return False


_FTS5_OPERATORS: frozenset = frozenset({'AND', 'OR', 'NOT'})


def _is_simple_natural_query(q: str) -> bool:
    """query 是否仅含字母/数字/空格/CJK (自然语言关键词).

    含其他 punctuation (`"`, `*`, `(`, `:`, `+`, `-`, `@`, `.` 等) → False,
    smart_query_transform 退回原 query 让 FTS5 自己 parse.
    """
    for c in q:
        if c.isalnum() or c.isspace() or _is_cjk_char(c):
            continue
        return False
    return True


def _wrap_token_cjk_aware(tok: str) -> str:
    """单 token 转 FTS5 片段.

    规则:
        纯拉丁:  原样 (FTS5 默认整词 match)
        单字 CJK: 'X*' (prefix 通配)
        多字 CJK: '(token* OR (c1* AND c2* AND ...))'
                  整 token prefix 优先, 字符级 AND fallback (unicode61
                  chunk-level token 命不中时兜底)
        混合 token (CJK + Latin): 按字符类切 segment, 各自处理, AND 连
    """
    if not tok:
        return ''

    segments: list = []  # list[tuple[bool, str]]
    current_cjk: Optional[bool] = None
    current: str = ''
    for c in tok:
        c_cjk = _is_cjk_char(c)
        if current_cjk is None:
            current_cjk = c_cjk
            current = c
        elif c_cjk == current_cjk:
            current += c
        else:
            segments.append((current_cjk, current))
            current = c
            current_cjk = c_cjk
    if current and current_cjk is not None:
        segments.append((current_cjk, current))

    if len(segments) == 1:
        is_cjk, seg = segments[0]
        if not is_cjk:
            return seg
        if len(seg) == 1:
            return f'{seg}*'
        chars_and = ' AND '.join(f'{c}*' for c in seg)
        return f'({seg}* OR ({chars_and}))'

    parts: list = []
    for is_cjk, seg in segments:
        if not is_cjk:
            parts.append(seg)
        elif len(seg) == 1:
            parts.append(f'{seg}*')
        else:
            chars_and = ' AND '.join(f'{c}*' for c in seg)
            parts.append(f'({seg}* OR ({chars_and}))')
    return '(' + ' AND '.join(parts) + ')'


def smart_query_transform(query: str) -> str:
    """把简单自然语言关键词 query 转成 FTS5-friendly query (CJK 感知).

    转换规则:
        - 空 / 仅空白 → 原样
        - 含 FTS5 特殊字符 (引号/通配/括号/punct 等) → 原样
        - 含 AND/OR/NOT 全大写 operator token → 原样
        - 否则按空白 split token, 逐 token 用 _wrap_token_cjk_aware 包装,
          多 token 用 AND 连接

    Examples:
        '产' → '产*'
        '产品' → '(产品* OR (产* AND 品*))'
        '本周产品评审' → '(本周产品评审* OR (本* AND 周* AND 产* AND 品* AND 评* AND 审*))'
        'redis 超时' → 'redis AND (超时* OR (超* AND 时*))'
        'redis timeout' → 'redis AND timeout'
        'Redis超时' → '(Redis AND (超时* OR (超* AND 时*)))'
        '"redis timeout"' → '"redis timeout"'   (raw, 含 quote)
        'redis AND timeout' → 'redis AND timeout'  (raw, 含 operator)
        '产品*' → '产品*'  (raw, 含 wildcard)
    """
    if not query or not query.strip():
        return query
    q = query.strip()

    if not _is_simple_natural_query(q):
        return q

    tokens = q.split()
    if any(t in _FTS5_OPERATORS for t in tokens):
        return q

    wrapped = [_wrap_token_cjk_aware(t) for t in tokens]
    wrapped = [w for w in wrapped if w]
    if not wrapped:
        return q
    if len(wrapped) == 1:
        return wrapped[0]
    return ' AND '.join(wrapped)


_CONTACT_CACHE_TTL_SECONDS = 10 * 60
_CONTACT_SUGGEST_CACHE: dict[str, tuple[float, list[ContactSuggestion]]] = {}
_EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE)
_RRF_K = 60.0
_RRF_FETCH_MULTIPLIER = 4
_RRF_FETCH_MIN_EXTRA = 50
_RRF_FETCH_MAX = 1000


# ============================================================
# T7: CJK trigram 查询计划器 (flag-gated)
# ============================================================
#
# 设计来源: .trellis/tasks/06-17-dsl-parse-warnings/research/codex-t7-tokenizer.md 方案②。
# 对每个「裸全文 term」(无列限定 / 非短语) 按 CJK 占比 + CJK 长度分路由:
#   - 无 CJK (纯英文/数字/符号)  → unicode (主表 email_body_fts MATCH + smart_query_transform)
#   - CJK >= 3 字                → trigram_match (email_body_fts_trigram MATCH)
#   - CJK = 2 字                 → trigram_like (trigram 表 body/subject/sender LIKE '%词%')
#   - CJK = 1 字                → too_short (不查 + warning cjk_too_short:<词>)
#   - 中英混合 (CJK + Latin 同 term) → mixed (英文段 unicode 候选 ∩ 中文段 trigram 候选)
# 多 term 之间 AND (rowid 交集)。实测硬约束: trigram MATCH < 3 Unicode 字符无召回,
# 故 1/2 字中文不能走 MATCH。


def _count_cjk_chars(value: str) -> int:
    return sum(1 for c in value if _is_cjk_char(c))


def _split_cjk_segments(value: str) -> list[tuple[bool, str]]:
    """按 CJK / 非 CJK 边界切 segment, 返回 [(is_cjk, segment), ...]."""
    segments: list[tuple[bool, str]] = []
    current_cjk: Optional[bool] = None
    current = ""
    for c in value:
        c_cjk = _is_cjk_char(c)
        if current_cjk is None:
            current_cjk = c_cjk
            current = c
        elif c_cjk == current_cjk:
            current += c
        else:
            segments.append((current_cjk, current))
            current = c
            current_cjk = c_cjk
    if current and current_cjk is not None:
        segments.append((current_cjk, current))
    return segments


@dataclass
class _CjkSegmentRoute:
    """单个 CJK segment 的路由 (trigram_match / trigram_like / too_short)."""
    value: str
    route: str  # 'trigram_match' | 'trigram_like' | 'too_short'


@dataclass
class _TermRoute:
    """一个裸全文 term 的路由计划。

    ``route``:
        'unicode'       —— 纯非 CJK term, 走主表 unicode61 (unicode_expr 为 smart_query_transform 结果)
        'trigram'       —— 含 CJK term, 由 cjk_segments + latin_segments 组合
        'too_short'     —— 整 term 只有 1 个 CJK 字 (无别的内容), 拦截 + warning
    """
    original: str
    route: str
    unicode_expr: str = ""                       # route='unicode' 时的 FTS5 expr
    latin_segments: list[str] = field(default_factory=list)   # 混合 term 里的拉丁段 (走 unicode61)
    cjk_segments: list[_CjkSegmentRoute] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _route_text_term(value: str) -> _TermRoute:
    """把一个裸全文 term 分类成 _TermRoute (T7 路由核心, Python/TS 双端镜像逻辑)。"""
    cjk_count = _count_cjk_chars(value)
    if cjk_count == 0:
        return _TermRoute(
            original=value,
            route="unicode",
            unicode_expr=smart_query_transform(value),
        )

    segments = _split_cjk_segments(value)
    latin_segments: list[str] = []
    cjk_segments: list[_CjkSegmentRoute] = []
    warnings: list[str] = []
    for is_cjk, seg in segments:
        if not is_cjk:
            if seg.strip():
                latin_segments.append(seg)
            continue
        seg_len = len(seg)
        if seg_len >= 3:
            cjk_segments.append(_CjkSegmentRoute(seg, "trigram_match"))
        elif seg_len == 2:
            cjk_segments.append(_CjkSegmentRoute(seg, "trigram_like"))
        else:  # seg_len == 1
            cjk_segments.append(_CjkSegmentRoute(seg, "too_short"))
            warnings.append(f"cjk_too_short:{seg}")

    # 整 term 只有 1 个 CJK 字 (无拉丁段, 无其它可查 CJK 段) → 拦截整 term
    queryable_cjk = [s for s in cjk_segments if s.route != "too_short"]
    if not latin_segments and not queryable_cjk:
        return _TermRoute(original=value, route="too_short", warnings=warnings)

    return _TermRoute(
        original=value,
        route="trigram",
        latin_segments=latin_segments,
        cjk_segments=queryable_cjk,
        warnings=warnings,
    )


def _quote_fts_token(token: str) -> str:
    """把一个 token 包成 FTS5 短语字面量 ``"token"`` (内部双引号转义为 ``""``)。"""
    return '"' + token.replace('"', '""') + '"'


def build_trigram_snippet_expr(routes: list[_TermRoute]) -> str:
    """从路由计划构造「snippet 匹配表达式」(供 email_body_fts_trigram MATCH 高亮)。

    trigram 分词器要求 token >= 3 字符才有召回, 故只收:
      - latin 段 (英文/数字, 来自 unicode term 的 original 或 trigram term 的 latin_segments),
        按 ``[A-Za-z0-9]+`` 抽词后取 len>=3 的。
      - CJK 段中 route=='trigram_match' (>=3 字) 的整段。
    2 字 CJK (trigram_like) 与 1 字 CJK 不进表达式 (MATCH<3 无效)。
    各 token 包成 FTS5 短语并以 ``OR`` 连接; 全部不可 MATCH → 返回 ''。
    Python/TS 双端逐行镜像, 由行为夹具锁。
    """
    tokens: list[str] = []
    for route in routes:
        if route.route == "unicode":
            tokens.extend(t for t in re.findall(r"[A-Za-z0-9]+", route.original) if len(t) >= 3)
        elif route.route == "trigram":
            for latin in route.latin_segments:
                tokens.extend(t for t in re.findall(r"[A-Za-z0-9]+", latin) if len(t) >= 3)
            for seg in route.cjk_segments:
                if seg.route == "trigram_match":
                    tokens.append(seg.value)
    if not tokens:
        return ""
    return " OR ".join(_quote_fts_token(t) for t in tokens)


def build_search_plan(terms: list[str]) -> tuple[list[_TermRoute], list[str]]:
    """把裸全文 term 列表编译成路由计划 + 收集 warning。

    返回 ``(routes, warnings)``。``routes`` 只含可查 term (route in
    {'unicode','trigram'}); 'too_short' term 被丢弃但其 warning 进 warnings。
    供 Python (本方法) + 前端 TS (build_search_plan 等价) 共用同一份分类语义,
    由行为夹具 (trigram:true case) 锁住。
    """
    routes: list[_TermRoute] = []
    warnings: list[str] = []
    for term in terms:
        if not term:
            continue
        route = _route_text_term(term)
        warnings.extend(route.warnings)
        if route.route == "too_short":
            continue
        routes.append(route)
    return routes, warnings


def _normalize_contact_name(value: Optional[str]) -> Optional[str]:
    trimmed = (value or "").strip().strip("\"'")
    return trimmed or None


def _contact_date_key(value: Optional[str]) -> float:
    if not value:
        return 0.0
    try:
        normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
        return datetime.fromisoformat(normalized).timestamp()
    except ValueError:
        return 0.0


def _parse_address_segment(segment: str) -> Optional[tuple[str, Optional[str]]]:
    angle = re.match(r"^(.*?)<([^>]+)>", segment)
    if angle:
        email_match = _EMAIL_RE.search(angle.group(2) or "")
        if not email_match:
            return None
        return email_match.group(0).lower(), _normalize_contact_name(angle.group(1))

    email_match = _EMAIL_RE.search(segment)
    if not email_match:
        return None
    name = _normalize_contact_name(segment[:email_match.start()])
    return email_match.group(0).lower(), name


def _parse_address_list(value: Optional[str]) -> list[tuple[str, Optional[str]]]:
    if not value:
        return []
    items: list[tuple[str, Optional[str]]] = []
    for segment in value.split(","):
        parsed = _parse_address_segment(segment.strip())
        if parsed is not None:
            items.append(parsed)
    return items


def _normalize_exclude(exclude: Optional[str | list[str]]) -> set[str]:
    values = exclude if isinstance(exclude, list) else ([exclude] if exclude else [])
    result: set[str] = set()
    for value in values:
        for part in str(value).split(","):
            email = part.strip().lower()
            if email:
                result.add(email)
    return result


def _contact_prefix_match(item: ContactSuggestion, q: str) -> bool:
    if not q:
        return False
    local_part = item.email.split("@", 1)[0]
    if local_part.startswith(q):
        return True
    if any(part.startswith(q) for part in re.split(r"[._%+-]+", local_part)):
        return True
    name = (item.name or "").lower()
    return any(part.startswith(q) for part in re.split(r"[\s,.;:()\"'<>]+", name))


# ============================================================
# Repository
# ============================================================

class EmailRepository:
    """SQLite SSoT 读写入口（v4 架构）."""

    def __init__(
        self,
        db_path: str = "data/sync_store.db",
        attachment_store: Optional[AttachmentStore] = None,
        *,
        trigram_enabled: Optional[bool] = None,
    ):
        self.db_path = Path(db_path)
        self.attachment_store = attachment_store or AttachmentStore()
        # T7: CJK trigram 路由开关。None → 懒读 config.search_trigram_enabled
        # (默认 False; 读 config 失败/缺 env → False, 保证测试 / CLI 无 .env 也能起)。
        # 显式传 True/False → 测试 / caller 直控 (per-case trigram fixture 用)。
        self._trigram_enabled_override = trigram_enabled

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")  # CASCADE / SET NULL
        return conn

    @property
    def trigram_enabled(self) -> bool:
        """T7 CJK trigram 路由是否启用。

        构造时显式传了 ``trigram_enabled=`` → 直用；否则懒读
        ``config.search_trigram_enabled``（默认 False；读 config 失败 / 缺必填 env
        → 退回 False，保证无 .env 的测试 / CLI 上下文不炸）。
        """
        if self._trigram_enabled_override is not None:
            return self._trigram_enabled_override
        try:
            from src.config import config as _config
            return bool(getattr(_config, "search_trigram_enabled", False))
        except Exception:
            return False

    # ============================================================
    # READ
    # ============================================================

    def get_body_html(self, internal_id: int) -> Optional[str]:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT body_html FROM email_body WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            return row["body_html"] if row else None
        finally:
            conn.close()

    def get_body_markdown(
        self, internal_id: int, max_chars: int = -1
    ) -> Optional[str]:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT body_markdown FROM email_body WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            if not row or row["body_markdown"] is None:
                return None
            md = row["body_markdown"]
            if max_chars > 0 and len(md) > max_chars:
                return md[:max_chars]
            return md
        finally:
            conn.close()

    def get_body(self, internal_id: int) -> Optional[EmailBodyRecord]:
        conn = self._connect()
        try:
            row = conn.execute(
                """SELECT internal_id, message_id, body_html, body_markdown,
                          body_format, body_size_bytes, has_inline_images,
                          raw_mime_sha256, fetched_at, fetched_source
                   FROM email_body WHERE internal_id = ?""",
                (internal_id,),
            ).fetchone()
            if not row:
                return None
            return EmailBodyRecord(
                internal_id=row["internal_id"],
                message_id=row["message_id"],
                html=row["body_html"],
                markdown=row["body_markdown"],
                body_format=row["body_format"] or "html",
                body_size_bytes=row["body_size_bytes"] or 0,
                has_inline_images=bool(row["has_inline_images"]),
                raw_mime_sha256=row["raw_mime_sha256"],
                fetched_at=row["fetched_at"],
                fetched_source=row["fetched_source"],
            )
        finally:
            conn.close()

    def get_attachments(self, internal_id: int) -> list[AttachmentRecord]:
        conn = self._connect()
        try:
            rows = conn.execute(
                """SELECT id, internal_id, filename, content_type, size_bytes,
                          is_inline, content_id, local_path, sha256,
                          derived_from, derived_format,
                          notion_file_id, notion_block_id, created_at
                   FROM email_attachment WHERE internal_id = ?
                   ORDER BY is_inline DESC, id ASC""",
                (internal_id,),
            ).fetchall()
            return [
                AttachmentRecord(
                    id=r["id"],
                    internal_id=r["internal_id"],
                    filename=r["filename"],
                    content_type=r["content_type"],
                    size_bytes=r["size_bytes"],
                    is_inline=bool(r["is_inline"]),
                    content_id=r["content_id"],
                    local_path=r["local_path"],
                    sha256=r["sha256"],
                    derived_from=r["derived_from"],
                    derived_format=r["derived_format"],
                    notion_file_id=r["notion_file_id"],
                    notion_block_id=r["notion_block_id"],
                    created_at=r["created_at"],
                )
                for r in rows
            ]
        finally:
            conn.close()

    def get_attachment_bytes(self, attachment_id: int) -> Optional[bytes]:
        """根据 attachment.id 通过 local_path 读盘。"""
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT local_path FROM email_attachment WHERE id = ?",
                (attachment_id,),
            ).fetchone()
            if not row or not row["local_path"]:
                return None
            try:
                return self.attachment_store.read(row["local_path"])
            except FileNotFoundError:
                logger.warning(f"Attachment file missing: {row['local_path']}")
                return None
        finally:
            conn.close()

    def get_metadata(self, internal_id: int) -> Optional[EmailMetadataRecord]:
        """SELECT email_metadata 单行构造 dataclass."""
        conn = self._connect()
        try:
            row = conn.execute(
                """SELECT internal_id, message_id, thread_id, subject, sender,
                          sender_name, to_addr, cc_addr, date_received, mailbox,
                          is_read, is_flagged, sync_status,
                          notion_page_id, notion_thread_id, sync_error,
                          retry_count, next_retry_at, created_at, updated_at,
                          is_pinned, pinned_at, is_important
                   FROM email_metadata WHERE internal_id = ?""",
                (internal_id,),
            ).fetchone()
            if not row:
                return None
            return EmailMetadataRecord(
                internal_id=row["internal_id"],
                message_id=row["message_id"],
                thread_id=row["thread_id"],
                subject=row["subject"] or "",
                sender=row["sender"] or "",
                sender_name=row["sender_name"],
                to_addr=row["to_addr"] or "",
                cc_addr=row["cc_addr"] or "",
                date_received=row["date_received"],
                mailbox=row["mailbox"] or "",
                is_read=bool(row["is_read"]),
                is_flagged=bool(row["is_flagged"]),
                sync_status=row["sync_status"] or "pending",
                notion_page_id=row["notion_page_id"],
                notion_thread_id=row["notion_thread_id"],
                sync_error=row["sync_error"],
                retry_count=row["retry_count"] or 0,
                next_retry_at=row["next_retry_at"],
                created_at=row["created_at"] or 0.0,
                updated_at=row["updated_at"] or 0.0,
                is_pinned=bool(row["is_pinned"]),
                pinned_at=row["pinned_at"],
                is_important=bool(row["is_important"]),
            )
        finally:
            conn.close()

    def get_email_full(self, internal_id: int) -> Optional[EmailFull]:
        """一次聚合 metadata + body + attachments — CLI / Notion sync from-sqlite 主入口."""
        meta = self.get_metadata(internal_id)
        if meta is None:
            return None
        return EmailFull(
            internal_id=internal_id,
            metadata=meta,
            body=self.get_body(internal_id),
            attachments=self.get_attachments(internal_id),
        )

    def get_thread_members(
        self,
        thread_id: str,
        *,
        exclude_internal_id: Optional[int] = None,
        synced_only: bool = True,
    ) -> list[ThreadMember]:
        """从 SQLite 查同 thread_id 的兄弟邮件 (R-02 — SSoT 替代 Notion API 查询).

        与 sync_store.get_all_emails_by_thread_id 的区别:
            - 返回 dataclass list 而非 dict list
            - 用 internal_id 排除 (caller 语义一致, 不再依赖 message_id)
            - default synced_only=True — _handle_thread_relations 只关心已上 Notion 的邮件
              (要写 Notion relation 必须有 page_id)

        排序: date_received DESC (最新在前, 与 sync_store.get_all_emails_by_thread_id 一致)。
        空 thread_id → 返回 []。
        """
        if not thread_id:
            return []
        conn = self._connect()
        try:
            sql = (
                "SELECT internal_id, notion_page_id, date_received, sync_status "
                "FROM email_metadata WHERE thread_id = ?"
            )
            params: list = [thread_id]
            if exclude_internal_id is not None:
                sql += " AND internal_id != ?"
                params.append(exclude_internal_id)
            if synced_only:
                sql += " AND sync_status = 'synced'"
            sql += " ORDER BY date_received DESC"
            rows = conn.execute(sql, params).fetchall()
            return [
                ThreadMember(
                    internal_id=r["internal_id"],
                    page_id=r["notion_page_id"],
                    date_received=r["date_received"],
                    is_synced=(r["sync_status"] == "synced"),
                )
                for r in rows
            ]
        finally:
            conn.close()

    # ============================================================
    # LIST (CLI `email list` 专用 — 比 SyncStore.search_emails 更宽松,
    # 不锁 sync_status, 不 cap limit, 暴露 sync_status + thread_id)
    # ============================================================

    LIST_LIMIT_MAX = 500

    def list_metadata(
        self,
        *,
        mailbox: Optional[str] = None,
        status: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        sender_substr: Optional[str] = None,
        subject_substr: Optional[str] = None,
        is_read: Optional[bool] = None,
        is_flagged: Optional[bool] = None,
        is_pinned: Optional[bool] = None,
        is_important: Optional[bool] = None,
        has_notion: Optional[bool] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> dict:
        """CLI ``email list`` 用 — 返回 ``{total, limit, offset, emails: [EmailMetadataRecord, ...]}``.

        与 ``SyncStore.search_emails`` 的差异 (R-15 / PR-2 critic fix):
        - 不强制 ``sync_status IN ('synced', 'pending')``; 若 caller 传 ``status``
          就只过滤该 status, 否则不锁
        - 不把 limit 硬 cap 到 50; 上限走 ``LIST_LIMIT_MAX = 500``
          (与 CLI 公开契约一致, RFC §4.2)
        - SELECT 含 ``sync_status`` + ``thread_id``, CLI 能直接消费
        """
        if limit <= 0:
            return {"total": 0, "limit": limit, "offset": offset, "emails": []}
        limit = min(limit, self.LIST_LIMIT_MAX)

        clauses: list[str] = []
        params: list = []
        if mailbox:
            clauses.append("mailbox = ?")
            params.append(mailbox)
        if status:
            clauses.append("sync_status = ?")
            params.append(status)
        if date_from:
            clauses.append("date_received >= ?")
            params.append(date_from)
        if date_to:
            clauses.append("date_received <= ?")
            params.append(f"{date_to} 23:59:59")
        if sender_substr:
            clauses.append("(sender LIKE ? OR sender_name LIKE ?)")
            like_val = f"%{sender_substr}%"
            params.extend([like_val, like_val])
        if subject_substr:
            clauses.append("subject LIKE ?")
            params.append(f"%{subject_substr}%")
        if is_read is not None:
            clauses.append("is_read = ?")
            params.append(1 if is_read else 0)
        if is_flagged is not None:
            clauses.append("is_flagged = ?")
            params.append(1 if is_flagged else 0)
        if is_pinned is not None:
            clauses.append("is_pinned = ?")
            params.append(1 if is_pinned else 0)
        if is_important is not None:
            clauses.append("is_important = ?")
            params.append(1 if is_important else 0)
        if has_notion is True:
            clauses.append("notion_page_id IS NOT NULL")
        elif has_notion is False:
            clauses.append("notion_page_id IS NULL")

        where_clause = (" WHERE " + " AND ".join(clauses)) if clauses else ""

        conn = self._connect()
        try:
            count_row = conn.execute(
                f"SELECT COUNT(*) AS c FROM email_metadata{where_clause}",
                params,
            ).fetchone()
            total = count_row["c"] if count_row else 0

            rows = conn.execute(
                f"""SELECT internal_id, message_id, thread_id, subject, sender,
                           sender_name, to_addr, cc_addr, date_received, mailbox,
                           is_read, is_flagged, sync_status,
                           notion_page_id, notion_thread_id, sync_error,
                           retry_count, next_retry_at, created_at, updated_at,
                           is_pinned, pinned_at, is_important
                      FROM email_metadata{where_clause}
                  ORDER BY is_pinned DESC, is_important DESC, date_received DESC
                     LIMIT ? OFFSET ?""",
                params + [limit, offset],
            ).fetchall()

            emails = [
                EmailMetadataRecord(
                    internal_id=r["internal_id"],
                    message_id=r["message_id"],
                    thread_id=r["thread_id"],
                    subject=r["subject"] or "",
                    sender=r["sender"] or "",
                    sender_name=r["sender_name"],
                    to_addr=r["to_addr"] or "",
                    cc_addr=r["cc_addr"] or "",
                    date_received=r["date_received"],
                    mailbox=r["mailbox"] or "",
                    is_read=bool(r["is_read"]),
                    is_flagged=bool(r["is_flagged"]),
                    sync_status=r["sync_status"] or "pending",
                    notion_page_id=r["notion_page_id"],
                    notion_thread_id=r["notion_thread_id"],
                    sync_error=r["sync_error"],
                    retry_count=r["retry_count"] or 0,
                    next_retry_at=r["next_retry_at"],
                    created_at=r["created_at"] or 0.0,
                    updated_at=r["updated_at"] or 0.0,
                    is_pinned=bool(r["is_pinned"]),
                    pinned_at=r["pinned_at"],
                    is_important=bool(r["is_important"]),
                )
                for r in rows
            ]
            return {"total": total, "limit": limit, "offset": offset, "emails": emails}
        finally:
            conn.close()

    # ============================================================
    # CONTACT SUGGEST (compose 收件人自动补全)
    # ============================================================

    def suggest_contacts(
        self,
        q: str = "",
        *,
        limit: int = 8,
        exclude: Optional[str | list[str]] = None,
    ) -> list[ContactSuggestion]:
        """从本地邮件元数据聚合 compose 收件人自动补全候选。"""
        try:
            limit = min(max(int(limit), 1), 50)
        except (TypeError, ValueError):
            limit = 8
        query = (q or "").strip().lower()
        excluded = _normalize_exclude(exclude)

        items = [
            item
            for item in self._contact_corpus()
            if item.email.lower() not in excluded
        ]
        if query:
            items = [
                item
                for item in items
                if query in item.email.lower()
                or query in (item.name or "").lower()
            ]

        return sorted(
            items,
            key=lambda item: (
                0 if _contact_prefix_match(item, query) else 1,
                -item.score,
                -_contact_date_key(item.last_seen),
                item.email,
            ),
        )[:limit]

    def _contact_corpus(self) -> list[ContactSuggestion]:
        cache_key = str(self.db_path.resolve())
        now = time.time()
        cached = _CONTACT_SUGGEST_CACHE.get(cache_key)
        if cached and cached[0] > now:
            return cached[1]
        try:
            items = self._aggregate_contact_suggestions()
            _CONTACT_SUGGEST_CACHE[cache_key] = (
                now + _CONTACT_CACHE_TTL_SECONDS,
                items,
            )
            return items
        except Exception as e:
            logger.warning(f"suggest_contacts: aggregation failed: {e}")
            return []

    def _aggregate_contact_suggestions(self) -> list[ContactSuggestion]:
        conn = self._connect()
        contacts: dict[str, dict[str, object]] = {}

        def upsert(
            parsed: Optional[tuple[str, Optional[str]]],
            *,
            score_delta: int,
            date_received: Optional[str],
        ) -> None:
            if parsed is None:
                return
            email, name = parsed
            seen_ts = _contact_date_key(date_received)
            current = contacts.setdefault(
                email,
                {
                    "email": email,
                    "name": None,
                    "score": 0,
                    "last_seen": None,
                    "last_seen_ts": 0.0,
                    "name_seen_ts": 0.0,
                },
            )
            current["score"] = int(current["score"]) + score_delta
            if seen_ts >= float(current["last_seen_ts"]):
                current["last_seen_ts"] = seen_ts
                if date_received:
                    current["last_seen"] = date_received
            if name and seen_ts >= float(current["name_seen_ts"]):
                current["name"] = name
                current["name_seen_ts"] = seen_ts

        try:
            rows = conn.execute(
                """SELECT sender, sender_name, to_addr, cc_addr, mailbox, date_received
                   FROM email_metadata"""
            ).fetchall()
            for row in rows:
                sender = _parse_address_segment(row["sender"] or "")
                if sender is not None:
                    sender_email, sender_name = sender
                    upsert(
                        (
                            sender_email,
                            _normalize_contact_name(row["sender_name"]) or sender_name,
                        ),
                        score_delta=1,
                        date_received=row["date_received"],
                    )

                recipient_score = 3 if row["mailbox"] == "发件箱" else 1
                for parsed in _parse_address_list(row["to_addr"]):
                    upsert(
                        parsed,
                        score_delta=recipient_score,
                        date_received=row["date_received"],
                    )
                for parsed in _parse_address_list(row["cc_addr"]):
                    upsert(
                        parsed,
                        score_delta=recipient_score,
                        date_received=row["date_received"],
                    )

            return [
                ContactSuggestion(
                    email=str(item["email"]),
                    name=item["name"] if isinstance(item["name"], str) else None,
                    score=int(item["score"]),
                    last_seen=(
                        item["last_seen"]
                        if isinstance(item["last_seen"], str)
                        else None
                    ),
                )
                for item in contacts.values()
            ]
        finally:
            conn.close()

    # ============================================================
    # SEARCH (Phase 3: FTS5)
    # ============================================================

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

        normalized_mode = (mode or "smart").lower()
        if normalized_mode == "raw":
            structured_filters, structured_warnings = build_structured_filter_predicates(
                mailbox=mailbox,
                since_date=since_date,
                until_date=until_date,
                now=now,
                tz_offset_minutes=tz_offset_minutes,
            )
            hits = self._search_email_bodies_raw(
                query,
                limit=limit,
                extra_filters=structured_filters,
            )
            return EmailSearchResult(hits, query, structured_warnings)

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
                    limit=limit,
                    mailbox=mailbox,
                    since_date=since_date,
                    until_date=until_date,
                    now=now,
                    tz_offset_minutes=tz_offset_minutes,
                )
                if trigram_result is not None:
                    return trigram_result
            transformed = smart_query_transform(query)
            structured_filters, structured_warnings = build_structured_filter_predicates(
                mailbox=mailbox,
                since_date=since_date,
                until_date=until_date,
                now=now,
                tz_offset_minutes=tz_offset_minutes,
            )
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
                limit=limit,
                query_for_log=transformed,
            )
            return EmailSearchResult(
                hits,
                transformed,
                [*parsed.warnings, *structured_warnings],
            )

        hits, transformed = self._search_email_bodies_parsed(
            parsed,
            limit=limit,
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
            now=now,
            tz_offset_minutes=tz_offset_minutes,
        )
        return EmailSearchResult(hits, transformed, parsed.warnings)

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
                   bm25(email_body_fts, 1.0, 5.0, 2.0) AS rank
              FROM email_body_fts
              JOIN email_metadata m ON m.internal_id = email_body_fts.rowid
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

    # ============================================================
    # T7: CJK trigram 路由执行 (仅 flag=True + 裸全文含 CJK 的 plain fast-path)
    # ============================================================

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
    ) -> Optional[EmailSearchResult]:
        """裸全文 query 的 CJK trigram 路由 (T7)。

        - 每个 term 按 ``build_search_plan`` 路由 (unicode / trigram_match /
          trigram_like / too_short)。
        - 每个 term 产出有序候选 internal_id 列表; term 之间 AND (rowid 交集)。
        - 用 P1 的 RRF (``1/(_RRF_K + row_number)``) 把各 term 列表的 rank 融合,
          ORDER BY score DESC, date DESC。
        - 返回 None 表示「不接管, 回退老 unicode fast-path」(例如全部 term 都 too_short
          但仍有 1 字拦截 warning 要透传 → 仍返回空结果 result 而非 None)。

        英文 / 列级 FTS / 附件融合不在此路径 (那些走 parsed / 老 fast-path), 故 T5/T6 不受影响。
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
        warnings = [*parsed.warnings, *plan_warnings, *structured_warnings]

        # 全部 term 被拦截 (例如纯单字 CJK query '我') → 不查, 返回空 + warning。
        if not routes:
            return EmailSearchResult([], query, warnings)

        conn = self._connect()
        try:
            # 每个 term 一个有序候选 internal_id 列表 (rank 用 list 内位置算 RRF)。
            per_term_ids: list[list[int]] = []
            for route in routes:
                ids = self._trigram_term_candidate_ids(conn, route, query_for_log=query)
                if not ids:
                    # 任一 term 无候选 → AND 交集为空, 直接空结果 (warning 仍透传)。
                    return EmailSearchResult([], query, warnings)
                per_term_ids.append(ids)

            # AND 交集 (rowid 必须出现在每个 term 的候选集里)。
            common: set[int] = set(per_term_ids[0])
            for ids in per_term_ids[1:]:
                common &= set(ids)
            if not common:
                return EmailSearchResult([], query, warnings)

            # 应用 metadata 过滤 (mailbox / date) — 复用结构化谓词, 在 email_metadata 上过滤。
            allowed = self._filter_ids_by_metadata(conn, common, structured_filters)
            if not allowed:
                return EmailSearchResult([], query, warnings)

            # RRF 融合: 每个 term 列表里命中的 id 贡献 1/(k + rank)。
            rrf_scores: dict[int, float] = {}
            for ids in per_term_ids:
                rank = 0
                for iid in ids:
                    if iid not in allowed:
                        continue
                    rank += 1
                    rrf_scores[iid] = rrf_scores.get(iid, 0.0) + 1.0 / (_RRF_K + rank)

            hits = self._build_trigram_hits(conn, rrf_scores, limit, routes)
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
        - route='trigram': latin 段走 email_body_fts MATCH; 每个 CJK 段走 trigram 表
          (>=3 MATCH / =2 LIKE)。同 term 多段 AND (交集)。返回交集后的有序列表
          (以第一个可排序候选源的顺序为准, 缺失 bm25 的 LIKE 段按 internal_id DESC 兜底)。
        """
        if route.route == "unicode":
            return self._fts_match_ids(
                conn, "email_body_fts", route.unicode_expr, query_for_log=query_for_log
            )

        # trigram term: 收集各段候选, 段间 AND。
        segment_lists: list[list[int]] = []
        for latin in route.latin_segments:
            expr = smart_query_transform(latin)
            segment_lists.append(
                self._fts_match_ids(
                    conn, "email_body_fts", expr, query_for_log=query_for_log
                )
            )
        for seg in route.cjk_segments:
            if seg.route == "trigram_match":
                segment_lists.append(
                    self._fts_match_ids(
                        conn,
                        "email_body_fts_trigram",
                        seg.value,
                        query_for_log=query_for_log,
                    )
                )
            elif seg.route == "trigram_like":
                segment_lists.append(
                    self._trigram_like_ids(conn, seg.value, query_for_log=query_for_log)
                )

        if not segment_lists:
            return []
        # 段间 AND: 以第一个段的顺序为基准, 仅保留出现在所有段的 id。
        common = set(segment_lists[0])
        for lst in segment_lists[1:]:
            common &= set(lst)
        if not common:
            return []
        return [iid for iid in segment_lists[0] if iid in common]

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

    def _trigram_like_ids(
        self,
        conn: sqlite3.Connection,
        value: str,
        *,
        query_for_log: str,
    ) -> list[int]:
        """2 字 CJK: trigram 表 body/subject/sender LIKE '%词%' 兜底 (MATCH <3 无召回)。

        无 bm25, 按启发式排序: subject 命中 > sender 命中 > body 命中, 同档按 rowid DESC。
        返回的列表顺序即作为该段的 rank 来源。
        """
        like = f"%{value}%"
        sql = """
            SELECT rowid,
                   CASE
                       WHEN subject LIKE ? THEN 0
                       WHEN sender  LIKE ? THEN 1
                       ELSE 2
                   END AS boost
              FROM email_body_fts_trigram
             WHERE body_markdown LIKE ? OR subject LIKE ? OR sender LIKE ?
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

    @staticmethod
    def _filter_ids_by_metadata(
        conn: sqlite3.Connection,
        ids: set[int],
        predicates: list[FilterPredicate],
    ) -> set[int]:
        """在 email_metadata 上对候选 id 套结构化谓词 (mailbox / date), 返回允许集。"""
        if not ids:
            return set()
        if not predicates:
            return set(ids)
        id_list = list(ids)
        placeholders = ",".join("?" for _ in id_list)
        sql = (
            f"SELECT m.internal_id FROM email_metadata m "
            f"WHERE m.internal_id IN ({placeholders})"
        )
        params: list = list(id_list)
        for predicate in predicates:
            sql += f" AND ({predicate.sql})"
            params.extend(predicate.params)
        rows = conn.execute(sql, params).fetchall()
        return {int(r["internal_id"]) for r in rows}

    def _build_trigram_hits(
        self,
        conn: sqlite3.Connection,
        rrf_scores: dict[int, float],
        limit: int,
        routes: list[_TermRoute],
    ) -> list[EmailSearchHit]:
        """按 RRF 分数 + date 排序取 top-N, 查 metadata 拼 EmailSearchHit。

        ``rank`` = ``-rrf_score`` (越小越相关), 与 P1 _merge_search_rows_by_rrf 出口语义一致。
        snippet: 对最终 top-N 用「snippet 表达式」(build_trigram_snippet_expr) 在
        email_body_fts_trigram 上跑 snippet() 高亮命中词; 该表达式为空 (纯 2/1 字 CJK)
        或某 row 不被表达式 MATCH (只 2 字 LIKE 命中) → fallback 取 body_markdown 前
        ~80 字符无高亮摘要, 保证 snippet 不恒空。Python/TS 双端逐行镜像。
        """
        if not rrf_scores:
            return []
        id_list = list(rrf_scores.keys())
        placeholders = ",".join("?" for _ in id_list)
        rows = conn.execute(
            f"""SELECT internal_id,
                       COALESCE(subject, '') AS subject,
                       COALESCE(sender, '')  AS sender,
                       date_received, mailbox, notion_page_id
                  FROM email_metadata
                 WHERE internal_id IN ({placeholders})""",
            id_list,
        ).fetchall()
        meta_by_id = {int(r["internal_id"]): r for r in rows}

        ordered = sorted(
            rrf_scores.items(),
            key=lambda kv: (
                kv[1],
                self._date_sort_value(
                    meta_by_id[kv[0]]["date_received"] if kv[0] in meta_by_id else None,
                    oldest=False,
                ),
            ),
            reverse=True,
        )
        top = [(iid, score) for iid, score in ordered[:limit] if iid in meta_by_id]
        top_ids = [iid for iid, _ in top]
        snippet_by_id = self._build_trigram_snippets(conn, top_ids, routes)

        hits: list[EmailSearchHit] = []
        for iid, score in top:
            r = meta_by_id[iid]
            page_id = r["notion_page_id"]
            notion_url = (
                f"https://www.notion.so/{page_id.replace('-', '')}"
                if page_id else None
            )
            hits.append(EmailSearchHit(
                internal_id=iid,
                subject=r["subject"],
                sender=r["sender"],
                date_received=r["date_received"],
                mailbox=r["mailbox"],
                snippet=snippet_by_id.get(iid, ""),
                rank=-float(score),
                notion_page_id=page_id,
                notion_url=notion_url,
                source="body",
                filename=None,
            ))
        return hits

    def _build_trigram_snippets(
        self,
        conn: sqlite3.Connection,
        top_ids: list[int],
        routes: list[_TermRoute],
    ) -> dict[int, str]:
        """给 top-N trigram 命中生成 snippet (高亮 + fallback)。

        ① 若 snippet 表达式非空: 在 email_body_fts_trigram MATCH 该表达式 + rowid IN top,
           取 snippet() 高亮片段 (含 <mark>) 映射回 id。
        ② 表达式为空, 或某 id 未被 ① 命中 (只 2 字 LIKE 命中) → fallback: 取 body_markdown
           前 ~80 字符无高亮摘要。
        snippet() 只能在带 MATCH 的查询里用; fallback 摘要不经 snippet()。
        """
        if not top_ids:
            return {}
        result: dict[int, str] = {}
        expr = build_trigram_snippet_expr(routes)
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
    ) -> tuple[list[EmailSearchHit], str]:
        fts_expr = self._build_positive_fts_expr(parsed)
        neg_fts_expr = self._build_negative_fts_expr(parsed)
        # T8: 收件人列 term (to~:/cc~:/from~:) 编译成 email_recipient_fts 的 IN-子查询谓词。
        recipient_predicates = self._build_recipient_predicates(parsed)
        # 排名用的正向收件人 MATCH 表达式 (recipient-only 路径用)。
        positive_recipient_expr = self._build_positive_recipient_fts_expr(parsed)
        filters, structured_warnings = build_structured_filter_predicates(
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
            now=now,
            tz_offset_minutes=tz_offset_minutes,
        )
        parsed.warnings.extend(structured_warnings)

        predicates: list[FilterPredicate] = [
            *parsed.filters,
            *self._compile_or_filter_groups(parsed.or_filter_groups),
            *filters,
            *recipient_predicates,
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
                       0.0                            AS rank
                  FROM email_metadata m
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
        conn = self._connect()
        try:
            try:
                rows = conn.execute(sql, params).fetchall()
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
    ) -> list[EmailSearchHit]:
        """Search body + attachment FTS and merge by email-level RRF.

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
            attachment_rows: list[sqlite3.Row] = []
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
            return self._merge_search_rows_by_rrf(body_rows, attachment_rows, sort, limit)
        finally:
            conn.close()

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
        sql = """
            SELECT m.internal_id,
                   COALESCE(m.subject, '')        AS subject,
                   COALESCE(m.sender, '')         AS sender,
                   m.date_received,
                   m.mailbox,
                   m.notion_page_id,
                   snippet(email_body_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                   bm25(email_body_fts, 1.0, 5.0, 2.0) AS rank,
                   'body' AS source,
                   NULL AS filename
              FROM email_body_fts
              JOIN email_metadata m ON m.internal_id = email_body_fts.rowid
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
        sql = """
            SELECT m.internal_id,
                   COALESCE(m.subject, '')        AS subject,
                   COALESCE(m.sender, '')         AS sender,
                   m.date_received,
                   m.mailbox,
                   m.notion_page_id,
                   snippet(email_attachment_fts, 0, '<mark>', '</mark>', '...', 16) AS snippet,
                   bm25(email_attachment_fts) AS rank,
                   'attachment' AS source,
                   COALESCE(a.filename, '') AS filename
              FROM email_attachment_fts
              JOIN email_attachment a ON a.id = email_attachment_fts.rowid
              JOIN email_metadata m ON m.internal_id = a.internal_id
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

    def _merge_search_rows_by_rrf(
        self,
        body_rows: list[sqlite3.Row],
        attachment_rows: list[sqlite3.Row],
        sort: Optional[str],
        limit: int,
    ) -> list[EmailSearchHit]:
        combined: dict[int, dict] = {}
        seen_body: set[int] = set()
        seen_attachment: set[int] = set()

        for row in body_rows:
            internal_id = int(row["internal_id"])
            if internal_id in seen_body:
                continue
            seen_body.add(internal_id)
            combined[internal_id] = self._row_to_search_candidate(
                row,
                source="body",
                rrf_score=1.0 / (_RRF_K + len(seen_body)),
            )

        for row in attachment_rows:
            internal_id = int(row["internal_id"])
            if internal_id in seen_attachment:
                continue
            seen_attachment.add(internal_id)
            rrf_score = 1.0 / (_RRF_K + len(seen_attachment))
            if internal_id in combined:
                combined[internal_id]["rrf_score"] += rrf_score
                continue
            combined[internal_id] = self._row_to_search_candidate(
                row,
                source="attachment",
                rrf_score=rrf_score,
            )

        candidates = list(combined.values())
        if sort == "date":
            candidates.sort(
                key=lambda item: (
                    self._date_sort_value(item["date_received"], oldest=False),
                    item["rrf_score"],
                ),
                reverse=True,
            )
        elif sort == "oldest":
            candidates.sort(
                key=lambda item: (
                    self._date_sort_value(item["date_received"], oldest=True),
                    -item["rrf_score"],
                )
            )
        else:
            candidates.sort(
                key=lambda item: (
                    item["rrf_score"],
                    self._date_sort_value(item["date_received"], oldest=False),
                ),
                reverse=True,
            )

        return [
            EmailSearchHit(
                internal_id=item["internal_id"],
                subject=item["subject"],
                sender=item["sender"],
                date_received=item["date_received"],
                mailbox=item["mailbox"],
                snippet=item["snippet"],
                rank=-float(item["rrf_score"]),
                notion_page_id=item["notion_page_id"],
                notion_url=item["notion_url"],
                source=item["source"],
                filename=item["filename"],
            )
            for item in candidates[:limit]
        ]

    @staticmethod
    def _row_to_search_candidate(
        row: sqlite3.Row,
        *,
        source: str,
        rrf_score: float,
    ) -> dict:
        page_id = row["notion_page_id"]
        notion_url = (
            f"https://www.notion.so/{page_id.replace('-', '')}"
            if page_id else None
        )
        return {
            "internal_id": int(row["internal_id"]),
            "subject": row["subject"],
            "sender": row["sender"],
            "date_received": row["date_received"],
            "mailbox": row["mailbox"],
            "snippet": row["snippet"] or "",
            "notion_page_id": page_id,
            "notion_url": notion_url,
            "source": source,
            "filename": row["filename"] if source == "attachment" else None,
            "rrf_score": rrf_score,
        }

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

    @staticmethod
    def _is_recipient_term(term: TextTerm) -> bool:
        """T8: term 是否限定到收件人表 (email_recipient_fts) 列。"""
        return term.column_table == "recipient"

    def _build_positive_fts_expr(self, parsed: ParsedSearchQuery) -> str:
        # T8: 收件人列 term (to~:/cc~:/from~:) 不进 email_body_fts MATCH —— 它们走
        # email_recipient_fts 的 IN-子查询 AND 过滤 (见 _build_recipient_predicates)。
        parts: list[str] = []
        parts.extend(
            self._text_term_to_fts(term)
            for term in parsed.fts_terms
            if not self._is_recipient_term(term)
        )
        for group in parsed.fts_or_groups:
            if any(self._is_recipient_term(term) for term in group):
                # OR 组里混入收件人列 term → 整组归 recipient 编译, 不进 body MATCH。
                continue
            parts.append(self._build_fts_or_group(group))
        parts = [p for p in parts if p]
        return " AND ".join(parts)

    def _build_negative_fts_expr(self, parsed: ParsedSearchQuery) -> str:
        parts = [
            self._text_term_to_fts(term)
            for term in parsed.neg_fts_terms
            if not self._is_recipient_term(term)
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
                   bm25(email_recipient_fts)      AS rank
              FROM email_recipient_fts
              JOIN email_metadata m ON m.internal_id = email_recipient_fts.rowid
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
        """
        parts: list[str] = []
        parts.extend(
            self._text_term_to_fts(term)
            for term in parsed.fts_terms
            if term.column is not None and not self._is_recipient_term(term)
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

    # ============================================================
    # SEARCH (PR-2b: 附件文本 FTS5)
    # ============================================================

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

    def search_attachment_texts(
        self,
        query: str,
        *,
        limit: int = 30,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
    ) -> list[AttachmentSearchHit]:
        """FTS5 搜附件文本 + JOIN 拼邮件上下文 (PR-2b).

        跟 search_email_bodies 平行设计: bm25 升序 (最相关在前),
        snippet 高亮 <mark>...</mark>, JOIN email_attachment + email_metadata
        让 chat agent 直接 render '哪封邮件的哪个附件'.
        """
        if not query or not query.strip():
            return []
        if limit <= 0:
            return []

        sql = """
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
        params: list = [query]
        if mailbox:
            sql += " AND m.mailbox = ?"
            params.append(mailbox)
        if since_date:
            sql += " AND m.date_received >= ?"
            params.append(since_date)
        if until_date:
            sql += " AND m.date_received <= ?"
            params.append(until_date)
        sql += " ORDER BY rank LIMIT ?"
        params.append(limit)

        conn = self._connect()
        try:
            try:
                rows = conn.execute(sql, params).fetchall()
            except sqlite3.OperationalError as e:
                logger.warning(
                    f"search_attachment_texts: invalid FTS5 query {query!r}: {e}"
                )
                return []

            hits: list[AttachmentSearchHit] = []
            for r in rows:
                page_id = r['notion_page_id']
                notion_url = (
                    f"https://www.notion.so/{page_id.replace('-', '')}"
                    if page_id else None
                )
                hits.append(AttachmentSearchHit(
                    attachment_id=r['attachment_id'],
                    internal_id=r['internal_id'],
                    filename=r['filename'],
                    content_type=r['content_type'],
                    snippet=r['snippet'] or '',
                    rank=float(r['rank']),
                    email_subject=r['email_subject'],
                    email_sender=r['email_sender'],
                    email_date=r['email_date'],
                    email_mailbox=r['email_mailbox'],
                    notion_page_id=page_id,
                    notion_url=notion_url,
                ))
            return hits
        finally:
            conn.close()

    def search_attachment_texts_smart(
        self,
        query: str,
        *,
        limit: int = 30,
        mailbox: Optional[str] = None,
        since_date: Optional[str] = None,
        until_date: Optional[str] = None,
    ) -> list[AttachmentSearchHit]:
        """Smart wrapper of search_attachment_texts (复用 PR-2a smart_query_transform)."""
        transformed = smart_query_transform(query)
        if transformed != query:
            logger.debug(
                f"search_attachment_texts_smart: query={query!r} → "
                f"transformed={transformed!r}"
            )
        return self.search_attachment_texts(
            transformed,
            limit=limit,
            mailbox=mailbox,
            since_date=since_date,
            until_date=until_date,
        )

    # ============================================================
    # WRITE
    # ============================================================

    def commit_email_with_body(
        self,
        internal_id: int,
        body: BodyPayload,
        attachments: list[AttachmentPayload],
        *,
        message_id: Optional[str] = None,
    ) -> dict[str, int]:
        """事务：写 email_body + 落盘 attachments + 写 email_attachment 行.

        返回:
            ``dict[原始 AttachmentPayload.filename, attachment_id]`` —— 上层
            Notion uploader 上传后用这个 map 把 notion_file_id 回写过来。

            **Key 契约**: key 是 caller 传进来的原始 ``att.filename``，**不是**
            sanitize 后落盘的 ``used_filename``（SQLite ``email_attachment.filename``
            列里存的）。调用方持有 ``AttachmentPayload`` list 即可直接查；不要用
            ``AttachmentStore`` 内部的 sanitize 结果做 key。

        失败处理:
            事务级别 rollback；落盘错误会触发 rollback 并清理已写入文件。
            FK 约束要求 email_metadata.internal_id 必须存在（CASCADE 父表）。
        """
        # 1. 先落盘所有附件（外部 IO，先做避免 DB 事务持锁太久）
        saved_files: list[Path] = []
        attachment_disk_info: list[dict] = []  # 与 attachments 同序，包含 local_path / sha256 / 实际 used_filename
        try:
            for att in attachments:
                target_path, used_filename = self.attachment_store.save(
                    internal_id, att.filename, att.content
                )
                saved_files.append(target_path)
                attachment_disk_info.append({
                    "local_path": self.attachment_store.relative_path(
                        internal_id, used_filename
                    ),
                    "sha256": AttachmentStore.sha256(att.content),
                    "used_filename": used_filename,
                    "size_bytes": len(att.content),
                })
        except OSError as e:
            # 落盘失败：清理已写
            for f in saved_files:
                try:
                    f.unlink(missing_ok=True)
                except OSError:
                    pass
            raise RuntimeError(f"Failed to save attachment to disk: {e}") from e

        # 2. 事务写 SQLite
        conn = self._connect()
        now = time.time()
        try:
            conn.execute("BEGIN")
            # email_body upsert
            body_size = len(body.markdown or body.html or "")
            conn.execute(
                """INSERT OR REPLACE INTO email_body
                   (internal_id, message_id, body_html, body_markdown,
                    body_format, body_size_bytes, has_inline_images,
                    raw_mime_sha256, fetched_at, fetched_source, schema_version)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                (
                    internal_id,
                    message_id,
                    body.html,
                    body.markdown,
                    body.body_format,
                    body_size,
                    1 if body.has_inline_images else 0,
                    body.raw_mime_sha256,
                    now,
                    body.fetched_source,
                ),
            )

            # 删除老的 attachment 行（重新 commit 时避免重复）
            conn.execute(
                "DELETE FROM email_attachment WHERE internal_id = ?",
                (internal_id,),
            )

            # 两阶段写入：第一阶段写原始附件、收集 filename → id 映射
            #            第二阶段写 derived 附件，根据 filename 映射回填 derived_from
            filename_to_id: dict[str, int] = {}
            derived_queue: list[tuple[int, AttachmentPayload, dict]] = []

            for idx, (att, disk) in enumerate(zip(attachments, attachment_disk_info)):
                if att.derived_from_filename:
                    derived_queue.append((idx, att, disk))
                    continue
                cur = conn.execute(
                    """INSERT INTO email_attachment
                       (internal_id, content_id, filename, content_type, size_bytes,
                        is_inline, local_path, sha256, derived_from, derived_format,
                        created_at, schema_version)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 1)""",
                    (
                        internal_id,
                        att.content_id,
                        disk["used_filename"],
                        att.content_type,
                        disk["size_bytes"],
                        1 if att.is_inline else 0,
                        disk["local_path"],
                        disk["sha256"],
                        now,
                    ),
                )
                filename_to_id[att.filename] = cur.lastrowid

            for idx, att, disk in derived_queue:
                derived_from_id = filename_to_id.get(att.derived_from_filename)
                conn.execute(
                    """INSERT INTO email_attachment
                       (internal_id, content_id, filename, content_type, size_bytes,
                        is_inline, local_path, sha256, derived_from, derived_format,
                        created_at, schema_version)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)""",
                    (
                        internal_id,
                        att.content_id,
                        disk["used_filename"],
                        att.content_type,
                        disk["size_bytes"],
                        1 if att.is_inline else 0,
                        disk["local_path"],
                        disk["sha256"],
                        derived_from_id,
                        att.derived_format,
                        now,
                    ),
                )

            conn.commit()

            # 拼最终返回值：所有 filename → id（含 derived）
            id_map = dict(filename_to_id)
            # 重新查 derived 的 id
            if derived_queue:
                for idx, att, disk in derived_queue:
                    row = conn.execute(
                        """SELECT id FROM email_attachment
                           WHERE internal_id = ? AND filename = ?""",
                        (internal_id, disk["used_filename"]),
                    ).fetchone()
                    if row:
                        id_map[att.filename] = row["id"]

            # PR-2b: 把非 inline 附件登记为 'pending' 让 attachment_text worker
            # 抽 PDF / docx / pptx / xlsx 文本入 FTS5 索引. inline 图 (cid:) 跳过.
            # enqueue 失败 (lock 等) 仅 warning 不 raise — 主 commit 不阻塞;
            # CLI `mailagent attachment extract --include-missing` 可兜底补.
            for att in attachments:
                if att.is_inline:
                    continue
                att_id = id_map.get(att.filename)
                if att_id is None:
                    continue
                try:
                    conn.execute(
                        """INSERT OR IGNORE INTO email_attachment_text
                           (attachment_id, text_content, text_size_bytes, extractor,
                            status, retry_count, created_at, updated_at)
                           VALUES (?, NULL, 0, 'pending', 'pending', 0, ?, ?)""",
                        (att_id, now, now),
                    )
                except Exception as e:
                    logger.warning(
                        f"enqueue attachment_text extraction failed for "
                        f"att_id={att_id}: {e}"
                    )
            conn.commit()

            return id_map
        except Exception:
            conn.rollback()
            # 回滚事务后清理落盘文件
            for f in saved_files:
                try:
                    f.unlink(missing_ok=True)
                except OSError:
                    pass
            raise
        finally:
            conn.close()

    def update_notion_links(
        self,
        internal_id: int,
        *,
        page_id: Optional[str] = None,
        file_id_map: Optional[dict[int, str]] = None,
        block_id_map: Optional[dict[int, str]] = None,
    ) -> None:
        """Notion sync 完成后回写 file/block id 到 email_attachment.

        page_id 不写 email_body（Notion 的 page_id 已经在 email_metadata.notion_page_id），
        除非未来想冗余存。
        """
        if not file_id_map and not block_id_map:
            return
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            file_id_map = file_id_map or {}
            block_id_map = block_id_map or {}
            for att_id, file_id in file_id_map.items():
                conn.execute(
                    "UPDATE email_attachment SET notion_file_id = ? WHERE id = ?",
                    (file_id, att_id),
                )
            for att_id, block_id in block_id_map.items():
                conn.execute(
                    "UPDATE email_attachment SET notion_block_id = ? WHERE id = ?",
                    (block_id, att_id),
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    # ============================================================
    # PIN (v8) — front-end "置顶" persistence
    # ============================================================

    def set_pin(self, internal_id: int, pinned: bool) -> Optional[bool]:
        """置顶 / 取消置顶。

        Returns:
            True/False — 新的置顶状态（成功）；
            None — 邮件不存在。
        """
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT is_pinned FROM email_metadata WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            if row is None:
                return None
            target = 1 if pinned else 0
            now = time.time()
            conn.execute(
                """UPDATE email_metadata
                      SET is_pinned = ?,
                          pinned_at = ?,
                          updated_at = ?
                    WHERE internal_id = ?""",
                (target, now if pinned else None, now, internal_id),
            )
            conn.commit()
            return bool(target)
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def toggle_pin(self, internal_id: int) -> Optional[bool]:
        """翻转置顶状态。Returns 新状态 / None（邮件不存在）。"""
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT is_pinned FROM email_metadata WHERE internal_id = ?",
                (internal_id,),
            ).fetchone()
            if row is None:
                return None
            new_state = not bool(row["is_pinned"])
        finally:
            conn.close()
        return self.set_pin(internal_id, new_state)

    def list_pinned_ids(self) -> list[int]:
        """所有置顶邮件的 internal_id（pinned_at DESC，最近置顶在前）。"""
        conn = self._connect()
        try:
            rows = conn.execute(
                """SELECT internal_id FROM email_metadata
                    WHERE is_pinned = 1
                    ORDER BY pinned_at DESC NULLS LAST, internal_id DESC"""
            ).fetchall()
            return [r["internal_id"] for r in rows]
        finally:
            conn.close()

    def delete_email_full(self, internal_id: int) -> None:
        """删除 email_metadata（CASCADE 触发 body + attachment）+ 本地附件目录."""
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            conn.execute(
                "DELETE FROM email_metadata WHERE internal_id = ?", (internal_id,)
            )
            conn.commit()
        finally:
            conn.close()
        self.attachment_store.delete_email_dir(internal_id)

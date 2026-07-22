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
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from loguru import logger

from src.mail.mailbox_semantics import is_sent_mailbox
from src.repository.attachment_store import AttachmentStore
from src.repository.search_query import (
    FilterPredicate,
    ParsedSearchQuery,
    TextTerm,
    build_structured_filter_predicates,
    escape_like_value,
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
class EmailBodyContentRecord:
    internal_id: int
    content: Optional[str]
    body_size_bytes: int
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
    # MED-2: 命令面板 EmailHitRow 渲染优先级 chip + lang pip 用。**raw 串**
    # (emoji-中文 priority / 'English' 等) —— serve-api 出口经 _map_priority /
    # _map_language 映射成 wire enum (与旧 TS ai_mapping.ts 一致)；CLI 不投影。
    ai_priority: Optional[str] = None
    lang: Optional[str] = None


@dataclass
class EmailSearchResult:
    """带搜索 meta 的结果，用于 CLI/API/event 透传 parser warning。

    ``has_more`` (Phase A G-A2): 是否还有超出本次 ``limit`` 的命中。由
    ``search_email_bodies_with_meta`` 用 ``limit + 1`` 探针精确判定 —— 探针多取 1 条
    检测溢出，再裁回 ``limit``（返回的 ``hits`` 与裁剪前 top-``limit`` 逐条一致，零结果
    回归）。配合 agent-facing 的「本次命中数 = len(hits) + has_more」自我收敛信号，取代
    无意义的 total_indexed（语料总量）。``total_matches`` 不在此 dataclass 上单列（恒等于
    ``len(hits)``，由 CLI/serve-api 出口按需投影）。
    """

    hits: list[EmailSearchHit]
    transformed_query: str
    parse_warnings: list[str] = field(default_factory=list)
    has_more: bool = False


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
        - 含真·FTS5 语法字符 (引号 " / 通配 * / 分组 () / 列限定 :) → 原样下放
          (尊重高级用户手写 FTS5 的意图)
        - 含 AND/OR/NOT 全大写 operator token → 原样
        - 否则按空白 split token, 逐 token 包装:
            simple token (字母数字/CJK) → _wrap_token_cjk_aware (整词/前缀/CJK 子串)
            含「附带标点」的 token (版本号 6.3 / IP / 邮箱 / 连字符) → _quote_fts_token
              成短语 —— 否则裸 MATCH 触发 FTS5 语法错误 (near ".") → 整个查询零命中
          多 token 用 AND 连接

    历史 bug (本次修复): 旧实现对「含任意非 alnum/空格/CJK 字符」的整个 query 一律原样
    下放, 导致含版本号/IP/邮箱的自然语言 query (如 'Omada 6.3' / 'SDN 6.3 Wlan
    Group修改' 的 '6.3' term) 裸 MATCH 报 fts5 syntax error → _fts_match_ids/
    _fetch_body_fts_rows 吞错返回空 → 整句搜不到。改为只对真·FTS5 语法原样下放, 其余
    逐 token 安全化 (含标点 token quote 成短语), 既保留高级语法又修复零命中。

    Examples:
        '产' → '产*'
        '产品' → '(产品* OR (产* AND 品*))'
        '本周产品评审' → '(本周产品评审* OR (本* AND 周* AND 产* AND 品* AND 评* AND 审*))'
        'redis 超时' → 'redis AND (超时* OR (超* AND 时*))'
        'redis timeout' → 'redis AND timeout'
        'Redis超时' → '(Redis AND (超时* OR (超* AND 时*)))'
        '6.3' → '"6.3"'                          (附带标点, quote 成短语)
        'Omada 6.3' → 'Omada AND "6.3"'          (版本号 token 安全化)
        'user@host.com' → '"user@host.com"'      (邮箱, quote)
        '"redis timeout"' → '"redis timeout"'   (raw, 含 quote)
        'redis AND timeout' → 'redis AND timeout'  (raw, 含 operator)
        '产品*' → '产品*'  (raw, 含 wildcard)
    """
    if not query or not query.strip():
        return query
    q = query.strip()

    # 真·FTS5 语法字符 → 原样下放 (用户手写 FTS5: 短语/通配/分组/列限定)。
    # 注意: 仅这些字符算「语法」; 附带标点 (. @ , - / 等) 不算, 继续走逐 token 安全化。
    if any(c in q for c in '"*():'):
        return q

    tokens = q.split()
    if any(t in _FTS5_OPERATORS for t in tokens):
        return q

    wrapped: list[str] = []
    for t in tokens:
        if _is_simple_natural_query(t):
            w = _wrap_token_cjk_aware(t)
        else:
            # 含附带标点的 token: quote 成短语, 避免裸 MATCH 语法错误。
            w = _quote_fts_token(t)
        if w:
            wrapped.append(w)
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
# NS-3: 候选 id 集 IN(...) 的分块大小。trigram 路径全召回 per-term 候选 (大语料 2-3 字
# 中文可命中数万行), 之后 IN(<all ids>) 套 metadata 过滤 / 拼 hit; 超 SQLite 默认参数
# 上限 (999) 会 OperationalError。分块 (≤900 / 批) union 结果, 不丢任何 id (全召回保持)。
_IN_CHUNK_SIZE = 900


# ============================================================
# T7: CJK trigram 查询计划器 (flag-gated)
# ============================================================
#
# 设计来源: .trellis/tasks/06-17-dsl-parse-warnings/research/codex-t7-tokenizer.md 方案②。
# 对每个「裸全文 term」(无列限定 / 非短语; term 已按空格切分, 无内部空格) 按
# 「是否含 CJK + 整 term 字符长度」分路由:
#   - 无 CJK (纯英文/数字/符号)  → unicode (主表 email_body_fts MATCH + smart_query_transform)
#       PR2 (搜索批次1): 含 CJK 的混合 query 里, >=3 字符的 unicode term 在执行层追加
#       trigram 子串 lane (组内并集, flag SEARCH_LATIN_TRIGRAM_ENABLED 默认开) —— 路由
#       分类本身不变, 见 _search_email_bodies_trigram。
#   - 含 CJK 且整 term >= 3 字    → trigram, mode='match' (email_body_fts_trigram MATCH 整串短语)
#   - 含 CJK 且整 term = 2 字     → trigram, mode='like' (trigram 表 body/subject/sender LIKE '%整串%')
#   - 含 CJK 且整 term = 1 字     → too_short (不查 + warning cjk_too_short:<词>)
# 多 term (空格分隔) 之间 AND (rowid 交集)。实测硬约束: trigram MATCH < 3 Unicode 字符无召回,
# 故 1/2 字中文不能走 MATCH。
# 历史 bug 修复: 含 CJK 的连续 term **整体** 走 trigram 子串检索 (不再拆 CJK/latin 段各自
# MATCH 后 AND 交集) —— 嵌在连续 token 中间的 latin 段 (如 "研发项目deadline汇报" 里的
# deadline) unicode61 召回为 0, 旧拆段 AND 会让整 term 搜不到。


def _count_cjk_chars(value: str) -> int:
    return sum(1 for c in value if _is_cjk_char(c))


@dataclass
class _TermRoute:
    """一个裸全文 term 的路由计划。

    ``route``:
        'unicode'   —— 纯非 CJK term, 走主表 unicode61 (``unicode_expr`` 为 smart_query_transform 结果)
        'trigram'   —— 含 CJK 的 term, **整 term** 走并行 trigram 表子串检索 (不再拆段 AND):
                          ``trigram_mode='match'`` (整 term >=3 字, MATCH 整串短语)
                          ``trigram_mode='like'``  (整 term =2 字, LIKE '%整串%')
        'too_short' —— 整 term 只有 1 个 CJK 字 (无别的内容), 拦截 + warning

    历史 bug 修复: 旧实现把含 CJK 的连续 term 按 CJK/非 CJK 边界拆段, latin 段走
    unicode61 主表 MATCH、CJK 段走 trigram, 段间 AND 交集。但 unicode61 只能整词/前缀
    匹配, 嵌在连续 token 中间的 latin 段 (如 ``研发项目deadline汇报`` 里的 ``deadline``)
    召回为 0 → AND 交集空 → 整 term 搜不到。整 term 走 trigram 子串检索可正确命中连续串。
    """
    original: str
    route: str
    unicode_expr: str = ""              # route='unicode' 时的 FTS5 expr
    trigram_core: str = ""             # route='trigram' 时的整 term 字面量
    trigram_mode: str = ""            # route='trigram' 时: 'match' (>=3) | 'like' (=2)
    warnings: list[str] = field(default_factory=list)


def _route_text_term(value: str) -> _TermRoute:
    """把一个裸全文 term 分类成 _TermRoute (T7 路由核心, Python/TS 双端镜像逻辑)。

    term 已按空格切分, 无内部空格。无 CJK → unicode61; 含 CJK → **整 term** 走 trigram
    子串检索 (不再拆段), 按整 term 字符长度路由: >=3 MATCH 整串 / =2 LIKE / =1 拦截。
    """
    cjk_count = _count_cjk_chars(value)
    if cjk_count == 0:
        return _TermRoute(
            original=value,
            route="unicode",
            unicode_expr=smart_query_transform(value),
        )

    core = value
    core_len = len(core)
    if core_len >= 3:
        return _TermRoute(
            original=value, route="trigram", trigram_core=core, trigram_mode="match"
        )
    if core_len == 2:
        return _TermRoute(
            original=value, route="trigram", trigram_core=core, trigram_mode="like"
        )
    # core_len == 1: 单个 CJK 字, 全表扫描噪声太高 → 拦截 + warning
    return _TermRoute(
        original=value,
        route="too_short",
        warnings=[f"cjk_too_short:{core}"],
    )


def _quote_fts_token(token: str) -> str:
    """把一个 token 包成 FTS5 短语字面量 ``"token"`` (内部双引号转义为 ``""``)。"""
    return '"' + token.replace('"', '""') + '"'


def build_trigram_snippet_expr(routes: list[_TermRoute]) -> str:
    """从路由计划构造「snippet 匹配表达式」(供 email_body_fts_trigram MATCH 高亮)。

    trigram 分词器要求 token >= 3 字符才有召回, 故只收:
      - unicode term: 其 ``original`` 里按 ``[A-Za-z0-9]+`` 抽词后取 len>=3 的。
      - trigram term 且 ``trigram_mode=='match'`` (整 term >=3 字): 收整 term ``trigram_core``。
    2 字 CJK (trigram_mode='like') 与 1 字 CJK 不进表达式 (MATCH<3 无效)。
    含 CJK 的整串 (如 ``研发项目deadline汇报``) 整体进表达式 → snippet 高亮整个连续命中串。
    各 token 包成 FTS5 短语并以 ``OR`` 连接; 全部不可 MATCH → 返回 ''。
    Python/TS 双端逐行镜像, 由行为夹具锁。
    """
    tokens: list[str] = []
    for route in routes:
        if route.route == "unicode":
            tokens.extend(t for t in re.findall(r"[A-Za-z0-9]+", route.original) if len(t) >= 3)
        elif route.route == "trigram" and route.trigram_mode == "match":
            tokens.append(route.trigram_core)
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


# ============================================================
# 候选源 (lane) 管线 — plain fast-path 的统一候选收集形态
# ============================================================
#
# plain fast-path 原先两条各自手拼的执行链 (非 CJK fused / CJK trigram) 收敛为统一
# 候选源形态: 每个 lane 产出一个「有序候选列表」(最相关在前), 下游是单一的 RRF 合并点
# ``_merge_lane_groups`` + 统一的 metadata 过滤。后续批次 (英文 trigram 子串 lane /
# 附件 lane) 以「往组里追加 lane」的方式接入, 不再各自手拼 SQL。
#
# 组合语义 (两条旧路径的语义在此统一, 行为不变):
#   - 组内多 lane **并集** (任一 lane 命中即该组命中) —— fused 路径 body ∪ attachment;
#   - 组间 **AND 交集** (每组都命中才是最终候选) —— trigram 路径 term 间 AND;
#   - RRF: 每个 lane 内按「最终候选中的出现位置」计 1/(_RRF_K + pos), 跨 lane 求和。


@dataclass
class _SearchLane:
    """plain 检索管线的一个候选源。

    ``entries``: 有序候选 ``(internal_id, row)`` (最相关在前; lane 内重复 id 按首次
    出现计位)。row 两种形态:
      - sqlite3.Row (行级 lane, fused 路径): 携带 metadata + snippet + source/filename
        投影, metadata 谓词已内联在 lane SQL (合并点不再后置过滤), 命中可直接物化;
      - None (id 级 lane, trigram 路径): 全召回不截断 (NS-3: 交集前截断会丢真命中),
        metadata 过滤由合并点统一走 ``_filter_ids_by_metadata`` 分块后置, 排序所需
        date 由合并点补查, snippet 由 ``_build_trigram_hits`` 对 top-N 统一生成。
    """
    name: str
    entries: list[tuple[int, Optional[sqlite3.Row]]]


@dataclass
class _MergedCandidate:
    """``_merge_lane_groups`` 出口: 单点 RRF 合并后的一条候选 (已排序 + 裁 top-limit)。

    ``row`` = 提供该 id 的首个行级 lane 的行 (lane 注册顺序即 payload 优先级, fused
    路径 body 先于 attachment → 正文+附件同时命中时 source='body'); 全部 lane 都是
    id 级时为 None (由 trigram 物化路径补 metadata)。
    """
    internal_id: int
    rrf_score: float
    row: Optional[sqlite3.Row]


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
        latin_trigram_enabled: Optional[bool] = None,
    ):
        self.db_path = Path(db_path)
        self.attachment_store = attachment_store or AttachmentStore()
        # T7: CJK trigram 路由开关。None → 懒读 config.search_trigram_enabled
        # (默认 False; 读 config 失败/缺 env → False, 保证测试 / CLI 无 .env 也能起)。
        # 显式传 True/False → 测试 / caller 直控 (per-case trigram fixture 用)。
        self._trigram_enabled_override = trigram_enabled
        # PR2: 含 CJK 混合 query 中 >=3 字符拉丁 token 的双 lane 开关 (镜像上面的模式)。
        self._latin_trigram_enabled_override = latin_trigram_enabled
        # MED-2: AI 投影 schema 探测的实例级 memo (旧/裸/测试库可能无 llm_processing 表 /
        # email_metadata.ai_priority v14 列)。schema 进程内静态 (迁移在 init 时已跑完) →
        # 首次探测后缓存, 免每次搜索重查 sqlite_master / pragma。
        self._has_llm_processing: Optional[bool] = None
        self._has_ai_priority_col: Optional[bool] = None

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")  # CASCADE / SET NULL
        return conn

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

    def get_body_summary(self, internal_id: int) -> Optional[EmailBodyRecord]:
        """Read body metadata without loading either large content column."""
        conn = self._connect()
        try:
            row = conn.execute(
                """SELECT internal_id, message_id, body_format, body_size_bytes,
                          has_inline_images, raw_mime_sha256, fetched_at, fetched_source
                   FROM email_body WHERE internal_id = ?""",
                (internal_id,),
            ).fetchone()
            if not row:
                return None
            return EmailBodyRecord(
                internal_id=row["internal_id"],
                message_id=row["message_id"],
                html=None,
                markdown=None,
                body_format=row["body_format"] or "html",
                body_size_bytes=row["body_size_bytes"] or 0,
                has_inline_images=bool(row["has_inline_images"]),
                raw_mime_sha256=row["raw_mime_sha256"],
                fetched_at=row["fetched_at"],
                fetched_source=row["fetched_source"],
            )
        finally:
            conn.close()

    def get_body_content(
        self,
        internal_id: int,
        format_: str,
        *,
        max_chars: int = -1,
    ) -> Optional[EmailBodyContentRecord]:
        """Read exactly one requested content column, optionally as a SQL prefix."""
        columns = {
            "markdown": "body_markdown",
            "html": "body_html",
            "raw": "raw_mime_sha256",
        }
        column = columns.get(format_)
        if column is None:
            raise ValueError(f"unsupported body format: {format_!r}")
        expression = f"substr({column}, 1, ?)" if max_chars > 0 else column
        params = (max_chars, internal_id) if max_chars > 0 else (internal_id,)
        conn = self._connect()
        try:
            row = conn.execute(
                f"""SELECT internal_id, {expression} AS content, body_size_bytes,
                           fetched_at, fetched_source
                    FROM email_body WHERE internal_id = ?""",
                params,
            ).fetchone()
            if not row:
                return None
            return EmailBodyContentRecord(
                internal_id=row["internal_id"],
                content=row["content"],
                body_size_bytes=row["body_size_bytes"] or 0,
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

    def get_attachment_record(self, attachment_id: int) -> Optional[AttachmentRecord]:
        """按 attachment.id 读单行 (compose attachment_id 引用装配需要 filename/
        content_type; 行→dataclass 映射与 get_attachments 一致)。"""
        conn = self._connect()
        try:
            r = conn.execute(
                """SELECT id, internal_id, filename, content_type, size_bytes,
                          is_inline, content_id, local_path, sha256,
                          derived_from, derived_format,
                          notion_file_id, notion_block_id, created_at
                   FROM email_attachment WHERE id = ?""",
                (attachment_id,),
            ).fetchone()
            if not r:
                return None
            return AttachmentRecord(
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

                recipient_score = 3 if is_sent_mailbox(row["mailbox"]) else 1
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

        候选**不截断** (见 ``_trigram_term_candidate_ids`` doc): 多 term AND 交集前不能
        先截断。NS-4 的 2 字 CJK LIKE 全表扫是 pre-existing perf (warmup 已缓解桌面),
        非本次修复范围; NS-3 崩溃风险在 ``_filter_ids_by_metadata`` 分块解决。
        """
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

    # ============================================================
    # PR4 (1b/1f): 附件 trigram lane 候选 (email_attachment_fts_trigram)
    # ============================================================

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
        """2 字 CJK: 附件 trigram 表 filename/text_content LIKE 兜底 (MATCH <3 无召回)。

        镜像 body 侧 ``_trigram_like_ids`` 的启发式: filename 命中 > text_content 命中,
        同档按 rowid DESC。全召回不截断; 表缺失 graceful degrade 同 MATCH 分支。
        """
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
        # P5: trigram_enabled 时, parsed 路径里的裸 CJK 词编译成 trigram IN/NOT-IN 谓词
        # (与 from:/is:/date 等过滤 AND); 同步收 1 字 CJK 拦截 warning。flag=False → 空。
        cjk_trigram_predicates: list[FilterPredicate] = []
        if self.trigram_enabled:
            cjk_trigram_predicates = self._build_cjk_trigram_predicates(parsed)
            parsed.warnings.extend(self._collect_cjk_term_warnings(parsed))
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
            *cjk_trigram_predicates,
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

    # ============================================================
    # P5: parsed 路径里「正向/负向裸全文 CJK 词」也走 trigram (flag-gated)
    # ============================================================
    #
    # T7 之前只在 plain_passthrough (无字段语法) query 启用 trigram; 一旦 query 带
    # 字段 (from:/is:/date/列词/收件人词) 就走 parsed 路径, 裸 CJK 词退回 unicode61
    # 前缀 MATCH (培训* / (培* AND 训*)), 匹配不到 CJK 串内部子串 (如 "新人培训")。
    # 修复: trigram_enabled 时把 parsed 路径里的裸 CJK 词改成 trigram 表 IN-子查询谓词
    # (复用 T8 _build_recipient_predicates 的手法), 与 from:/is:/date 等过滤 AND;
    # 同时把这些词从 body MATCH expr 里排除 (避免再走 unicode61 前缀 MATCH 双重/冲突)。
    # flag=False → 完全不启用, parsed 路径逐字节不变 (零回归)。

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
        for predicate in filters:
            sql += f" AND ({predicate.sql})"
            params.extend(predicate.params)
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
            conn.execute(
                "UPDATE email_metadata SET snippet = substr(?, 1, 100) WHERE internal_id = ?",
                (body.markdown, internal_id),
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

    def delete_email_full_if_status(
        self, internal_id: int, expected_status: str
    ) -> bool:
        """带 sync_status 谓词的 delete_email_full 变体: 仅当行仍是 expected_status 才删。

        消除 AdminService.delete_dead_letter 的 TOCTOU —— SELECT status(连接 A) 与删除
        (连接 B) 之间, 并发 admin 面若把该行 retry 成 pending/synced, 通用
        delete_email_full 会删掉一封刚复活的真邮件。把状态判定并入删除事务的 WHERE 谓词,
        rowcount==0 = 状态在窗口内已变 → 不删, 返回 False。CASCADE + 附件目录清理与
        delete_email_full 一致(仅当确实删了才清附件目录)。

        Returns:
            True  行已删除(+ 附件目录已清)
            False 行不存在或 sync_status 已变(未删任何东西)
        """
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            cur = conn.execute(
                "DELETE FROM email_metadata WHERE internal_id = ? AND sync_status = ?",
                (internal_id, expected_status),
            )
            deleted = cur.rowcount == 1
            conn.commit()
        finally:
            conn.close()
        if deleted:
            self.attachment_store.delete_email_dir(internal_id)
        return deleted

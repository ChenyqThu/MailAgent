"""Leaf dataclasses and search-plan types/helpers shared across EmailRepository modules."""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field
from typing import Optional

from src.repository.cjk_bigram import is_cjk_char as _is_cjk_char

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
    coverage: Optional[dict] = None
    effective_filters: Optional[dict] = None


@dataclass
class ContactSuggestion:
    """compose 收件人自动补全候选（出口形状 = wire 字段）。"""

    email: str
    name: Optional[str]
    score: int
    last_seen: Optional[str]
    #: 通讯录 organization —— 只用于展示（补全行的次要标识），不参与排序。
    #: 邮件头 lane 的候选没有这一项。
    org: Optional[str] = None


@dataclass
class _ContactCandidate:
    """补全候选的内部形状（邮件头 lane + 通讯录 lane 合流后的一行）。

    ``fields`` = 子串匹配面, ``tokens`` = 前缀匹配面 —— 两者都在建候选时算好,
    排序里不再做字符串切分。``former`` = 通讯录标了「曾用邮箱」, 恒排主邮箱之后。
    """

    email: str
    name: Optional[str]
    score: int
    last_seen: Optional[str]
    last_seen_ts: float
    former: bool
    fields: list[str]
    tokens: list[str]
    org: Optional[str] = None

    def to_suggestion(self) -> ContactSuggestion:
        return ContactSuggestion(
            email=self.email,
            name=self.name,
            score=self.score,
            last_seen=self.last_seen,
            org=self.org,
        )


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
    # 批次3 PR-E: trigram 纯 LIKE 查询 (2 字 CJK / 短拉丁 <3) 无 bm25 → rank 为 None
    # (按日期排序); MATCH / 老 unicode61 路径仍是 bm25 float。响应字段容 null。
    rank: Optional[float]
    email_subject: str
    email_sender: str
    email_date: Optional[str]
    email_mailbox: Optional[str]
    notion_page_id: Optional[str] = None
    notion_url: Optional[str] = None


@dataclass
class ThreadAttachmentRecord:
    """get_attachments_by_thread 单条 — email_attachment 行 + 邮件归属上下文.

    附件字段与 AttachmentRecord 同（供线程附件面板复用同一渲染），另外 JOIN
    email_metadata 拼「这个附件来自线程里哪封邮件」的归属信息（sender / date /
    subject），让 chat agent 一次拿到跨邮件的线程附件清单而不用逐封回查。
    """
    # --- email_attachment 字段（同 AttachmentRecord） ---
    id: int
    internal_id: int
    filename: str
    content_type: Optional[str]
    size_bytes: Optional[int]
    is_inline: bool
    content_id: Optional[str]
    sha256: Optional[str]
    derived_from: Optional[int]
    derived_format: Optional[str]
    notion_file_id: Optional[str]
    notion_block_id: Optional[str]
    created_at: float
    # --- 归属字段（来自 email_metadata JOIN） ---
    sender: str
    sender_name: Optional[str]
    date_received: Optional[str]
    email_subject: str


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


# Keep _is_cjk_char re-exported for callers/tests (canonical impl in src.repository.cjk_bigram).
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

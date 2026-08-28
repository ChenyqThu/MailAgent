"""Email endpoint response models.

These mirror the cli-schema shapes 1:1 so the FastAPI `data` blocks validate
against docs/cli-schema/email-*.schema.json AND match the frontend
`shared/api/types.ts` aliases (EmailMeta / EmailDetail / EmailBody / SearchHit /
SearchResult / ResyncResult / DraftPlanResult).

Field nullability + naming (snake_case) are load-bearing: the frontend codegen
(`cli.gen.ts`) is derived from the same JSON Schemas, so any drift here breaks
ajv conformance tests on the web side. In particular `DraftPlanResult` stays
snake_case (`reply_html`, `forward_intro_html`, `reply_source`) — camelCasing it
was a real past bug.

`extra="allow"` is set on the loose CLI-backed write payloads (resync/flag) so a
backend schema bump that adds a field doesn't 500 the API before this file is
updated; the strict read models keep the default (ignore-extra) to match the
`additionalProperties:false` read schemas without rejecting unknown keys at the
boundary (we forward, we don't gatekeep).
"""

from __future__ import annotations

from typing import Literal, Optional, get_args

from pydantic import BaseModel, Field

# sync_status enum (cli-schema/_common.schema.json#/$defs/sync_status).
SyncStatus = Literal[
    "pending", "fetch_failed", "synced", "failed",
    "skipped", "dead_letter", "deleted",
]

# 🔴 `--status` / `?status=` 过滤白名单的**唯一真源**（issue #68）。CLI 与 serve-api
# 此前各硬编码一份 6 值集合，双双漏了 `deleted` —— 而 `deleted` 是**真实存在的数据**
# （生产库现有一行），于是那行邮件在两个传输端都过滤不出来：
# `--status deleted` 被当成非法参数拒掉，报的还是「必须是这 6 个之一」。
# 从 Literal 派生 = 声明域与过滤域**结构性不可能再分家**。
# 与 wire 契约 `docs/cli-schema/_common.schema.json` 的对撞见
# tests/api/test_sync_status_parity.py。
VALID_SYNC_STATUSES: frozenset[str] = frozenset(get_args(SyncStatus))

# AI priority (email-search.schema.json search_hit.ai_priority).
AIPriority = Literal["critical", "urgent", "important", "normal", "low"]
Lang = Literal["zh", "en", "unknown"]

BodyFormat = Literal["markdown", "html", "raw"]
ComposeMode = Literal["reply", "reply-all", "forward"]


# --- email list -------------------------------------------------------------
class EmailListItem(BaseModel):
    """One row of `GET /api/email/list` (email-list.schema.json email_list_item).

    Frontend alias: `EmailMeta`. Order produced by repo.list_metadata is
    is_pinned DESC, is_important DESC, date_received DESC.
    """

    internal_id: int = Field(..., ge=0)
    message_id: Optional[str] = None
    thread_id: Optional[str] = None
    subject: str
    sender: str
    sender_name: Optional[str] = None
    date_received: Optional[str] = None  # ISO datetime | "YYYY-MM-DD HH:MM:SS" | null
    mailbox: Optional[str] = None
    is_read: bool
    is_flagged: bool
    sync_status: Optional[SyncStatus] = None
    notion_page_id: Optional[str] = None
    notion_url: Optional[str] = None


# --- email body summary (embedded in email get) -----------------------------
class EmailBodySummary(BaseModel):
    """Body SUMMARY object embedded in `email get` (NOT the content).

    Matches email-get.schema.json email_record.body. The actual content is only
    served by GET /api/email/{id}/body.
    """

    format: Literal["html", "text-only", "empty", "markdown"]
    size_bytes: int = Field(..., ge=0)
    has_inline_images: Optional[bool] = None
    fetched_at: Optional[float] = None
    fetched_source: Optional[str] = None
    raw_mime_sha256: Optional[str] = None


# --- attachment summary (embedded in email get) -----------------------------
class EmailGetAttachmentItem(BaseModel):
    """Attachment entry embedded in `email get` (email-get.schema.json).

    Note this is the embedded shape (no `internal_id` / `local_path`); the
    standalone attachment list uses AttachmentItem (attachment.py).
    """

    id: int
    filename: str
    size_bytes: Optional[int] = None
    content_type: Optional[str] = None
    is_inline: bool
    content_id: Optional[str] = None
    sha256: Optional[str] = None
    derived_from: Optional[int] = None
    derived_format: Optional[str] = None
    notion_file_id: Optional[str] = None
    notion_block_id: Optional[str] = None


# --- email get (detail) -----------------------------------------------------
class EmailRecord(BaseModel):
    """`GET /api/email/{id}` data (email-get.schema.json email_record).

    Frontend alias: `EmailDetail` = this + optional `is_important`. `body` is the
    SUMMARY (or null); `attachments` only present when include=attachments.
    """

    model_config = {"extra": "allow"}  # tolerate is_important + future fields

    internal_id: int = Field(..., ge=0)
    message_id: Optional[str] = None
    thread_id: Optional[str] = None
    subject: str
    sender: str
    sender_name: Optional[str] = None
    to_addr: str
    cc_addr: str = ""
    date_received: Optional[str] = None
    mailbox: str
    is_read: bool
    is_flagged: bool
    sync_status: Optional[SyncStatus] = None
    notion_page_id: Optional[str] = None
    notion_thread_id: Optional[str] = None
    notion_url: Optional[str] = None
    sync_error: Optional[str] = None
    retry_count: int = Field(default=0, ge=0)
    # Frontend EmailDetail extension (handlers/email.ts surfaces the SQLite col).
    is_important: Optional[bool] = None
    body: Optional[EmailBodySummary] = None
    attachments: Optional[list[EmailGetAttachmentItem]] = None


# --- email body (content) ---------------------------------------------------
class EmailBody(BaseModel):
    """`GET /api/email/{id}/body` data (email-body.schema.json).

    Frontend alias: `EmailBody`. `content` is null in raw mode (only the
    raw_mime_sha256 is meaningful there).
    """

    internal_id: int = Field(..., ge=0)
    format: BodyFormat
    content: Optional[str] = None
    size_bytes: int = Field(..., ge=0)
    fetched_at: Optional[float] = None
    fetched_source: Optional[str] = None


# --- email search -----------------------------------------------------------
class SearchHit(BaseModel):
    """One FTS5 hit (email-search.schema.json search_hit). Alias: `SearchHit`.

    `rank` is bm25 for raw/body-only paths or negative RRF for smart fused
    body+attachment paths (smaller = more relevant). `snippet` carries <mark> highlight.
    `ai_priority` / `lang` come from a LEFT JOIN on llm_processing and may be
    null when unclassified.
    """

    internal_id: int = Field(..., ge=0)
    subject: str
    sender: str
    date_received: Optional[str] = None
    mailbox: Optional[str] = None
    rank: float
    snippet: Optional[str] = None
    notion_page_id: Optional[str] = None
    notion_url: Optional[str] = None
    ai_priority: Optional[AIPriority] = None
    lang: Optional[Lang] = None
    source: Literal["body", "attachment"] = "body"
    filename: Optional[str] = None


class SearchResult(BaseModel):
    """`GET /api/email/search` data shape per the FRONTEND `SearchResult` type.

    The CLI emits `data=[hits]` + `meta{query,total_hits,limit,total_indexed}`;
    the frontend's HttpApi reshapes it into `{items, total_indexed,
    transformed_query?, mode?, parse_warnings?}`. The router builds this from the
    CLI/repo hits + a `SELECT count(*) FROM email_body_fts` for `total_indexed`.
    """

    items: list[SearchHit]
    total_indexed: int = Field(..., ge=0)
    # Phase A G-A2: 本次查询命中数 (= len(items), ≤ limit) + 是否还有更多。取代把语料总量
    # total_indexed 当「命中数」喂给搜索 agent 的误导 —— agent 据 has_more 自我收敛 (太多→
    # 加 filter 缩小)。has_more 由 repo 的 limit+1 探针精确判定。
    total_matches: int = Field(0, ge=0)
    has_more: bool = False
    transformed_query: Optional[str] = None
    mode: Optional[Literal["smart", "raw"]] = None
    parse_warnings: Optional[list[str]] = None


class ContactSuggestion(BaseModel):
    """`GET /api/email/contacts` item; compose 收件人自动补全候选。"""

    email: str
    name: Optional[str] = None
    #: 通讯录 organization（只有通讯录 lane 的候选带）。展示用，不参与排序。
    org: Optional[str] = None
    score: int = Field(..., ge=0)
    last_seen: Optional[str] = None


class ContactSuggestResult(BaseModel):
    """`GET /api/email/contacts` data shape."""

    items: list[ContactSuggestion]


# --- email resync -----------------------------------------------------------
class ResyncPlan(BaseModel):
    """`--dry-run` plan (email-resync.schema.json resync_plan)."""

    model_config = {"extra": "allow"}

    internal_id: int = Field(..., ge=0)
    subject: Optional[str] = None
    current_page_id: Optional[str] = None
    action: Literal["create_or_skip", "replace"]
    would_replace: Optional[bool] = None
    skip_parent_lookup: Optional[bool] = None
    dry_run: Literal[True] = True


class ResyncResult(BaseModel):
    """Executed resync (email-resync.schema.json resync_result). Alias: `ResyncResult`."""

    model_config = {"extra": "allow"}

    internal_id: int = Field(..., ge=0)
    old_page_id: Optional[str] = None
    new_page_id: Optional[str] = None
    archived_page_id: Optional[str] = None
    action: Literal["created", "replaced", "skipped"]
    dry_run: Literal[False] = False
    attachments_uploaded: Optional[int] = None
    attachments_failed: Optional[int] = None
    thread_relations_updated: Optional[bool] = None


# --- email flag (Sprint 15 outbox write) ------------------------------------
class FlagPayload(BaseModel):
    """Subset of fields actually written (email-flag.schema.json payload)."""

    model_config = {"extra": "allow"}

    is_read: Optional[bool] = None
    is_flagged: Optional[bool] = None
    processing_status: Optional[str] = None


class FlagOutboxEntry(BaseModel):
    """One enqueued outbox row pair (email-flag.schema.json)."""

    internal_id: int = Field(..., ge=0)
    mailapp_outbox_id: Optional[int] = None  # -1 = echo-prevent skip; null = empty payload
    notion_outbox_id: int


class FlagResult(BaseModel):
    """Executed flag write (email-flag.schema.json flag_result).

    The dry-run plan variant is forwarded verbatim by the router (loose), so we
    only model the executed result strictly-ish. `extra=allow` keeps it robust.
    """

    model_config = {"extra": "allow"}

    dry_run: Literal[False] = False
    updated_ids: list[int]
    payload: FlagPayload
    outbox_entries: list[FlagOutboxEntry]
    not_found: Optional[list[int]] = None


# --- email archive ----------------------------------------------------------
class ArchiveResult(BaseModel):
    """`POST /api/email/{id}/archive` data (davmail-only IMAP MOVE → 存档)."""

    model_config = {"extra": "allow"}

    success: bool
    from_mailbox: Optional[str] = None
    to_mailbox: Optional[str] = None
    notion_updated: Optional[bool] = None
    notion_error: Optional[str] = None


# --- compose draft-plan / draft / send --------------------------------------
class DraftPlanResult(BaseModel):
    """`GET /api/email/{id}/draft-plan` data (CLI `email draft --dry-run`).

    Alias: `DraftPlanResult`. MUST stay snake_case — `reply_html`,
    `forward_intro_html`, `reply_source` (camelCasing broke compose pre-fill in
    a prior sprint). allow_missing_reply=True on the CLI means recipients come
    back even with no LLM suggestion.
    """

    model_config = {"extra": "allow"}

    internal_id: int = Field(..., ge=0)
    mode: ComposeMode
    to: list[str]
    cc: list[str]
    bcc: list[str]
    subject: str
    reply_source: Optional[str] = None
    reply_html: str
    forward_intro_html: str
    attachments: int
    warnings: list[str]


class DraftResult(BaseModel):
    """`POST /api/email/{id}/draft` data (davmail IMAP APPEND to Drafts)."""

    model_config = {"extra": "allow"}

    drafts_folder: Optional[str] = None
    appended_uid: Optional[int] = None
    method: Optional[str] = None


class SendResult(BaseModel):
    """`POST /api/email/{id}/send` data (irreversible SMTP send)."""

    model_config = {"extra": "allow"}

    sent: bool
    message_id: Optional[str] = None
    archived_to_sent: Optional[bool] = None
    method: Optional[str] = None


# --- pinned -----------------------------------------------------------------
class PinnedIds(BaseModel):
    """`GET /api/email/pinned-ids` data (wraps repo.list_pinned_ids)."""

    pinned_ids: list[int]
    count: int


__all__ = [
    "SyncStatus", "AIPriority", "Lang", "BodyFormat", "ComposeMode",
    "EmailListItem", "EmailBodySummary", "EmailGetAttachmentItem", "EmailRecord",
    "EmailBody", "SearchHit", "SearchResult",
    "ResyncPlan", "ResyncResult",
    "FlagPayload", "FlagOutboxEntry", "FlagResult",
    "ArchiveResult",
    "DraftPlanResult", "DraftResult", "SendResult",
    "PinnedIds",
]

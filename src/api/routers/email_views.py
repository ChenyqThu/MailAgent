"""email enriched 视图路由 — /api/email/* (enriched 读端点)。

与 routers/email.py **同 prefix 不同文件**: email.py 装 CLI-契约镜像的 CRUD/搜索/写端点，
本文件专装收件箱 UI 主力的 **enriched 读视图** (email_metadata + email_body +
llm_processing 的 JOIN，非 repo-backed 单表)。tags=['email-enriched'] 便于 OpenAPI 分组。

实现的 6 端点 (handoff §2 + gotcha #4):
  GET  /api/email/list-enriched        — listEnriched (snippet+AI chip JOIN，**本 sprint 必须**)
  GET  /api/email/mailboxes            — listMailboxes (mailbox 汇总计数，**本 sprint 必须**)
  GET  /api/email/thread/{thread_id}   — listByThread (单线程兄弟邮件，ASC)
  POST /api/email/threads              — listByThreads (批量线程 → {thread_id: items[]})
  POST /api/email/snippets             — listSnippets (ids → {id: snippet}，懒取正文摘要)
  POST /api/email/ai-fields            — aiFields (ids → {id: AIFields}，LLM 标签 JOIN)

这些视图的 wire ``data`` 形状 1:1 镜像 **Electron 主进程 handler**
(frontend/src/electron/main/handlers/email.ts 的 listEmailsEnriched / listMailboxes /
listEmailsByThread(s) / listEmailSnippets / getAIFields)，让 web HttpApi 能与
ElectronApi 同形复用 EnrichedEmailMeta / MailboxSummary / AIFields
(frontend/src/shared/api/types.ts) 类型，无须跨 main/renderer 边界。

**SQLite SSoT 直读**: 不经 CLI subprocess，借 ``repo._connect()`` 起短命连接 (timeout=30,
per-call open/close)，WAL 下与 mail-sync writer 并发安全 (gotcha #13)。

**防御式 schema 适配** (gotcha #4 "graceful 返回空/降级，勿 throw" + 现有 search 端点
吞 OperationalError 的同款韧性)：enriched JOIN 依赖 v13/v14 迁移列
(``processing_status`` / ``ai_priority`` / ``ai_action``) 与 ``llm_processing`` 表
(src/llm_agent/store.py 建)。生产库齐全；裸/旧库或测试 fixture 可能缺。本模块**启动前探测**
实际 schema，缺失的列/表降级为 NULL (该行 AI 字段空着)，核心 enriched 列表/mailbox 仍可用，
绝不让端点因 schema 漂移 500。

统一响应走 app.success_envelope / app.APIError；鉴权挂 Depends(verify_cf_access)。
"""

from __future__ import annotations

import json
import sqlite3
from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter, Body, Depends, Query, Request

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_repository

if TYPE_CHECKING:
    from src.repository import EmailRepository

router = APIRouter(prefix="/api/email", tags=["email-enriched"])

# C10: batch 端点 (threads / snippets / ai-fields / list-enriched internalIds) 从请求体/
# query 构 ``IN (...)`` SQL。无界列表会撑爆 SQLite 变量上限 (SQLITE_MAX_VARIABLE_NUMBER,
# 默认 999) 并阻塞连接。统一 cap 批量基数 ≤500 (远低于变量上限, 留余量给其它绑定参数),
# 超限 → 400 E_INVALID_ARG (调用方应分页/分批)。
BATCH_IDS_MAX = 500


def _reject_oversized_batch(n: int, *, field: str) -> None:
    """批量基数 > BATCH_IDS_MAX → raise E_INVALID_ARG (→ 400)。

    在 SQL 构建前调用 (de-dupe 后的实际计数), 避免无界 ``IN (...)`` 撑爆 SQLite
    变量限制 / 长时间占用连接。``field`` 是出错的请求字段名 (内嵌进 message)。
    """
    if n > BATCH_IDS_MAX:
        raise APIError(
            "E_INVALID_ARG",
            f"{field} batch too large: {n} > {BATCH_IDS_MAX} max; "
            "split into smaller batches",
            source="sqlite",
        )


# ===========================================================================
# AI label mapping — Python 端口，1:1 对齐 frontend/src/shared/lib/ai_mapping.ts
# (handlers/email.ts 用同名 helper 把 labels_json 原始值映成前端 enum)。
# 改这里时同步改 ai_mapping.ts，否则 web 与 electron 行为分叉。
# ===========================================================================


def _map_priority(raw: Optional[str]) -> Optional[str]:
    """emoji-中文 priority → 5-slug enum (critical/urgent/important/normal/low)。

    镜像 ai_mapping.ts::mapPriority — 按中文子串匹配 (不依赖 emoji)，顺序敏感
    ('重要' 在 '一般' 前)。无法识别 → None。
    """
    if not raw or not isinstance(raw, str):
        return None
    if "紧急" in raw or "Critical" in raw:
        return "critical"
    if "紧迫" in raw or "严重" in raw or "Urgent" in raw:
        return "urgent"
    if "重要" in raw or "Important" in raw:
        return "important"
    if "一般" in raw or "普通" in raw or "Normal" in raw:
        return "normal"
    if "低" in raw or "Low" in raw:
        return "low"
    return None


def _map_language(raw: Optional[str]) -> str:
    """LLM 语言串 → 2-letter ('zh'/'en'/'unknown')。镜像 ai_mapping.ts::mapLanguage。"""
    if not raw or not isinstance(raw, str):
        return "unknown"
    s = raw.lower()
    if "中文" in raw or s in ("chinese", "zh", "zh-cn"):
        return "zh"
    if s in ("english", "en", "en-us", "en-gb"):
        return "en"
    return "unknown"


def _map_sentiment(raw: Optional[str]) -> Optional[str]:
    """sentiment 透传 (agent 暂不产出)。镜像 ai_mapping.ts::mapSentiment。"""
    if not raw or not isinstance(raw, str):
        return None
    return raw


def _map_review_status(raw: Optional[str]) -> Optional[str]:
    """llm_processing.status → 'pending'/'reviewed'/None。镜像 ai_mapping.ts::mapReviewStatus。"""
    if not raw or not isinstance(raw, str):
        return None
    if raw == "success":
        return "reviewed"
    if raw in ("failed", "gave_up", "pending"):
        return "pending"
    return None


def _parse_labels(raw: Optional[str]) -> Optional[dict[str, Any]]:
    """labels_json 安全解析 → dict | None。镜像 ai_mapping.ts::parseLabels (容错 malformed)。"""
    if not raw or not isinstance(raw, str):
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _as_bool(n: Any) -> bool:
    """SQLite int → bool。镜像 handlers/email.ts::asBool (仅 1 为 True)。"""
    return n == 1


def _notion_url(page_id: Optional[str]) -> Optional[str]:
    """page_id → bare notion.so URL。镜像 handlers/email.ts::notionUrl。"""
    if not page_id:
        return None
    return f"https://www.notion.so/{page_id.replace('-', '')}"


# ===========================================================================
# Schema 探测 — 适配生产 (全列 + llm_processing) vs 裸/旧/测试库 (缺迁移列/表)。
# 结果按 db_path 进程内 memo (schema 在进程生命周期内不变；mail-sync 迁移在另一进程，
# 但 serve-api 与之共享同一物理库且 v4 迁移在 SyncStore 初始化期完成，API 进程只读)。
# ===========================================================================

# {db_path_str: {"meta_cols": set[str], "has_llm": bool}}
_SCHEMA_CACHE: dict[str, dict[str, Any]] = {}


def _probe_schema(repo: "EmailRepository") -> dict[str, Any]:
    """探测 email_metadata 列集合 + llm_processing 表是否存在 (按 db_path memo)。

    enriched SQL 据此决定是否 SELECT ``ai_priority`` / ``ai_action`` /
    ``processing_status`` (v13/v14 迁移列) 与是否 JOIN ``llm_processing``
    (src/llm_agent/store.py 建)。缺失列/表在生产不会发生，但旧/裸/测试库会 —
    那时这些字段降级 NULL，核心列表仍出数据 (gotcha #4 graceful)。
    """
    key = str(repo.db_path)
    cached = _SCHEMA_CACHE.get(key)
    if cached is not None:
        return cached

    meta_cols: set[str] = set()
    has_llm = False
    conn = repo._connect()
    try:
        try:
            rows = conn.execute("PRAGMA table_info(email_metadata)").fetchall()
            meta_cols = {r["name"] for r in rows}
        except sqlite3.OperationalError:
            meta_cols = set()
        try:
            row = conn.execute(
                "SELECT name FROM sqlite_master "
                "WHERE type='table' AND name='llm_processing'"
            ).fetchone()
            has_llm = row is not None
        except sqlite3.OperationalError:
            has_llm = False
    finally:
        conn.close()

    result = {"meta_cols": meta_cols, "has_llm": has_llm}
    _SCHEMA_CACHE[key] = result
    return result


# ===========================================================================
# WHERE 构建 — 复用 handlers/email.ts::buildListWhere 的列/语义 (m. 限定)。
# camelCase (前端契约 ListOpts) 在 router 入参层归一，这里只收已归一的 dict。
# ===========================================================================


_LIST_ITEM_META_COLS = (
    "internal_id, message_id, thread_id, subject, sender, sender_name, "
    "to_addr, cc_addr, date_received, mailbox, is_read, is_flagged, "
    "is_important, sync_status, notion_page_id, notion_thread_id, "
    "sync_error, retry_count"
)


def _shape_list_item(row: sqlite3.Row) -> dict[str, Any]:
    """email_metadata 行 → EmailList_EmailListItem wire dict。

    镜像 handlers/email.ts::shapeListItem (前端 EmailMeta 形状)。enriched 视图与
    listByThread(s) 共用此基。``subject``/``sender`` 空缺归 ''；bool 列归一。
    """
    return {
        "internal_id": row["internal_id"],
        "message_id": row["message_id"],
        "thread_id": row["thread_id"],
        "subject": row["subject"] or "",
        "sender": row["sender"] or "",
        "sender_name": row["sender_name"],
        "date_received": row["date_received"],
        "mailbox": row["mailbox"],
        "is_read": _as_bool(row["is_read"]),
        "is_flagged": _as_bool(row["is_flagged"]),
        "sync_status": row["sync_status"],
        "notion_page_id": row["notion_page_id"],
        "notion_url": _notion_url(row["notion_page_id"]),
    }


def _build_enriched_where(opts: dict[str, Any]) -> tuple[list[str], list[Any]]:
    """据归一后的 opts dict 构建 enriched JOIN 的 WHERE 子句 (m. 限定列)。

    镜像 handlers/email.ts::buildListWhere + buildEnrichedWhere (后者把裸列重限定为
    m.alias，这里直接生成 m. 形)。所有值参数化，无注入面。返回 (clauses, params)。
    """
    clauses: list[str] = []
    params: list[Any] = []
    if opts.get("mailbox"):
        clauses.append("m.mailbox = ?")
        params.append(opts["mailbox"])
    if opts.get("status"):
        clauses.append("m.sync_status = ?")
        params.append(opts["status"])
    if opts.get("since"):
        clauses.append("m.date_received >= ?")
        params.append(opts["since"])
    if opts.get("until"):
        clauses.append("m.date_received <= ?")
        params.append(opts["until"])
    if opts.get("from_addr"):
        clauses.append("m.sender LIKE ?")
        params.append(f"%{opts['from_addr']}%")
    if opts.get("subject"):
        clauses.append("m.subject LIKE ?")
        params.append(f"%{opts['subject']}%")
    if opts.get("is_read") is not None:
        clauses.append("m.is_read = ?")
        params.append(1 if opts["is_read"] else 0)
    if opts.get("is_flagged") is not None:
        clauses.append("m.is_flagged = ?")
        params.append(1 if opts["is_flagged"] else 0)
    if opts.get("has_notion") is not None:
        clauses.append(
            "m.notion_page_id IS NOT NULL"
            if opts["has_notion"]
            else "m.notion_page_id IS NULL"
        )
    internal_ids = opts.get("internal_ids")
    if internal_ids:
        placeholders = ",".join("?" for _ in internal_ids)
        clauses.append(f"m.internal_id IN ({placeholders})")
        params.extend(internal_ids)
    return clauses, params


# ===========================================================================
# GET /api/email/list-enriched — listEnriched (收件箱主列表，本 sprint 必须)
# ===========================================================================

ENRICHED_LIMIT_MAX = 3000  # 对齐 handlers/email.ts (前端 MAX_PAGES*PAGE_SIZE=3000)


@router.get("/list-enriched", dependencies=[Depends(verify_cf_access)])
async def list_enriched(
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
    # camelCase = 前端 ListOpts 契约 (types.ts)；snake_case alias 兼容 CLI 口径
    # (与 email.py list 端点 F2 修法一致: 两种都绑，避免静默丢弃 filter)。
    mailbox: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    since: Optional[str] = Query(None, alias="sinceDate"),
    until: Optional[str] = Query(None, alias="untilDate"),
    from_addr: Optional[str] = Query(None, alias="fromAddr"),
    subject: Optional[str] = Query(None),
    is_read: Optional[bool] = Query(None, alias="isRead"),
    is_flagged: Optional[bool] = Query(None, alias="isFlagged"),
    has_notion: Optional[bool] = Query(None, alias="hasNotion"),
    internal_ids: Optional[str] = Query(
        None,
        alias="internalIds",
        description="逗号分隔 internal_id 白名单 (pinned-supplement / 已知 id 批量取)",
    ),
    limit: int = Query(100, ge=1, le=ENRICHED_LIMIT_MAX),
    offset: int = Query(0, ge=0),
):
    """收件箱 enriched 列表 — metadata + snippet(懒) + AI chip + attach_count + 线程。

    data = EnrichedEmailMeta[] (types.ts): EmailMeta + {snippet(null,懒取)/has_body/
    lang/ai_priority/ai_action/ai_category/attach_count/is_important/processing_status}。
    1:1 镜像 handlers/email.ts::listEmailsEnriched —— 含 ``skipped`` 守卫 (调用方未显式
    查 status 时排除陈旧/过滤行，与 mailbox 计数口径一致) + Sprint19 snippet 懒取
    (列表查询不读 body blob，snippet=null，前端对可见行调 /snippets)。

    AI 字段经 ``llm_processing.labels_json`` LEFT JOIN + 主表 ai_priority/ai_action
    COALESCE 提升 (v14)。schema 缺这些列/表时 (旧/裸/测试库) 降级 NULL，列表仍出数据。
    """
    parsed_ids: Optional[list[int]] = None
    if internal_ids:
        try:
            parsed_ids = [
                int(x) for x in internal_ids.split(",") if x.strip() != ""
            ]
        except ValueError:
            raise APIError(
                "E_INVALID_ARG",
                f"internalIds must be comma-separated integers, got {internal_ids!r}",
                source="sqlite",
            )
        # C10: cap the IN(...) whitelist size before it reaches SQL.
        _reject_oversized_batch(len(parsed_ids), field="internalIds")

    opts: dict[str, Any] = {
        "mailbox": mailbox,
        "status": status,
        "since": since,
        "until": until,
        "from_addr": from_addr,
        "subject": subject,
        "is_read": is_read,
        "is_flagged": is_flagged,
        "has_notion": has_notion,
        "internal_ids": parsed_ids,
    }

    schema = _probe_schema(repo)
    meta_cols: set[str] = schema["meta_cols"]
    has_llm: bool = schema["has_llm"]
    has_processing = "processing_status" in meta_cols
    has_ai_priority = "ai_priority" in meta_cols
    has_ai_action = "ai_action" in meta_cols

    clauses, params = _build_enriched_where(opts)

    # skipped 守卫: 仅当调用方未显式查 status 时附加 (保留显式查 skipped 原义)。
    # 渲染层永不显示 skipped 行 (AppleScript 时代发件箱降级遗留 + pre-SYNC_START_DATE
    # 过滤行)，与 listMailboxes 计数 SQL 同口径，避免 sidebar badge 与列表数错位。
    if status is None:
        clauses.append("m.sync_status != 'skipped'")
    where_sql = ("WHERE " + " AND ".join(clauses)) if clauses else ""

    # m. 限定的 list-item 列 (LEFT JOIN 后裸名歧义) + enriched 额外列。
    enriched_meta_cols = (
        "m.internal_id, m.message_id, m.thread_id, m.subject, m.sender, "
        "m.sender_name, m.to_addr, m.cc_addr, m.date_received, m.mailbox, "
        "m.is_read, m.is_flagged, m.is_important, m.sync_status, "
        "m.notion_page_id, m.notion_thread_id, m.sync_error, m.retry_count"
    )
    # processing_status: 缺列时给 NULL 占位 (Sprint15 D 块，旧库可能无)。
    if has_processing:
        enriched_meta_cols += ", m.processing_status"
    else:
        enriched_meta_cols += ", NULL AS processing_status"

    # AI 字段: labels_json 经 json_valid 守卫 (malformed JSON 否则整 query 抛 →
    # 列表整页崩)；priority/action 走主表列 COALESCE fallback labels_json (v14)。
    # has_body: 只判 body 行存在 (PK join，不读 blob → Sprint19 perf)。
    if has_llm:
        lang_expr = (
            "CASE WHEN json_valid(l.labels_json) "
            "THEN json_extract(l.labels_json, '$.language') END"
        )
        category_expr = (
            "CASE WHEN json_valid(l.labels_json) "
            "THEN json_extract(l.labels_json, '$.category') END"
        )
        labels_priority = (
            "CASE WHEN json_valid(l.labels_json) "
            "THEN json_extract(l.labels_json, '$.priority') END"
        )
        labels_action = (
            "CASE WHEN json_valid(l.labels_json) "
            "THEN json_extract(l.labels_json, '$.action_type') END"
        )
    else:
        lang_expr = category_expr = labels_priority = labels_action = "NULL"

    priority_expr = (
        f"COALESCE(m.ai_priority, {labels_priority})"
        if has_ai_priority
        else labels_priority
    )
    action_expr = (
        f"COALESCE(m.ai_action, {labels_action})"
        if has_ai_action
        else labels_action
    )

    extra_cols = (
        "(b.internal_id IS NOT NULL) AS has_body_raw, "
        f"{lang_expr} AS lang_raw, "
        f"{priority_expr} AS priority_raw, "
        f"{action_expr} AS action_raw, "
        f"{category_expr} AS category_raw, "
        "COALESCE(a.attach_count, 0) AS attach_count"
    )

    llm_join = (
        "LEFT JOIN llm_processing l ON l.internal_id = m.internal_id"
        if has_llm
        else ""
    )

    sql = f"""
        SELECT {enriched_meta_cols}, {extra_cols}
          FROM email_metadata m
          LEFT JOIN email_body b ON b.internal_id = m.internal_id
          {llm_join}
          LEFT JOIN (
            SELECT internal_id, COUNT(*) AS attach_count
              FROM email_attachment WHERE is_inline = 0
             GROUP BY internal_id
          ) a ON a.internal_id = m.internal_id
          {where_sql}
         ORDER BY m.date_received DESC NULLS LAST, m.internal_id DESC
         LIMIT ? OFFSET ?
    """

    conn = repo._connect()
    try:
        rows = conn.execute(sql, [*params, limit, offset]).fetchall()
    finally:
        conn.close()

    data = [_shape_enriched_item(r) for r in rows]
    return success_envelope(
        data,
        request=request,
        source="sqlite",
        meta_extra={"count": len(data), "limit": limit, "offset": offset},
    )


def _shape_enriched_item(row: sqlite3.Row) -> dict[str, Any]:
    """enriched 行 → EnrichedEmailMeta wire dict。镜像 handlers/email.ts::shapeEnrichedItem。

    snippet 恒 null (Sprint19 懒取，前端对可见行调 /snippets)；has_body 立即可知
    (行高稳定)；lang/ai_priority 经映射；ai_action/ai_category 原样透传 (中文 label)。
    """
    base = _shape_list_item(row)
    base.update(
        {
            "is_important": _as_bool(row["is_important"]),
            "snippet": None,
            "has_body": row["has_body_raw"] == 1,
            "lang": _map_language(row["lang_raw"]),
            "ai_priority": _map_priority(row["priority_raw"]),
            "ai_action": row["action_raw"] if row["action_raw"] is not None else None,
            "ai_category": (
                row["category_raw"] if row["category_raw"] is not None else None
            ),
            "attach_count": row["attach_count"] or 0,
            "processing_status": (
                row["processing_status"]
                if row["processing_status"] is not None
                else None
            ),
        }
    )
    return base


# ===========================================================================
# GET /api/email/mailboxes — listMailboxes (sidebar 汇总，本 sprint 必须)
# ===========================================================================


@router.get("/mailboxes", dependencies=[Depends(verify_cf_access)])
async def list_mailboxes(
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
):
    """mailbox 维度汇总 — total/unread/flagged/failed (sidebar 虚拟条目用)。

    data = MailboxSummary[] (types.ts): {mailbox, total, unread, flagged, failed}。
    1:1 镜像 handlers/email.ts::listMailboxes —— 排除 ``skipped`` (口径对齐
    list-enriched，否则 sidebar 数 ≠ 列表数) + NULL/空 mailbox。total DESC 排序。
    """
    sql = """
        SELECT mailbox,
               COUNT(*) AS total,
               SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread,
               SUM(CASE WHEN is_flagged = 1 THEN 1 ELSE 0 END) AS flagged,
               SUM(CASE WHEN sync_status IN ('failed', 'dead_letter')
                        THEN 1 ELSE 0 END) AS failed
          FROM email_metadata
         WHERE mailbox IS NOT NULL AND mailbox != ''
           AND sync_status != 'skipped'
         GROUP BY mailbox
         ORDER BY total DESC
    """
    conn = repo._connect()
    try:
        rows = conn.execute(sql).fetchall()
    finally:
        conn.close()

    data = [
        {
            "mailbox": r["mailbox"],
            "total": r["total"] or 0,
            "unread": r["unread"] or 0,
            "flagged": r["flagged"] or 0,
            "failed": r["failed"] or 0,
        }
        for r in rows
        if r["mailbox"]
    ]
    return success_envelope(
        data, request=request, source="sqlite", meta_extra={"count": len(data)}
    )


# ===========================================================================
# GET /api/email/thread/{thread_id} — listByThread (单线程兄弟邮件)
# ===========================================================================


@router.get("/thread/{thread_id}", dependencies=[Depends(verify_cf_access)])
async def list_by_thread(
    request: Request,
    thread_id: str,
    repo: "EmailRepository" = Depends(get_repository),
):
    """单线程的兄弟邮件 list-item — Thread 侧栏用。

    data = EmailMeta[] (EmailList_EmailListItem)。1:1 镜像
    handlers/email.ts::listEmailsByThread —— **ASC** 日期序 (会话自上而下读) +
    **全 sync_status** (不锁 synced，与渲染列表一致；区别 repo.get_thread_members
    的 synced_only=True/DESC，那是 Notion fanout 专用语义)。空 thread_id → []。
    """
    if not thread_id:
        return success_envelope(
            [], request=request, source="sqlite", meta_extra={"count": 0}
        )

    sql = f"""
        SELECT {_LIST_ITEM_META_COLS}
          FROM email_metadata
         WHERE thread_id = ?
         ORDER BY date_received ASC NULLS LAST, internal_id ASC
    """
    conn = repo._connect()
    try:
        rows = conn.execute(sql, (thread_id,)).fetchall()
    finally:
        conn.close()

    data = [_shape_list_item(r) for r in rows]
    return success_envelope(
        data, request=request, source="sqlite", meta_extra={"count": len(data)}
    )


# ===========================================================================
# POST /api/email/threads — listByThreads (批量线程 → {thread_id: items[]})
# ===========================================================================


@router.post("/threads", dependencies=[Depends(verify_cf_access)])
async def list_by_threads(
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
    body: dict[str, Any] = Body(
        default={},
        description='{"threadIds": ["thread-A", ...]} — 批量取兄弟邮件，单 SQL',
    ),
):
    """批量线程兄弟邮件 — 一次 SQL 取多 thread_id，替代前端 per-thread fan-out。

    body = {threadIds: string[]}；data = {thread_id: EmailMeta[]} (键缺即无命中)。
    1:1 镜像 handlers/email.ts::listEmailsByThreads —— de-dupe + 丢空 id，组内
    ASC 日期序 (与 list-by-thread 同形)。空/非法输入 → {}。
    """
    thread_ids_raw = body.get("threadIds") if isinstance(body, dict) else None
    if not isinstance(thread_ids_raw, list):
        return success_envelope(
            {}, request=request, source="sqlite", meta_extra={"count": 0}
        )
    # de-dupe + 丢空 (保序无关，IN 集合)；不信任调用方预清洗。
    seen: set[str] = set()
    ids: list[str] = []
    for t in thread_ids_raw:
        if isinstance(t, str) and t and t not in seen:
            seen.add(t)
            ids.append(t)
    if not ids:
        return success_envelope(
            {}, request=request, source="sqlite", meta_extra={"count": 0}
        )
    # C10: cap the IN(...) batch size (de-duped count) before SQL.
    _reject_oversized_batch(len(ids), field="threadIds")

    placeholders = ",".join("?" for _ in ids)
    sql = f"""
        SELECT {_LIST_ITEM_META_COLS}
          FROM email_metadata
         WHERE thread_id IN ({placeholders})
         ORDER BY thread_id ASC, date_received ASC NULLS LAST, internal_id ASC
    """
    conn = repo._connect()
    try:
        rows = conn.execute(sql, ids).fetchall()
    finally:
        conn.close()

    out: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        item = _shape_list_item(r)
        tid = item["thread_id"]
        if not tid:
            continue
        out.setdefault(tid, []).append(item)
    return success_envelope(
        out, request=request, source="sqlite", meta_extra={"count": len(out)}
    )


# ===========================================================================
# POST /api/email/snippets — listSnippets (ids → {id: snippet}，懒取)
# ===========================================================================


@router.post("/snippets", dependencies=[Depends(verify_cf_access)])
async def list_snippets(
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
    body: dict[str, Any] = Body(
        default={},
        description='{"internalIds": [1001, ...]} — 按 id 批量取正文 snippet',
    ),
):
    """按 internal_id 批量取正文 snippet (body_markdown 前 100 字) — Sprint19 懒取。

    body = {internalIds: number[]}；data = {internal_id(str): snippet}。
    1:1 镜像 handlers/email.ts::listEmailSnippets —— list-enriched 不读 body blob，
    前端对【可见行】调本接口懒取。无 body / 空 snippet 的 id 不出现在 map。
    空/非法输入 → {}。

    NOTE: JSON object 键必为 string，故 map 键是 ``"1001"`` 形 (前端按 String(id)
    取，与 IPC 的 number 键语义等价)。
    """
    ids_raw = body.get("internalIds") if isinstance(body, dict) else None
    if not isinstance(ids_raw, list):
        return success_envelope(
            {}, request=request, source="sqlite", meta_extra={"count": 0}
        )
    seen: set[int] = set()
    ids: list[int] = []
    for n in ids_raw:
        if isinstance(n, bool):
            continue  # bool 是 int 子类，排除
        if isinstance(n, int) and n >= 0 and n not in seen:
            seen.add(n)
            ids.append(n)
    if not ids:
        return success_envelope(
            {}, request=request, source="sqlite", meta_extra={"count": 0}
        )
    # C10: cap the IN(...) batch size (de-duped count) before SQL.
    _reject_oversized_batch(len(ids), field="internalIds")

    placeholders = ",".join("?" for _ in ids)
    sql = (
        "SELECT internal_id, substr(body_markdown, 1, 100) AS snippet "
        f"FROM email_body WHERE internal_id IN ({placeholders})"
    )
    conn = repo._connect()
    try:
        rows = conn.execute(sql, ids).fetchall()
    finally:
        conn.close()

    out: dict[str, str] = {}
    for r in rows:
        snip = r["snippet"]
        if isinstance(snip, str) and snip:
            out[str(r["internal_id"])] = snip
    return success_envelope(
        out, request=request, source="sqlite", meta_extra={"count": len(out)}
    )


# ===========================================================================
# POST /api/email/ai-fields — aiFields (ids → {id: AIFields})
# ===========================================================================


@router.post("/ai-fields", dependencies=[Depends(verify_cf_access)])
async def ai_fields(
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
    body: dict[str, Any] = Body(
        default={},
        description='{"internalIds": [1001, ...]} — 按 id 批量取 LLM 标签字段',
    ),
):
    """按 internal_id 批量取 AI 字段 (LLM 标签 + processing_status + 来源模型)。

    body = {internalIds: number[]}；data = {internal_id(str): AIFields}。
    单条 AIFields (types.ts) 镜像 handlers/email.ts::getAIFields:
    {internal_id, processing_status, mailbox, is_read, is_flagged, ai_priority,
    ai_action, ai_review_status, sentiment, ai_model, labels_raw}。
    handoff §2 矩阵指定 batch (ids → map)，对齐 /snippets 形 (前端可一次取整页可见行)。

    AI 来源 = llm_processing (labels_json/status/model)。schema 无 processing_status
    列 / 无 llm_processing 表时 (旧/裸/测试库) 这些字段降级 NULL，仍返回 metadata 部分。
    无对应 email_metadata 行的 id 不出现在 map。
    """
    ids_raw = body.get("internalIds") if isinstance(body, dict) else None
    if not isinstance(ids_raw, list):
        return success_envelope(
            {}, request=request, source="sqlite", meta_extra={"count": 0}
        )
    seen: set[int] = set()
    ids: list[int] = []
    for n in ids_raw:
        if isinstance(n, bool):
            continue
        if isinstance(n, int) and n >= 0 and n not in seen:
            seen.add(n)
            ids.append(n)
    if not ids:
        return success_envelope(
            {}, request=request, source="sqlite", meta_extra={"count": 0}
        )
    # C10: cap the IN(...) batch size (de-duped count) before SQL.
    _reject_oversized_batch(len(ids), field="internalIds")

    schema = _probe_schema(repo)
    meta_cols: set[str] = schema["meta_cols"]
    has_llm: bool = schema["has_llm"]
    has_processing = "processing_status" in meta_cols

    proc_col = "m.processing_status" if has_processing else "NULL AS processing_status"
    if has_llm:
        llm_join = "LEFT JOIN llm_processing l ON l.internal_id = m.internal_id"
        labels_col = "l.labels_json AS labels_json"
        status_col = "l.status AS llm_status"
        model_col = "l.model AS llm_model"
    else:
        llm_join = ""
        labels_col = "NULL AS labels_json"
        status_col = "NULL AS llm_status"
        model_col = "NULL AS llm_model"

    placeholders = ",".join("?" for _ in ids)
    sql = f"""
        SELECT m.internal_id AS internal_id, m.mailbox AS mailbox,
               m.is_read AS is_read, m.is_flagged AS is_flagged,
               {proc_col}, {labels_col}, {status_col}, {model_col}
          FROM email_metadata m
          {llm_join}
         WHERE m.internal_id IN ({placeholders})
    """
    conn = repo._connect()
    try:
        rows = conn.execute(sql, ids).fetchall()
    finally:
        conn.close()

    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        out[str(r["internal_id"])] = _shape_ai_fields(r)
    return success_envelope(
        out, request=request, source="sqlite", meta_extra={"count": len(out)}
    )


def _shape_ai_fields(row: sqlite3.Row) -> dict[str, Any]:
    """ai-fields 行 → AIFields wire dict。镜像 handlers/email.ts::getAIFields。

    labels_json 安全解析后提升 priority/action_type/sentiment；ai_review_status
    映自 llm_processing.status；ai_model = llm_processing.model (不在 labels_json)。
    """
    labels = _parse_labels(row["labels_json"])
    priority_raw = (
        labels.get("priority")
        if labels and isinstance(labels.get("priority"), str)
        else None
    )
    action_raw = (
        labels.get("action_type")
        if labels and isinstance(labels.get("action_type"), str)
        else None
    )
    sentiment_raw = (
        labels.get("sentiment")
        if labels and isinstance(labels.get("sentiment"), str)
        else None
    )
    return {
        "internal_id": row["internal_id"],
        "processing_status": (
            row["processing_status"]
            if row["processing_status"] is not None
            else None
        ),
        "mailbox": row["mailbox"] if row["mailbox"] is not None else None,
        "is_read": _as_bool(row["is_read"]),
        "is_flagged": _as_bool(row["is_flagged"]),
        "ai_priority": _map_priority(priority_raw),
        "ai_action": action_raw,
        "ai_review_status": _map_review_status(row["llm_status"]),
        "sentiment": _map_sentiment(sentiment_raw),
        "ai_model": row["llm_model"] if row["llm_model"] is not None else None,
        "labels_raw": labels,
    }

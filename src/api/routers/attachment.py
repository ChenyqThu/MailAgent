"""attachment 路由 — /api/attachment/*。

list (strip local_path!) / download (StreamingResponse + Range) / inline (cid: 图)。
契约: attachment-list.schema.json + 实现规格 gotcha #1 (绝不回显 host 路径)、#2
(无 single-attachment-by-id repo 方法，download/inline 需自取 filename/content_type)。

读端点经 EmailRepository (Depends(get_repository)) 直查 SQLite；二进制端点**从盘流式**
返回 (open(path,'rb') + seek + chunk iterator，绝不把整文件读进内存)，无 JSON envelope
(StreamingResponse)。鉴权统一走 verify_cf_access 依赖。

安全 (REMOTE-ACCESS §9):
  - local_path **绝不**进 wire 响应 (gotcha #1)。AttachmentItem schema 已无此字段。
  - download/inline 在读盘前做 path-traversal 防护: local_path 经 pathlib resolve 后
    必须落在 AttachmentStore.base_dir (= 解析后的 data/attachments/) 子树内，否则 403。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_repository
from src.api.schemas import (
    AttachmentItem,
    AttachmentTextResponse,
    ThreadAttachmentItem,
)

if TYPE_CHECKING:
    from src.repository import (
        AttachmentRecord,
        EmailRepository,
        ThreadAttachmentRecord,
    )

router = APIRouter(prefix="/api/attachment", tags=["attachment"])

# 流式分块大小 (StreamingResponse iterator)。从盘按 _STREAM_CHUNK 字节增量读出并吐给
# 前端/浏览器，**绝不**把整文件 read_bytes 进内存 (C5: 大附件 OOM + 阻塞 event loop +
# 撞 pm2 --max-memory-restart 500M)。Range 请求只 seek 到目标区间再读这一段。
_STREAM_CHUNK = 64 * 1024

# 兜底 MIME — DB 里 content_type 可能为空 (旧数据 / 解析失败)。八位字节流是
# RFC 2046 对未知二进制的标准回退；浏览器据此走"下载"而非内联渲染。
_DEFAULT_MIME = "application/octet-stream"

# Range 头解析: 仅支持单 range 的 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`。
# 多 range (逗号分隔) 不支持 → 当作整文件返回 200 (合法降级，RFC 7233 §3.1 允许)。
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

# `/{attachment_id}/text` 同步抽取兜底的文件大小上限 (5 MB)。
# 生产事实 (task 0)：附件文本抽取【无自动 worker】—— commit_email_with_body 只把
# 非 inline 附件登记为 email_attachment_text.status='pending'，真正 pending→extracted
# 仅 CLI `mailagent attachment extract` 处理 (main.py 无 worker、new_watcher 无 hook；
# sync_store.py 里提到的 `_process_attachment_text_queue` 并不存在，是过时注释)。
# 故 pending 附件若不现场抽，text 端点永远拿不到文本。这里对 ≤5MB 的 pending 文件做
# 同步兜底抽取 (extract_text + commit_attachment_text)，>5MB 才回落 pending + hint —
# 上限防单请求在 event loop 外的线程池里跑太久 / 吃内存 (端点用 sync def 让 FastAPI
# 自动 offload 到 threadpool，抽取不阻塞主 event loop)。
_ATTACHMENT_TEXT_SYNC_MAX_BYTES = 5 * 1024 * 1024

# text 端点 status → 人类可执行 hint。**不回显 rec.error_message** —— 它可能含 host
# 路径 (CLI 写入的 "file missing: {abs_path}")，与本模块「绝不回显 local_path」安全
# 不变式冲突，故按 status 给通用 hint。
_ATTACHMENT_TEXT_HINTS = {
    "pending": (
        "附件文本尚未抽取（无自动抽取 worker，或文件过大 >5MB 无法现场抽取）；"
        "可运行 CLI `mailagent attachment extract --pending` 后重试"
    ),
    "failed": "附件文本抽取失败（可能是扫描版 / 加密 / 损坏的 PDF 等）",
    "unsupported": "该附件类型不支持文本抽取（支持 PDF / docx / pptx / xlsx / txt / md / csv）",
}


# ---------------------------------------------------------------------------
# 内部 helper —— 单行 attachment 元信息 + path-traversal 防护后读盘
# ---------------------------------------------------------------------------


class _AttachmentMeta:
    """download/inline 需要的最小元信息 (repo 无 by-id 单查 API，gotcha #2)。"""

    __slots__ = ("id", "internal_id", "filename", "content_type", "local_path", "size_bytes")

    def __init__(
        self,
        *,
        id: int,
        internal_id: int,
        filename: Optional[str],
        content_type: Optional[str],
        local_path: Optional[str],
        size_bytes: Optional[int],
    ) -> None:
        self.id = id
        self.internal_id = internal_id
        self.filename = filename
        self.content_type = content_type
        self.local_path = local_path
        self.size_bytes = size_bytes


def _fetch_attachment_meta(
    repo: "EmailRepository", attachment_id: int
) -> Optional[_AttachmentMeta]:
    """1-row SELECT 取 attachment 元信息 (id/filename/content_type/local_path/size)。

    repo 没暴露 get-attachment-by-id 单查 (gotcha #2)，这里复用 repo 自己的短命连接
    模式 (_connect → close) 做一次窄查询。返回 None 表示行不存在。
    """
    conn = repo._connect()
    try:
        row = conn.execute(
            """SELECT id, internal_id, filename, content_type, local_path, size_bytes
               FROM email_attachment WHERE id = ?""",
            (attachment_id,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return _AttachmentMeta(
        id=row["id"],
        internal_id=row["internal_id"],
        filename=row["filename"],
        content_type=row["content_type"],
        local_path=row["local_path"],
        size_bytes=row["size_bytes"],
    )


def _fetch_attachment_text_context(
    repo: "EmailRepository", attachment_id: int
) -> Optional[dict]:
    """text 端点用: attachment 行 JOIN 邮件归属 (subject / sender)。

    比 _fetch_attachment_meta 多取 email_metadata 的 subject / sender，让 /text
    响应能直接带上「这个附件来自哪封邮件」上下文。LEFT JOIN → 附件行即便 internal_id
    悬空 (理论上不该发生) 也能返回 (subject/sender 空串)，404 只留给「附件行本身不存在」。
    返回 dict (含 local_path/size_bytes 供同步抽取兜底用)；行不存在 → None。
    """
    conn = repo._connect()
    try:
        row = conn.execute(
            """SELECT a.id, a.internal_id, a.filename, a.content_type,
                      a.local_path, a.size_bytes,
                      COALESCE(m.subject, '') AS email_subject,
                      COALESCE(m.sender, '')  AS sender
                 FROM email_attachment a
                 LEFT JOIN email_metadata m ON m.internal_id = a.internal_id
                WHERE a.id = ?""",
            (attachment_id,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "id": row["id"],
        "internal_id": row["internal_id"],
        "filename": row["filename"],
        "content_type": row["content_type"],
        "local_path": row["local_path"],
        "size_bytes": row["size_bytes"],
        "email_subject": row["email_subject"],
        "sender": row["sender"],
    }


def _sync_extract_attachment_text(repo: "EmailRepository", ctx: dict):
    """pending 附件的同步抽取兜底 (task 0: 无自动 worker，见 _ATTACHMENT_TEXT_SYNC_MAX_BYTES)。

    文件存在且 ≤5MB → extract_text 现场抽 + commit_attachment_text 落库 (复用 CLI
    `attachment extract` 的 status 分派: extracted / unsupported / failed→退避重试)。
    无 local_path / 文件丢失 / 超 5MB → 返回 None (调用方回落 pending + hint，不落库)。
    path-traversal 越界 → APIError 403 (与 download/inline 同一安全不变式)。
    返回抽取后重读的 AttachmentTextRecord (或 None)。
    """
    local_path = ctx["local_path"]
    if not local_path:
        return None
    guarded = _resolve_guarded_path(repo, local_path)  # 越界 → 403
    try:
        size = guarded.stat().st_size
    except OSError:
        return None
    if size > _ATTACHMENT_TEXT_SYNC_MAX_BYTES:
        return None  # 太大, 不现场抽 (交给 CLI 离线批处理)

    from src.converter.attachment_text import extract_text

    att_id = ctx["id"]
    try:
        result = extract_text(
            guarded,
            content_type=ctx["content_type"],
            filename=ctx["filename"],
        )
    except Exception as e:  # noqa: BLE001 — extractor 任意异常都不该 500 端点
        repo.mark_attachment_text_failure(att_id, f"extractor exception: {e}")
        return repo.get_attachment_text(att_id)

    if result.status == "extracted":
        repo.commit_attachment_text(
            att_id,
            text=result.text,
            extractor=result.extractor,
            status="extracted",
            truncated=result.truncated,
        )
    elif result.status == "unsupported":
        repo.commit_attachment_text(
            att_id,
            text="",
            extractor=result.extractor,
            status="unsupported",
            error_message=result.error_message,
        )
    else:  # failed → 走退避重试队列 (与 CLI 一致)
        repo.mark_attachment_text_failure(
            att_id, result.error_message or "unknown extractor failure"
        )
    return repo.get_attachment_text(att_id)


def _resolve_guarded_path(repo: "EmailRepository", local_path: str) -> Path:
    """把 local_path 解析成绝对路径并强制 path-traversal 防护 (REMOTE-ACCESS §9)。

    AttachmentStore.read 对相对 local_path 以 base_dir.parent.parent (项目根) 反推；
    base_dir 本身已是 resolve 后的 data/attachments/。这里复刻同样的解析规则，再用
    Path.resolve() 拍平 `..` 后，断言结果落在 base_dir 子树内 — 否则 403。

    raise:
      APIError E_NOT_FOUND   — local_path 空 (调用方应已挡掉，双保险)。
      APIError E_AUTH_FAILED — 解析后逃出 data/attachments/ (http 403)。
    """
    store = repo.attachment_store
    base = store.base_dir.resolve()  # 解析后的 data/attachments/ 绝对路径

    p = Path(local_path)
    if not p.is_absolute():
        # 与 AttachmentStore.read 一致: 相对路径以 project_root (base_dir.parent.parent) 反推
        project_root = store.base_dir.parent.parent
        p = project_root / p
    resolved = p.resolve()

    # 防护: resolved 必须等于 base 或在其子树内。Path.is_relative_to 需 3.9+ (项目 ≥3.9)。
    if resolved != base and not resolved.is_relative_to(base):
        raise APIError(
            "E_AUTH_FAILED",
            "attachment path escapes the allowed storage root",
            hint="local_path 必须位于 data/attachments/ 子树内 (REMOTE-ACCESS §9)",
            http_status=403,
            source="sqlite",
        )
    return resolved


def _resolve_attachment_for_stream(
    repo: "EmailRepository", attachment_id: int
) -> tuple[_AttachmentMeta, Path, int]:
    """取元信息 → path 防护 → stat 取大小。供 download / inline 共用。

    **不读文件内容** (C5)：只解析 + 防护 + stat，让大附件走盘上 chunk 流式而非整块进内存。
    path-traversal 防护 (_resolve_guarded_path) 在 stat 之前执行，越界即 403、不碰盘。

    返回 (meta, guarded_path, size_bytes)；size 取自 stat().st_size，作为 Range/Content-Length
    的权威总长 (不再依赖 len(content))。

    raise APIError:
      E_NOT_FOUND   — 行不存在、local_path 空、或盘上文件已丢失。
      E_AUTH_FAILED — path-traversal 防护失败 (403，见 _resolve_guarded_path)。
    """
    meta = _fetch_attachment_meta(repo, attachment_id)
    if meta is None:
        raise APIError(
            "E_NOT_FOUND",
            f"attachment id={attachment_id} not found",
            hint="GET /api/attachment/list/{internal_id} 查可用 attachment id",
            source="sqlite",
        )
    if not meta.local_path:
        raise APIError(
            "E_NOT_FOUND",
            f"attachment id={attachment_id} has no stored file",
            hint="该附件无本地副本 (未落盘)；重跑 sync 拉回",
            source="sqlite",
        )

    guarded = _resolve_guarded_path(repo, meta.local_path)  # 防护 (可能 403)

    # 防护通过后 stat 一次拿大小 (不读内容)。stat 失败 (文件已丢) → 404，在 response
    # 开始前抛出 (流已开始就无法再改状态码)。
    try:
        size_bytes = guarded.stat().st_size
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise APIError(
            "E_NOT_FOUND",
            f"attachment file missing on disk for id={attachment_id}",
            hint="附件文件已被删除或路径错位；重跑 sync 拉回",
            source="sqlite",
        ) from exc
    return meta, guarded, size_bytes


def _iter_file_range(path: Path, start: int, length: int):
    """从盘按 _STREAM_CHUNK 流式读 [start, start+length) 这一段，绝不整块进内存 (C5)。

    open(path,'rb') → seek(start) → 循环读 chunk 直到吐满 length 字节。length<=0 立即收尾
    (空文件 / 空 range)。文件句柄用 with 确保关闭，即便消费方提前断开。
    """
    if length <= 0:
        return
    with open(path, "rb") as fh:
        if start:
            fh.seek(start)
        remaining = length
        while remaining > 0:
            chunk = fh.read(min(_STREAM_CHUNK, remaining))
            if not chunk:
                break  # 文件比 stat 时更短 (被截断)；按已读字节收尾
            remaining -= len(chunk)
            yield chunk


def _parse_range(range_header: str, total: int) -> Optional[tuple[int, int]]:
    """解析单 range 的 Range 头 → (start, end) 闭区间字节偏移；不可满足/不支持 → None。

    支持 `bytes=a-b` / `bytes=a-` / `bytes=-suffix`。返回 None 表示:
      - 语法不符 (含多 range 逗号) → 调用方退回整文件 200。
    超界 start (start >= total) 由调用方判成 416 (这里返回的是 (start,end)，
    调用方负责越界检测)。
    """
    m = _RANGE_RE.match(range_header.strip())
    if not m:
        return None
    start_s, end_s = m.group(1), m.group(2)
    if start_s == "" and end_s == "":
        return None
    if start_s == "":
        # 后缀 range: 最后 N 字节
        suffix = int(end_s)
        if suffix <= 0:
            return None
        start = max(0, total - suffix)
        end = total - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s != "" else total - 1
        end = min(end, total - 1)
    return (start, end)


def _content_disposition(filename: Optional[str], disposition: str) -> str:
    """构造 Content-Disposition 头值，文件名经 RFC 5987 编码避免非 ASCII / 注入。

    disposition = 'attachment' (下载) | 'inline' (内联图)。filename 为空时回退 'download'。
    既给 ASCII fallback (filename=...) 又给 UTF-8 (filename*=...)，覆盖老/新浏览器。
    """
    name = filename or "download"
    # ASCII fallback: 去掉引号 / 控制字符 / 路径分隔，避免头注入。
    ascii_name = re.sub(r'[\x00-\x1f\x7f"\\/]', "_", name.encode("ascii", "ignore").decode("ascii"))
    if not ascii_name:
        ascii_name = "download"
    from urllib.parse import quote

    utf8_name = quote(name, safe="")
    return f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{utf8_name}"


def _stream_response(
    meta: _AttachmentMeta,
    path: Path,
    total: int,
    *,
    disposition: str,
    range_header: Optional[str],
) -> StreamingResponse:
    """构造 StreamingResponse — 支持 Range (206 Partial Content) + 整文件 (200)。

    字节从盘 (path) 按 chunk 流式读出 (_iter_file_range)，绝不整块进内存。total 为 stat 大小。
    disposition='attachment' → 浏览器保存为文件 (download 端点)；
    disposition='inline'     → 浏览器内联渲染 (inline 端点，cid: 图)。
    """
    media_type = meta.content_type or _DEFAULT_MIME
    base_headers = {
        "Content-Disposition": _content_disposition(meta.filename, disposition),
        # 声明支持断点续传 (RFC 7233)；前端/浏览器据此发 Range。
        "Accept-Ranges": "bytes",
    }

    if range_header:
        rng = _parse_range(range_header, total)
        if rng is not None:
            start, end = rng
            if start >= total or start > end:
                # 不可满足的 range → 416 + Content-Range: bytes */total (RFC 7233 §4.4)。
                raise APIError(
                    "E_INVALID_ARG",
                    f"requested range not satisfiable (size={total})",
                    hint=f"Range start {start} 超出附件大小 {total}",
                    http_status=416,
                    source="sqlite",
                )
            length = end - start + 1
            headers = dict(base_headers)
            headers["Content-Range"] = f"bytes {start}-{end}/{total}"
            headers["Content-Length"] = str(length)
            return StreamingResponse(
                _iter_file_range(path, start, length),
                status_code=206,
                media_type=media_type,
                headers=headers,
            )
        # range 头语法不符 (含多 range) → 合法降级为整文件 200。

    headers = dict(base_headers)
    headers["Content-Length"] = str(total)
    return StreamingResponse(
        _iter_file_range(path, 0, total),
        status_code=200,
        media_type=media_type,
        headers=headers,
    )


# ---------------------------------------------------------------------------
# 端点
# ---------------------------------------------------------------------------


_ATTACHMENT_SEARCH_LIMIT_MAX = 50


def _count_attachment_fts_indexed(repo: "EmailRepository") -> int:
    """``SELECT count(*) FROM email_attachment_fts`` — AttachmentSearchResult.total_indexed 用。

    repo 无现成 helper（同 email.py ``_count_fts_indexed``）；用 repo._connect() 起短命连接。
    FTS5 表缺失 / 异常 → 0，不让搜索因 count 失败而 500。
    批次3 PR-E（D3）：口径**继续数老表** —— v39 ``email_attachment_fts_trigram`` 与老表由
    同源 trigger 维持同集合行数，改口径零收益、有测试波及。
    """
    import sqlite3

    conn = repo._connect()
    try:
        row = conn.execute("SELECT count(*) AS c FROM email_attachment_fts").fetchone()
        return int(row["c"]) if row else 0
    except sqlite3.Error:
        return 0
    finally:
        conn.close()


@router.get("/search", dependencies=[Depends(verify_cf_access)])
async def search_attachments(
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
    q: str = Query(..., description="自然语言关键词 或 FTS5 query 语法"),
    mailbox: Optional[str] = Query(None),
    since: Optional[str] = Query(None, description="YYYY-MM-DD"),
    until: Optional[str] = Query(None, description="YYYY-MM-DD"),
    limit: int = Query(20, ge=1, le=_ATTACHMENT_SEARCH_LIMIT_MAX),
    raw: bool = Query(False, description="true=直传 FTS5; false(默认)=smart（trigram 子串/文件名路由，flag off 回 CJK 改写）"),
):
    """FTS5 搜附件抽取文本（PDF/docx/pptx/xlsx）+ JOIN 邮件上下文（V2.1 3b-4）。

    镜像前端 chat 工具 ``email_search_attachments`` 的后端原语（handlers/attachment.ts
    searchAttachments → repo.search_attachment_texts）。data = AttachmentSearchResult
    （前端 types：{items, total_indexed, mode, has_more, transformed_query?}）。默认 smart
    （CJK-aware 改写，与前端 smartQueryTransform 同算法）；raw=true 走原 FTS5 syntax。FTS
    语法错误 → 空命中（repo 内部吞掉）。HttpChatPlatform.searchAttachments（3b-5）fetch
    本端点。

    搜索批次2 PR-B（D4）：``has_more`` 用 limit+1 探针在路由层判定——本端点自己按 probe 结果
    裁回 ``limit`` 并置 ``has_more``。本端点不跑 DSL 解析（无 parse_warnings 概念），故不新增该字段。

    搜索批次3 PR-E（D1 路由内化）：内核 ``search_attachment_texts`` 收**原始 q + raw 标志**，
    CJK 子串/文件名 trigram 路由与 smart 变换全在 repo 侧（不再由本端点 pre-transform）。本端点
    的 ``smart_query_transform`` 仅用于 ``transformed_query`` meta 的回报，**不喂给检索**。
    """

    # 路由内化: 传原始 q + raw 标志; 内核按 trigram_enabled 决定 trigram 路由 or smart 变换。
    probe = limit + 1
    hits = repo.search_attachment_texts(
        q,
        raw=raw,
        limit=probe,
        mailbox=mailbox,
        since_date=since,
        until_date=until,
    )
    has_more = len(hits) > limit
    if has_more:
        hits = hits[:limit]

    items = [
        {
            "attachment_id": h.attachment_id,
            "internal_id": h.internal_id,
            "filename": h.filename,
            "content_type": h.content_type,
            "email_subject": h.email_subject,
            "email_sender": h.email_sender,
            "email_date": h.email_date,
            "email_mailbox": h.email_mailbox,
            "snippet": h.snippet,
            "rank": h.rank,
            "notion_page_id": h.notion_page_id,
            "notion_url": h.notion_url,
        }
        for h in hits
    ]

    mode = "raw" if raw else "smart"
    total_indexed = _count_attachment_fts_indexed(repo)
    # has_more 恒发布尔（不作 additive-only 省略）——镜像主端点 email.py 的 has_more 语义
    # （:472/:479，恒发而 transformed_query/parse_warnings 才是条件发），让 gateway 工具的
    # 自我收敛投影可以无条件读取，不必先判字段是否存在。
    data: dict[str, Any] = {
        "items": items,
        "total_indexed": total_indexed,
        "mode": mode,
        "has_more": has_more,
    }
    # transformed_query 语义收窄（批次3 PR-E D1 修订）：仅当实际走了 unicode61 smart 变换路径
    # （raw=False 且 trigram 关）且变换结果 != q 时回报。trigram 开（生产默认）走 term 路由、
    # 无单一「变换串」→ 不发；v38 缺表 fallback 的罕见态也不发（router 用 repo.trigram_enabled
    # 复刻判定，不去嗅探缺表）。reporting-only —— 检索用的是原始 q（上面已直传）。
    transformed_query: Optional[str] = None
    if not raw and not repo.trigram_enabled:
        from src.repository.email_repository import smart_query_transform

        _rewritten = smart_query_transform(q)
        if _rewritten != q:
            transformed_query = _rewritten
    if transformed_query is not None:
        data["transformed_query"] = transformed_query

    meta_extra: dict[str, Any] = {
        "query": q,
        "mode": mode,
        "count": len(items),
        "limit": limit,
        "total_indexed": total_indexed,
        "has_more": has_more,
    }
    if transformed_query is not None:
        meta_extra["transformed_query"] = transformed_query

    return success_envelope(
        data, request=request, source="sqlite", meta_extra=meta_extra
    )


@router.get("/list/{internal_id}", dependencies=[Depends(verify_cf_access)])
async def attachment_list(
    internal_id: int,
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
):
    """GET /api/attachment/list/{internal_id} — 列出该邮件全部附件 (含 derived)。

    repo.get_attachments → AttachmentItem[] (DROP local_path / created_at，gotcha #1)。
    排序由 repo 保证: is_inline DESC, id ASC。返回前先校验 metadata 存在 (与 CLI
    attachment list 一致)，让 internal_id 笔误得到 404 而非空列表。
    meta: {count, internal_id}，对齐 CLI attachment list 的 meta_extra。
    """
    if repo.get_metadata(internal_id) is None:
        raise APIError(
            "E_NOT_FOUND",
            f"email internal_id={internal_id} not found",
            hint="GET /api/email/list 查可用 internal_id",
            source="sqlite",
        )

    records: list["AttachmentRecord"] = repo.get_attachments(internal_id)
    items = [
        AttachmentItem(
            id=r.id,
            internal_id=r.internal_id,
            filename=r.filename,
            size_bytes=r.size_bytes,
            content_type=r.content_type,
            is_inline=r.is_inline,
            content_id=r.content_id,
            sha256=r.sha256,
            derived_from=r.derived_from,
            derived_format=r.derived_format,
            notion_file_id=r.notion_file_id,
            notion_block_id=r.notion_block_id,
        ).model_dump(exclude_none=True)
        for r in records
    ]
    return success_envelope(
        items,
        request=request,
        source="sqlite",
        meta_extra={"count": len(items), "internal_id": internal_id},
    )


@router.get("/thread/{thread_id}", dependencies=[Depends(verify_cf_access)])
async def attachment_thread(
    thread_id: str,
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
):
    """GET /api/attachment/thread/{thread_id} — 线程内全部附件元数据（跨邮件聚合）。

    分层附件访问的「线程」层：给 chat agent 一次拿到整条线程里每封邮件的附件清单
    + 归属（来自哪封邮件的 sender / date / subject），不用逐封回查。data =
    {thread_id, items}；每 item 为 ThreadAttachmentItem（含 is_inline 供上层滤内联
    cid: 图；**不含** local_path / sha256 / notion_* / derived_*）。空 / 未知
    thread_id → items=[]（不 404，thread_id 非强主键）。排序 date_received ASC,
    attachment.id ASC 由 repo 保证。
    """
    records: list["ThreadAttachmentRecord"] = repo.get_attachments_by_thread(
        thread_id
    )
    items = [
        ThreadAttachmentItem(
            id=r.id,
            internal_id=r.internal_id,
            filename=r.filename,
            size_bytes=r.size_bytes,
            content_type=r.content_type,
            is_inline=r.is_inline,
            sender=r.sender,
            sender_name=r.sender_name,
            date_received=r.date_received,
            email_subject=r.email_subject,
        ).model_dump()
        for r in records
    ]
    return success_envelope(
        {"thread_id": thread_id, "items": items},
        request=request,
        source="sqlite",
        meta_extra={"count": len(items), "thread_id": thread_id},
    )


@router.get("/{att_id}/download", dependencies=[Depends(verify_cf_access)])
async def attachment_download(
    att_id: int,
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
):
    """GET /api/attachment/{att_id}/download — 流式下载 (Content-Disposition: attachment)。

    浏览器侧等价于 Electron 的 copy-to-Downloads (浏览器保存流式文件)。
    支持 Range → 206 Partial Content (断点续传)。path-traversal 防护见
    _resolve_guarded_path (越界 403)。404 当行不存在 / 无 local_path / 盘上文件丢失。
    """
    meta, path, total = _resolve_attachment_for_stream(repo, att_id)
    return _stream_response(
        meta,
        path,
        total,
        disposition="attachment",
        range_header=request.headers.get("range"),
    )


@router.get("/{att_id}/inline", dependencies=[Depends(verify_cf_access)])
async def attachment_inline(
    att_id: int,
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
):
    """GET /api/attachment/{att_id}/inline — 内联图 (cid:)，Content-Disposition: inline。

    供正文 iframe srcdoc 里 cid: 图片加载 (前端把 cid: 重写成该 URL)。与 download
    走同一字节管线 + 同一 path-traversal 防护，仅 Content-Disposition 改 inline 让浏览器
    内联渲染而非下载。Content-Type 取附件 mime (图片类) 让 <img> 正确解码。
    支持 Range → 206。
    """
    meta, path, total = _resolve_attachment_for_stream(repo, att_id)
    return _stream_response(
        meta,
        path,
        total,
        disposition="inline",
        range_header=request.headers.get("range"),
    )


# sync `def` (非 async): 同步兜底抽取 (pypdf / calamine 等) 是阻塞 CPU/IO；FastAPI 对
# sync 端点自动 offload 到 threadpool，抽取不阻塞主 event loop。
@router.get("/{attachment_id}/text", dependencies=[Depends(verify_cf_access)])
def attachment_text(
    attachment_id: int,
    request: Request,
    repo: "EmailRepository" = Depends(get_repository),
    max_chars: Optional[int] = Query(
        None,
        ge=1,
        description="截断文本上限字符数; 缺省=全文 (抽取层 256KB 上限内)",
    ),
):
    """GET /api/attachment/{attachment_id}/text — 按需读附件抽取文本。

    分层附件访问的「内容」层：agent 先看元数据 (list / thread)，需要正文时才拉这个。
    data = AttachmentTextResponse。status ∈ {extracted, pending, failed, unsupported}；
    非 extracted 时 text_content=null + hint 给可执行提示。max_chars 截断时 truncated=true
    (与抽取层 256KB 截断合并，任一为真即真)。**响应绝不含 local_path** (本模块安全不变式)。

    pending 同步兜底 (task 0)：附件抽取无自动 worker，commit 时只登记 pending。故 pending
    (或无 text 行) 且文件 ≤5MB 时现场 extract_text + 落库；>5MB / 无文件 → pending + hint。
    404 当 attachment id 不存在 (跟随 router error envelope)。
    """
    ctx = _fetch_attachment_text_context(repo, attachment_id)
    if ctx is None:
        raise APIError(
            "E_NOT_FOUND",
            f"attachment id={attachment_id} not found",
            hint="GET /api/attachment/list/{internal_id} 查可用 attachment id",
            source="sqlite",
        )

    rec = repo.get_attachment_text(attachment_id)
    # pending / 无行 → 同步抽取兜底 (无自动 worker，见 _sync_extract_attachment_text)。
    if rec is None or rec.status == "pending":
        rec = _sync_extract_attachment_text(repo, ctx) or rec

    status = rec.status if rec is not None else "pending"
    extractor = rec.extractor if rec is not None else None
    text_content: Optional[str] = None
    truncated = False
    hint: Optional[str] = None

    if status == "extracted" and rec is not None:
        text_content = rec.text_content
        truncated = rec.truncated
        if (
            max_chars is not None
            and text_content is not None
            and len(text_content) > max_chars
        ):
            text_content = text_content[:max_chars]
            truncated = True  # 与抽取层 256KB 截断合并 (任一为真即真)
    else:
        # pending / failed / unsupported → text=null + 通用 hint (不回显 error_message,
        # 它可能含 host 路径, 违反本模块安全不变式)。
        hint = _ATTACHMENT_TEXT_HINTS.get(status, _ATTACHMENT_TEXT_HINTS["pending"])

    data = AttachmentTextResponse(
        attachment_id=ctx["id"],
        internal_id=ctx["internal_id"],
        filename=ctx["filename"],
        status=status,
        text_content=text_content,
        truncated=truncated,
        extractor=extractor,
        email_subject=ctx["email_subject"],
        sender=ctx["sender"],
        hint=hint,
    ).model_dump()
    return success_envelope(
        data,
        request=request,
        source="sqlite",
        meta_extra={"attachment_id": ctx["id"], "status": status},
    )


# ============================================================
# POST /api/attachment/convert — 内存文档 → markdown（task 08-10 WP3）
# ============================================================
#
# 给 **chat 附件**用：用户往对话里拖一个 docx，模型此前只能看到文件名（chat 附件是
# renderer 内存里的 File 对象，非文本类型一律 content=null）。本端点把字节转成 markdown
# 填进那个 content，模型同一轮就能读到正文。
#
# 🔴 与本文件其余端点的根本区别：**这里的输入不是已入库的附件**，没有 attachment_id、
# 不碰 email_attachment / AttachmentStore、不查库。就是「一段字节进、一段 markdown 出」。
#
# 🔴 **本端点全程 in-memory，不写任何持久化位置**：走 anydoc 的 to_markdown_bytes（实测与
# 路径版产出逐字节相同），省掉一整类临时文件泄漏面。
#
# ⚠️ 2026-09-03（design §1.4，P2-L5）更正：这段此前写的「与 chat 附件『从未落盘』的现状语义
# 一致」**已经不成立**。chat 附件现在是发送即入库 —— renderer 在发消息的同一刻把**原字节**
# `POST /library/files` 写进资料库的 `chat-attachments/{YYYY-MM}/`（`source='chat'`）。
# 落盘的是那条路径，不是这里：本端点仍然只是「一段字节进、一段 markdown 出」，转换产物不落盘、
# 也不回写库行。两条路互不知道对方存在，改任一条都别顺手把另一条也改了。
# TS 侧同批改写的对应注释在 `frontend/src/shared/lib/chat-attachments.ts` 头部。
#
# 鉴权沿用本 router 的 verify_cf_access（桌面 = 主进程 webRequest 注入本地 token，
# 远程 web = CF Access cookie）。本端点是 Python serve-api 自己的路由，远程天然可达，
# **不需要**进 ai_gateway_proxy 的转发表——那张表是给活在 Node gateway 里的端点用的。

#: 解码后的字节上限。base64 传输会膨胀约 33%，故 wire 上大约 20 MiB。
#: 与 pack_fetch 的 20 MiB / vision_ocr 的 15 MB 同量级；chat 里拖的文档远小于此。
_CONVERT_MAX_BYTES = 15 * 1024 * 1024

#: 单个 chat 附件进 prompt 的字符上限。
#:
#: 🔴 **跨语言手抄常量**，TS 侧镜像 = `frontend/src/shared/lib/chat-attachments.ts` 的
#: `ATTACHMENT_MAX_CONTENT_CHARS`。两侧都要截：服务端截防止把一份 300 页文档整个吐回
#: renderer，客户端截是入 prompt 前的最后一道。值不一致会让 `truncated` 标记说谎
#: （服务端说没截、客户端又截了一刀，模型不知道自己看的是片段）。
#: 一致性闸：`tests/config/test_chat_attachment_chars_parity.py`。
#:
#: 20000 而非沿用旧的 5000：5000 是为「粘贴一段日志/代码」定的，一份 docx 转成 markdown
#: 后通常几千到几万字符，5000 会把正文腰斩。20000 × ~0.25 token/char ≈ 5k token/份，
#: 多文件仍受 buildAttachmentBlock 的总量护栏约束。
CHAT_ATTACHMENT_MAX_CHARS = 20000


@router.post("/convert", dependencies=[Depends(verify_cf_access)])
async def convert_attachment(request: Request, body: Optional[dict[str, Any]] = None):
    """内存文档字节 → GFM markdown。flag 关 / 不支持 / 失败 → 404 或 status!='converted'。

    请求体（base64 JSON，沿用 P9 plugin import 的既有约定，不引入 multipart 依赖）::

        {"filename": "report.docx", "contentBase64": "..."}

    响应 data::

        {"status": "converted"|"unsupported", "markdown": str|null,
         "truncated": bool, "extractor": "anydoc"|null, "filename": str}

    转换失败**不是错误**（返回 200 + status='unsupported'）—— 调用方据此回落到
    metadata-only，用户的消息照常发得出去。真正的 4xx 只留给参数问题与超限。
    """
    import base64
    import binascii

    from src.converter import anydoc_extract

    # flag off ⇒ 端点不存在。renderer 侧据此静默回落，不给用户看半截功能。
    if not anydoc_extract.anydoc_enabled():
        raise APIError(
            "E_NOT_FOUND", "document conversion is disabled",
            http_status=404, source="sqlite",
        )

    raw = body or {}
    filename = raw.get("filename")
    content_b64 = raw.get("contentBase64")
    if not isinstance(filename, str) or not filename.strip():
        raise APIError("E_INVALID_ARG", "filename is required", http_status=400, source="sqlite")
    if not isinstance(content_b64, str) or not content_b64:
        raise APIError(
            "E_INVALID_ARG", "contentBase64 is required", http_status=400, source="sqlite",
        )

    # 先按 base64 长度估算解码后大小，超限直接拒 —— 不要先解码再判断（那正好把
    # 「防 OOM」的护栏放在会 OOM 的操作之后）。base64 每 4 字符 → 3 字节。
    if (len(content_b64) // 4) * 3 > _CONVERT_MAX_BYTES:
        raise APIError(
            "E_TOO_LARGE",
            f"file exceeds {_CONVERT_MAX_BYTES // (1024 * 1024)} MiB conversion limit",
            http_status=413, source="sqlite",
        )
    try:
        data_bytes = base64.b64decode(content_b64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise APIError(
            "E_INVALID_ARG", "contentBase64 is invalid", http_status=400, source="sqlite",
        ) from exc
    if len(data_bytes) > _CONVERT_MAX_BYTES:
        raise APIError(
            "E_TOO_LARGE",
            f"file exceeds {_CONVERT_MAX_BYTES // (1024 * 1024)} MiB conversion limit",
            http_status=413, source="sqlite",
        )

    ext = Path(filename).suffix.lower()
    # lane 判定复用提取链同一套（含 flag + LANES），于是 chat 与邮件附件的可转换集合
    # 天然一致 —— 不会出现「邮件里读得出、聊天里读不出」这种最难解释的分裂。
    if not anydoc_extract.lane_active(ext):
        return success_envelope(
            {
                "status": "unsupported", "markdown": None, "truncated": False,
                "extractor": None, "filename": filename,
            },
            request=request, source="sqlite",
        )

    markdown = anydoc_extract.convert_bytes(
        data_bytes, anydoc_extract.format_for_extension(ext),
    )
    if markdown is None:
        return success_envelope(
            {
                "status": "unsupported", "markdown": None, "truncated": False,
                "extractor": None, "filename": filename,
            },
            request=request, source="sqlite",
        )

    truncated = False
    if len(markdown) > CHAT_ATTACHMENT_MAX_CHARS:
        markdown = markdown[:CHAT_ATTACHMENT_MAX_CHARS]
        truncated = True
    return success_envelope(
        {
            "status": "converted", "markdown": markdown, "truncated": truncated,
            "extractor": anydoc_extract.ANYDOC_EXTRACTOR, "filename": filename,
        },
        request=request, source="sqlite",
    )

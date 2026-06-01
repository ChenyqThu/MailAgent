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
from typing import TYPE_CHECKING, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from src.api.app import APIError, success_envelope
from src.api.auth import verify_cf_access
from src.api.deps import get_repository
from src.api.schemas import AttachmentItem

if TYPE_CHECKING:
    from src.repository import AttachmentRecord, EmailRepository

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

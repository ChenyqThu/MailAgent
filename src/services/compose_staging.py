"""compose 附件暂存 (staging) — D1 两段式上传的服务器侧暂存区。

契约 (task 07-04-send-attachments-richtext prd D1):
    上传: PUT /api/email/compose-attachment (raw bytes) → 本模块 ``stage_attachment``
    暂存: ``{staging_root}/{stage_id}/{sanitized_filename}``, stage_id = uuid4 hex
    引用: compose/send 请求体 ``attachments: [{"stage_id": ...}]`` →
          ``MailWriteService._resolve_attachment_refs`` 经 ``read_staged`` 取 bytes
    清理: send 成功后 ``discard_staged`` (消费即删); 未消费的 (草稿/放弃) 由
          ``sweep_stale`` 机会式 TTL 回收 (上传时顺带扫, 免 serve-api 启动钩子)。

🔴 staging root 锚定 ``sync_store_db_path`` 同级 (= data/), 与 ``data/attachments/``
(已收邮件 SSoT, internal_id 目录空间) **严格隔离** — 绝不写进 AttachmentStore base_dir。
"""

from __future__ import annotations

import mimetypes
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Optional

from loguru import logger

if TYPE_CHECKING:
    from src.config import Config

_STAGING_DIRNAME = "compose_staging"

# 未消费暂存的保留时长 (draft 保存 / 用户放弃 compose 都会留下孤儿目录)。
STAGING_TTL_SECONDS = 24 * 3600

# stage_id 只接受本模块生成的 uuid4().hex 形态 — 32 位小写 hex。
# 严格 fullmatch = stage_id 维度的路径穿越防御 (拒 '../x' / 绝对路径 / 空串)。
_STAGE_ID_RE = re.compile(r"[0-9a-f]{32}")


def staging_root(cfg: "Config") -> Path:
    """暂存根目录: sync_store.db 同级的 compose_staging/ (打包态跟随 DATA_ROOT)。"""
    return Path(cfg.sync_store_db_path).parent / _STAGING_DIRNAME


def guess_mime(filename: str) -> str:
    """按扩展名猜 MIME, 兜底 application/octet-stream (仅标准库, 不引依赖)。"""
    mime, _ = mimetypes.guess_type(filename)
    return mime or "application/octet-stream"


def stage_attachment(cfg: "Config", filename: str, content: bytes) -> dict:
    """写入一个暂存附件, 返回响应 dict ``{stage_id, filename, size, mime}``。

    filename 经 ``AttachmentStore.sanitize_filename`` basename 化 (路径分隔符 →
    下划线, 控制字符剔除, '..' 归一) — 与 SSoT 附件同一套 sanitize 规则。
    大小 cap 由调用方 (serve-api 端点) 先行校验, 本函数不重复。
    """
    from src.repository.attachment_store import AttachmentStore

    safe = AttachmentStore.sanitize_filename(filename)
    stage_id = uuid.uuid4().hex
    target_dir = staging_root(cfg) / stage_id
    target_dir.mkdir(parents=True, exist_ok=True)
    (target_dir / safe).write_bytes(content)
    return {
        "stage_id": stage_id,
        "filename": safe,
        "size": len(content),
        "mime": guess_mime(safe),
    }


def read_staged(cfg: "Config", stage_id: str) -> Optional[tuple[str, bytes, str]]:
    """按 stage_id 读暂存附件 → ``(filename, bytes, mime)``; 不存在/非法 → None。"""
    if not _STAGE_ID_RE.fullmatch(stage_id or ""):
        return None
    target_dir = staging_root(cfg) / stage_id
    if not target_dir.is_dir():
        return None
    files = sorted(p for p in target_dir.iterdir() if p.is_file())
    if not files:
        return None
    p = files[0]
    try:
        return p.name, p.read_bytes(), guess_mime(p.name)
    except OSError as e:
        logger.warning(f"[compose-staging] read {stage_id} failed: {e}")
        return None


def discard_staged(cfg: "Config", stage_id: str) -> None:
    """删除一个暂存目录 (send 成功后消费清理)。best-effort, 失败仅 warning。"""
    if not _STAGE_ID_RE.fullmatch(stage_id or ""):
        return
    target_dir = staging_root(cfg) / stage_id
    if target_dir.is_dir():
        try:
            shutil.rmtree(target_dir)
        except OSError as e:
            logger.warning(f"[compose-staging] discard {stage_id} failed: {e}")


def sweep_stale(cfg: "Config", ttl_seconds: int = STAGING_TTL_SECONDS) -> int:
    """清掉超 TTL 的暂存目录 (上传时机会式调用)。返回清理个数, 失败仅 warning。"""
    root = staging_root(cfg)
    if not root.is_dir():
        return 0
    cutoff = time.time() - ttl_seconds
    removed = 0
    for child in root.iterdir():
        if not child.is_dir() or not _STAGE_ID_RE.fullmatch(child.name):
            continue
        try:
            if child.stat().st_mtime < cutoff:
                shutil.rmtree(child)
                removed += 1
        except OSError as e:
            logger.warning(f"[compose-staging] sweep {child.name} failed: {e}")
    if removed:
        logger.info(f"[compose-staging] swept {removed} stale staging dir(s)")
    return removed

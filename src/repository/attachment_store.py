"""AttachmentStore - 附件本地文件系统封装（v4 架构）.

约定:
    base_dir / {internal_id} / {sanitized_filename}

base_dir 默认 data/attachments/，与 sync_store.db 同目录便于统一备份。
internal_id 是 v3 主键，稳定不变。
"""

from __future__ import annotations

import hashlib
import re
import shutil
from pathlib import Path
from typing import Optional

from loguru import logger


# 文件名 sanitize 规则：
# - 替换 macOS / Linux 都不允许的字符
# - 截断到 200 字符避免 ext4 / APFS 的 255-byte 上限
# - 空文件名 → "unnamed"
_UNSAFE_FILENAME_RE = re.compile(r'[\x00-\x1f\x7f<>:"/\\|?*]')
_FILENAME_MAX_LEN = 200


class AttachmentStore:
    """附件本地文件系统封装。

    职责:
        - 路径生成 + 文件名 sanitize
        - 内容落盘 / 读取
        - 整个 internal_id 目录的清理

    不做:
        - 不查 SQLite（那是 EmailRepository 的事）
        - 不上传 Notion
    """

    def __init__(self, base_dir: str | Path = "data/attachments"):
        self.base_dir = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    # ---------- 路径相关 ----------

    def dir_for(self, internal_id: int) -> Path:
        """该邮件的附件目录（不创建）。"""
        return self.base_dir / str(internal_id)

    def relative_path(self, internal_id: int, filename: str) -> str:
        """相对于项目根的路径，用于写入 email_attachment.local_path。

        例: 'data/attachments/41457/report.pdf'
        """
        safe = self.sanitize_filename(filename)
        return str(self.base_dir / str(internal_id) / safe)

    @staticmethod
    def sanitize_filename(name: str) -> str:
        """去除控制字符 + 文件系统保留字符；截断到 200 字符。

        '../etc/passwd' → '__etc_passwd'（路径分隔符变下划线）
        空 / 全空格 → 'unnamed'
        """
        if not name or not name.strip():
            return "unnamed"
        cleaned = _UNSAFE_FILENAME_RE.sub("_", name.strip())
        # 防 '.' / '..' 等 directory traversal
        if cleaned in (".", ".."):
            return "unnamed"
        if len(cleaned) > _FILENAME_MAX_LEN:
            stem = Path(cleaned).stem[: _FILENAME_MAX_LEN - 16]
            ext = Path(cleaned).suffix[:16]
            cleaned = f"{stem}{ext}"
        return cleaned

    # ---------- 读写 ----------

    def save(
        self,
        internal_id: int,
        filename: str,
        content: bytes,
        *,
        dedup_within_email: bool = True,
    ) -> tuple[Path, str]:
        """保存附件到本地。返回 (绝对路径, 实际使用的 filename)。

        Args:
            internal_id: 邮件 internal_id
            filename: 原始文件名（会经 sanitize）
            content: 附件二进制
            dedup_within_email: 同邮件目录内同名冲突时是否加 _1 _2 后缀（默认开）

        Returns:
            (target_path, used_filename) - 用 used_filename 写 email_attachment 行
        """
        target_dir = self.dir_for(internal_id)
        target_dir.mkdir(parents=True, exist_ok=True)

        safe = self.sanitize_filename(filename)
        target = target_dir / safe

        if dedup_within_email and target.exists():
            stem, suffix = target.stem, target.suffix
            counter = 1
            while target.exists():
                target = target_dir / f"{stem}_{counter}{suffix}"
                counter += 1
            safe = target.name

        target.write_bytes(content)
        return target, safe

    def read(self, local_path: str | Path) -> bytes:
        """按 local_path 读盘。local_path 可以是相对/绝对。"""
        p = Path(local_path)
        if not p.is_absolute():
            # 假设 local_path 相对项目根（与 email_attachment.local_path 一致）
            p = Path.cwd() / p
        return p.read_bytes()

    def exists(self, local_path: str | Path) -> bool:
        p = Path(local_path)
        if not p.is_absolute():
            p = Path.cwd() / p
        return p.exists()

    def delete_email_dir(self, internal_id: int) -> None:
        """删除该 internal_id 的整个附件目录。供 EmailRepository.delete_email_full 调用。"""
        target = self.dir_for(internal_id)
        if target.exists():
            try:
                shutil.rmtree(target)
            except OSError as e:
                logger.warning(f"Failed to delete attachment dir {target}: {e}")

    @staticmethod
    def sha256(content: bytes) -> str:
        return hashlib.sha256(content).hexdigest()

    # ---------- orphan 清理（独立 CLI 调用） ----------

    def find_orphan_dirs(self, known_internal_ids: set[int]) -> list[Path]:
        """扫 base_dir 找不在 known set 里的子目录（孤儿）。返回路径列表，调用者决定删不删。"""
        if not self.base_dir.exists():
            return []
        orphans = []
        for child in self.base_dir.iterdir():
            if not child.is_dir():
                continue
            try:
                int_id = int(child.name)
            except ValueError:
                continue
            if int_id not in known_internal_ids:
                orphans.append(child)
        return orphans

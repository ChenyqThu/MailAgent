"""资料库领域服务 —— **唯一写面**（design §1.3 / §3 / §4 / §5.1 写侧强制 / §8.2）。

文件系统是正文 SSoT；``library.db`` 是元数据投影 + id 分配器（``id ↔ rel_path`` 一旦分配永不重算，
文件消失标 ``missing`` 不删行）。不做 watcher：打开文件夹按目录 mtime 增量对账、打开文件按 stat +
必要时重算 hash、发现外部改动补记 ``changed_by='external'``；设置页「重扫」全量对账。

并发写靠 ``expected_hash`` CAS：不符 → ``E_VERSION_CONFLICT``（响应体带当前 hash 与 content）；
``expected_hash=None`` 是新建语义，已存在也是冲突；hash 相同 = no-op 不记历史；rollback = 拿快照做一次
普通写（走同一道校验）。每次写记一条 ``library_history`` 全快照 + ``change_note``（只对文本类；二进制只进
索引不进历史），按 ``HISTORY_MAX_PER_FILE`` / ``HISTORY_MAX_TOTAL_BYTES`` 裁剪。

写侧强制在**服务端**（不是前端）：投影区拒写；``mode='ro'`` 挂载根拒写；custom agent 只能写
``agent-docs/`` + ``rw`` 挂载根；主 agent 另可写 ``my-docs/``；agent 写面限扩展名白名单与 1 MB。

``.trash``：软删 = 把文件搬到 ``.trash/{file_id}/{filename}``，行的 ``parent_path`` **保留原文件夹**
（restore 的目标就从它来，零新增列），``rel_path`` 指向 ``.trash`` 内的实际位置；30 天 sweep 抄
``compose_staging.sweep_stale``；单文件 ``purge`` 立即真删文件 + 删行（F11）。挂载区的删除走系统废纸篓
（Electron ``shell.trashItem``），本服务对挂载区文件拒 ``trash``。
"""

from __future__ import annotations

import hashlib
import os
import shutil
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from loguru import logger

from src.library import paths as P
from src.library.constants import (
    AGENT_DOCS_SLUG,
    FOLDER_PAGE_SIZE,
    MOUNT_MAX_FILES,
    MOUNT_MODES,
    PROJECTION_SLUG,
    READ_TOOL_MAX_BYTES,
    TEXT_WRITE_MAX_BYTES,
    TOP_LEVEL_SLUGS,
    TRASH_SLUG,
    TRASH_TTL_DAYS,
    UPLOAD_MAX_BYTES,
    WRITE_EXT_ALLOWLIST,
)
from src.library.db import LibraryDb
from src.library.extract import ensure_text, initial_text_status, kind_for_filename
from src.library.paths import MountRoot, PathError, ResolvedPath
from src.library.repository import FOLDER_SORTS, LibraryRepository, SearchResult
from src.services.compose_staging import guess_mime


class LibraryError(RuntimeError):
    """领域错误 → router 映射成 APIError；``data`` 只有 409 CAS 冲突用（当前 hash + content）。"""

    def __init__(self, code: str, message: str, *, hint: Optional[str] = None, data: Optional[dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint
        self.data = data


@dataclass(frozen=True)
class Actor:
    """调用方身份。``kind``：``user``（UI）/ ``main_agent`` / ``custom_agent``（带 ``agent_id``）。"""

    kind: str = "user"
    agent_id: Optional[str] = None
    session_id: Optional[int] = None
    message_id: Optional[int] = None

    @property
    def is_agent(self) -> bool:
        return self.kind != "user"

    @property
    def changed_by(self) -> str:
        if self.kind == "user":
            return "user"
        return self.agent_id or self.kind


USER = Actor()

#: 库根下能放文件的顶层目录（= 内置 slug 去掉投影根与废纸篓；派生，不手抄）。
ROOT_WRITABLE_TOP = tuple(s for s in TOP_LEVEL_SLUGS if s not in (PROJECTION_SLUG, TRASH_SLUG))
#: 有正文语义的 kind：进历史、走 CAS、``GET /file/{id}`` 直接带 content。
TEXT_KINDS = frozenset({"markdown", "html", "text"})
#: 搜索时顺带抽取的 pending 上限（P1 没有后台队列）。
EXTRACT_ON_SEARCH_CAP = 25
#: 扫描时跳过的目录（挂载根还跳过全部 ``.`` 开头目录）。
SCAN_SKIP_DIRS = frozenset({".git", "node_modules"})
#: 树遍历的目录数上限（防把整个 ~ 挂进来时一次 walk 卡死）。
TREE_MAX_DIRS = 5000
#: 可挂载性判据用到的保留目录。
_MOUNT_REJECT_HOME_SUBDIRS = ("Library",)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


#: 系统 mime.types 不认 markdown（Python 3.11 的 mimetypes 表里没有 .md），补上；其余交给 guess_mime。
_MIME_OVERRIDES = {".md": "text/markdown", ".markdown": "text/markdown"}


def _mime(filename: str) -> str:
    return _MIME_OVERRIDES.get(Path(filename).suffix.lower()) or guess_mime(filename)


def _cap_text(text: str, max_bytes: int) -> tuple[str, bool]:
    """按 utf-8 字节上限截断（gateway 读工具下推的天花板 ``max_bytes``），不切坏多字节字符。"""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text, False
    return encoded[:max_bytes].decode("utf-8", errors="ignore"), True


def _text_hint(status: str, error: Optional[str] = None) -> Optional[str]:
    """非 extracted 态给读工具 / 预览面的一句原因（extracted 恒 None）。"""
    if status == "extracted":
        return None
    if status == "pending":
        return "text extraction is pending for this file"
    if status == "unsupported":
        return "this file kind has no extractable text"
    return f"text extraction failed: {error}" if error else "text extraction failed for this file"


def _nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value)


class LibraryService:
    def __init__(self, db_path: str, library_root: str, sync_store_db_path: Optional[str] = None) -> None:
        self.db = LibraryDb(db_path)
        self.repo = LibraryRepository(self.db, sync_store_db_path)
        os.makedirs(library_root, exist_ok=True)
        self.root_path = os.path.realpath(library_root)
        for slug in ROOT_WRITABLE_TOP + (TRASH_SLUG,):
            os.makedirs(os.path.join(self.root_path, slug), exist_ok=True)
        self.root = MountRoot(id=0, label="", abs_path=self.root_path, mode="rw")

    # ── 挂载根 ────────────────────────────────────────────────────────────────

    @staticmethod
    def _mount_from_row(row: dict[str, Any]) -> MountRoot:
        return MountRoot(id=int(row["id"]), label=str(row["label"]), abs_path=str(row["abs_path"]), mode=str(row["mode"]))

    def _mount_row_ok(self, conn, row: Optional[dict[str, Any]], ref: str) -> MountRoot:
        if row is None or row["status"] == "unmounted":
            raise LibraryError("E_NOT_FOUND", f"mount {ref} not found")
        if not os.path.isdir(row["abs_path"]):
            if row["status"] != "unavailable":
                self.repo.update_mount(conn, int(row["id"]), status="unavailable")
            raise LibraryError("E_INVALID_STATE", f"mount {ref} is unavailable", hint="外置卷拔了 / 目录被移走；树里灰显，行不删")
        if row["status"] == "unavailable":
            self.repo.update_mount(conn, int(row["id"]), status="ok")
        return self._mount_from_row(row)

    def _mount_by_id(self, conn, mount_id: int) -> MountRoot:
        if int(mount_id) == 0:
            return self.root
        return self._mount_row_ok(conn, self.repo.get_mount(conn, int(mount_id)), str(mount_id))

    def _resolve_virtual(self, conn, path: str, *, for_write: bool = False) -> ResolvedPath:
        try:
            label, rel = P.split_virtual(path)
            if label is None:
                return P.resolve(self.root, rel, for_write=for_write)
            mount = self._mount_row_ok(conn, self.repo.get_mount_by_label(conn, label), f"@{label}")
            return P.resolve(mount, rel, for_write=for_write)
        except PathError as exc:
            raise LibraryError(exc.code, exc.message, hint=exc.hint) from exc

    def _resolve_row(self, conn, row: dict[str, Any]) -> ResolvedPath:
        mount = self._mount_by_id(conn, int(row["mount_id"]))
        try:
            return P.resolve(mount, str(row["rel_path"]))
        except PathError as exc:
            raise LibraryError(exc.code, exc.message, hint=exc.hint) from exc

    def _mount_dict(self, conn, row: dict[str, Any]) -> dict[str, Any]:
        """设置页形状：``library_mount`` 列 + ``file_count``（唯一会露出 abs_path 的响应，design §8.2）。"""
        return {**row, "file_count": self.repo.count_files(conn, int(row["id"]))}

    def mounts(self, *, include_unmounted: bool = False) -> list[dict[str, Any]]:
        conn = self.db.connect()
        try:
            return [self._mount_dict(conn, r) for r in self.repo.list_mounts(conn, include_unmounted=include_unmounted)]
        finally:
            conn.close()

    def add_mount(self, abs_path: str, *, label: Optional[str] = None, mode: str = "rw") -> dict[str, Any]:
        if mode not in MOUNT_MODES:
            raise LibraryError("E_INVALID_ARG", f"invalid mode: {mode}")
        real = os.path.realpath(os.path.expanduser(str(abs_path)))
        if not os.path.isdir(real):
            raise LibraryError("E_INVALID_ARG", "mount path is not a directory")
        home = os.path.realpath(os.path.expanduser("~"))
        rejected = {"/", home, self.root_path, os.path.dirname(self.root_path)}
        rejected.update(os.path.join(home, d) for d in _MOUNT_REJECT_HOME_SUBDIRS)
        if real in rejected:
            raise LibraryError("E_INVALID_ARG", "this directory cannot be mounted", hint="拒挂 / 、~ 本身、~/Library、DATA_ROOT")
        label = _nfc(label or os.path.basename(real)).strip()
        if not label or "/" in label or label.startswith("@"):
            raise LibraryError("E_INVALID_ARG", "invalid mount label")
        file_count = self._count_files_on_disk(real)
        if file_count > MOUNT_MAX_FILES:
            raise LibraryError(
                "E_INVALID_ARG",
                f"directory has {file_count} files (limit {MOUNT_MAX_FILES})",
                hint="选一个更小的文件夹",
            )
        with self.db.transaction() as conn:
            for other in self.repo.list_mounts(conn):
                op = str(other["abs_path"])
                if real == op or real.startswith(op + os.sep) or op.startswith(real + os.sep):
                    raise LibraryError("E_INVALID_STATE", f"overlaps mount @{other['label']}")
            existing = self.repo.get_mount_by_path(conn, real)
            if existing is not None:  # unmounted 行重新挂同一路径：复用行（文件 id 因此不变）
                if self.repo.get_mount_by_label(conn, label) not in (None, existing):
                    raise LibraryError("E_INVALID_STATE", f"label @{label} already in use")
                self.repo.update_mount(conn, int(existing["id"]), label=label, mode=mode, status="ok")
                mount_id = int(existing["id"])
            else:
                if self.repo.get_mount_by_label(conn, label) is not None:
                    raise LibraryError("E_INVALID_STATE", f"label @{label} already in use")
                mount_id = self.repo.insert_mount(conn, label=label, abs_path=real, mode=mode, added_at=time.time())
            mount = self._mount_from_row(self.repo.get_mount(conn, mount_id))
            self._rescan_mount(conn, mount)
            return self._mount_dict(conn, self.repo.get_mount(conn, mount_id))

    def remove_mount(self, mount_id: int) -> dict[str, Any]:
        """卸载：挂载行标 ``unmounted``、其下文件行标 ``missing``、清文本 / FTS；不删行、不动磁盘。"""
        with self.db.transaction() as conn:
            row = self.repo.get_mount(conn, int(mount_id))
            if row is None or row["status"] == "unmounted":
                raise LibraryError("E_NOT_FOUND", f"mount {mount_id} not found")
            now = time.time()
            for f in self.repo.list_mount_rows(conn, int(mount_id)):
                self.repo.delete_text(conn, int(f["id"]))
                self.repo.update_file(conn, int(f["id"]), status="missing", text_status=None, updated_at=now)
            self.repo.update_mount(conn, int(mount_id), status="unmounted")
            return self._mount_dict(conn, self.repo.get_mount(conn, int(mount_id)))

    def patch_mount(self, mount_id: int, *, label: Optional[str] = None, mode: Optional[str] = None) -> dict[str, Any]:
        with self.db.transaction() as conn:
            row = self.repo.get_mount(conn, int(mount_id))
            if row is None or row["status"] == "unmounted":
                raise LibraryError("E_NOT_FOUND", f"mount {mount_id} not found")
            fields: dict[str, Any] = {}
            if label is not None:
                label = _nfc(label).strip()
                if not label or "/" in label or label.startswith("@"):
                    raise LibraryError("E_INVALID_ARG", "invalid mount label")
                other = self.repo.get_mount_by_label(conn, label)
                if other is not None and int(other["id"]) != int(mount_id):
                    raise LibraryError("E_INVALID_STATE", f"label @{label} already in use")
                fields["label"] = label
            if mode is not None:
                if mode not in MOUNT_MODES:
                    raise LibraryError("E_INVALID_ARG", f"invalid mode: {mode}")
                fields["mode"] = mode
            self.repo.update_mount(conn, int(mount_id), **fields)
            return self._mount_dict(conn, self.repo.get_mount(conn, int(mount_id)))

    # ── 读面 ──────────────────────────────────────────────────────────────────

    def tree(self) -> dict[str, Any]:
        """扁平文件夹节点 ``{path, parent_path, name, mount_id, file_count}``（层级由前端按 parent_path 还原）
        + 挂载根摘要（**不带** abs_path）。内置五根恒发；投影月份挂在 ``mail-attachments`` 下。"""
        conn = self.db.connect()
        try:
            counts = self.repo.folder_counts(conn)
            folders: list[dict[str, Any]] = []
            months = self._projection_months_safe()
            folders.append({
                "path": PROJECTION_SLUG, "parent_path": "", "name": PROJECTION_SLUG, "mount_id": 0,
                "file_count": sum(m["count"] for m in months),
            })
            for m in months:
                folders.append({
                    "path": f"{PROJECTION_SLUG}/{m['month']}", "parent_path": PROJECTION_SLUG, "name": m["month"],
                    "mount_id": 0, "file_count": m["count"],
                })
            budget = [TREE_MAX_DIRS]
            for slug in ROOT_WRITABLE_TOP:
                folders.append({"path": slug, "parent_path": "", "name": slug, "mount_id": 0, "file_count": counts.get((0, slug), 0)})
                self._collect_dirs(self.root, slug, folders, counts, budget)
            _, trash_count = self.repo.list_trash(conn, offset=0, limit=1)
            folders.append({"path": TRASH_SLUG, "parent_path": "", "name": TRASH_SLUG, "mount_id": 0, "file_count": trash_count})
            mounts: list[dict[str, Any]] = []
            for row in self.repo.list_mounts(conn):
                mount = self._mount_from_row(row)
                available = os.path.isdir(mount.abs_path)
                status = "ok" if available else "unavailable"
                if status != row["status"]:
                    self.repo.update_mount(conn, mount.id, status=status)
                    conn.commit()
                mounts.append({
                    "id": mount.id, "label": mount.label, "path": f"@{mount.label}", "mode": mount.mode,
                    "status": status, "file_count": self.repo.count_files(conn, mount.id),
                })
                if available:
                    self._collect_dirs(mount, "", folders, counts, budget)
            return {"folders": folders, "mounts": mounts, "file_count": self.repo.count_files(conn)}
        finally:
            conn.close()

    def _projection_months_safe(self) -> list[dict[str, Any]]:
        if not self.repo.sync_store_db_path or not os.path.exists(self.repo.sync_store_db_path):
            return []
        try:
            return self.repo.projection_months()
        except Exception as exc:  # noqa: BLE001 — 投影只读，坏了不该拖垮整棵树
            logger.warning(f"[library] projection months failed: {exc}")
            return []

    def _subdirs(self, mount: MountRoot, rel: str) -> list[tuple[str, str]]:
        """磁盘上的直属子目录 ``(name, child_rel)``（不含文件、不跟 symlink）。挂载根跳过 ``.`` 开头与
        SCAN_SKIP_DIRS；库根只跳顶层的 ``.trash``。"""
        base = os.path.join(mount.abs_path, *rel.split("/")) if rel else mount.abs_path
        out: list[tuple[str, str]] = []
        try:
            entries = sorted(os.scandir(base), key=lambda e: e.name.casefold())
        except OSError:
            return out
        for entry in entries:
            if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                continue
            name = _nfc(entry.name)
            if name in SCAN_SKIP_DIRS or (mount.is_external and name.startswith(".")):
                continue
            if not mount.is_external and not rel and name == TRASH_SLUG:
                continue
            out.append((name, f"{rel}/{name}" if rel else name))
        return out

    def _collect_dirs(self, mount: MountRoot, rel: str, out: list[dict[str, Any]], counts: dict[tuple[int, str], int], budget: list[int]) -> None:
        for name, child_rel in self._subdirs(mount, rel):
            if budget[0] <= 0:
                return
            budget[0] -= 1
            out.append({
                "path": P.join_virtual(mount, child_rel), "parent_path": P.join_virtual(mount, rel), "name": name,
                "mount_id": mount.id, "file_count": counts.get((mount.id, child_rel), 0),
            })
            self._collect_dirs(mount, child_rel, out, counts, budget)

    def folder(
        self,
        path: str,
        *,
        offset: int = 0,
        limit: int = FOLDER_PAGE_SIZE,
        q: Optional[str] = None,
        sort: str = "name",
        direction: str = "asc",
    ) -> dict[str, Any]:
        limit = max(1, min(int(limit), FOLDER_PAGE_SIZE))
        offset = max(0, int(offset))
        if sort not in FOLDER_SORTS or direction not in ("asc", "desc"):
            raise LibraryError("E_INVALID_ARG", f"invalid sort/dir: {sort}/{direction}", hint=f"sort ∈ {', '.join(FOLDER_SORTS)}；dir ∈ asc, desc")
        try:
            label, rel = P.split_virtual(path)
        except PathError as exc:
            raise LibraryError(exc.code, exc.message, hint=exc.hint) from exc
        if label is None:
            top = rel.split("/")[0] if rel else ""
            if top == PROJECTION_SLUG:
                return self._projection_folder(rel, offset=offset, limit=limit, q=q)
            if top == TRASH_SLUG:
                return self._trash_folder(offset=offset, limit=limit)
            if not rel:
                conn = self.db.connect()
                try:
                    counts = self.repo.folder_counts(conn)
                    _, trash_count = self.repo.list_trash(conn, offset=0, limit=1)
                finally:
                    conn.close()
                projection_count = sum(m["count"] for m in self._projection_months_safe())
                top = []
                for slug in TOP_LEVEL_SLUGS:
                    if slug == PROJECTION_SLUG:
                        n = projection_count
                    elif slug == TRASH_SLUG:
                        n = trash_count
                    else:
                        n = counts.get((0, slug), 0)
                    top.append({"name": slug, "path": slug, "file_count": n})
                return {"path": "", "mount_id": 0, "files": [], "folders": top, "total": 0, "offset": 0, "limit": limit, "has_more": False}
            if top not in ROOT_WRITABLE_TOP:
                raise LibraryError("E_NOT_FOUND", f"unknown top-level folder: {top}")
        with self.db.transaction() as conn:
            resolved = self._resolve_virtual(conn, path)
            if not os.path.isdir(resolved.abs_path):
                raise LibraryError("E_NOT_FOUND", f"folder not found: {path}")
            self._reconcile_folder(conn, resolved)
            rows, total = self.repo.list_folder(
                conn, resolved.mount.id, resolved.rel_path, offset=offset, limit=limit, q=q, sort=sort, direction=direction,
            )
            counts = self.repo.folder_counts(conn)
            folders = [
                {"name": n, "path": P.join_virtual(resolved.mount, r), "file_count": counts.get((resolved.mount.id, r), 0)}
                for n, r in self._subdirs(resolved.mount, resolved.rel_path)
            ]
            return {
                "path": resolved.virtual_path,
                "mount_id": resolved.mount.id,
                "files": [self._file_dict(r, resolved.mount) for r in rows],
                "folders": folders,
                "total": total,
                "offset": offset,
                "limit": limit,
                "has_more": offset + len(rows) < total,
            }

    def _projection_folder(self, rel: str, *, offset: int, limit: int, q: Optional[str]) -> dict[str, Any]:
        parts = rel.split("/")
        if len(parts) == 1:
            months = self._projection_months_safe()
            return {
                "path": PROJECTION_SLUG, "is_projection": True, "files": [],
                "folders": [{"name": m["month"], "path": f"{PROJECTION_SLUG}/{m['month']}", "count": m["count"]} for m in months],
                "total": 0, "offset": offset, "limit": limit, "has_more": False,
            }
        if len(parts) != 2:
            raise LibraryError("E_NOT_FOUND", f"unknown projection folder: {rel}")
        month = parts[1]
        if not self.repo.sync_store_db_path:
            raise LibraryError("E_NOT_FOUND", "projection unavailable")
        items, total = self.repo.projection_files(month, q=q, offset=offset, limit=limit)
        files = [self._projection_item(it) for it in items]
        return {
            "path": f"{PROJECTION_SLUG}/{month}", "is_projection": True, "files": files, "folders": [],
            "total": total, "offset": offset, "limit": limit, "has_more": offset + len(files) < total,
        }

    @staticmethod
    def _projection_item(it: dict[str, Any]) -> dict[str, Any]:
        """投影行 → 与 ``_file_dict`` 同形的行对象（``id`` 为 null，多 ``attachment_id`` 与来源列）。"""
        name = str(it["filename"])
        month = str(it["month"])
        return {
            "id": None,
            "attachment_id": int(it["attachment_id"]),
            "internal_id": it["internal_id"],
            "mount_id": 0,
            "path": f"{PROJECTION_SLUG}/{month}/{name}",
            "rel_path": None,
            "parent_path": f"{PROJECTION_SLUG}/{month}",
            "filename": name,
            "kind": kind_for_filename(name),
            "mime": it.get("content_type") or _mime(name),
            "size_bytes": it.get("size_bytes"),
            "mtime": None,
            "date_received": it.get("date_received"),
            "content_hash": None,
            "source": "mail",
            "source_ref": str(it["attachment_id"]),
            "created_by": None,
            "status": "present" if it.get("has_file") else "missing",
            "text_status": it.get("text_status"),
            "created_at": it.get("created_at"),
            "updated_at": it.get("created_at"),
            "subject": it.get("subject"),
            "sender": it.get("sender"),
            "sender_name": it.get("sender_name"),
            # 列表「来源」列 = 邮件主题 + 发件人（F4：过滤框也按这两项匹配）
            "source_label": " · ".join(
                part for part in (it.get("subject") or "", it.get("sender_name") or it.get("sender") or "") if part
            ),
            "is_projection": True,
        }

    def _require_projection(self, attachment_id: int) -> dict[str, Any]:
        if not self.repo.sync_store_db_path or not os.path.exists(self.repo.sync_store_db_path):
            raise LibraryError("E_NOT_FOUND", "projection unavailable")
        row = self.repo.projection_attachment(int(attachment_id))
        if row is None:
            raise LibraryError("E_NOT_FOUND", f"attachment {attachment_id} is not in the projection", hint="内嵌图与不存在的附件都不是投影行")
        return row

    def projection_file(self, attachment_id: int) -> dict[str, Any]:
        """``GET /library/attachment/{id}``：与 ``file()`` 同形的行对象（正文由调用方按守卫路径补）。"""
        item = self._projection_item(self._require_projection(attachment_id))
        item["content"] = None
        item["truncated"] = False
        return item

    def projection_text(self, attachment_id: int, *, max_bytes: Optional[int] = None) -> dict[str, Any]:
        """``GET /library/attachment/{id}/text``：直接读 ``email_attachment_text`` 已抽好的文本，不重抽、不写 ``library_text``。"""
        row = self._require_projection(attachment_id)
        status = row.get("text_status")
        markdown = row.get("text_content") if status == "extracted" else None
        truncated = bool(row.get("text_truncated"))
        if markdown is not None and max_bytes is not None:
            markdown, cut = _cap_text(markdown, max_bytes)
            truncated = truncated or cut
        return {
            "file_id": None,
            "attachment_id": int(attachment_id),
            "text_status": status or "pending",
            "markdown": markdown,
            "extractor": row.get("extractor") if markdown is not None else None,
            "truncated": truncated,
            "source_hash": None,
            "content_hash": None,
            "stale": False,
            "hint": _text_hint(status or "pending", row.get("error_message")),
        }

    def _trash_folder(self, *, offset: int, limit: int) -> dict[str, Any]:
        conn = self.db.connect()
        try:
            rows, total = self.repo.list_trash(conn, offset=offset, limit=limit)
            return {
                "path": TRASH_SLUG, "files": [self._file_dict(r, self.root) for r in rows], "folders": [],
                "total": total, "offset": offset, "limit": limit, "has_more": offset + len(rows) < total,
            }
        finally:
            conn.close()

    def file(self, file_id: int, *, max_bytes: Optional[int] = None) -> dict[str, Any]:
        """元数据 + 文本类正文 + ``content_hash``；打开即对账。

        ``content`` 只给文本类且文件 ≤ READ_TOOL_MAX_BYTES；``max_bytes``（gateway 读工具下推的天花板）
        再往下截，截了 ``truncated: true``。
        """
        with self.db.transaction() as conn:
            row = self._require_file(conn, file_id)
            row = self._reconcile_file(conn, row)
            out = self._file_dict(row, self._mount_by_id_lenient(conn, int(row["mount_id"])))
            out["content"] = None
            out["truncated"] = False
            if row["status"] == "present" and row["kind"] in TEXT_KINDS and int(row["size_bytes"] or 0) <= READ_TOOL_MAX_BYTES:
                text = self._read_bytes(self._resolve_row(conn, row)).decode("utf-8", errors="replace")
                if max_bytes is not None:
                    text, out["truncated"] = _cap_text(text, max_bytes)
                out["content"] = text
            return out

    def stream_target(self, file_id: int) -> tuple[str, str, str, int]:
        """inline 端点用：``(abs_path, filename, mime, size)``。绝对路径只在进程内流转，不上 wire。"""
        with self.db.transaction() as conn:
            row = self._require_file(conn, file_id)
            row = self._reconcile_file(conn, row)
            if row["status"] != "present":
                raise LibraryError("E_NOT_FOUND", f"file {file_id} is {row['status']}")
            resolved = self._resolve_row(conn, row)
            return resolved.abs_path, str(row["filename"]), _mime(str(row["filename"])), int(row["size_bytes"] or 0)

    def files(self, file_ids: list[int]) -> list[dict[str, Any]]:
        conn = self.db.connect()
        try:
            rows = self.repo.get_files(conn, file_ids)
            return [self._file_dict(r, self._mount_by_id_lenient(conn, int(r["mount_id"]))) for r in rows]
        finally:
            conn.close()

    def _mount_by_id_lenient(self, conn, mount_id: int) -> MountRoot:
        if mount_id == 0:
            return self.root
        row = self.repo.get_mount(conn, mount_id)
        return self._mount_from_row(row) if row else MountRoot(id=mount_id, label=str(mount_id), abs_path="", mode="ro")

    def file_text(self, file_id: int, *, max_bytes: Optional[int] = None) -> dict[str, Any]:
        """解析版（``library_text``）；pending → 就地抽取。返回体是解析视图与 agent 读面的同一来源。"""
        with self.db.transaction() as conn:
            row = self._require_file(conn, file_id)
            row = self._reconcile_file(conn, row)
            if row["status"] != "present":
                raise LibraryError("E_NOT_FOUND", f"file {file_id} is {row['status']}")
            resolved = self._resolve_row(conn, row)
            text = ensure_text(self.repo, conn, row, resolved.abs_path)
            row = self.repo.get_file(conn, int(file_id)) or row
            status = row["text_status"] or "pending"
            markdown = text["text_content"] if text else None
            truncated = bool(text["truncated"]) if text else False
            if markdown is not None and max_bytes is not None:
                markdown, cut = _cap_text(markdown, max_bytes)
                truncated = truncated or cut
            return {
                "file_id": int(file_id),
                "text_status": status,
                "markdown": markdown,
                "extractor": text["extractor"] if text else None,
                "truncated": truncated,
                "source_hash": text["source_hash"] if text else None,
                "content_hash": row["content_hash"],
                "stale": bool(text) and text["source_hash"] != row["content_hash"],
                "hint": _text_hint(status) if text is None else None,
            }

    def search(self, query: str, *, limit: int = 20) -> dict[str, Any]:
        limit = max(1, min(int(limit), 100))
        with self.db.transaction() as conn:
            for row in self.repo.list_pending_extraction(conn, limit=EXTRACT_ON_SEARCH_CAP):
                try:
                    resolved = self._resolve_row(conn, row)
                except LibraryError:
                    continue
                row = self._reconcile_file(conn, row)
                if row["status"] == "present":
                    ensure_text(self.repo, conn, row, resolved.abs_path)
            result: SearchResult = self.repo.search(conn, query, limit=limit)
            hits = []
            for h in result.hits:
                mount = self._mount_by_id_lenient(conn, int(h["mount_id"]))
                d = self._file_dict(h, mount)
                d.update({"snippet": h["snippet"], "rank": h["rank"], "match": h["match"]})
                hits.append(d)
            return {"query": query, "mode": result.mode, "hits": hits, "warnings": result.warnings}

    def history(self, file_id: int) -> list[dict[str, Any]]:
        conn = self.db.connect()
        try:
            self._require_file(conn, file_id)
            return self.repo.list_history(conn, int(file_id))
        finally:
            conn.close()

    # ── 写面 ──────────────────────────────────────────────────────────────────

    def _assert_writable(self, mount: MountRoot, rel_path: str, actor: Actor, *, check_ext: bool = True) -> None:
        top = rel_path.split("/")[0] if rel_path else ""
        if not mount.is_external:
            if top == PROJECTION_SLUG:
                raise LibraryError("E_AUTH_FAILED", "mail-attachments projection is read-only", hint="用「另存到资料库」复制一份")
            if top == TRASH_SLUG:
                raise LibraryError("E_AUTH_FAILED", ".trash is managed by the service")
            if top not in ROOT_WRITABLE_TOP:
                raise LibraryError("E_INVALID_ARG", f"unknown top-level folder: {top!r}", hint=f"可写顶层：{', '.join(ROOT_WRITABLE_TOP)}")
            if actor.kind == "custom_agent" and top != AGENT_DOCS_SLUG:
                raise LibraryError("E_AUTH_FAILED", f"custom agents may only write under {AGENT_DOCS_SLUG}/")
            if actor.kind == "main_agent" and top not in (AGENT_DOCS_SLUG, "my-docs"):
                raise LibraryError("E_AUTH_FAILED", f"main agent may only write under {AGENT_DOCS_SLUG}/ or my-docs/")
        elif mount.mode != "rw":
            raise LibraryError("E_AUTH_FAILED", f"mount @{mount.label} is read-only")
        if actor.is_agent and check_ext:
            ext = Path(rel_path).suffix.lower()
            if ext not in WRITE_EXT_ALLOWLIST:
                raise LibraryError("E_AUTH_FAILED", f"agents may only write {', '.join(WRITE_EXT_ALLOWLIST)} files")

    @staticmethod
    def _check_size(nbytes: int, actor: Actor) -> None:
        cap = TEXT_WRITE_MAX_BYTES if actor.is_agent else UPLOAD_MAX_BYTES
        if nbytes > cap:
            raise LibraryError("E_INVALID_ARG", f"content too large ({nbytes} > {cap} bytes)")

    def create_file(
        self,
        path: str,
        content: bytes,
        *,
        actor: Actor = USER,
        source: str = "user",
        source_ref: Optional[str] = None,
        change_note: Optional[str] = None,
    ) -> dict[str, Any]:
        """新建（``expected_hash=None`` 语义）：路径已存在 → 409 ``E_VERSION_CONFLICT``。"""
        self._check_size(len(content), actor)
        with self.db.transaction() as conn:
            resolved = self._resolve_virtual(conn, path, for_write=True)
            if not resolved.filename:
                raise LibraryError("E_INVALID_ARG", "path must name a file")
            self._assert_writable(resolved.mount, resolved.rel_path, actor)
            existing = self.repo.get_file_by_key(conn, resolved.mount.id, resolved.rel_key)
            if (existing is not None and existing["status"] != "missing") or os.path.lexists(resolved.abs_path):
                raise LibraryError("E_VERSION_CONFLICT", f"already exists: {resolved.virtual_path}", hint="覆写请带 expected_hash")
            self._write_bytes(resolved, content, "create_new")
            file_id = self._register(conn, resolved, existing, content=content, source=source, source_ref=source_ref, created_by=actor.changed_by)
            row = self.repo.get_file(conn, file_id)
            if row["kind"] in TEXT_KINDS:
                self._record_history(conn, row, old_hash=None, content=content, actor=actor, change_note=change_note)
            return self._file_dict(row, resolved.mount)

    def write_file(
        self,
        file_id: int,
        content: str,
        *,
        expected_hash: Optional[str],
        actor: Actor = USER,
        change_note: Optional[str] = None,
    ) -> dict[str, Any]:
        """整体覆写，``expected_hash`` CAS。相同 hash = no-op（不记历史）。"""
        data = content.encode("utf-8")
        self._check_size(len(data), actor)
        with self.db.transaction() as conn:
            row = self._require_file(conn, file_id)
            if row["status"] != "present":
                raise LibraryError("E_INVALID_STATE", f"file {file_id} is {row['status']}")
            if row["kind"] not in TEXT_KINDS:
                raise LibraryError("E_INVALID_ARG", "only text files can be written through the editor")
            resolved = self._resolve_row(conn, row)
            self._assert_writable(resolved.mount, resolved.rel_path, actor)
            row = self._reconcile_file(conn, row)
            current_hash = row["content_hash"]
            if expected_hash is None or expected_hash != current_hash:
                current_text = self._read_bytes(resolved).decode("utf-8", errors="replace")
                raise LibraryError(
                    "E_VERSION_CONFLICT",
                    "file changed since it was read" if expected_hash else "file already exists",
                    hint="按返回的 content_hash / content 合并后重试一次",
                    data={"content_hash": current_hash, "content": current_text},
                )
            new_hash = _sha256(data)
            if new_hash == current_hash:
                return self._file_dict(row, resolved.mount)
            self._write_bytes(resolved, data, "overwrite")
            self._after_write(conn, row, data, new_hash)
            self._record_history(conn, row, old_hash=current_hash, content=data, actor=actor, change_note=change_note)
            return self._file_dict(self.repo.get_file(conn, int(file_id)), resolved.mount)

    def append_file(self, file_id: int, content: str, *, actor: Actor = USER, change_note: Optional[str] = None) -> dict[str, Any]:
        """只追加（加性，冲突面为零）；历史快照仍是追加后的全文。"""
        data = content.encode("utf-8")
        with self.db.transaction() as conn:
            row = self._require_file(conn, file_id)
            if row["status"] != "present":
                raise LibraryError("E_INVALID_STATE", f"file {file_id} is {row['status']}")
            if row["kind"] not in TEXT_KINDS:
                raise LibraryError("E_INVALID_ARG", "only text files can be appended")
            resolved = self._resolve_row(conn, row)
            self._assert_writable(resolved.mount, resolved.rel_path, actor)
            row = self._reconcile_file(conn, row)
            self._check_size(len(data) + int(row["size_bytes"] or 0), actor)
            old_hash = row["content_hash"]
            self._write_bytes(resolved, data, "append")
            full = self._read_bytes(resolved)
            new_hash = _sha256(full)
            self._after_write(conn, row, full, new_hash)
            self._record_history(conn, row, old_hash=old_hash, content=full, actor=actor, change_note=change_note)
            return self._file_dict(self.repo.get_file(conn, int(file_id)), resolved.mount)

    def move_file(self, file_id: int, target_path: str, *, actor: Actor = USER) -> dict[str, Any]:
        """``target_path`` = 新的完整虚拟路径；指向已有目录时保留文件名移进去。目标被占 → 409。"""
        with self.db.transaction() as conn:
            row = self._require_file(conn, file_id)
            if row["status"] != "present":
                raise LibraryError("E_INVALID_STATE", f"file {file_id} is {row['status']}")
            src = self._resolve_row(conn, row)
            self._assert_writable(src.mount, src.rel_path, actor, check_ext=False)
            probe = self._resolve_virtual(conn, target_path)
            if os.path.isdir(probe.abs_path):
                target_path = P.join_virtual(probe.mount, f"{probe.rel_path}/{row['filename']}" if probe.rel_path else str(row["filename"]))
            dst = self._resolve_virtual(conn, target_path, for_write=True)
            if not dst.filename:
                raise LibraryError("E_INVALID_ARG", "target must name a file")
            self._assert_writable(dst.mount, dst.rel_path, actor)
            if dst.mount.id == src.mount.id and dst.rel_key == src.rel_key and dst.rel_path == src.rel_path:
                return self._file_dict(row, src.mount)
            occupied = self.repo.get_file_by_key(conn, dst.mount.id, dst.rel_key)
            same_row = occupied is not None and int(occupied["id"]) == int(file_id)
            if (occupied is not None and not same_row and occupied["status"] != "missing") or (
                os.path.lexists(dst.abs_path) and not (same_row and os.path.samefile(src.abs_path, dst.abs_path))
            ):
                raise LibraryError("E_INVALID_STATE", f"target already exists: {dst.virtual_path}")
            if occupied is not None and not same_row:  # missing 行占着 key：让位（其 id 已悬空于磁盘）
                self.repo.delete_file(conn, int(occupied["id"]))
            os.makedirs(os.path.dirname(dst.abs_path), exist_ok=True)
            shutil.move(src.abs_path, dst.abs_path)
            self.repo.update_file(
                conn, int(file_id), mount_id=dst.mount.id, rel_path=dst.rel_path, rel_key=dst.rel_key,
                parent_path=dst.parent_path, filename=dst.filename, updated_at=time.time(),
            )
            return self._file_dict(self.repo.get_file(conn, int(file_id)), dst.mount)

    def trash_file(self, file_id: int, *, actor: Actor = USER) -> dict[str, Any]:
        """软删：搬到 ``.trash/{id}/{filename}``；``parent_path`` 保留原文件夹供 restore。挂载区拒（走系统废纸篓）。"""
        with self.db.transaction() as conn:
            row = self._require_file(conn, file_id)
            if row["status"] == "trashed":
                return self._file_dict(row, self.root)
            src = self._resolve_row(conn, row)
            if src.mount.is_external:
                raise LibraryError("E_AUTH_FAILED", "mounted folders use the system trash", hint="挂载区删除 = shell.trashItem，不进库内 .trash")
            self._assert_writable(src.mount, src.rel_path, actor, check_ext=False)
            trash_rel = f"{TRASH_SLUG}/{int(file_id)}/{row['filename']}"
            dst_abs = os.path.join(self.root_path, TRASH_SLUG, str(int(file_id)), str(row["filename"]))
            if row["status"] == "present" and os.path.lexists(src.abs_path):
                os.makedirs(os.path.dirname(dst_abs), exist_ok=True)
                shutil.move(src.abs_path, dst_abs)
            self.repo.update_file(
                conn, int(file_id), rel_path=trash_rel, rel_key=P.rel_key_of(trash_rel), status="trashed", updated_at=time.time(),
            )
            out = self._file_dict(self.repo.get_file(conn, int(file_id)), self.root)
        self.sweep_trash()
        return out

    def restore_file(self, file_id: int) -> dict[str, Any]:
        with self.db.transaction() as conn:
            row = self._require_file(conn, file_id)
            if row["status"] != "trashed":
                raise LibraryError("E_INVALID_STATE", f"file {file_id} is not in trash")
            original = f"{row['parent_path']}/{row['filename']}" if row["parent_path"] else str(row["filename"])
            dst = self._resolve_virtual(conn, original, for_write=True)
            occupied = self.repo.get_file_by_key(conn, 0, dst.rel_key)
            if (occupied is not None and occupied["status"] != "missing") or os.path.lexists(dst.abs_path):
                raise LibraryError("E_INVALID_STATE", f"original path is occupied: {original}", hint="先把占位的文件移走")
            if occupied is not None:
                self.repo.delete_file(conn, int(occupied["id"]))
            src_abs = os.path.join(self.root_path, *str(row["rel_path"]).split("/"))
            status = "present"
            if os.path.lexists(src_abs):
                os.makedirs(os.path.dirname(dst.abs_path), exist_ok=True)
                shutil.move(src_abs, dst.abs_path)
                shutil.rmtree(os.path.dirname(src_abs), ignore_errors=True)
            else:
                status = "missing"
            self.repo.update_file(
                conn, int(file_id), rel_path=dst.rel_path, rel_key=dst.rel_key, status=status, updated_at=time.time(),
            )
            return self._file_dict(self.repo.get_file(conn, int(file_id)), self.root)

    def purge_file(self, file_id: int) -> dict[str, Any]:
        """立即永久删除（F11）：只对 ``trashed`` 行；真删文件 + 删行（历史 / 文本 / FTS 一并清）。"""
        with self.db.transaction() as conn:
            row = self._require_file(conn, file_id)
            if row["status"] != "trashed":
                raise LibraryError("E_INVALID_STATE", "only trashed files can be purged", hint="先删除进废纸篓")
            shutil.rmtree(os.path.join(self.root_path, TRASH_SLUG, str(int(file_id))), ignore_errors=True)
            self.repo.delete_file(conn, int(file_id))
            return {"id": int(file_id), "purged": True}

    def sweep_trash(self, ttl_seconds: int = TRASH_TTL_DAYS * 86400) -> int:
        """清掉超 TTL 的 ``.trash/{id}/``（抄 compose_staging.sweep_stale）；行随目录一起删。"""
        root = Path(self.root_path) / TRASH_SLUG
        if not root.is_dir():
            return 0
        cutoff = time.time() - ttl_seconds
        removed = 0
        with self.db.transaction() as conn:
            for child in root.iterdir():
                if not child.is_dir() or not child.name.isdigit():
                    continue
                try:
                    if child.stat().st_mtime < cutoff:
                        shutil.rmtree(child)
                        row = self.repo.get_file(conn, int(child.name))
                        if row is not None and row["status"] == "trashed":
                            self.repo.delete_file(conn, int(child.name))
                        removed += 1
                except OSError as exc:
                    logger.warning(f"[library] sweep {child.name} failed: {exc}")
        if removed:
            logger.info(f"[library] swept {removed} expired trash entr(y/ies)")
        return removed

    def rollback(self, file_id: int, history_id: int, *, actor: Actor = USER) -> dict[str, Any]:
        """拿快照做一次普通写（同一道 CAS / 写侧强制 / 历史）。"""
        conn = self.db.connect()
        try:
            hist = self.repo.get_history(conn, int(history_id))
            row = self._require_file(conn, file_id)
            row = self._reconcile_file(conn, row)
            conn.commit()
        finally:
            conn.close()
        if hist is None or int(hist["file_id"]) != int(file_id):
            raise LibraryError("E_NOT_FOUND", f"history {history_id} not found for file {file_id}")
        return self.write_file(
            file_id, str(hist["content_snapshot"]), expected_hash=row["content_hash"], actor=actor,
            change_note=f"rollback to #{int(history_id)}",
        )

    def keep_attachment(
        self,
        target_folder: str,
        *,
        filename: str,
        src_path: str,
        attachment_id: int,
        text: Optional[dict[str, Any]] = None,
        actor: Actor = USER,
    ) -> dict[str, Any]:
        """「另存到资料库」：真复制 + 连已抽好的附件文本一起复制进 ``library_text``（投影零成本，不重抽）。

        ``src_path`` 由调用方经 ``attachment.py::_resolve_guarded_path`` 钉在附件存储根内后传入。
        ``text`` = ``{text_content, extractor, truncated}``（``email_attachment_text`` 的 extracted 行）或 None。
        """
        with self.db.transaction() as conn:
            folder = self._resolve_virtual(conn, target_folder)
            self._assert_writable(folder.mount, folder.rel_path, actor, check_ext=False)
            if not os.path.isdir(folder.abs_path):
                raise LibraryError("E_NOT_FOUND", f"folder not found: {target_folder}")
            base = folder.rel_path
            resolved = self._resolve_virtual(conn, P.join_virtual(folder.mount, f"{base}/{filename}" if base else filename), for_write=True)
            stem, suffix = os.path.splitext(resolved.filename)
            counter = 1
            while True:  # 同名冲突加 _1 _2 后缀（与 AttachmentStore.save 的 dedup 同款）
                occupied = self.repo.get_file_by_key(conn, resolved.mount.id, resolved.rel_key)
                if not os.path.lexists(resolved.abs_path) and (occupied is None or occupied["status"] == "missing"):
                    break
                alt = f"{stem}_{counter}{suffix}"
                resolved = self._resolve_virtual(conn, P.join_virtual(folder.mount, f"{base}/{alt}" if base else alt), for_write=True)
                counter += 1
            try:
                size = os.stat(src_path).st_size
            except OSError as exc:
                raise LibraryError("E_NOT_FOUND", "attachment file missing on disk") from exc
            if size > UPLOAD_MAX_BYTES:
                raise LibraryError("E_INVALID_ARG", f"attachment too large ({size} > {UPLOAD_MAX_BYTES} bytes)")
            os.makedirs(os.path.dirname(resolved.abs_path), exist_ok=True)
            shutil.copyfile(src_path, resolved.abs_path)
            content = self._read_bytes(resolved)
            existing = self.repo.get_file_by_key(conn, resolved.mount.id, resolved.rel_key)
            file_id = self._register(
                conn, resolved, existing, content=content, source="mail", source_ref=str(int(attachment_id)), created_by=actor.changed_by,
            )
            if text and text.get("text_content"):
                self.repo.upsert_text(
                    conn, file_id, filename=resolved.filename, text=str(text["text_content"]),
                    extractor=str(text.get("extractor") or "attachment"), source_hash=_sha256(content),
                    truncated=bool(text.get("truncated")),
                )
                self.repo.update_file(conn, file_id, text_status="extracted", updated_at=time.time())
            return self._file_dict(self.repo.get_file(conn, file_id), resolved.mount)

    def rescan(self, mount_id: Optional[int] = None) -> dict[str, Any]:
        """全量对账（设置页按钮）：磁盘 → 行（新增 / missing / 外部改动）。

        返回 ``{scanned, added, updated, missing, elapsed_ms}``：``updated`` = size / mtime 变了而补记的行
        （含 external 历史）；顺带 sweep 的过期废纸篓条目只进日志。
        """
        started = time.monotonic()
        stats = {"scanned": 0, "added": 0, "updated": 0, "missing": 0}
        with self.db.transaction() as conn:
            mounts: list[MountRoot] = []
            if mount_id is None or int(mount_id) == 0:
                mounts.append(self.root)
            for row in self.repo.list_mounts(conn):
                if mount_id is not None and int(mount_id) != int(row["id"]):
                    continue
                if os.path.isdir(row["abs_path"]):
                    mounts.append(self._mount_from_row(row))
                    if row["status"] != "ok":
                        self.repo.update_mount(conn, int(row["id"]), status="ok")
                elif row["status"] == "ok":
                    self.repo.update_mount(conn, int(row["id"]), status="unavailable")
            for mount in mounts:
                for k, v in self._rescan_mount(conn, mount).items():
                    stats[k] += v
        self.sweep_trash()
        stats["elapsed_ms"] = int((time.monotonic() - started) * 1000)
        return stats

    # ── 对账内核 ──────────────────────────────────────────────────────────────

    def _rescan_mount(self, conn, mount: MountRoot) -> dict[str, int]:
        stats = {"scanned": 0, "added": 0, "updated": 0, "missing": 0}
        seen: set[str] = set()
        for parent_rel in self._walk_dirs(mount):
            try:
                resolved = P.resolve(mount, parent_rel)
            except PathError:
                continue
            s = self._reconcile_folder(conn, resolved, force=True, seen=seen)
            for k in stats:
                stats[k] += s[k]
        now = time.time()
        for row in self.repo.list_mount_rows(conn, mount.id):
            if row["rel_key"] not in seen and row["status"] == "present":
                self.repo.update_file(conn, int(row["id"]), status="missing", updated_at=now)
                stats["missing"] += 1
        return stats

    def _walk_dirs(self, mount: MountRoot) -> list[str]:
        """磁盘目录清单（含根 ``''``，库根除外 —— 库根只走四个顶层）。"""
        out: list[str] = []
        stack = [""] if mount.is_external else list(ROOT_WRITABLE_TOP)
        while stack and len(out) < TREE_MAX_DIRS:
            rel = stack.pop()
            out.append(rel)
            base = os.path.join(mount.abs_path, *rel.split("/")) if rel else mount.abs_path
            try:
                with os.scandir(base) as it:
                    for entry in it:
                        if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                            continue
                        name = _nfc(entry.name)
                        if name in SCAN_SKIP_DIRS or (mount.is_external and name.startswith(".")):
                            continue
                        stack.append(f"{rel}/{name}" if rel else name)
            except OSError:
                continue
        return out

    def _count_files_on_disk(self, root: str) -> int:
        count = 0
        for _dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SCAN_SKIP_DIRS and not d.startswith(".")]
            count += len(filenames)
            if count > MOUNT_MAX_FILES:
                break
        return count

    def _reconcile_folder(self, conn, folder: ResolvedPath, *, force: bool = False, seen: Optional[set[str]] = None) -> dict[str, int]:
        """一个目录（非递归）：目录 mtime 没变就跳过；否则登记新文件、标 missing、补记外部改动。"""
        stats = {"scanned": 0, "added": 0, "updated": 0, "missing": 0}
        mount = folder.mount
        if not mount.is_external and not folder.rel_path:
            return stats
        try:
            dir_st = os.stat(folder.abs_path)
        except OSError:
            return stats
        memo_key = f"dirmtime:{mount.id}:{folder.rel_path}"
        memo = f"{dir_st.st_mtime_ns}"
        prior = conn.execute("SELECT value FROM library_meta WHERE key=?", (memo_key,)).fetchone()
        rows = {r["rel_key"]: r for r in self.repo.list_folder_rows(conn, mount.id, folder.rel_path)}
        if not force and prior is not None and prior[0] == memo:
            if seen is not None:
                seen.update(rows)
            return stats
        now = time.time()
        present_keys: set[str] = set()
        try:
            entries = list(os.scandir(folder.abs_path))
        except OSError:
            return stats
        for entry in entries:
            if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                continue
            name = _nfc(entry.name)
            rel = f"{folder.rel_path}/{name}" if folder.rel_path else name
            if P.denied_reason(mount, rel):
                continue
            key = P.rel_key_of(rel)
            present_keys.add(key)
            stats["scanned"] += 1
            st = entry.stat(follow_symlinks=False)
            row = rows.get(key)
            if row is None:
                kind = kind_for_filename(name)
                self.repo.insert_file(
                    conn, mount_id=mount.id, rel_path=rel, rel_key=key, parent_path=folder.rel_path, filename=name,
                    kind=kind, size_bytes=st.st_size, mtime=st.st_mtime, content_hash=None, source="user",
                    source_ref=None, created_by="user", status="present", text_status=initial_text_status(kind),
                    created_at=now, updated_at=now,
                )
                stats["added"] += 1
                continue
            if (
                row["status"] != "present"
                or int(row["size_bytes"] or -1) != st.st_size
                or float(row["mtime"] or 0.0) != st.st_mtime
                or row["rel_path"] != rel
            ):
                self._note_external_change(conn, row, os.path.join(folder.abs_path, entry.name), st, rel=rel, parent=folder.rel_path, filename=name)
                stats["updated"] += 1
        for key, row in rows.items():
            if key not in present_keys and row["status"] == "present":
                self.repo.update_file(conn, int(row["id"]), status="missing", updated_at=now)
                stats["missing"] += 1
        if seen is not None:
            seen.update(present_keys)
        conn.execute("INSERT OR REPLACE INTO library_meta (key, value) VALUES (?, ?)", (memo_key, memo))
        return stats

    def _reconcile_file(self, conn, row: dict[str, Any]) -> dict[str, Any]:
        """打开文件时：stat → 消失标 missing；size / mtime 变或从未算过 hash → 重算 + 外部改动补记。"""
        if row["status"] == "trashed":
            return row
        try:
            resolved = self._resolve_row(conn, row)
        except LibraryError:
            return row
        try:
            st = os.lstat(resolved.abs_path)
            if not os.path.isfile(resolved.abs_path) or os.path.islink(resolved.abs_path):
                raise FileNotFoundError(resolved.abs_path)
        except OSError:
            if row["status"] != "missing":
                self.repo.update_file(conn, int(row["id"]), status="missing", updated_at=time.time())
            return self.repo.get_file(conn, int(row["id"])) or row
        if (
            row["status"] != "present"
            or row["content_hash"] is None
            or int(row["size_bytes"] or -1) != st.st_size
            or float(row["mtime"] or 0.0) != st.st_mtime
        ):
            self._note_external_change(conn, row, resolved.abs_path, st, rel=row["rel_path"], parent=row["parent_path"], filename=row["filename"])
            return self.repo.get_file(conn, int(row["id"])) or row
        return row

    def _note_external_change(self, conn, row: dict[str, Any], abs_path: str, st: os.stat_result, *, rel: str, parent: str, filename: str) -> None:
        data = None
        try:
            fd = os.open(abs_path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                data = os.read(fd, max(0, st.st_size) + 1) if st.st_size <= READ_TOOL_MAX_BYTES else self._hash_fd(fd)
            finally:
                os.close(fd)
        except OSError:
            data = None
        new_hash = data if isinstance(data, str) else (_sha256(data) if data is not None else row["content_hash"])
        fields: dict[str, Any] = {
            "status": "present", "size_bytes": st.st_size, "mtime": st.st_mtime, "updated_at": time.time(),
            "rel_path": rel, "rel_key": P.rel_key_of(rel), "parent_path": parent, "filename": filename,
        }
        if new_hash != row["content_hash"]:
            fields["content_hash"] = new_hash
            if row["text_status"] in ("extracted", "failed"):
                fields["text_status"] = "pending"
            if (
                row["content_hash"] is not None
                and row["kind"] in TEXT_KINDS
                and isinstance(data, bytes)
                and len(data) <= TEXT_WRITE_MAX_BYTES
            ):
                self.repo.insert_history(
                    conn, file_id=int(row["id"]), old_hash=row["content_hash"], new_hash=new_hash,
                    content_snapshot=data.decode("utf-8", errors="replace"), changed_by="external",
                    change_note=None, created_at=time.time(),
                )
                self.repo.prune_history(conn, int(row["id"]))
        self.repo.update_file(conn, int(row["id"]), **fields)

    @staticmethod
    def _hash_fd(fd: int) -> str:
        h = hashlib.sha256()
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            h.update(chunk)
        return h.hexdigest()

    # ── 内部工具 ──────────────────────────────────────────────────────────────

    def _require_file(self, conn, file_id: int) -> dict[str, Any]:
        row = self.repo.get_file(conn, int(file_id))
        if row is None:
            raise LibraryError("E_NOT_FOUND", f"file {file_id} not found")
        return row

    def _register(
        self,
        conn,
        resolved: ResolvedPath,
        existing: Optional[dict[str, Any]],
        *,
        content: bytes,
        source: str,
        source_ref: Optional[str],
        created_by: str,
    ) -> int:
        st = os.stat(resolved.abs_path)
        kind = kind_for_filename(resolved.filename)
        now = time.time()
        fields = dict(
            rel_path=resolved.rel_path, rel_key=resolved.rel_key, parent_path=resolved.parent_path, filename=resolved.filename,
            kind=kind, size_bytes=st.st_size, mtime=st.st_mtime, content_hash=_sha256(content), source=source,
            source_ref=source_ref, created_by=created_by, status="present", text_status=initial_text_status(kind), updated_at=now,
        )
        if existing is not None:  # missing 行在同一路径重生：复用 id（引用不悬空）
            self.repo.update_file(conn, int(existing["id"]), **fields)
            return int(existing["id"])
        return self.repo.insert_file(conn, mount_id=resolved.mount.id, created_at=now, **fields)

    def _after_write(self, conn, row: dict[str, Any], data: bytes, new_hash: str) -> None:
        st = os.stat(os.path.join(self._mount_by_id(conn, int(row["mount_id"])).abs_path, *str(row["rel_path"]).split("/")))
        fields: dict[str, Any] = {"content_hash": new_hash, "size_bytes": st.st_size, "mtime": st.st_mtime, "updated_at": time.time()}
        if row["text_status"] in ("extracted", "failed"):
            fields["text_status"] = "pending"
        self.repo.update_file(conn, int(row["id"]), **fields)

    def _record_history(self, conn, row: dict[str, Any], *, old_hash: Optional[str], content: bytes, actor: Actor, change_note: Optional[str]) -> None:
        self.repo.insert_history(
            conn, file_id=int(row["id"]), old_hash=old_hash, new_hash=_sha256(content),
            content_snapshot=content.decode("utf-8", errors="replace"), changed_by=actor.changed_by,
            change_note=change_note, session_id=actor.session_id, message_id=actor.message_id, created_at=time.time(),
        )
        self.repo.prune_history(conn, int(row["id"]))

    @staticmethod
    def _write_bytes(resolved: ResolvedPath, data: bytes, mode: str) -> None:
        try:
            fd = P.open_write(resolved, mode)
        except PathError as exc:
            raise LibraryError(exc.code, exc.message, hint=exc.hint) from exc
        try:
            os.write(fd, data)
        finally:
            os.close(fd)

    @staticmethod
    def _read_bytes(resolved: ResolvedPath) -> bytes:
        try:
            fd = P.open_read(resolved)
        except PathError as exc:
            raise LibraryError(exc.code, exc.message, hint=exc.hint) from exc
        try:
            chunks = []
            while True:
                chunk = os.read(fd, 1 << 20)
                if not chunk:
                    break
                chunks.append(chunk)
            return b"".join(chunks)
        finally:
            os.close(fd)

    @staticmethod
    def _file_dict(row: dict[str, Any], mount: MountRoot) -> dict[str, Any]:
        """wire 形状：``library_file`` 列名 + ``path``（虚拟）+ ``mime``；**不含** ``rel_key`` 与任何绝对路径。"""
        return {
            "id": int(row["id"]),
            "mount_id": int(row["mount_id"]),
            "path": P.join_virtual(mount, str(row["rel_path"])),
            "rel_path": row["rel_path"],
            "parent_path": row["parent_path"],
            "filename": row["filename"],
            "kind": row["kind"],
            "mime": _mime(str(row["filename"])),
            "size_bytes": row["size_bytes"],
            "mtime": row["mtime"],
            "content_hash": row["content_hash"],
            "source": row["source"],
            "source_ref": row["source_ref"],
            "created_by": row["created_by"],
            "status": row["status"],
            "text_status": row["text_status"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

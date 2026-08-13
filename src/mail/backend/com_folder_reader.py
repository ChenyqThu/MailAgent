"""FolderComReader — FolderImapReader 的 Outlook COM 等价物 (task 08-12 BE2).

`src/services/mail_write.py` 的 folder 级写面 (归档/移动/文件夹 CRUD/删草稿) 原本
经 `FolderImapReader` 直连 IMAP (davmail-only, isinstance 硬闸)。outlook_com 模式
没有 IMAP 服务器 —— 本类用 COM `MailItem.Move()` / `Folders` 集合 CRUD 提供
**同名同形状** (duck-typing) 的等价方法面, mail_write 的能力判定闸按 backend
分派两个 reader (davmail 路径字节级不变)。

方法面 = mail_write 实际消费的最小集 (全仓 grep 证实, 其余 FolderImapReader 方法
无外部调用者):

- ``resolve_imap_folder("archive"|"drafts")``
- ``archive_inbox_message(message_id, fallback_uid=, src_imap=)``
- ``move_by_message_id(src_imap, message_id, dst_imap, fallback_uid=)``
- ``build_child_imap_name(parent_imap, child_display)`` (静态, 与 IMAP 版同构)
- ``create_folder / rename_folder / delete_folder``
- ``delete_draft_by_anchor(entry_id=, message_id=)`` (COM 专属 — 替代
  ``delete_message("drafts", uid)`` 的 imap_uid 锚, prd §2.2-4)

契约 (镜像 FolderImapReader): 全部方法**返回 bool / Optional, 不 raise** ——
失败 log + False, 由 mail_write 翻译成 ServiceError。``fallback_uid`` 参数保留
签名兼容但**忽略** (IMAP UID 概念, COM 锚 = message_id/entry_id)。

命名约定: 方法名/参数沿用 "imap_name" 字样 (mail_write 调用面已固化), 但
outlook_com 语境下值 = modified-UTF7 编码的**显示名** (mail_write._resolve_folder_imap
对自定义文件夹 encode_imap_utf7(显示名)); 本类一进门 decode 回显示名再做 COM
文件夹定位 —— ASCII 名 encode/decode 恒等, 中文名可逆, 语义无损。

🔴 平台纪律: 不直接 import win32com/pythoncom — 全部 COM 调用经
``backend._com`` (STA 线程 + 忙态退避 + reconnect), mac 上可 import 可单测。
"""
from __future__ import annotations

from typing import Any, Optional

from loguru import logger

from src.mail.mailbox_semantics import DRAFTS_LABEL

_OL_FOLDER_INBOX = 6
_OL_FOLDER_SENT_MAIL = 5
_OL_FOLDER_DRAFTS = 16

#: Archive 文件夹候选显示名 (镜像 imap_client.discover_archive_folder 的 fallback
#: 名单; Outlook classic 的 OlDefaultFolders 枚举没有 archive 值, 只能按名找)
_ARCHIVE_CANDIDATES = ("Archive", "存档", "已归档", "归档")


def _com_get(obj: Any, attr: str, default: Any = None) -> Any:
    """COM 属性读取 (属性可抛 COM 异常) — 与 outlook_com_backend._com_get 同构.

    独立复制而非 import: 避免 reader 对 backend 模块的非必要 import 面
    (backend 侧那份还叠了 bytes 解码, 这里只需要裸读)。
    """
    try:
        return getattr(obj, attr)
    except Exception:  # noqa: BLE001 — COM 属性读取失败一律回 default
        return default


def _decode_display(imap_name: str) -> str:
    """modified-UTF7 imap_name → 显示名. 解码失败 (已是裸显示名等) 原样返回."""
    try:
        from src.mail.backend.imap_utf7 import decode_imap_utf7

        return decode_imap_utf7(imap_name)
    except Exception:  # noqa: BLE001 — 非法 utf7 序列 → 当作已是显示名
        return imap_name


class FolderComReader:
    """Outlook COM folder 级写面 (归档/移动/文件夹 CRUD/删草稿).

    构造参数 = ``OutlookComBackend`` 实例 (复用其 STA executor / 会话重连 /
    message_id DASL 反查 / entry_id 快路径)。
    """

    def __init__(self, backend: Any):
        self.backend = backend
        self.cfg = backend.cfg
        self._archive_display: Optional[str] = None  # 发现缓存 (镜像 IMAP 版)
        self._archive_probed = False

    # ------------------------------------------------------------------
    # 内部: 文件夹定位
    # ------------------------------------------------------------------

    def _default(self, session: Any, kind: int) -> Any:
        return session.namespace.GetDefaultFolder(kind)

    def _root(self, session: Any) -> Any:
        """邮箱根 (收件箱的 Parent) — 自定义文件夹/Archive 的枚举起点."""
        inbox = self._default(session, _OL_FOLDER_INBOX)
        return _com_get(inbox, "Parent")

    @staticmethod
    def _child_by_name(parent: Any, name: str) -> Any:
        """在 parent.Folders 里按显示名找子文件夹 (大小写不敏感). 找不到 → None."""
        if parent is None:
            return None
        target = (name or "").strip().lower()
        try:
            for f in parent.Folders:
                if str(_com_get(f, "Name", "") or "").strip().lower() == target:
                    return f
        except Exception:  # noqa: BLE001 — Folders 枚举失败按找不到处理
            return None
        return None

    def _find_archive_folder(self, session: Any) -> Any:
        """按候选名在根/收件箱下找 Archive 文件夹. 结果显示名缓存 (每会话只扫一次)."""
        root = self._root(session)
        inbox = self._default(session, _OL_FOLDER_INBOX)
        for candidate in _ARCHIVE_CANDIDATES:
            for parent in (root, inbox):
                folder = self._child_by_name(parent, candidate)
                if folder is not None:
                    self._archive_display = str(
                        _com_get(folder, "Name", candidate) or candidate
                    )
                    return folder
        return None

    def _resolve_com_folder(self, session: Any, imap_name: str) -> Any:
        """imap_name (mail_write._resolve_folder_imap 产出) → COM Folder 对象.

        识别顺序: INBOX → 探测到的 sent/drafts 显示名 → Archive 显示名 →
        根下按显示路径逐段走 (自定义文件夹, 支持 "父/子" 层级)。找不到 → None。
        """
        raw = (imap_name or "").strip()
        if not raw:
            return None
        if raw.upper() == "INBOX":
            return self._default(session, _OL_FOLDER_INBOX)
        display = _decode_display(raw)
        names = {raw, display}
        sent_name = getattr(self.backend, "sent_folder", None)
        if (sent_name and sent_name in names) or names & {"Sent", "Sent Items"}:
            return self._default(session, _OL_FOLDER_SENT_MAIL)
        drafts_name = getattr(self.backend, "drafts_folder", None)
        if (drafts_name and drafts_name in names) or "Drafts" in names:
            return self._default(session, _OL_FOLDER_DRAFTS)
        if self._archive_display and self._archive_display in names:
            found = self._find_archive_folder(session)
            if found is not None:
                return found
        # 自定义文件夹: 根下按 "/" 分段显示名逐层走
        node = self._root(session)
        for segment in display.split("/"):
            node = self._child_by_name(node, segment)
            if node is None:
                return None
        return node

    def _find_item_in_folder(self, folder: Any, message_id: str) -> Any:
        """在指定文件夹里按 PR_INTERNET_MESSAGE_ID (DASL) Items.Find 单封."""
        from src.mail.backend.com_client import DASL_MESSAGE_ID
        from src.mail.backend.outlook_com_backend import _dasl_quote

        mid = (message_id or "").strip().strip("<>")
        if not mid or folder is None:
            return None
        for literal in (f"<{mid}>", mid):
            flt = f"@SQL=\"{DASL_MESSAGE_ID}\" = '{_dasl_quote(literal)}'"
            try:
                item = folder.Items.Find(flt)
            except Exception:  # noqa: BLE001 — filter 被 store 拒绝, 试下一形态
                continue
            if item is not None:
                return item
        return None

    def _locate_item(self, session: Any, src_imap: str, message_id: Optional[str]) -> Any:
        """定位待移动邮件: 源文件夹内 DASL 反查 → miss 时 backend 候选文件夹兜底."""
        if not message_id:
            return None
        folder = self._resolve_com_folder(session, src_imap)
        item = self._find_item_in_folder(folder, message_id)
        if item is not None:
            return item
        # 兜底: 邮件可能已被外部客户端挪走 → backend 的候选文件夹链反查
        return self.backend._find_by_message_id(session, message_id, None)

    # ------------------------------------------------------------------
    # 消费面 (mail_write duck-typing)
    # ------------------------------------------------------------------

    def resolve_imap_folder(self, folder: str) -> Optional[str]:
        """'archive' / 'drafts' → 文件夹名 (显示名的 modified-UTF7 编码). None=找不到.

        返回值会被 mail_write 回传给本类其它方法 (src_imap 等), encode 保持
        「reader 方法收 utf7 名」的不变量 (ASCII 名恒等)。
        """
        from src.mail.backend.imap_utf7 import encode_imap_utf7

        if folder == "drafts":
            return encode_imap_utf7(
                getattr(self.backend, "drafts_folder", None) or "Drafts"
            )
        if folder == "archive":
            if not self._archive_probed:
                self._archive_probed = True
                try:
                    self.backend._com(self._find_archive_folder, op="archive-discover")
                except Exception as e:  # noqa: BLE001 — 发现失败 → None (跳过归档)
                    logger.warning(f"[com-folder] discover archive failed: {e}")
                    self._archive_display = None
            if self._archive_display is None:
                return None
            return encode_imap_utf7(self._archive_display)
        raise ValueError(f"unknown folder {folder!r} (expect 'archive'|'drafts')")

    def archive_inbox_message(
        self,
        message_id: Optional[str],
        fallback_uid: Optional[int] = None,  # noqa: ARG002 — IMAP UID 概念, COM 忽略
        src_imap: str = "INBOX",
    ) -> bool:
        """把 ``src_imap`` 里的邮件 Move 到 Archive 文件夹 (锚 = message_id)."""

        def _do(session: Any) -> bool:
            dst = self._find_archive_folder(session)
            if dst is None:
                logger.error("[com-folder] archive: Archive 文件夹未发现, 无法归档")
                return False
            item = self._locate_item(session, src_imap, message_id)
            if item is None:
                logger.error(
                    f"[com-folder] archive: message_id={message_id!r} 不在 "
                    f"{src_imap!r} (已被外部移动/删除?)"
                )
                return False
            item.Move(dst)
            return True

        try:
            return bool(self.backend._com(_do, op="archive-move"))
        except Exception as e:  # noqa: BLE001 — reader 契约: 失败 log + False
            logger.error(f"[com-folder] archive_inbox_message failed: {e}")
            return False

    def move_by_message_id(
        self,
        src_imap: str,
        message_id: Optional[str],
        dst_imap: str,
        fallback_uid: Optional[int] = None,  # noqa: ARG002 — IMAP UID 概念, COM 忽略
    ) -> bool:
        """泛化移动: src/dst 任意文件夹 (锚 = message_id, Move 之于 COPY+EXPUNGE)."""

        def _do(session: Any) -> bool:
            dst = self._resolve_com_folder(session, dst_imap)
            if dst is None:
                logger.error(f"[com-folder] move: 目标 {dst_imap!r} 未找到")
                return False
            item = self._locate_item(session, src_imap, message_id)
            if item is None:
                logger.error(
                    f"[com-folder] move: message_id={message_id!r} 不在 {src_imap!r}"
                )
                return False
            item.Move(dst)
            return True

        try:
            return bool(self.backend._com(_do, op="folder-move"))
        except Exception as e:  # noqa: BLE001
            logger.error(
                f"[com-folder] move_by_message_id({src_imap!r}→{dst_imap!r}) failed: {e}"
            )
            return False

    @staticmethod
    def build_child_imap_name(
        parent_imap: str, child_display: str, delimiter: str = "/"
    ) -> str:
        """父 imap_name + 子显示名 → 子文件夹完整 imap_name (与 IMAP 版逐字同构)."""
        from src.mail.backend.imap_utf7 import encode_imap_utf7

        child_enc = encode_imap_utf7(child_display)
        if not parent_imap:
            return child_enc
        return f"{parent_imap}{delimiter}{child_enc}"

    def create_folder(self, imap_name: str) -> bool:
        """按显示路径新建文件夹 (父级必须已存在; 已存在同名 → False, 镜像 IMAP CREATE)."""

        def _do(session: Any) -> bool:
            display = _decode_display((imap_name or "").strip())
            if not display:
                return False
            segments = display.split("/")
            parent = self._root(session)
            for seg in segments[:-1]:
                parent = self._child_by_name(parent, seg)
                if parent is None:
                    logger.error(
                        f"[com-folder] create: 父路径段 {seg!r} 不存在 ({display!r})"
                    )
                    return False
            leaf = segments[-1]
            if self._child_by_name(parent, leaf) is not None:
                logger.error(f"[com-folder] create: {display!r} 已存在")
                return False
            parent.Folders.Add(leaf)
            return True

        try:
            return bool(self.backend._com(_do, op="folder-create"))
        except Exception as e:  # noqa: BLE001
            logger.error(f"[com-folder] create_folder({imap_name!r}) failed: {e}")
            return False

    def rename_folder(self, old_imap: str, new_imap: str) -> bool:
        """重命名 (COM: folder.Name = 新叶子显示名; new_imap 的父路径由调用方保持)."""

        def _do(session: Any) -> bool:
            folder = self._resolve_com_folder(session, old_imap)
            if folder is None:
                logger.error(f"[com-folder] rename: {old_imap!r} 未找到")
                return False
            new_leaf = _decode_display(new_imap).split("/")[-1]
            if not new_leaf:
                return False
            folder.Name = new_leaf
            return True

        try:
            return bool(self.backend._com(_do, op="folder-rename"))
        except Exception as e:  # noqa: BLE001
            logger.error(
                f"[com-folder] rename_folder({old_imap!r}→{new_imap!r}) failed: {e}"
            )
            return False

    def delete_folder(self, imap_name: str) -> bool:
        """删除文件夹 (COM Folder.Delete → 移入已删除邮件; 系统文件夹 Outlook 自拒)."""

        def _do(session: Any) -> bool:
            folder = self._resolve_com_folder(session, imap_name)
            if folder is None:
                logger.error(f"[com-folder] delete: {imap_name!r} 未找到")
                return False
            folder.Delete()
            return True

        try:
            return bool(self.backend._com(_do, op="folder-delete"))
        except Exception as e:  # noqa: BLE001
            logger.error(f"[com-folder] delete_folder({imap_name!r}) failed: {e}")
            return False

    def delete_draft_by_anchor(
        self,
        entry_id: Optional[str] = None,
        message_id: Optional[str] = None,
    ) -> bool:
        """删草稿 — entry_id 快路径 + message_id DASL 反查 (草稿箱候选链).

        替代 IMAP 版 ``delete_message("drafts", uid)`` 的 imap_uid 锚
        (mail_write.delete_draft 的 outlook_com 分支消费, prd §2.2-4)。
        """
        if not entry_id and not message_id:
            return False

        def _do(session: Any) -> bool:
            item = None
            if entry_id:
                item = self.backend._get_item_by_entry_id(session, str(entry_id))
            if item is None and message_id:
                item = self.backend._find_by_message_id(
                    session, message_id, DRAFTS_LABEL
                )
            if item is None:
                logger.warning(
                    f"[com-folder] delete_draft: 未定位到草稿 "
                    f"(entry_id={entry_id!r}, message_id={message_id!r})"
                )
                return False
            item.Delete()
            return True

        try:
            return bool(self.backend._com(_do, op="draft-delete"))
        except Exception as e:  # noqa: BLE001
            logger.error(f"[com-folder] delete_draft_by_anchor failed: {e}")
            return False

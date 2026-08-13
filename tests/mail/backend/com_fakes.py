"""fake COM 对象基础设施 — outlook_com backend 测试专用 (macOS 可跑, 零 pywin32).

模拟面 = OutlookComBackend / FolderComReader 实际消费的 Outlook 对象模型子集:

- ``FakeApplication``      → ``Dispatch("Outlook.Application")`` 替身 (经 dispatch_factory 注入)
- ``FakeNamespace``        → ``GetNamespace("MAPI")``: GetDefaultFolder / GetItemFromID
- ``FakeFolder``           → Name / FolderPath / Items / Folders / Parent / StoreID
- ``FakeItems``            → Sort / Restrict / Find / GetFirst / GetNext (DASL filter 解析)
- ``FakeItem``             → MailItem: 属性 + PropertyAccessor(DASL) + Reply/Forward/Move/
                             Delete/Save/Send + Attachments
- ``FakeSyncStore``        → get / get_by_message_id / allocate_davmail_internal_id

DASL filter 只解析 backend 真实产出的两种形状 (`_since_filter` / `_msgid_filter`),
不做通用 SQL——测试断言的是"backend 发出了什么查询", 不是重写 Outlook.
"""
from __future__ import annotations

import re
from datetime import datetime
from types import SimpleNamespace
from typing import Optional

# DASL 常量与实现侧同值 (src/mail/backend/com_client.py); 手抄进 fake 是有意的 ——
# fake 若 import 实现侧常量, "常量写错"这类 bug 就测不出来.
PR_INTERNET_MESSAGE_ID = "http://schemas.microsoft.com/mapi/proptag/0x1035001F"
PR_TRANSPORT_MESSAGE_HEADERS = "http://schemas.microsoft.com/mapi/proptag/0x007D001F"

_SINCE_RE = re.compile(r'"urn:schemas:httpmail:datereceived"\s*>=\s*\'([^\']+)\'')
_MSGID_RE = re.compile(r'"urn:schemas:mailheader:message-id"\s*=\s*\'((?:[^\']|\'\')*)\'')


def local_dt(epoch: int) -> datetime:
    """epoch 秒 → 本机时区 naive datetime (镜像 COM ReceivedTime 的 pywintypes 语义)."""
    return datetime.fromtimestamp(int(epoch))


class FakePropertyAccessor:
    def __init__(self, props: dict):
        self._props = props

    def GetProperty(self, dasl: str):
        if dasl not in self._props:
            raise KeyError(f"property not found: {dasl}")
        return self._props[dasl]


class FakeAttachment:
    def __init__(self, filename: str, data: bytes = b"", content_id: str = ""):
        self.FileName = filename
        self.DisplayName = filename
        self._data = data
        self._content_id = content_id
        self.saved_paths: list[str] = []

    @property
    def PropertyAccessor(self):
        props = {}
        if self._content_id:
            props["http://schemas.microsoft.com/mapi/proptag/0x3712001F"] = self._content_id
        return FakePropertyAccessor(props)

    def SaveAsFile(self, path: str):
        with open(path, "wb") as f:
            f.write(self._data)
        self.saved_paths.append(path)


class FakeAttachments:
    def __init__(self, attachments: Optional[list] = None):
        self._items = list(attachments or [])
        self.added_paths: list[str] = []

    @property
    def Count(self):
        return len(self._items)

    def Item(self, index: int):  # 1-based
        return self._items[index - 1]

    def Add(self, path: str):
        self.added_paths.append(path)
        self._items.append(FakeAttachment(path.rsplit("/", 1)[-1]))


class FakeItem:
    """MailItem 替身. Class=43 (olMail); 非邮件项用 item_class 覆盖."""

    _seq = 0

    def __init__(
        self,
        *,
        entry_id: str = "",
        subject: str = "",
        message_id: str = "",
        transport_headers: str = "",
        received_epoch: Optional[int] = None,
        html_body: str = "",
        text_body: str = "",
        sender_name: str = "",
        sender_email: str = "",
        sender_email_type: str = "SMTP",
        to: str = "",
        cc: str = "",
        unread: bool = False,
        item_class: int = 43,
        attachments: Optional[list] = None,
        parent=None,
    ):
        FakeItem._seq += 1
        self.EntryID = entry_id or f"EID-{FakeItem._seq:04d}"
        self.Subject = subject
        self.ReceivedTime = local_dt(received_epoch) if received_epoch else None
        self.HTMLBody = html_body
        self.Body = text_body
        self.SenderName = sender_name
        self.SenderEmailAddress = sender_email
        self.SenderEmailType = sender_email_type
        self.To = to
        self.CC = cc
        self.BCC = ""
        self.UnRead = unread
        self.Class = item_class
        self.FlagStatus = 0
        self.FlagRequest = ""
        self.Importance = 1
        self.Attachments = FakeAttachments(attachments)
        self.Parent = parent
        self.ConversationIndex = ""
        self.ConversationID = ""
        self.Sender = None  # Exchange DN 解析路径按需注入
        self._props: dict = {}
        if message_id:
            self._props[PR_INTERNET_MESSAGE_ID] = message_id
        if transport_headers:
            self._props[PR_TRANSPORT_MESSAGE_HEADERS] = transport_headers
        # 行为记录
        self.saved = 0
        self.sent = 0
        self.deleted = 0
        self.moved_to = None
        self.mark_as_task_calls: list = []
        self.clear_task_calls = 0

    @property
    def PropertyAccessor(self):
        return FakePropertyAccessor(self._props)

    def Save(self):
        self.saved += 1
        # 模拟 Outlook: 首次 Save 落 Drafts 并分配 Message-ID (让 DASL 读取路径被真实走到)
        if PR_INTERNET_MESSAGE_ID not in self._props:
            self._props[PR_INTERNET_MESSAGE_ID] = f"<draft-{self.EntryID}@fake.outlook>"

    def Send(self):
        self.sent += 1

    def Delete(self):
        self.deleted += 1
        if self.Parent is not None and self in self.Parent._items:
            self.Parent._items.remove(self)

    def Move(self, dst_folder):
        self.moved_to = dst_folder
        if self.Parent is not None and self in self.Parent._items:
            self.Parent._items.remove(self)
        dst_folder._items.append(self)
        self.Parent = dst_folder
        return self

    def MarkAsTask(self, interval):
        self.mark_as_task_calls.append(interval)
        self.FlagStatus = 2

    def ClearTaskFlag(self):
        self.clear_task_calls += 1
        self.FlagStatus = 0

    def Reply(self):
        return FakeItem(
            subject=f"RE: {self.Subject}",
            html_body=f"<html><body><br>quoted: {self.Subject}</body></html>",
            to=self.SenderEmailAddress,
            parent=None,
        )

    def ReplyAll(self):
        item = self.Reply()
        item.CC = self.CC
        return item

    def Forward(self):
        return FakeItem(
            subject=f"FW: {self.Subject}",
            html_body=f"<html><body><br>forwarded: {self.Subject}</body></html>",
            parent=None,
        )


class FakeItems:
    """Items 集合: Sort / Restrict / Find / GetFirst / GetNext."""

    def __init__(self, items: list):
        self._source = items  # 活引用 (folder._items)
        self._sorted = list(items)
        self._cursor = 0

    @property
    def Count(self):
        return len(self._sorted)

    def Sort(self, key: str, descending: bool = False):
        assert "[ReceivedTime]" in key, f"unexpected sort key: {key}"
        epoch_min = datetime.fromtimestamp(0)
        self._sorted = sorted(
            self._source,
            key=lambda it: it.ReceivedTime or epoch_min,
            reverse=bool(descending),
        )

    def Restrict(self, flt: str):
        m = _SINCE_RE.search(flt)
        if not m:
            raise ValueError(f"unsupported Restrict filter: {flt}")
        threshold = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
        subset = [
            it for it in self._sorted
            if it.ReceivedTime is not None and it.ReceivedTime >= threshold
        ]
        result = FakeItems(subset)
        result._sorted = subset
        return result

    def Find(self, flt: str):
        m = _MSGID_RE.search(flt)
        if not m:
            raise ValueError(f"unsupported Find filter: {flt}")
        literal = m.group(1).replace("''", "'")
        for it in self._sorted:
            if it._props.get(PR_INTERNET_MESSAGE_ID) == literal:
                return it
        return None

    def GetFirst(self):
        self._cursor = 0
        return self.GetNext()

    def GetNext(self):
        if self._cursor >= len(self._sorted):
            return None
        item = self._sorted[self._cursor]
        self._cursor += 1
        return item


class BrokenItems:
    """任何访问都炸 — 模拟 COM 枚举失败 (三态契约测试用)."""

    def __init__(self, exc: Optional[Exception] = None):
        self._exc = exc or RuntimeError("COM enumeration failed (fake)")

    def __getattr__(self, name):
        raise self._exc


class FakeFolders:
    def __init__(self, folders: Optional[list] = None):
        self._folders = list(folders or [])

    @property
    def Count(self):
        return len(self._folders)

    def Item(self, index: int):  # 1-based
        return self._folders[index - 1]

    def Add(self, name: str):
        for f in self._folders:
            if f.Name == name:
                raise RuntimeError(f"folder already exists: {name}")
        folder = FakeFolder(name)
        self._folders.append(folder)
        return folder

    def __iter__(self):
        return iter(list(self._folders))


class FakeFolder:
    def __init__(self, name: str, items: Optional[list] = None, store_id: str = "STORE-1"):
        self.Name = name
        self.StoreID = store_id
        self._items = list(items or [])
        for it in self._items:
            it.Parent = self
        self.Folders = FakeFolders()
        self.Parent = None
        self.deleted = 0
        self.broken_items: Optional[Exception] = None

    @property
    def FolderPath(self):
        parts = [self.Name]
        node = self.Parent
        while node is not None and isinstance(node, FakeFolder):
            parts.append(node.Name)
            node = node.Parent
        return "\\\\" + "\\".join(reversed(parts))

    @property
    def Items(self):
        if self.broken_items is not None:
            raise self.broken_items
        return FakeItems(self._items)

    def Delete(self):
        self.deleted += 1
        parent = self.Parent
        if parent is not None and self in parent.Folders._folders:
            parent.Folders._folders.remove(self)

    def add_subfolder(self, folder: "FakeFolder"):
        folder.Parent = self
        self.Folders._folders.append(folder)
        return folder

    def add_item(self, item: FakeItem):
        item.Parent = self
        self._items.append(item)
        return item


# olDefaultFolders 常量 (与实现侧同值; 手抄有意, 理由见文件头)
OL_FOLDER_INBOX = 6
OL_FOLDER_SENT = 5
OL_FOLDER_DRAFTS = 16


class FakeOutlookStore:
    """一棵完整文件夹树: root ← inbox / sent / drafts (+按需挂 archive/custom)."""

    def __init__(self):
        self.root = FakeFolder("owner@example.test")
        self.inbox = self.root.add_subfolder(FakeFolder("Inbox"))
        self.sent = self.root.add_subfolder(FakeFolder("Sent Items"))
        self.drafts = self.root.add_subfolder(FakeFolder("Drafts"))

    def all_folders(self):
        out = []

        def walk(f):
            out.append(f)
            for sub in f.Folders:
                walk(sub)

        walk(self.root)
        return out

    def find_item_by_entry_id(self, entry_id: str):
        for folder in self.all_folders():
            for it in folder._items:
                if it.EntryID == entry_id:
                    return it
        return None


class FakeNamespace:
    def __init__(self, store: FakeOutlookStore):
        self._store = store

    def GetDefaultFolder(self, kind: int):
        mapping = {
            OL_FOLDER_INBOX: self._store.inbox,
            OL_FOLDER_SENT: self._store.sent,
            OL_FOLDER_DRAFTS: self._store.drafts,
        }
        try:
            return mapping[kind]
        except KeyError:
            raise RuntimeError(f"no default folder for kind={kind}")

    def GetItemFromID(self, entry_id: str, store_id: Optional[str] = None):
        item = self._store.find_item_by_entry_id(entry_id)
        if item is None:
            raise RuntimeError(f"GetItemFromID failed: {entry_id!r} (fake MAPI miss)")
        return item


class FakeApplication:
    def __init__(self, store: FakeOutlookStore):
        self._store = store
        self.created_items: list[FakeItem] = []

    def GetNamespace(self, name: str):
        assert name == "MAPI"
        return FakeNamespace(self._store)

    def CreateItem(self, kind: int):
        assert kind == 0  # olMailItem
        item = FakeItem(subject="", html_body="")
        self.created_items.append(item)
        return item


class FakeSyncStore:
    """SyncStore 替身: 只实现 backend 消费的三个方法."""

    def __init__(self):
        self._next_id = 1_000_000_000
        self.rows: dict[int, dict] = {}
        self.alloc_fail = False

    def allocate_davmail_internal_id(self) -> int:
        if self.alloc_fail:
            raise RuntimeError("allocate failed (fake sync_state lock)")
        val = self._next_id
        self._next_id += 1
        return val

    def add_row(self, internal_id: int, **kw) -> dict:
        row = {
            "internal_id": internal_id,
            "message_id": None,
            "entry_id": None,
            "mailbox": "收件箱",
            **kw,
        }
        self.rows[internal_id] = row
        return row

    def get(self, internal_id: int):
        return self.rows.get(internal_id)

    def get_by_message_id(self, message_id: str):
        for row in self.rows.values():
            if row.get("message_id") == message_id:
                return row
        return None


class FakeCfg:
    """OutlookComBackend 消费的 config 面."""

    user_email = "owner@example.test"
    outlook_com_publish_timeout_sec = 5
    # 指向不可建库的路径: 若测试忘了 monkeypatch _update_entry_id 而真走 sqlite,
    # connect 失败会被实现侧 warning 吞掉, 不会污染真实数据.
    sync_store_db_path = "/dev/null/never/sync_store.db"


def make_backend(store: Optional[FakeOutlookStore] = None,
                 sync_store: Optional[FakeSyncStore] = None,
                 cfg: Optional[FakeCfg] = None):
    """组装 backend + 全套 fake, 返回 SimpleNamespace(backend/store/sync_store/app/cfg)."""
    from src.mail.backend.outlook_com_backend import OutlookComBackend

    store = store or FakeOutlookStore()
    sync_store = sync_store or FakeSyncStore()
    cfg = cfg or FakeCfg()
    app = FakeApplication(store)
    backend = OutlookComBackend(
        cfg, sync_store=sync_store, dispatch_factory=lambda prog_id: app,
    )
    return SimpleNamespace(
        backend=backend, store=store, sync_store=sync_store, app=app, cfg=cfg,
    )

"""FolderComReader 单测 (task 08-12 BE2) + mail_write 能力判定闸 dispatch.

契约 (镜像 FolderImapReader): 所有方法失败 log + False, **不 raise**;
`fallback_uid` 参数保留签名兼容但忽略; imap_name 收 modified-UTF7 显示名。
"""
import os

os.environ.setdefault("USER_EMAIL", "ci@example.test")

from types import SimpleNamespace

import pytest

from src.mail.backend.com_folder_reader import FolderComReader
from src.mail.backend.imap_utf7 import encode_imap_utf7
from tests.mail.backend.com_fakes import (
    FakeFolder,
    FakeItem,
    FakeOutlookStore,
    make_backend,
)


def make_reader(store=None):
    env = make_backend(store=store)
    return FolderComReader(env.backend), env


def _inbox_mail(store, message_id: str, subject: str = "hello", **kw) -> FakeItem:
    item = FakeItem(subject=subject, message_id=message_id, received_epoch=1_700_000_000, **kw)
    store.inbox.add_item(item)
    return item


# ---------------------------------------------------------------------------
# resolve_imap_folder
# ---------------------------------------------------------------------------


def test_resolve_drafts_default():
    reader, _ = make_reader()
    assert reader.resolve_imap_folder("drafts") == "Drafts"


def test_resolve_drafts_uses_backend_probed_name():
    reader, env = make_reader()
    env.backend.drafts_folder = "草稿箱"
    assert reader.resolve_imap_folder("drafts") == encode_imap_utf7("草稿箱")


def test_resolve_archive_discovers_by_candidate_name():
    store = FakeOutlookStore()
    store.root.add_subfolder(FakeFolder("Archive"))
    reader, _ = make_reader(store)
    assert reader.resolve_imap_folder("archive") == "Archive"


def test_resolve_archive_chinese_candidate():
    store = FakeOutlookStore()
    store.root.add_subfolder(FakeFolder("存档"))
    reader, _ = make_reader(store)
    assert reader.resolve_imap_folder("archive") == encode_imap_utf7("存档")


def test_resolve_archive_absent_returns_none_and_caches_probe():
    reader, _ = make_reader()
    assert reader.resolve_imap_folder("archive") is None
    assert reader._archive_probed is True
    assert reader.resolve_imap_folder("archive") is None  # 二次调用走缓存不炸


def test_resolve_unknown_kind_raises():
    reader, _ = make_reader()
    with pytest.raises(ValueError):
        reader.resolve_imap_folder("junk")


# ---------------------------------------------------------------------------
# archive_inbox_message
# ---------------------------------------------------------------------------


def test_archive_moves_inbox_item():
    store = FakeOutlookStore()
    archive = store.root.add_subfolder(FakeFolder("Archive"))
    item = _inbox_mail(store, "<a1@example.test>")
    reader, _ = make_reader(store)
    assert reader.archive_inbox_message("a1@example.test", fallback_uid=123) is True
    assert item.moved_to is archive
    assert item not in store.inbox._items
    assert item in archive._items


def test_archive_without_archive_folder_false():
    store = FakeOutlookStore()
    _inbox_mail(store, "<a2@example.test>")
    reader, _ = make_reader(store)
    assert reader.archive_inbox_message("a2@example.test") is False


def test_archive_message_not_found_false():
    store = FakeOutlookStore()
    store.root.add_subfolder(FakeFolder("Archive"))
    reader, _ = make_reader(store)
    assert reader.archive_inbox_message("ghost@example.test") is False


def test_archive_com_failure_returns_false_not_raise(monkeypatch):
    store = FakeOutlookStore()
    store.root.add_subfolder(FakeFolder("Archive"))
    _inbox_mail(store, "<a3@example.test>")
    reader, env = make_reader(store)

    def boom(fn, *, op):
        raise RuntimeError("COM dead (fake)")

    monkeypatch.setattr(env.backend, "_com", boom)
    assert reader.archive_inbox_message("a3@example.test") is False  # 契约: 不 raise


# ---------------------------------------------------------------------------
# move_by_message_id
# ---------------------------------------------------------------------------


def test_move_to_custom_chinese_folder():
    store = FakeOutlookStore()
    projects = store.root.add_subfolder(FakeFolder("项目"))
    item = _inbox_mail(store, "<m1@example.test>")
    reader, _ = make_reader(store)
    ok = reader.move_by_message_id(
        "INBOX", "m1@example.test", encode_imap_utf7("项目"), fallback_uid=7,
    )
    assert ok is True
    assert item in projects._items and item not in store.inbox._items


def test_move_to_nested_custom_folder():
    store = FakeOutlookStore()
    parent = store.root.add_subfolder(FakeFolder("Work"))
    child = parent.add_subfolder(FakeFolder("Reports"))
    item = _inbox_mail(store, "<m2@example.test>")
    reader, _ = make_reader(store)
    assert reader.move_by_message_id("INBOX", "m2@example.test", "Work/Reports") is True
    assert item in child._items


def test_move_dst_missing_false():
    store = FakeOutlookStore()
    _inbox_mail(store, "<m3@example.test>")
    reader, _ = make_reader(store)
    assert reader.move_by_message_id("INBOX", "m3@example.test", "Nowhere") is False


def test_move_item_missing_falls_back_to_backend_candidates():
    # 源文件夹 miss 时走 backend._find_by_message_id 候选链 (邮件已被外部挪走场景):
    # 邮件实际在 Sent, src_imap 却说 INBOX → 兜底反查仍能命中并移动
    store = FakeOutlookStore()
    dst = store.root.add_subfolder(FakeFolder("Keep"))
    item = FakeItem(subject="s", message_id="<m4@example.test>", received_epoch=1_700_000_000)
    store.sent.add_item(item)
    reader, _ = make_reader(store)
    assert reader.move_by_message_id("INBOX", "m4@example.test", "Keep") is True
    assert item in dst._items


def test_move_message_nowhere_false():
    reader, _ = make_reader()
    assert reader.move_by_message_id("INBOX", "ghost@example.test", "INBOX") is False


# ---------------------------------------------------------------------------
# build_child_imap_name / folder CRUD
# ---------------------------------------------------------------------------


def test_build_child_imap_name():
    assert FolderComReader.build_child_imap_name("INBOX", "sub") == "INBOX/sub"
    assert FolderComReader.build_child_imap_name("", "solo") == "solo"
    assert FolderComReader.build_child_imap_name("Work", "项目") == (
        "Work/" + encode_imap_utf7("项目")
    )


def test_create_folder_at_root():
    store = FakeOutlookStore()
    reader, _ = make_reader(store)
    assert reader.create_folder("NewFolder") is True
    assert any(f.Name == "NewFolder" for f in store.root.Folders)


def test_create_folder_chinese_utf7():
    store = FakeOutlookStore()
    reader, _ = make_reader(store)
    assert reader.create_folder(encode_imap_utf7("新建夹")) is True
    assert any(f.Name == "新建夹" for f in store.root.Folders)


def test_create_nested_folder_under_existing_parent():
    store = FakeOutlookStore()
    parent = store.root.add_subfolder(FakeFolder("Parent"))
    reader, _ = make_reader(store)
    assert reader.create_folder("Parent/Child") is True
    assert any(f.Name == "Child" for f in parent.Folders)


def test_create_folder_parent_missing_false():
    reader, _ = make_reader()
    assert reader.create_folder("Ghost/Child") is False


def test_create_folder_already_exists_false():
    store = FakeOutlookStore()
    store.root.add_subfolder(FakeFolder("Dup"))
    reader, _ = make_reader(store)
    assert reader.create_folder("Dup") is False


def test_rename_folder():
    store = FakeOutlookStore()
    folder = store.root.add_subfolder(FakeFolder("OldName"))
    reader, _ = make_reader(store)
    assert reader.rename_folder("OldName", "NewName") is True
    assert folder.Name == "NewName"


def test_rename_folder_missing_false():
    reader, _ = make_reader()
    assert reader.rename_folder("Ghost", "New") is False


def test_delete_folder():
    store = FakeOutlookStore()
    folder = store.root.add_subfolder(FakeFolder("Doomed"))
    reader, _ = make_reader(store)
    assert reader.delete_folder("Doomed") is True
    assert folder.deleted == 1
    assert folder not in store.root.Folders._folders


def test_delete_folder_missing_false():
    reader, _ = make_reader()
    assert reader.delete_folder("Ghost") is False


# ---------------------------------------------------------------------------
# delete_draft_by_anchor (mail_write.delete_draft 的 outlook_com 锚)
# ---------------------------------------------------------------------------


def test_delete_draft_entry_id_fast_path():
    store = FakeOutlookStore()
    draft = FakeItem(subject="draft", entry_id="EID-D1", message_id="<d1@example.test>")
    store.drafts.add_item(draft)
    reader, _ = make_reader(store)
    assert reader.delete_draft_by_anchor(entry_id="EID-D1") is True
    assert draft.deleted == 1
    assert draft not in store.drafts._items


def test_delete_draft_message_id_fallback_when_entry_id_stale():
    store = FakeOutlookStore()
    draft = FakeItem(subject="draft", entry_id="EID-D2", message_id="<d2@example.test>")
    store.drafts.add_item(draft)
    reader, _ = make_reader(store)
    # entry_id 漂移 (GetItemFromID miss) → message_id DASL 反查草稿箱兜底
    ok = reader.delete_draft_by_anchor(entry_id="STALE-EID", message_id="d2@example.test")
    assert ok is True
    assert draft.deleted == 1


def test_delete_draft_no_anchor_false():
    reader, _ = make_reader()
    assert reader.delete_draft_by_anchor() is False
    assert reader.delete_draft_by_anchor(entry_id=None, message_id=None) is False


def test_delete_draft_not_found_false():
    reader, _ = make_reader()
    assert reader.delete_draft_by_anchor(entry_id="GHOST", message_id="ghost@x") is False


# ---------------------------------------------------------------------------
# mail_write._folder_imap_reader 能力判定闸 (isinstance 硬闸改造)
# ---------------------------------------------------------------------------


def _mail_write_service_with(backend):
    from src.services.mail_write import MailWriteService

    svc = MailWriteService.__new__(MailWriteService)
    svc._ctx = SimpleNamespace(backend=backend)
    return svc


def test_mail_write_dispatch_davmail_gets_imap_reader():
    from src.mail.backend.davmail_backend import DavMailBackend
    from src.mail.backend.imap_folder_reader import FolderImapReader

    backend = object.__new__(DavMailBackend)  # isinstance 判定即可, 不跑 __init__
    backend.cfg = SimpleNamespace()
    reader = _mail_write_service_with(backend)._folder_imap_reader()
    assert isinstance(reader, FolderImapReader)  # davmail 路径字节级不变


def test_mail_write_dispatch_outlook_com_gets_com_reader():
    env = make_backend()
    assert env.backend.supports_folder_ops is True
    reader = _mail_write_service_with(env.backend)._folder_imap_reader()
    assert isinstance(reader, FolderComReader)


def test_mail_write_dispatch_applescript_raises():
    from src.services.errors import ServiceInvalidArgError

    backend = SimpleNamespace(backend_origin="applescript")
    with pytest.raises(ServiceInvalidArgError):
        _mail_write_service_with(backend)._folder_imap_reader()

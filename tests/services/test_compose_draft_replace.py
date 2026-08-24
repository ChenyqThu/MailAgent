"""草稿保存正确性四连修 (task 08-20 draft-save) — C-1 replace / D1 镜像附件 /
D2 inline 保真集 / D3 兜底闸 后端回归。

- C-1 replace: compose_draft 消费 source_draft_id — APPEND 成功、镜像之后对旧草稿
  行执行与 delete_draft 同构三步 (墓碑 → 本地删+SSE → IMAP EXPUNGE 后台化)。
- D1: _mirror_draft_locally 把 draft.attachments/inline_attachments 转
  AttachmentPayload 传 commit_email_with_body 第三参, 本地镜像行不再零附件。
- D2: attachment_id 引用命中 is_inline 行 → 分流 inline_attachments 四元组;
  build_outgoing_mime 仅对正文真引用 cid 的部件编回 multipart/related part。
- D3: draft-edit (source_draft_id 在场) 源行有非 derived 附件而请求省略
  attachments 键 → E_INVALID_ARG, 不静默产出无附件 EML; 显式 [] 放行。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import src.services.mail_write as mail_write
from src.mail.backend.types import DraftAppendResult
from src.mail.draft_tombstones import active_uids
from src.mail.sync_store import SyncStore
from src.services.errors import ServiceInvalidArgError
from src.services.guards import Actor
from src.services.mail_write import ComposeRequest, MailWriteService

OLD_DRAFT_IID = 1_000_000_001
OLD_UID = 42
NEW_UID = 555


# ---------------------------------------------------------------------------
# stubs
# ---------------------------------------------------------------------------


class _StubRepo:
    """email_repo 替身: 库内附件面 + commit/delete 录制。"""

    def __init__(self):
        self.records = {
            7: SimpleNamespace(
                id=7, filename="plan.xlsx",
                content_type="application/vnd.ms-excel",
                is_inline=False, content_id=None, derived_from=None,
            ),
            8: SimpleNamespace(
                id=8, filename="logo.png", content_type="image/png",
                is_inline=True, content_id="img-cid-1@x", derived_from=None,
            ),
        }
        self.bytes_by_id = {7: b"XLSX-BYTES", 8: b"PNG-BYTES"}
        # D3 守卫读源草稿行附件 — 默认无附件 (各测试按需覆盖)
        self.source_attachments: list = []
        self.commits: list = []
        self.deleted: list[int] = []

    def get_attachment_record(self, att_id):
        return self.records.get(att_id)

    def get_attachment_bytes(self, att_id):
        return self.bytes_by_id.get(att_id)

    def get_attachments(self, internal_id):
        return self.source_attachments

    def commit_email_with_body(self, internal_id, body, attachments, *, message_id=None):
        self.commits.append(
            {
                "internal_id": internal_id,
                "body": body,
                "attachments": attachments,
                "message_id": message_id,
            }
        )
        return {a.filename: 100 + i for i, a in enumerate(attachments)}

    def delete_email_full(self, internal_id):
        self.deleted.append(internal_id)


class _StubBackend:
    def __init__(self):
        self.appended = []

    def append_draft(self, draft):
        self.appended.append(draft)
        return DraftAppendResult(
            success=True, drafts_folder="Drafts", appended_uid=NEW_UID,
            method="imap_append", message_id="new-mid@x", appended_uidvalidity=1,
        )


class _StubReader:
    def __init__(self):
        self.deleted = []

    def delete_message(self, folder, uid):
        self.deleted.append((folder, uid))
        return True


class _ImmediateThread:
    """替换 threading.Thread — 后台 EXPUNGE 在测试里同步执行, 断言可见。"""

    last_target = None

    def __init__(self, *, target=None, name=None, daemon=None):
        self._target = target
        _ImmediateThread.last_target = target

    def start(self):
        if self._target:
            self._target()


@pytest.fixture()
def svc(tmp_path, monkeypatch):
    service = MailWriteService.__new__(MailWriteService)
    ctx = SimpleNamespace(
        config=SimpleNamespace(
            user_email="me@x.com",
            drafts_sync_enabled=True,
            sync_store_db_path=str(tmp_path / "t.db"),
        ),
        sync_store=SyncStore(str(tmp_path / "t.db")),
        email_repo=_StubRepo(),
        backend=_StubBackend(),
    )
    service._ctx = ctx
    reader = _StubReader()
    service._folder_imap_reader = lambda: reader  # type: ignore[method-assign]
    service._reader = reader  # 测试访问口
    monkeypatch.setattr(
        mail_write, "threading", SimpleNamespace(Thread=_ImmediateThread)
    )
    return service


@pytest.fixture()
def publishes(monkeypatch):
    calls: list = []
    import src.events.publisher as publisher

    monkeypatch.setattr(
        publisher, "safe_publish",
        lambda event_type, **kw: calls.append((event_type, kw)),
    )
    return calls


def _seed_old_draft(store, **overrides):
    row = {
        "internal_id": OLD_DRAFT_IID,
        "message_id": "old-mid@x",
        "subject": "draft v1",
        "sender": "me@x.com",
        "mailbox": "草稿箱",
        "sync_status": "synced",
        "backend_origin": "davmail",
        "imap_uid": OLD_UID,
        # ''=已探测无 threading 头 (A2 哨兵), 测试免走 heal 探测分支
        "draft_in_reply_to": "",
    }
    row.update(overrides)
    store.save_email(row)
    return row["internal_id"]


def _draft_edit_request(source_draft_id=OLD_DRAFT_IID, **kw):
    kw.setdefault("attachments", [])
    kw.setdefault("body_html", "<p>edited</p>")
    return ComposeRequest(
        internal_id=source_draft_id, mode="new",
        to="a@x.com", subject="draft v2",
        source_draft_id=source_draft_id, **kw,
    )


def _save(svc, request):
    return svc.compose_draft(
        request, actor=Actor(kind="cli", authenticated=True, label="test")
    )


# ---------------------------------------------------------------------------
# C-1 replace 三步
# ---------------------------------------------------------------------------


def test_replace_deletes_old_row_tombstones_and_publishes(svc, publishes):
    store = svc._ctx.sync_store
    _seed_old_draft(store)

    result = _save(svc, _draft_edit_request())

    # ① 墓碑: 旧 uid 在 TTL 窗口内对 reconcile 可见
    assert OLD_UID in active_uids(store)
    # ② 本地行删 + SSE deleted 事件
    assert OLD_DRAFT_IID in svc._ctx.email_repo.deleted
    deleted_events = [
        kw for et, kw in publishes
        if et == "email.synced" and kw.get("internal_id") == OLD_DRAFT_IID
    ]
    assert deleted_events and deleted_events[0]["data"]["deleted"] is True
    # ③ 远端 IMAP 删 (后台线程, 测试里同步跑)
    assert ("drafts", OLD_UID) in svc._reader.deleted
    assert result.replaced_source_draft_id == OLD_DRAFT_IID


def test_replace_missing_row_is_idempotent_noop(svc, publishes):
    result = _save(svc, _draft_edit_request(source_draft_id=999_999))
    assert result.replaced_source_draft_id is None
    assert svc._ctx.email_repo.deleted == []
    assert svc._reader.deleted == []


def test_replace_skips_non_draft_mailbox_row(svc, publishes):
    _seed_old_draft(svc._ctx.sync_store, mailbox="收件箱")
    result = _save(svc, _draft_edit_request())
    assert result.replaced_source_draft_id is None
    assert OLD_DRAFT_IID not in svc._ctx.email_repo.deleted
    assert svc._reader.deleted == []


def test_replace_row_without_uid_split_by_origin(svc, publishes):
    """无 uid 行按 backend_origin 分流 (批2 异步 APPEND 起):
    davmail-origin = 异步镜像行 → 本地删即替换 (无墓碑无远端删);
    非 davmail (AppleScript 存量, 远端有物无锚) → 仍整体跳过, 删本地必回弹。"""
    _seed_old_draft(svc._ctx.sync_store, imap_uid=None)
    result = _save(svc, _draft_edit_request())
    assert result.replaced_source_draft_id == OLD_DRAFT_IID
    assert OLD_DRAFT_IID in svc._ctx.email_repo.deleted
    assert OLD_UID not in active_uids(svc._ctx.sync_store)
    assert svc._reader.deleted == []

    legacy_iid = OLD_DRAFT_IID + 1
    _seed_old_draft(
        svc._ctx.sync_store, internal_id=legacy_iid,
        message_id="legacy-mid@x", imap_uid=None, backend_origin="applescript",
    )
    result2 = _save(svc, _draft_edit_request(source_draft_id=legacy_iid))
    assert result2.replaced_source_draft_id is None
    assert legacy_iid not in svc._ctx.email_repo.deleted


def test_replace_not_triggered_without_source_draft_id(svc, publishes):
    """普通 mode='new' (写新邮件) 不触发替换删除。"""
    _seed_old_draft(svc._ctx.sync_store)
    req = ComposeRequest(
        internal_id=-1, mode="new", to="a@x.com", subject="s",
        body_html="<p>x</p>",
    )
    result = _save(svc, req)
    assert result.replaced_source_draft_id is None
    assert svc._ctx.email_repo.deleted == []


# ---------------------------------------------------------------------------
# D1: 本地镜像带附件 + mirror 回执
# ---------------------------------------------------------------------------


def test_mirror_commits_attachments_and_returns_ids(svc, publishes):
    _seed_old_draft(svc._ctx.sync_store)
    result = _save(
        svc, _draft_edit_request(attachments=[{"attachment_id": 7}])
    )

    assert len(svc._ctx.email_repo.commits) == 1
    commit = svc._ctx.email_repo.commits[0]
    payloads = commit["attachments"]
    assert [p.filename for p in payloads] == ["plan.xlsx"]
    assert payloads[0].content == b"XLSX-BYTES"
    assert payloads[0].is_inline is False
    # mirror 回执: 新行 id + filename → attachment_id 映射 (前端换锚用)
    assert result.mirror_internal_id == commit["internal_id"]
    assert result.mirror_attachment_ids == {"plan.xlsx": 100}
    # 新镜像行是草稿箱行且带 APPEND 回执 uid
    row = svc._ctx.sync_store.get(result.mirror_internal_id)
    assert row["mailbox"] == "草稿箱"
    assert row["imap_uid"] == NEW_UID


def test_mirror_writes_negative_cache_sentinel_for_non_reply_draft(svc, publishes):
    """A2: 镜像行无 threading 头是确定事实 → 直写哨兵 '', 该行再保存不探测。"""
    _seed_old_draft(svc._ctx.sync_store)
    result = _save(svc, _draft_edit_request())
    row = svc._ctx.sync_store.get(result.mirror_internal_id)
    assert row["draft_in_reply_to"] == ""


def test_mirror_inline_payload_and_cid_rewrite(svc, publishes):
    """D2+D1: inline 引用进镜像附件行 (content_id/is_inline), 正文 cid: 引用改写为
    新行本地相对路径 (与 watcher 入库口径一致)。"""
    _seed_old_draft(svc._ctx.sync_store)
    result = _save(
        svc,
        _draft_edit_request(
            attachments=[{"attachment_id": 8}],
            body_html='<p>hi</p><img src="cid:img-cid-1@x">',
        ),
    )
    commit = svc._ctx.email_repo.commits[0]
    inline = [p for p in commit["attachments"] if p.is_inline]
    assert [(p.filename, p.content_id) for p in inline] == [("logo.png", "img-cid-1@x")]
    html = commit["body"].html
    assert f"attachments/{result.mirror_internal_id}/logo.png" in html
    assert "cid:img-cid-1@x" not in html
    assert commit["body"].has_inline_images is True


# ---------------------------------------------------------------------------
# D2: refs 分流 + 出站 MIME 编回
# ---------------------------------------------------------------------------


def test_inline_ref_routes_to_inline_attachments(svc):
    _seed_old_draft(svc._ctx.sync_store)
    req = _draft_edit_request(
        attachments=[{"attachment_id": 7}, {"attachment_id": 8}]
    )
    draft, _, _ = svc._prepare_draft(
        req, allow_missing_reply=False, split_quote=False
    )
    assert [a[0] for a in draft.attachments] == ["plan.xlsx"]
    assert draft.inline_attachments == [
        ("logo.png", b"PNG-BYTES", "image/png", "img-cid-1@x")
    ]


def test_build_outgoing_mime_embeds_only_referenced_inline_parts():
    """正文引用 cid 的部件编回 related part; 未引用的跳过 (不产孤儿 part)。"""
    from email.parser import BytesParser

    from src.mail.backend.sender import build_outgoing_mime
    from src.mail.backend.types import DraftRequest

    class _Cfg:
        user_email = "me@x.com"
        user_name = ""
        attachment_storage_dir = ""

    draft = DraftRequest(
        mode="new", to=["a@x.com"], subject="s",
        reply_text="t",
        reply_html='<p>x</p><img src="cid:ic-1@x">',
        inline_attachments=[
            ("logo.png", b"PNG-A", "image/png", "ic-1@x"),
            ("orphan.png", b"PNG-B", "image/png", "ic-2@x"),
        ],
    )
    msg = BytesParser().parsebytes(build_outgoing_mime(_Cfg(), draft))
    cids = [
        p.get("Content-ID") for p in msg.walk() if p.get("Content-ID")
    ]
    assert cids == ["<ic-1@x>"]
    png_parts = [
        p for p in msg.walk() if p.get_content_type() == "image/png"
    ]
    assert len(png_parts) == 1
    assert png_parts[0].get_payload(decode=True) == b"PNG-A"


# ---------------------------------------------------------------------------
# D3: 附件兜底硬闸
# ---------------------------------------------------------------------------


def test_guard_rejects_missing_attachments_key_when_source_has_attachments(svc):
    _seed_old_draft(svc._ctx.sync_store)
    svc._ctx.email_repo.source_attachments = [
        SimpleNamespace(id=7, filename="plan.xlsx", is_inline=False, derived_from=None),
    ]
    with pytest.raises(ServiceInvalidArgError, match="attachments"):
        _save(svc, _draft_edit_request(attachments=None))


def test_guard_allows_explicit_empty_list(svc, publishes):
    """显式 [] = 用户明确移除全部附件 → 放行。"""
    _seed_old_draft(svc._ctx.sync_store)
    svc._ctx.email_repo.source_attachments = [
        SimpleNamespace(id=7, filename="plan.xlsx", is_inline=False, derived_from=None),
    ]
    result = _save(svc, _draft_edit_request(attachments=[]))
    assert result.replaced_source_draft_id == OLD_DRAFT_IID


def test_guard_ignores_derived_only_rows(svc, publishes):
    """derived 行 (office 预转产物) 不算源附件 — 键省略照常放行。"""
    _seed_old_draft(svc._ctx.sync_store)
    svc._ctx.email_repo.source_attachments = [
        SimpleNamespace(id=9, filename="plan.csv", is_inline=False, derived_from=7),
    ]
    result = _save(svc, _draft_edit_request(attachments=None))
    assert result.replaced_source_draft_id == OLD_DRAFT_IID


def test_guard_noop_when_source_has_no_attachments(svc, publishes):
    _seed_old_draft(svc._ctx.sync_store)
    result = _save(svc, _draft_edit_request(attachments=None))
    assert result.replaced_source_draft_id == OLD_DRAFT_IID

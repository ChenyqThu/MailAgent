"""草稿保存批2 — IMAP APPEND 后台化 (task 08-20 draft-save, 本地优先秒回)。

- 顺序: _prepare_draft → 先 _mirror_draft_locally (无 uid, 'synced') →
  _replace_source_draft → 立即返回; append_draft 挪后台线程。
- 成功: finalize_draft_append 落 uid + 置 pending (watcher 重 fetch 链);
  行已不在 (期间被 replace/删除) → 清刚 APPEND 的远端孤儿 + 墓碑。
- 失败: 行保留 + sync_error「未同步」+ NotifyCenter 系统通知; 重存/删除该行时
  通知 resolve。
- 门控: 仅 defer_append=True (serve-api) + davmail + drafts_sync_enabled;
  其余组合与镜像失败回退同步路径 (CLI 恒同步)。
"""

from __future__ import annotations

import sqlite3
from types import SimpleNamespace

import pytest

import src.services.mail_write as mail_write
from src.mail.backend.types import DraftAppendResult
from src.mail.draft_tombstones import active_uids
from src.mail.sync_store import SyncStore
from src.services.guards import Actor
from src.services.mail_write import ComposeRequest, MailWriteService

OLD_DRAFT_IID = 1_000_000_001
OLD_UID = 42
NEW_UID = 555


class _StubRepo:
    def __init__(self, calls: list):
        self._calls = calls
        self.source_attachments: list = []

    def get_attachments(self, internal_id):
        return self.source_attachments

    def commit_email_with_body(self, internal_id, body, attachments, *, message_id=None):
        self._calls.append("mirror-commit")
        return {}

    def delete_email_full(self, internal_id):
        self._calls.append(f"local-delete:{internal_id}")


class _StubBackend:
    def __init__(self, calls: list, *, ok=True, uid=NEW_UID):
        self._calls = calls
        self.ok = ok
        self.uid = uid
        self.appended: list = []
        self.drafts_folder = "Drafts"

    def append_draft(self, draft):
        self._calls.append("append")
        self.appended.append(draft)
        if not self.ok:
            return DraftAppendResult(
                success=False, drafts_folder="Drafts",
                error="IMAP APPEND failed: boom",
            )
        return DraftAppendResult(
            success=True, drafts_folder="Drafts", appended_uid=self.uid,
            method="imap_append", message_id="ignored-by-deferred@x",
            appended_uidvalidity=1,
        )


class _StubReader:
    def __init__(self):
        self.deleted = []

    def delete_message(self, folder, uid):
        self.deleted.append((folder, uid))
        return True


class _CapturedThread:
    """threading.Thread 替身: start() 只记录不执行 — 证明响应先于 APPEND 返回,
    测试再手动跑 target 驱动后台链。"""

    captured: list = []

    def __init__(self, *, target=None, name=None, daemon=None):
        self._target = target
        self._name = name

    def start(self):
        _CapturedThread.captured.append((self._name, self._target))


def _run_captured(name: str) -> int:
    ran = 0
    for n, target in list(_CapturedThread.captured):
        if n == name:
            target()
            ran += 1
    return ran


@pytest.fixture()
def calls():
    return []


@pytest.fixture()
def svc(tmp_path, monkeypatch, calls):
    service = MailWriteService.__new__(MailWriteService)
    db = str(tmp_path / "t.db")
    ctx = SimpleNamespace(
        config=SimpleNamespace(
            user_email="me@x.com",
            mailagent_backend="davmail",
            drafts_sync_enabled=True,
            sync_store_db_path=db,
        ),
        sync_store=SyncStore(db),
        email_repo=_StubRepo(calls),
        backend=_StubBackend(calls),
    )
    service._ctx = ctx
    reader = _StubReader()
    service._folder_imap_reader = lambda: reader  # type: ignore[method-assign]
    service._reader = reader
    _CapturedThread.captured = []
    monkeypatch.setattr(
        mail_write, "threading", SimpleNamespace(Thread=_CapturedThread)
    )
    return service


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


def _save(svc, request, *, defer=True):
    return svc.compose_draft(
        request,
        actor=Actor(kind="cli", authenticated=True, label="test"),
        defer_append=defer,
    )


def _notifications(db_path):
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute(
            "SELECT category, severity, state, dedupe_key, title FROM notification"
        ).fetchall()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 本地优先顺序 + uid 后置落行
# ---------------------------------------------------------------------------


def test_deferred_returns_before_append_and_lands_uid_later(svc, calls):
    store = svc._ctx.sync_store
    _seed_old_draft(store)

    result = _save(svc, _draft_edit_request())

    # 响应先回: APPEND 未跑 (线程只捕获), uid 不在响应里
    assert "append" not in calls
    assert result.appended_uid is None
    assert result.method == "imap_append_deferred"
    assert result.replaced_source_draft_id == OLD_DRAFT_IID
    # 顺序: 镜像 (commit) 先于 replace (local-delete)
    assert calls.index("mirror-commit") < calls.index(f"local-delete:{OLD_DRAFT_IID}")
    # 镜像行 = 本地真身: 无 uid + 'synced' (不进 watcher 取件轮) + 预分配 message_id
    row = store.get(result.mirror_internal_id)
    assert row["imap_uid"] is None
    assert row["sync_status"] == "synced"
    assert row["message_id"]
    assert row["draft_in_reply_to"] == ""  # A2 哨兵在 deferred 镜像同样落

    # 跑后台 APPEND → 与镜像同 Message-ID 的 MIME 上行, uid 落行 + pending refetch
    assert _run_captured("compose-append-draft") == 1
    draft_sent = svc._ctx.backend.appended[0]
    assert draft_sent.message_id == f"<{row['message_id']}>"
    row2 = store.get(result.mirror_internal_id)
    assert row2["imap_uid"] == NEW_UID
    assert row2["sync_status"] == "pending"
    assert row2["sync_error"] is None


def test_deferred_append_failure_marks_row_and_notifies(svc, calls):
    svc._ctx.backend.ok = False
    store = svc._ctx.sync_store
    _seed_old_draft(store)

    result = _save(svc, _draft_edit_request())
    _run_captured("compose-append-draft")

    # 行保留 (本地即真身) + 「未同步」标记, 不进重试机
    row = store.get(result.mirror_internal_id)
    assert row is not None
    assert row["imap_uid"] is None
    assert row["sync_status"] == "synced"
    assert "未同步" in (row["sync_error"] or "")
    # NotifyCenter 系统通知 (中文落库, warn)
    rows = _notifications(store.db_path)
    assert rows == [
        (
            "system", "warn", "open",
            f"draft_append_failed:{result.mirror_internal_id}",
            "草稿未同步到服务器",
        )
    ]
    # 远端零动作
    assert svc._reader.deleted == []


def test_deferred_success_row_gone_cleans_remote_orphan(svc, calls):
    store = svc._ctx.sync_store
    _seed_old_draft(store)
    result = _save(svc, _draft_edit_request())

    # APPEND 完成前行被删 (第二次保存 replace / 用户删除)
    conn = sqlite3.connect(store.db_path)
    conn.execute(
        "DELETE FROM email_metadata WHERE internal_id = ?",
        (result.mirror_internal_id,),
    )
    conn.commit()
    conn.close()

    _run_captured("compose-append-draft")

    # 刚上去的远端副本是孤儿 → 墓碑 + IMAP 删
    assert NEW_UID in active_uids(store)
    assert ("drafts", NEW_UID) in svc._reader.deleted
    # 不落失败通知 (不是失败)
    assert _notifications(store.db_path) == []


# ---------------------------------------------------------------------------
# 门控与回退
# ---------------------------------------------------------------------------


def test_gate_non_davmail_backend_stays_sync(svc, calls):
    svc._ctx.config.mailagent_backend = "applescript"
    _seed_old_draft(svc._ctx.sync_store)
    result = _save(svc, _draft_edit_request())
    assert "append" in calls  # 同步路径: 返回前已 APPEND
    assert result.appended_uid == NEW_UID
    assert not any(n == "compose-append-draft" for n, _ in _CapturedThread.captured)


def test_gate_drafts_sync_disabled_stays_sync(svc, calls):
    svc._ctx.config.drafts_sync_enabled = False
    _seed_old_draft(svc._ctx.sync_store)
    result = _save(svc, _draft_edit_request())
    assert "append" in calls
    assert result.appended_uid == NEW_UID


def test_cli_default_stays_sync(svc, calls):
    """defer_append 缺省 False (CLI 短命进程, daemon 线程随退出即死)。"""
    _seed_old_draft(svc._ctx.sync_store)
    result = _save(svc, _draft_edit_request(), defer=False)
    assert "append" in calls
    assert result.appended_uid == NEW_UID


def test_deferred_mirror_failure_falls_back_to_sync(svc, calls, monkeypatch):
    _seed_old_draft(svc._ctx.sync_store)
    monkeypatch.setattr(
        svc, "_mirror_draft_locally", lambda draft, result: None
    )
    result = _save(svc, _draft_edit_request())
    # 本地无真身 → 回退同步 APPEND, 响应带 uid
    assert "append" in calls
    assert result.appended_uid == NEW_UID
    assert result.mirror_internal_id is None


# ---------------------------------------------------------------------------
# 无 uid 行的 replace / delete 闭环 (安全前提 #2/#3)
# ---------------------------------------------------------------------------


def test_replace_local_only_deletes_davmail_row_without_uid(svc, calls):
    """异步镜像行 (davmail-origin 无 uid) 被再次保存 → 本地删即替换: 无墓碑
    无远端删, 「未同步」通知 resolve (重试闭环)。"""
    from src.notify.center import NotifyCenter

    store = svc._ctx.sync_store
    _seed_old_draft(store, imap_uid=None)
    NotifyCenter(store.db_path).publish(
        category="system", source="compose", title="草稿未同步到服务器",
        dedupe_key=f"draft_append_failed:{OLD_DRAFT_IID}", severity="warn",
    )

    result = _save(svc, _draft_edit_request())

    assert result.replaced_source_draft_id == OLD_DRAFT_IID
    assert f"local-delete:{OLD_DRAFT_IID}" in calls
    assert OLD_UID not in active_uids(store)  # 无墓碑
    assert svc._reader.deleted == []          # 无远端删
    states = {r[3]: r[2] for r in _notifications(store.db_path)}
    assert states[f"draft_append_failed:{OLD_DRAFT_IID}"] == "resolved"


def test_replace_still_skips_legacy_row_without_uid(svc, calls):
    """AppleScript 存量行 (无 uid 且非 davmail-origin): 仍整体跳过 — 远端有物
    无锚, 删本地必被 reconcile 拉回。"""
    _seed_old_draft(svc._ctx.sync_store, imap_uid=None, backend_origin="applescript")
    result = _save(svc, _draft_edit_request())
    assert result.replaced_source_draft_id is None
    assert f"local-delete:{OLD_DRAFT_IID}" not in calls


def test_delete_draft_local_only_row(svc, calls):
    """失败/待上传草稿 (davmail-origin 无 uid) 的删除按钮: 本地删即删 + 通知
    resolve — 此前这类行删除会 E_INVALID_ARG, 除重存外无法移除。"""
    from src.notify.center import NotifyCenter

    store = svc._ctx.sync_store
    _seed_old_draft(store, imap_uid=None)
    NotifyCenter(store.db_path).publish(
        category="system", source="compose", title="草稿未同步到服务器",
        dedupe_key=f"draft_append_failed:{OLD_DRAFT_IID}", severity="warn",
    )

    result = svc.delete_draft(
        OLD_DRAFT_IID, actor=Actor(kind="cli", authenticated=True, label="test")
    )

    assert result.imap_uid == 0
    assert result.local_deleted is True
    assert f"local-delete:{OLD_DRAFT_IID}" in calls
    assert svc._reader.deleted == []
    states = {r[3]: r[2] for r in _notifications(store.db_path)}
    assert states[f"draft_append_failed:{OLD_DRAFT_IID}"] == "resolved"

"""Compose 优化 epic T7 — codex 交叉 review finding 1/4 修复回归。

- finding 1 (HIGH) 存量草稿 linkage 懒自愈: v36 迁移前的草稿行 draft_* 全 NULL 且
  reconcile 稳态短路永不回填 → source_draft_id 恢复分支消费时按行从 davmail 取草稿
  MIME 头 (复用 fetch_email_content_by_id), 解析/校验后当场使用并回写 draft_* 三列。
  取件失败/无头/applescript backend → 回退现状零派生, 不报错。
- finding 4 (MED) linkage 消费校验: _sanitize_draft_linkage — msg-id 形状规整
  (含 @、无空白/尖括号)、References 逐 token 校验畸形丢弃、拒自引用
  (in_reply_to == 草稿行自己的 message_id); 不合法 → 回退零派生。
"""

from __future__ import annotations

from unittest.mock import MagicMock

from src.mail.sync_store import SyncStore
from src.services.mail_write import (
    ComposeRequest,
    MailWriteService,
    _sanitize_draft_linkage,
)

# ─────────────────────────────────────────────────────────────────────────────
# finding 4: _sanitize_draft_linkage 纯函数
# ─────────────────────────────────────────────────────────────────────────────


def test_sanitize_valid_chain_passes():
    irt, refs = _sanitize_draft_linkage(
        "orig@x", "<head@x> <orig@x>", own_message_id="draft-mid@x"
    )
    assert irt == "orig@x"
    assert refs == "<head@x> <orig@x>"


def test_sanitize_rejects_self_reference():
    """自引用 (in_reply_to == 草稿自己的 message_id) → 数据不一致, 整体拒。"""
    irt, refs = _sanitize_draft_linkage(
        "draft-mid@x", "<head@x> <draft-mid@x>", own_message_id="draft-mid@x"
    )
    assert irt is None
    assert refs is None


def test_sanitize_self_reference_bracket_insensitive():
    """own_message_id 带尖括号也命中自引用判定 (口径归一后比较)。"""
    irt, _ = _sanitize_draft_linkage("mid@x", None, own_message_id="<mid@x>")
    assert irt is None


def test_sanitize_rejects_malformed_in_reply_to():
    for bad in ("", "no-at-sign", "has space@x", "still<bracket@x", "a>b@x"):
        irt, refs = _sanitize_draft_linkage(bad, "<head@x>")
        assert irt is None, f"expected reject for {bad!r}"
        assert refs is None


def test_sanitize_drops_malformed_references_tokens():
    """畸形 token (无 @ / 折行残片) 丢弃, 合法 token 保留并规范化为 <mid> 链。"""
    irt, refs = _sanitize_draft_linkage(
        "orig@x", "<head@x> garbage-no-at <orig@x> =?utf-8?q?frag?="
    )
    assert irt == "orig@x"
    assert refs == "<head@x> <orig@x>"


def test_sanitize_all_references_malformed_gives_none():
    """References 全畸形 → refs=None (调用方按既有口径从 thread_id 派生)。"""
    irt, refs = _sanitize_draft_linkage("orig@x", "junk more-junk")
    assert irt == "orig@x"
    assert refs is None


def test_sanitize_unbracketed_reference_token_kept():
    """裸 msg-id token (无尖括号) 合法则规范化补上尖括号。"""
    _, refs = _sanitize_draft_linkage("orig@x", "head@x orig@x")
    assert refs == "<head@x> <orig@x>"


# ─────────────────────────────────────────────────────────────────────────────
# service fixture
# ─────────────────────────────────────────────────────────────────────────────

DRAFT_IID = 1_000_000_001
DRAFT_MID = "draft-mid@x"

HEALTHY_MIME = (
    f"Message-ID: <{DRAFT_MID}>\r\n"
    "Subject: Re: orig\r\n"
    "In-Reply-To: <orig@x>\r\n"
    "References: <head@x> <orig@x>\r\n"
    "\r\n"
    "body"
)

NO_THREADING_MIME = (
    f"Message-ID: <{DRAFT_MID}>\r\nSubject: standalone\r\n\r\nbody"
)


def _service(tmp_path, *, backend_name="davmail", mime=HEALTHY_MIME):
    svc = MailWriteService.__new__(MailWriteService)
    ctx = MagicMock()
    ctx.sync_store = SyncStore(str(tmp_path / "t.db"))
    ctx.config.user_email = "me@x.com"
    ctx.config.mailagent_backend = backend_name
    ctx.backend.fetch_email_content_by_id = MagicMock(
        return_value={"source": mime} if mime is not None else None
    )
    svc._ctx = ctx
    return svc


def _seed_legacy_draft(store, internal_id=DRAFT_IID, **overrides):
    """v36 迁移前形态: 草稿行存在但 draft_* 三列全 NULL。"""
    row = {
        "internal_id": internal_id,
        "message_id": DRAFT_MID,
        "subject": "Re: orig",
        "sender": "me@x.com",
        "mailbox": "草稿箱",
        "sync_status": "synced",
        "backend_origin": "davmail",
        "imap_uid": 42,
    }
    row.update(overrides)
    store.save_email(row)
    return row["internal_id"]


def _seed_original(store, internal_id=42, message_id="orig@x"):
    store.save_email({
        "internal_id": internal_id, "message_id": message_id, "subject": "orig",
        "sender": "a@x.com", "to_addr": "me@x.com", "mailbox": "收件箱",
        "sync_status": "synced",
    })


def _new_request(source_draft_id):
    return ComposeRequest(
        internal_id=-1, mode="new",
        to="a@x.com", subject="Re: orig",
        body_html="<p>edited</p>",
        source_draft_id=source_draft_id,
    )


def _prepare(svc, iid):
    return svc._prepare_draft(
        _new_request(iid), allow_missing_reply=False, split_quote=False
    )


# ─────────────────────────────────────────────────────────────────────────────
# finding 1: 懒自愈 — 取件成功路
# ─────────────────────────────────────────────────────────────────────────────


def test_selfheal_restores_threading_and_writes_back(tmp_path):
    svc = _service(tmp_path)
    store = svc._ctx.sync_store
    _seed_original(store)
    iid = _seed_legacy_draft(store)

    draft, _, _ = _prepare(svc, iid)

    # 当场使用: threading 头恢复
    assert draft.in_reply_to == "<orig@x>"
    assert draft.references == "<head@x> <orig@x>"
    assert draft.internal_id_for_threading == 42
    svc._ctx.backend.fetch_email_content_by_id.assert_called_once_with(iid)

    # 回写: draft_* 三列 + thread_id 落库
    row = store.get(iid)
    assert row["draft_in_reply_to"] == "orig@x"
    assert row["draft_references"] == "<head@x> <orig@x>"
    assert row["draft_source_internal_id"] == 42
    assert row["thread_id"] == "head@x"


def test_selfheal_second_consume_hits_columns_no_refetch(tmp_path):
    """自愈后再次消费直接命中列, 不再取件 (fetch 只调一次)。"""
    svc = _service(tmp_path)
    _seed_original(svc._ctx.sync_store)
    iid = _seed_legacy_draft(svc._ctx.sync_store)
    _prepare(svc, iid)
    draft, _, _ = _prepare(svc, iid)
    assert draft.in_reply_to == "<orig@x>"
    assert svc._ctx.backend.fetch_email_content_by_id.call_count == 1


def test_selfheal_source_lookup_miss_leaves_none(tmp_path):
    """原邮件行已删 → draft_source_internal_id 留空, threading 头照常恢复。"""
    svc = _service(tmp_path)
    iid = _seed_legacy_draft(svc._ctx.sync_store)  # 不 seed 原邮件行
    draft, _, _ = _prepare(svc, iid)
    assert draft.in_reply_to == "<orig@x>"
    assert draft.internal_id_for_threading is None
    assert svc._ctx.sync_store.get(iid)["draft_source_internal_id"] is None


def test_selfheal_preserves_existing_thread_id(tmp_path):
    """行已有 thread_id (COALESCE 只填空) → 回写不覆写既有线程归属。"""
    svc = _service(tmp_path)
    iid = _seed_legacy_draft(svc._ctx.sync_store, thread_id="existing@x")
    _prepare(svc, iid)
    assert svc._ctx.sync_store.get(iid)["thread_id"] == "existing@x"


# ─────────────────────────────────────────────────────────────────────────────
# finding 1: 懒自愈 — 失败/回退路 (零派生, 不报错)
# ─────────────────────────────────────────────────────────────────────────────


def _assert_zero_derivation(draft):
    assert draft.in_reply_to is None
    assert draft.references is None
    assert draft.internal_id_for_threading is None


def test_selfheal_fetch_returns_none_falls_back(tmp_path):
    svc = _service(tmp_path, mime=None)
    iid = _seed_legacy_draft(svc._ctx.sync_store)
    draft, _, _ = _prepare(svc, iid)
    _assert_zero_derivation(draft)
    assert svc._ctx.sync_store.get(iid)["draft_in_reply_to"] is None  # 未误回写


def test_selfheal_fetch_raises_falls_back(tmp_path):
    svc = _service(tmp_path)
    svc._ctx.backend.fetch_email_content_by_id.side_effect = RuntimeError("imap down")
    iid = _seed_legacy_draft(svc._ctx.sync_store)
    draft, _, _ = _prepare(svc, iid)  # 不抛
    _assert_zero_derivation(draft)


def test_selfheal_mime_without_threading_headers_falls_back(tmp_path):
    """非回复草稿 (MIME 无 In-Reply-To) → 零派生, 不回写。"""
    svc = _service(tmp_path, mime=NO_THREADING_MIME)
    iid = _seed_legacy_draft(svc._ctx.sync_store)
    draft, _, _ = _prepare(svc, iid)
    _assert_zero_derivation(draft)
    assert svc._ctx.sync_store.get(iid)["draft_in_reply_to"] is None


def test_selfheal_skipped_on_applescript_backend(tmp_path):
    """applescript fallback 下不走懒自愈 (无草稿同步语义), 直接回退零派生。"""
    svc = _service(tmp_path, backend_name="applescript")
    iid = _seed_legacy_draft(svc._ctx.sync_store)
    draft, _, _ = _prepare(svc, iid)
    _assert_zero_derivation(draft)
    svc._ctx.backend.fetch_email_content_by_id.assert_not_called()


def test_selfheal_skipped_on_non_draft_row(tmp_path):
    """source_draft_id 指到非草稿箱行 → 不取件不派生 (防误拉任意邮件)。"""
    svc = _service(tmp_path)
    iid = _seed_legacy_draft(svc._ctx.sync_store, mailbox="收件箱")
    draft, _, _ = _prepare(svc, iid)
    _assert_zero_derivation(draft)
    svc._ctx.backend.fetch_email_content_by_id.assert_not_called()


def test_selfheal_self_referencing_mime_rejected(tmp_path):
    """取回的 MIME In-Reply-To 指向草稿自己 → 校验拒, 零派生不回写。"""
    bad_mime = (
        f"Message-ID: <{DRAFT_MID}>\r\n"
        f"In-Reply-To: <{DRAFT_MID}>\r\n"
        "\r\nbody"
    )
    svc = _service(tmp_path, mime=bad_mime)
    iid = _seed_legacy_draft(svc._ctx.sync_store)
    draft, _, _ = _prepare(svc, iid)
    _assert_zero_derivation(draft)
    assert svc._ctx.sync_store.get(iid)["draft_in_reply_to"] is None


# ─────────────────────────────────────────────────────────────────────────────
# finding 4: 消费路校验 (列值已存在但不合法 → 回退零派生)
# ─────────────────────────────────────────────────────────────────────────────


def test_consume_rejects_self_referencing_column(tmp_path):
    svc = _service(tmp_path)
    iid = _seed_legacy_draft(
        svc._ctx.sync_store,
        draft_in_reply_to=DRAFT_MID,  # == 行自己的 message_id
        draft_references=f"<head@x> <{DRAFT_MID}>",
    )
    draft, _, _ = _prepare(svc, iid)
    _assert_zero_derivation(draft)


def test_consume_rejects_malformed_column(tmp_path):
    svc = _service(tmp_path)
    iid = _seed_legacy_draft(
        svc._ctx.sync_store, draft_in_reply_to="not a msgid",
    )
    draft, _, _ = _prepare(svc, iid)
    _assert_zero_derivation(draft)


def test_consume_drops_malformed_reference_tokens(tmp_path):
    svc = _service(tmp_path)
    iid = _seed_legacy_draft(
        svc._ctx.sync_store,
        draft_in_reply_to="orig@x",
        draft_references="<head@x> broken-token <orig@x>",
        draft_source_internal_id=42,
    )
    draft, _, _ = _prepare(svc, iid)
    assert draft.in_reply_to == "<orig@x>"
    assert draft.references == "<head@x> <orig@x>"  # 畸形 token 已滤除


# ─────────────────────────────────────────────────────────────────────────────
# SyncStore.update_draft_linkage (自愈回写原语)
# ─────────────────────────────────────────────────────────────────────────────


def test_update_draft_linkage_writes_columns_and_fills_thread(tmp_path):
    store = SyncStore(str(tmp_path / "t.db"))
    _seed_legacy_draft(store)
    ok = store.update_draft_linkage(
        DRAFT_IID,
        draft_in_reply_to="orig@x",
        draft_references="<head@x> <orig@x>",
        draft_source_internal_id=42,
        thread_id="head@x",
    )
    assert ok
    row = store.get(DRAFT_IID)
    assert row["draft_in_reply_to"] == "orig@x"
    assert row["draft_references"] == "<head@x> <orig@x>"
    assert row["draft_source_internal_id"] == 42
    assert row["thread_id"] == "head@x"


def test_update_draft_linkage_does_not_overwrite_thread(tmp_path):
    store = SyncStore(str(tmp_path / "t.db"))
    _seed_legacy_draft(store, thread_id="existing@x")
    store.update_draft_linkage(
        DRAFT_IID,
        draft_in_reply_to="orig@x",
        draft_references=None,
        draft_source_internal_id=None,
        thread_id="head@x",
    )
    assert store.get(DRAFT_IID)["thread_id"] == "existing@x"  # COALESCE 只填空

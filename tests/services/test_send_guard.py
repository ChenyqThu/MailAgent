"""chat-panel P4 Phase 04b — Python send guard (double-guard) unit tests. Zero LLM, zero network.

Proves the Python half of the outbound-send double guard:
  - the content hash is BYTE-IDENTICAL to the gateway (TS) for the same payload — pinned with the
    same cross-language golden vector the TS suite asserts
    (frontend/tests/ai-gateway/tools/outbound_hash.test.ts);
  - verify_send_approval passes a valid token and rejects every tampering (bad signature, expiry,
    hash mismatch, no secret);
  - SendLedger.reserve is the atomic idempotency guard (a replay raises E_SEND_ALREADY_SENT).
"""
import pytest

from src.services import send_guard


# 🔴 The same vector + golden the gateway TS suite pins. If these diverge, every real send would
# be rejected E_SEND_HASH_MISMATCH (cross-language hash contract).
_VEC = dict(
    to=["  a@x.com ", "b@y.com"],
    cc=["c@z.com"],
    bcc=[],
    subject="Hello 你好",
    body="Body line1\nline2  ",
)
_GOLDEN = "f20307313f87a208e2b8884e93922f4ffa324e6e8b8507f44245f6ff94b97bff"


def test_canonical_and_hash_match_cross_language_golden():
    assert send_guard.canonicalize_outbound(**_VEC) == (
        "v1\na@x.com,b@y.com\nc@z.com\n\nHello 你好\nBody line1\nline2  "
    )
    assert send_guard.hash_outbound(**_VEC) == _GOLDEN


def test_signing_message_format():
    assert send_guard._signing_message("h", "i", 42) == "h.i.42"


def _valid_token(secret, to, cc, bcc, subject, body, idem, expires_at):
    content_hash = send_guard.hash_outbound(to, cc, bcc, subject, body)
    token = send_guard.sign_send_approval_token(secret, content_hash, idem, expires_at)
    return content_hash, token


def test_verify_send_approval_accepts_a_valid_token():
    secret = "shared-local-token"
    to, cc, bcc, subj, body = ["p@corp.test"], [], [], "s", "b"
    expires_at = 2_000
    content_hash, token = _valid_token(secret, to, cc, bcc, subj, body, "idem-1", expires_at)
    # now < expires_at → passes (returns None, does not raise).
    assert (
        send_guard.verify_send_approval(
            token=token,
            content_hash=content_hash,
            idempotency_key="idem-1",
            expires_at=expires_at,
            to=to,
            cc=cc,
            bcc=bcc,
            subject=subj,
            body=body,
            secret=secret,
            now_ms=1_000,
        )
        is None
    )


def test_verify_rejects_no_secret():
    with pytest.raises(send_guard.SendApprovalError) as ei:
        send_guard.verify_send_approval(
            token="t", content_hash="h", idempotency_key="i", expires_at=2,
            to=["a@b.test"], cc=[], bcc=[], subject="s", body="b", secret="", now_ms=1,
        )
    assert ei.value.code == "E_SEND_NO_SECRET"


def test_verify_rejects_forged_signature():
    secret = "real-secret"
    to, cc, bcc, subj, body = ["p@corp.test"], [], [], "s", "b"
    content_hash, _good = _valid_token(secret, to, cc, bcc, subj, body, "idem-1", 2_000)
    with pytest.raises(send_guard.SendApprovalError) as ei:
        send_guard.verify_send_approval(
            token="forged", content_hash=content_hash, idempotency_key="idem-1", expires_at=2_000,
            to=to, cc=cc, bcc=bcc, subject=subj, body=body, secret=secret, now_ms=1_000,
        )
    assert ei.value.code == "E_SEND_BAD_SIGNATURE"


def test_verify_rejects_expired_token():
    secret = "s"
    to, cc, bcc, subj, body = ["p@corp.test"], [], [], "s", "b"
    content_hash, token = _valid_token(secret, to, cc, bcc, subj, body, "idem-1", 1_000)
    with pytest.raises(send_guard.SendApprovalError) as ei:
        send_guard.verify_send_approval(
            token=token, content_hash=content_hash, idempotency_key="idem-1", expires_at=1_000,
            to=to, cc=cc, bcc=bcc, subject=subj, body=body, secret=secret, now_ms=1_001,  # past expiry
        )
    assert ei.value.code == "E_SEND_EXPIRED"


def test_verify_rejects_payload_hash_mismatch():
    """A token signed for one payload cannot send a DIFFERENT payload (content tampering)."""
    secret = "s"
    to, cc, bcc, subj, body = ["p@corp.test"], [], [], "s", "pay 100"
    content_hash, token = _valid_token(secret, to, cc, bcc, subj, body, "idem-1", 2_000)
    with pytest.raises(send_guard.SendApprovalError) as ei:
        send_guard.verify_send_approval(
            token=token, content_hash=content_hash, idempotency_key="idem-1", expires_at=2_000,
            to=to, cc=cc, bcc=bcc, subject=subj, body="pay 900",  # body swapped after signing
            secret=secret, now_ms=1_000,
        )
    assert ei.value.code == "E_SEND_HASH_MISMATCH"


def test_send_ledger_reserve_is_one_shot(tmp_path):
    ledger = send_guard.SendLedger(str(tmp_path / "sync_store.db"))
    assert ledger.is_used("idem-1") is False
    ledger.reserve("idem-1", "hashA", now_ms=1_000)  # first → ok
    assert ledger.is_used("idem-1") is True
    with pytest.raises(send_guard.SendApprovalError) as ei:
        ledger.reserve("idem-1", "hashA", now_ms=1_001)  # replay → rejected
    assert ei.value.code == "E_SEND_ALREADY_SENT"
    # a DIFFERENT key is independent.
    ledger.reserve("idem-2", "hashB", now_ms=1_002)
    assert ledger.is_used("idem-2") is True


def test_send_ledger_mark_sent_records_message_id(tmp_path):
    ledger = send_guard.SendLedger(str(tmp_path / "sync_store.db"))
    ledger.reserve("idem-1", "hashA", now_ms=1_000)
    ledger.mark_sent("idem-1", "<msg-1@corp.test>", now_ms=1_001)  # best-effort, no raise
    assert ledger.is_used("idem-1") is True

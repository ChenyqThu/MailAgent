"""High-risk outbound-send guard — Python half of the double guard (chat-panel P4 Phase 04b).

The AI SDK Gateway's ``email_prepare_send`` tool only fires after a blocking SendApprovalCard +
the gateway-side ApprovalGuard (id / hash / expiry / one-shot idempotency). This module is the
*independent* second layer the serve-api ``POST /email/send-approved`` endpoint runs before any
real SMTP send (phase-04 §6 / architecture §13.10.3):

  1. approval token signature valid  — HMAC-SHA256 keyed by the SHARED per-session local API
     token (``MAILAGENT_LOCAL_API_TOKEN``, main-generated → injected into serve-api's env →
     also the gateway's signing key). No new key distribution; the trust boundary is the
     existing one (only the main process holds it).
  2. token not expired               — the approval's ``expiresAt`` (epoch ms) is in the future.
  3. payload hash matches            — recompute the content hash over the RECEIVED payload and
     compare to the claimed ``contentHash`` (and to the hash inside the signed token). A single
     changed character → mismatch → no send (content integrity across the process boundary).
  4. idempotency not used            — the send ledger (sync_store.db) atomically reserves the
     one-shot key; a replay → ``E_SEND_ALREADY_SENT`` → no double-send.

Only when all pass does the endpoint call ``MailWriteService.send`` for a real send. Any failure
raises ``SendApprovalError`` → the endpoint maps it to an error envelope and the email is NOT sent.

🔴 Cross-language contract: ``canonicalize_outbound`` + ``_signing_message`` MUST produce the
   byte-identical strings the gateway's TS mirrors do
   (``frontend/src/shared/assistant/tools/security/hashOutboundPayload.ts`` +
   ``frontend/src/ai-gateway/security/sendToken.ts``). Any format change is a breaking change:
   bump ``OUTBOUND_CANONICAL_VERSION`` on BOTH sides so an old/new mismatch fails closed.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import sqlite3
import time
from typing import Optional, Sequence

from loguru import logger

# 🔴 Must equal the TS OUTBOUND_CANONICAL_VERSION. Bump on both sides together.
OUTBOUND_CANONICAL_VERSION = "v1"


class SendApprovalError(Exception):
    """A double-guard failure. ``code`` is surfaced to the gateway as the tool-error code
    (the gateway DomainClient reads it from the error envelope)."""

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def _norm_addrs(xs: Optional[Sequence[str]]) -> str:
    """Trim each address, drop empties, KEEP ORDER, join with ',' — mirrors the TS normAddrs."""
    if not xs:
        return ""
    return ",".join(s.strip() for s in xs if isinstance(s, str) and s.strip())


def canonicalize_outbound(
    to: Optional[Sequence[str]],
    cc: Optional[Sequence[str]],
    bcc: Optional[Sequence[str]],
    subject: str,
    body: str,
) -> str:
    """The canonical string both sides hash. Fixed field order, '\\n'-joined, version-prefixed.
    Byte-identical to the TS ``canonicalizeOutbound``."""
    return "\n".join(
        [
            OUTBOUND_CANONICAL_VERSION,
            _norm_addrs(to),
            _norm_addrs(cc),
            _norm_addrs(bcc),
            subject or "",
            body or "",
        ]
    )


def hash_outbound(
    to: Optional[Sequence[str]],
    cc: Optional[Sequence[str]],
    bcc: Optional[Sequence[str]],
    subject: str,
    body: str,
) -> str:
    """sha256 hex of the canonical outbound form (mirrors the gateway's ``hashOutbound``)."""
    return hashlib.sha256(
        canonicalize_outbound(to, cc, bcc, subject, body).encode("utf-8")
    ).hexdigest()


def _signing_message(content_hash: str, idempotency_key: str, expires_at: int) -> str:
    """The exact message the HMAC signs — mirrors TS ``sendApprovalSigningMessage``. expires_at
    is stringified in base-10 (JS ``String(expiresAt)`` for an integer ms timestamp)."""
    return ".".join([content_hash, idempotency_key, str(int(expires_at))])


def sign_send_approval_token(
    secret: str, content_hash: str, idempotency_key: str, expires_at: int
) -> str:
    """HMAC-SHA256 (hex) of the approval envelope (mirrors TS ``signSendApprovalToken``)."""
    return hmac.new(
        secret.encode("utf-8"),
        _signing_message(content_hash, idempotency_key, expires_at).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def get_send_approval_secret() -> str:
    """The shared HMAC key = the per-session local API token (same env auth.py reads). Empty when
    the backend was not spawned by the Electron main (dev / pm2) → the guard fails closed."""
    return os.environ.get("MAILAGENT_LOCAL_API_TOKEN", "").strip()


def verify_send_approval(
    *,
    token: str,
    content_hash: str,
    idempotency_key: str,
    expires_at: int,
    to: Sequence[str],
    cc: Sequence[str],
    bcc: Sequence[str],
    subject: str,
    body: str,
    secret: str,
    now_ms: int,
) -> None:
    """Run the signature + expiry + payload-hash checks. Raises ``SendApprovalError`` on the first
    failure; returns None when all pass (the idempotency ledger check is a separate, stateful step
    so it can reserve atomically). Constant-time compares throughout."""
    if not secret:
        raise SendApprovalError(
            "E_SEND_NO_SECRET",
            "send-approval secret not configured (local API token missing) — cannot verify",
        )
    if not (token and content_hash and idempotency_key):
        raise SendApprovalError(
            "E_SEND_INVALID", "approval token / content hash / idempotency key required"
        )
    expected = sign_send_approval_token(secret, content_hash, idempotency_key, int(expires_at))
    if not hmac.compare_digest(expected, token):
        raise SendApprovalError(
            "E_SEND_BAD_SIGNATURE", "approval token signature is invalid (forged or tampered)"
        )
    if now_ms >= int(expires_at):
        raise SendApprovalError(
            "E_SEND_EXPIRED", "approval token has expired — re-propose the send"
        )
    recomputed = hash_outbound(to, cc, bcc, subject, body)
    if not hmac.compare_digest(recomputed, content_hash):
        raise SendApprovalError(
            "E_SEND_HASH_MISMATCH",
            "outbound payload does not match the approved content hash (content was modified)",
        )


_SEND_LEDGER_DDL = """
CREATE TABLE IF NOT EXISTS send_ledger (
    idempotency_key TEXT PRIMARY KEY,
    content_hash    TEXT NOT NULL,
    reserved_at     INTEGER NOT NULL,
    sent_at         INTEGER,
    message_id      TEXT
)
"""


class SendLedger:
    """Cross-process idempotency for outbound send, backed by a feature-owned table in
    sync_store.db. Created lazily (``CREATE TABLE IF NOT EXISTS``) only when the gated send path
    is exercised — so it adds no schema-version churn for the flag-off-by-default majority.

    ``reserve`` is the atomic check-and-claim (PRIMARY KEY conflict → already used). It runs
    BEFORE the real send so a replay can never double-send; if the send then fails the key stays
    reserved (fail-closed: a retry needs a fresh approval, which carries a fresh key)."""

    def __init__(self, db_path: str) -> None:
        self._db_path = str(db_path)

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=30.0)
        conn.execute(_SEND_LEDGER_DDL)
        return conn

    def reserve(self, idempotency_key: str, content_hash: str, *, now_ms: int) -> None:
        """Atomically claim the idempotency key. Raises ``E_SEND_ALREADY_SENT`` if already used."""
        with self._conn() as conn:
            try:
                conn.execute(
                    "INSERT INTO send_ledger (idempotency_key, content_hash, reserved_at) "
                    "VALUES (?, ?, ?)",
                    (idempotency_key, content_hash, now_ms),
                )
            except sqlite3.IntegrityError as exc:
                raise SendApprovalError(
                    "E_SEND_ALREADY_SENT",
                    "this send was already submitted (idempotency replay) — not re-sending",
                ) from exc

    def mark_sent(self, idempotency_key: str, message_id: Optional[str], *, now_ms: int) -> None:
        """Record the successful send (audit). Best-effort: a missing row (never reserved) is a
        no-op rather than an error. 🔴 This runs AFTER the irreversible send has already happened,
        so a failure here (e.g. a locked DB) must NEVER raise — otherwise the caller would report
        a 500 for an email that actually went out. The reservation already blocks replay; the
        sent_at/message_id is audit-only, so we swallow + log on failure."""
        try:
            with self._conn() as conn:
                conn.execute(
                    "UPDATE send_ledger SET sent_at = ?, message_id = ? WHERE idempotency_key = ?",
                    (now_ms, message_id, idempotency_key),
                )
        except sqlite3.Error as exc:  # post-send audit write — never propagate
            logger.warning(
                "[send-ledger] mark_sent failed for %s (send already succeeded): %s",
                idempotency_key,
                exc,
            )

    def is_used(self, idempotency_key: str) -> bool:
        """Diagnostic / test helper — whether the key has been reserved."""
        with self._conn() as conn:
            row = conn.execute(
                "SELECT 1 FROM send_ledger WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
            return row is not None


def now_ms() -> int:
    """Epoch milliseconds (matches the JS Date.now() the gateway stamped into expiresAt)."""
    return int(time.time() * 1000)

"""chat-panel P4 Phase 04b dogfood — real outbound send through the send-approved double guard.

Exercises the EXACT Python send path the gateway tool drives (src/api/routers/email.py
/send-approved), but in-process so we don't need the app's random local token:
  1. build the outbound payload (to = USER_EMAIL, i.e. send to self) + content hash + idempotency;
  2. sign the approval token with a known secret + run verify_send_approval (the real guard);
  3. reserve idempotency in a TEMP send ledger (so we never touch the running app's sync_store.db);
  4. MailWriteService.send(confirmed=True) → REAL SMTP via davmail → lands in Sent;
  5. prove idempotency: a replay reserve of the same key → E_SEND_ALREADY_SENT.

Run: venv/bin/python scripts/dev/dogfood_send_approved_04b.py
"""
import os
import sys
import tempfile

# A known shared secret for this dogfood (stands in for the per-session local API token).
SECRET = "dogfood-04b-secret"
os.environ.setdefault("MAILAGENT_LOCAL_API_TOKEN", SECRET)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from src.config import Config  # noqa: E402
from src.services.context import ServiceContext  # noqa: E402
from src.services import send_guard  # noqa: E402
from src.services.mail_write import ComposeRequest, MailWriteService  # noqa: E402
from src.services.guards import Actor  # noqa: E402


def main() -> int:
    cfg = Config()
    self_addr = cfg.user_email
    print(f"[dogfood] backend={os.environ.get('MAILAGENT_BACKEND')} send-to-self={self_addr}")

    import time

    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    to = [self_addr]
    cc: list[str] = []
    bcc: list[str] = []
    subject = f"[MailAgent 04b dogfood] send-approved self-test {stamp}"
    body = (
        f"这是 chat-panel Phase 04b 高风险外发（email_prepare_send）的真发自测信。\n"
        f"时间：{stamp}\n\n"
        f"路径：content hash 绑定 → HMAC 审批令牌 → verify_send_approval → send_ledger 幂等 → "
        f"MailWriteService.send（davmail SMTP）。若你收到本信且 Sent 有副本，则真实发送链路通。"
    )

    # ── double-guard materials (what the gateway tool computes) ──────────────
    content_hash = send_guard.hash_outbound(to, cc, bcc, subject, body)
    idem = "dogfood-" + stamp.replace(" ", "_").replace(":", "")
    expires_at = send_guard.now_ms() + 5 * 60 * 1000
    token = send_guard.sign_send_approval_token(SECRET, content_hash, idem, expires_at)
    print(f"[dogfood] content_hash={content_hash[:16]}… idem={idem} token={token[:16]}…")

    # ── guard 1-3: signature + expiry + payload hash (the real verify) ───────
    send_guard.verify_send_approval(
        token=token,
        content_hash=content_hash,
        idempotency_key=idem,
        expires_at=expires_at,
        to=to,
        cc=cc,
        bcc=bcc,
        subject=subject,
        body=body,
        secret=SECRET,
        now_ms=send_guard.now_ms(),
    )
    print("[dogfood] verify_send_approval OK (signature + expiry + payload hash)")

    # ── guard 4: idempotency (TEMP ledger — never touches the app's sync_store.db) ──
    ledger_dir = tempfile.mkdtemp(prefix="dogfood-ledger-")
    ledger = send_guard.SendLedger(os.path.join(ledger_dir, "ledger.db"))
    ledger.reserve(idem, content_hash, now_ms=send_guard.now_ms())
    print("[dogfood] send_ledger reserved idempotency key")

    # ── REAL SEND ────────────────────────────────────────────────────────────
    ctx = ServiceContext(cfg)
    req = ComposeRequest(
        internal_id=-1,
        mode="new",
        to=",".join(to),
        cc=",".join(cc) or None,
        bcc=",".join(bcc) or None,
        subject=subject,
        body_text=body,
    )
    svc = MailWriteService(ctx)
    result = svc.send(
        req,
        actor=Actor(kind="http", authenticated=True, label="dogfood"),
        confirmed=True,
    )
    ledger.mark_sent(idem, result.message_id, now_ms=send_guard.now_ms())
    print(
        f"[dogfood] ✅ SENT: message_id={result.message_id} archived_to_sent={result.archived_to_sent} "
        f"method={result.method} to_count={result.to_count}"
    )

    # ── prove idempotency: a replay of the same key is rejected ──────────────
    try:
        ledger.reserve(idem, content_hash, now_ms=send_guard.now_ms())
        print("[dogfood] ❌ REPLAY WAS NOT REJECTED — idempotency BROKEN")
        return 1
    except send_guard.SendApprovalError as exc:
        assert exc.code == "E_SEND_ALREADY_SENT", exc.code
        print(f"[dogfood] ✅ replay rejected: {exc.code} (idempotency holds — no double send)")

    print("[dogfood] DONE — check your inbox + Sent for the self-test message.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

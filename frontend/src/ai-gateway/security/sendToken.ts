// chat-panel P4 Phase 04b — gateway-side crypto for the outbound-send double guard.
//
// The high-risk send tool (email_prepare_send) binds what the user approved to what is sent
// with a CONTENT HASH + an HMAC APPROVAL TOKEN that the Python serve-api independently
// re-verifies (architecture §13.10.3 / phase-04 §6). This module owns the gateway (Node) half:
//   - sha256hex / hashOutbound — the content hash over the canonical outbound form (the pure,
//     cross-language canonicalization lives in the renderer-safe hashOutboundPayload.ts; this
//     file injects the node:crypto hasher so that module stays crypto-free).
//   - signSendApprovalToken — HMAC-SHA256 over the {contentHash, idempotencyKey, expiresAt}
//     envelope, keyed by the SAME secret Python knows: the per-session local API token
//     (MAILAGENT_LOCAL_API_TOKEN, main-generated → injected into serve-api's env →
//     auth.py / send_guard.py). Reusing that secret means NO new config / key distribution,
//     and the trust boundary is exactly the existing one (only the main process holds it; the
//     renderer never sees it). The Python mirror is src/services/send_guard.py — keep the
//     signing-message format in lock-step.
//
// 🔴 Pure Node (node:crypto only) — no electron / chat_db / ai imports, so the gateway core
//    stays harness-testable and this is directly unit-testable.

import { createHash, createHmac } from 'node:crypto'

import {
  canonicalizeOutbound,
  type OutboundPayload
} from '../../shared/assistant/tools/security/hashOutboundPayload'

/** sha256 hex of a UTF-8 string (the injected hasher for hashOutboundPayload). */
export function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Content hash of the outbound payload (canonical form → sha256). Python recomputes the
 *  identical hex from the received payload; a mismatch means the content was tampered with
 *  between approval and send → the email is NOT sent. */
export function hashOutbound(payload: OutboundPayload): string {
  return sha256hex(canonicalizeOutbound(payload))
}

/** The signed approval envelope (what the HMAC covers). Carried alongside the payload to the
 *  send-approved endpoint; Python rebuilds the signing message and verifies the signature. */
export interface SendApprovalEnvelope {
  contentHash: string
  idempotencyKey: string
  /** epoch ms — the approval expiry (Python rejects an expired token). */
  expiresAt: number
}

/** The exact message the HMAC signs. 🔴 Python (send_guard.py `_signing_message`) MUST build
 *  the identical string. Fixed order, '.'-joined; expiresAt stringified in base-10. */
export function sendApprovalSigningMessage(env: SendApprovalEnvelope): string {
  return [env.contentHash, env.idempotencyKey, String(env.expiresAt)].join('.')
}

/** HMAC-SHA256 (hex) of the approval envelope, keyed by the shared local API token. A forged
 *  or tampered envelope (different content hash / idempotency / expiry) produces a different
 *  signature → Python's constant-time compare fails → no send. */
export function signSendApprovalToken(secret: string, env: SendApprovalEnvelope): string {
  return createHmac('sha256', secret).update(sendApprovalSigningMessage(env), 'utf8').digest('hex')
}

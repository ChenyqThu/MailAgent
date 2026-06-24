// chat-panel P4 Phase 04b — outbound-send content hash + recipient/term safety heuristics.
//
// The high-risk send tool (email_prepare_send) is guarded by a CONTENT HASH that binds what
// the user approved to what is actually sent, verified independently on BOTH sides of the
// gateway↔Python boundary (architecture §13.10.3 / phase-04 §6 "double guard"). For that to
// work, the gateway (Node) and the Python serve-api MUST hash the SAME canonical bytes.
//
// 🔴 Pure TS, ZERO crypto import — so this module is safe to load in the RENDERER (the
//    SendApprovalCard imports the recipient/term heuristics) AND in the gateway core (which
//    injects a node:crypto hasher) AND in tests. The canonical form is a line-delimited string
//    (NOT JSON) deliberately: JSON key ordering / unicode escaping differs subtly between JS
//    `JSON.stringify` and Python `json.dumps`, which would silently break cross-language hash
//    agreement. A fixed-order, newline-joined string hashes byte-identically in both languages.
//    The Python mirror is src/services/send_guard.py `canonicalize_outbound` — keep them in
//    lock-step (any format change is a breaking change: bump CANONICAL_VERSION on both sides).

/** Canonical-form version tag. A change to the field order / normalization MUST bump this on
 *  BOTH sides (here + send_guard.py) so an old gateway and a new Python (or vice-versa) fail
 *  the hash check (fail-closed) rather than sending mismatched content. */
export const OUTBOUND_CANONICAL_VERSION = 'v1' as const

/** The outbound-relevant fields of a send. Only these enter the content hash — transient /
 *  presentational fields (internal_id, mode) do not, so the hash is exactly "what goes out". */
export interface OutboundPayload {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
}

/** Normalize an address list for the canonical form: trim each, drop empties, KEEP ORDER, join
 *  with ",". (Order is preserved because RFC recipient order can matter; we do not sort.) */
function normAddrs(xs: readonly string[] | undefined): string {
  return (xs ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(',')
}

/**
 * The canonical string both sides hash. Fixed field order, newline-delimited, version-prefixed.
 * Recipients are trimmed/compacted; subject + body are taken verbatim (exact content integrity —
 * a single changed character must change the hash). The Python mirror produces the identical
 * bytes for the identical payload.
 */
export function canonicalizeOutbound(payload: OutboundPayload): string {
  return [
    OUTBOUND_CANONICAL_VERSION,
    normAddrs(payload.to),
    normAddrs(payload.cc),
    normAddrs(payload.bcc),
    payload.subject ?? '',
    payload.body ?? ''
  ].join('\n')
}

/**
 * Hash the canonical outbound form. The sha256 hex function is INJECTED (the gateway passes a
 * node:crypto hasher; tests pass one too) so this module stays crypto-free and renderer-safe.
 * The returned hex string is the `contentHash` carried in the approval token + the send-approved
 * request; Python recomputes it from the received payload and rejects a mismatch (no send).
 */
export function hashOutboundPayload(
  payload: OutboundPayload,
  sha256hex: (input: string) => string
): string {
  return sha256hex(canonicalizeOutbound(payload))
}

// ── safety heuristics (SendApprovalCard warnings; pure, no external data required) ──────────

/** Personal / free webmail domains. A recipient on one of these is flagged as "external /
 *  personal" — a genuinely useful "are you sure you want to send outside?" nudge that needs no
 *  org config. NOT a block (the user may legitimately email a personal address); a warning only. */
export const PERSONAL_EMAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'qq.com',
  'foxmail.com',
  '163.com',
  '126.com',
  'sina.com',
  'sohu.com',
  'aol.com',
  'protonmail.com',
  'proton.me'
]

/** Extract the lowercased domain part of an address (after the last `@`), or '' if malformed. */
export function addressDomain(addr: string): string {
  const at = addr.lastIndexOf('@')
  return at >= 0
    ? addr
        .slice(at + 1)
        .trim()
        .toLowerCase()
    : ''
}

/**
 * Recipients (to + cc + bcc) considered "external" — a warning surface on the SendApprovalCard.
 * When `internalDomains` is supplied (the user's own org domain[s]), external = any recipient
 * whose domain is NOT one of them. Otherwise it falls back to the PERSONAL_EMAIL_DOMAINS
 * heuristic (free webmail recipients), so the warning is still useful without org config.
 * Returns the distinct external addresses, order-preserving.
 */
export function detectExternalRecipients(
  payload: Pick<OutboundPayload, 'to' | 'cc' | 'bcc'>,
  internalDomains?: readonly string[]
): string[] {
  const all = [...(payload.to ?? []), ...(payload.cc ?? []), ...(payload.bcc ?? [])]
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const internal = (internalDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)
  const seen = new Set<string>()
  const out: string[] = []
  for (const addr of all) {
    const dom = addressDomain(addr)
    if (!dom) continue
    const isExternal =
      internal.length > 0 ? !internal.includes(dom) : PERSONAL_EMAIL_DOMAINS.includes(dom)
    if (isExternal && !seen.has(addr.toLowerCase())) {
      seen.add(addr.toLowerCase())
      out.push(addr)
    }
  }
  return out
}

/** Sensitive terms whose presence in the subject/body warrants a "double-check before sending"
 *  nudge (credentials / money movement / confidentiality). Matched case-insensitively as
 *  substrings; CJK terms need no word boundary. A warning only — never a block. */
export const SENSITIVE_TERMS: readonly string[] = [
  'password',
  'passcode',
  'credential',
  'wire transfer',
  'bank account',
  'iban',
  'swift',
  'routing number',
  'confidential',
  'ssn',
  'social security',
  '密码',
  '账号',
  '账户',
  '转账',
  '汇款',
  '验证码',
  '机密',
  '保密',
  '银行卡',
  '身份证'
]

/** Distinct sensitive terms found in the subject + body (case-insensitive substring match). */
export function detectSensitiveTerms(payload: Pick<OutboundPayload, 'subject' | 'body'>): string[] {
  const haystack = `${payload.subject ?? ''}\n${payload.body ?? ''}`.toLowerCase()
  const out: string[] = []
  for (const term of SENSITIVE_TERMS) {
    if (haystack.includes(term.toLowerCase())) out.push(term)
  }
  return out
}

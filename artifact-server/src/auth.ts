import type { ArtifactRow, Env } from './types'

const SESSION_COOKIE_NAME = 'canvas_session'
const SESSION_TTL_SEC = 60 * 60 * 24 * 7

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(input: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) return null
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4)
  try {
    const binary = atob(padded)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i)
    }
    return out
  } catch {
    return null
  }
}

export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b))
  ])
  const bytesA = new Uint8Array(digestA)
  const bytesB = new Uint8Array(digestB)
  if ('timingSafeEqual' in crypto.subtle && typeof crypto.subtle.timingSafeEqual === 'function') {
    return crypto.subtle.timingSafeEqual(bytesA, bytesB)
  }
  let diff = 0
  for (let i = 0; i < bytesA.length; i += 1) {
    diff |= bytesA[i] ^ bytesB[i]
  }
  return diff === 0
}

function resolveSessionSecret(env: Env): string | null {
  const raw = env.SESSION_SECRET || env.AGENT_API_TOKEN || env.ADMIN_PASSWORD || ''
  return raw.trim().length > 0 ? raw : null
}

async function signHmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return toBase64Url(new Uint8Array(sig))
}

function parseCookies(headerValue: string | null): Record<string, string> {
  if (!headerValue) return {}
  const out: Record<string, string> = {}
  for (const part of headerValue.split(';')) {
    const eqIdx = part.indexOf('=')
    if (eqIdx <= 0) continue
    const k = part.slice(0, eqIdx).trim()
    const v = part.slice(eqIdx + 1).trim()
    if (k) out[k] = v
  }
  return out
}

export async function verifyAgentBearer(
  request: Request,
  env: Env
): Promise<{ ok: boolean; actor: string }> {
  const expected = env.AGENT_API_TOKEN?.trim()
  if (!expected) return { ok: false, actor: '' }
  const auth = request.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
  if (!match) return { ok: false, actor: '' }
  const presented = match[1].trim()
  if (!presented) return { ok: false, actor: '' }
  const ok = await timingSafeEqualStr(presented, expected)
  return ok ? { ok: true, actor: 'agent' } : { ok: false, actor: '' }
}

export async function verifyAdminPassword(password: string, env: Env): Promise<boolean> {
  const presented = password.trim()
  if (!presented) return false
  const admin = env.ADMIN_PASSWORD?.trim()
  if (admin) {
    return timingSafeEqualStr(presented, admin)
  }
  const fallbackToken = env.AGENT_API_TOKEN?.trim()
  if (fallbackToken) {
    return timingSafeEqualStr(presented, fallbackToken)
  }
  return false
}

export async function createSessionCookie(
  env: Env,
  actor: string,
  opts: { secure?: boolean } = {}
): Promise<string | null> {
  const secret = resolveSessionSecret(env)
  if (!secret) return null
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC
  const payload = toBase64Url(encoder.encode(JSON.stringify({ actor, exp })))
  const sig = await signHmac(secret, payload)
  const parts = [
    `${SESSION_COOKIE_NAME}=${payload}.${sig}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SEC}`
  ]
  if (opts.secure !== false) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookie(opts: { secure?: boolean } = {}): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0']
  if (opts.secure !== false) parts.push('Secure')
  return parts.join('; ')
}

export async function verifySessionCookie(request: Request, env: Env): Promise<string | null> {
  const secret = resolveSessionSecret(env)
  if (!secret) return null
  const cookies = parseCookies(request.headers.get('cookie'))
  const raw = cookies[SESSION_COOKIE_NAME]
  if (!raw) return null
  const dotIdx = raw.indexOf('.')
  if (dotIdx <= 0) return null
  const payloadB64 = raw.slice(0, dotIdx)
  const sigB64 = raw.slice(dotIdx + 1)
  if (!payloadB64 || !sigB64) return null

  const expectedSig = await signHmac(secret, payloadB64)
  if (!(await timingSafeEqualStr(sigB64, expectedSig))) return null

  const payloadBytes = fromBase64Url(payloadB64)
  if (!payloadBytes) return null
  try {
    const parsed = JSON.parse(decoder.decode(payloadBytes)) as {
      actor?: unknown
      exp?: unknown
    }
    if (
      typeof parsed.actor !== 'string' ||
      !parsed.actor ||
      typeof parsed.exp !== 'number' ||
      parsed.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null
    }
    return parsed.actor
  } catch {
    return null
  }
}

export async function verifyOwnerRequest(
  request: Request,
  env: Env
): Promise<{ ok: true; actor: string } | { ok: false }> {
  const bearer = await verifyAgentBearer(request, env)
  if (bearer.ok) return { ok: true, actor: bearer.actor }

  const sessionActor = await verifySessionCookie(request, env)
  if (sessionActor) return { ok: true, actor: sessionActor }

  if (env.ALLOW_CF_ACCESS === 'true') {
    const cfEmail = request.headers.get('cf-access-authenticated-user-email')?.trim()
    if (cfEmail) return { ok: true, actor: cfEmail }
  }

  return { ok: false }
}

export async function canReadArtifact(
  artifact: ArtifactRow,
  request: Request,
  env: Env,
  tokenParam: string | null
): Promise<{ allowed: boolean; isOwner: boolean; actor: string }> {
  const owner = await verifyOwnerRequest(request, env)
  if (owner.ok) {
    return { allowed: true, isOwner: true, actor: owner.actor }
  }
  if (artifact.visibility === 'public') {
    return { allowed: true, isOwner: false, actor: 'guest' }
  }
  if (artifact.visibility === 'unlisted' && tokenParam && tokenParam.trim().length > 0) {
    if (await timingSafeEqualStr(tokenParam.trim(), artifact.share_token)) {
      return { allowed: true, isOwner: false, actor: 'reviewer' }
    }
  }
  return { allowed: false, isOwner: false, actor: '' }
}

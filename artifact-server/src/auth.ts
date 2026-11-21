import {
  getMcpTokenByHash,
  getUserByEmail,
  getUserById,
  toSafeUser,
  touchMcpTokenLastUsed
} from './storage'
import type { AgentAuthResult, ArtifactRow, AuthIdentity, Env, UserRow } from './types'

const SESSION_COOKIE_NAME = 'canvas_session'
const SESSION_TTL_SEC = 60 * 60 * 24 * 7
const PBKDF2_ITERATIONS = 100_000
const PBKDF2_HASH_BYTES = 32

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

export async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(raw))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function generateMcpToken(): Promise<{
  plaintext: string
  prefix: string
  hash: string
}> {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const plaintext = `cas_${toBase64Url(bytes)}`
  const prefix = plaintext.slice(0, 12)
  const hash = await sha256Hex(plaintext)
  return { plaintext, prefix, hash }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    key,
    PBKDF2_HASH_BYTES * 8
  )
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false
  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1_000_000) return false
  const salt = fromBase64Url(parts[2] || '')
  const expected = fromBase64Url(parts[3] || '')
  if (!salt || !expected || expected.length !== PBKDF2_HASH_BYTES) return false

  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256'
    },
    key,
    PBKDF2_HASH_BYTES * 8
  )
  return timingSafeEqualStr(toBase64Url(new Uint8Array(bits)), parts[3] || '')
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

export async function verifyAgentBearer(request: Request, env: Env): Promise<AgentAuthResult> {
  const auth = request.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
  if (!match) return { ok: false }
  const presented = match[1].trim()
  if (!presented) return { ok: false }

  const expected = env.AGENT_API_TOKEN?.trim()
  if (expected && (await timingSafeEqualStr(presented, expected))) {
    return { ok: true, actor: 'agent', isAdmin: true, user: null, tokenId: null }
  }

  const hash = await sha256Hex(presented)
  const tokenRow = await getMcpTokenByHash(env, hash)
  if (!tokenRow || tokenRow.revoked_at !== null) {
    return { ok: false }
  }

  let actor = tokenRow.owner_label || 'member'
  let isAdmin = tokenRow.role_scope === 'admin'
  let safeUser: ReturnType<typeof toSafeUser> | null = null

  if (tokenRow.user_id) {
    const userRow = await getUserById(env, tokenRow.user_id)
    if (!userRow || userRow.disabled) {
      return { ok: false }
    }
    safeUser = toSafeUser(userRow)
    actor = safeUser.display_name || safeUser.email
    isAdmin = safeUser.role === 'admin'
  }

  await touchMcpTokenLastUsed(env, tokenRow.id, tokenRow.last_used_at).catch(() => {})
  return {
    ok: true,
    actor,
    isAdmin,
    user: safeUser,
    tokenId: tokenRow.id
  }
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
  subject: string | Pick<UserRow, 'id' | 'email' | 'display_name' | 'role' | 'pwd_version'>,
  opts: { secure?: boolean } = {}
): Promise<string | null> {
  const secret = resolveSessionSecret(env)
  if (!secret) return null
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC
  const sessionBody =
    typeof subject === 'string'
      ? { v: 1, actor: subject, exp }
      : {
          v: 2,
          uid: subject.id,
          email: subject.email,
          name: subject.display_name,
          role: subject.role,
          pwd_ver: subject.pwd_version,
          exp
        }
  const payload = toBase64Url(encoder.encode(JSON.stringify(sessionBody)))
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

export async function verifyUserSession(request: Request, env: Env): Promise<AuthIdentity | null> {
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
      v?: unknown
      uid?: unknown
      pwd_ver?: unknown
      actor?: unknown
      exp?: unknown
    }
    if (typeof parsed.exp !== 'number' || parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null
    }
    if (parsed.v === 2 && typeof parsed.uid === 'string' && parsed.uid) {
      const user = await getUserById(env, parsed.uid)
      if (!user || user.disabled) return null
      if (typeof parsed.pwd_ver !== 'number' || user.pwd_version !== parsed.pwd_ver) return null
      const safe = toSafeUser(user)
      return {
        actor: safe.display_name || safe.email,
        user: safe,
        role: safe.role,
        isAdmin: safe.role === 'admin',
        isBootstrap: false
      }
    }
    if (typeof parsed.actor === 'string' && parsed.actor) {
      return {
        actor: parsed.actor,
        user: null,
        role: 'bootstrap_admin',
        isAdmin: true,
        isBootstrap: true
      }
    }
    return null
  } catch {
    return null
  }
}

export async function verifySessionCookie(request: Request, env: Env): Promise<string | null> {
  const identity = await verifyUserSession(request, env)
  return identity ? identity.actor : null
}

export async function verifyOwnerRequest(
  request: Request,
  env: Env
): Promise<({ ok: true } & AuthIdentity) | { ok: false }> {
  const bearer = await verifyAgentBearer(request, env)
  if (bearer.ok) {
    return {
      ok: true,
      actor: bearer.actor,
      user: bearer.user,
      role: bearer.user ? bearer.user.role : 'agent',
      isAdmin: bearer.isAdmin,
      isBootstrap: false
    }
  }

  const sessionIdentity = await verifyUserSession(request, env)
  if (sessionIdentity) {
    return { ok: true, ...sessionIdentity }
  }

  if (env.ALLOW_CF_ACCESS === 'true') {
    const cfEmail = request.headers.get('cf-access-authenticated-user-email')?.trim()
    if (cfEmail) {
      const existing = await getUserByEmail(env, cfEmail)
      if (existing) {
        if (existing.disabled) return { ok: false }
        const safe = toSafeUser(existing)
        return {
          ok: true,
          actor: safe.display_name || safe.email,
          user: safe,
          role: safe.role,
          isAdmin: safe.role === 'admin',
          isBootstrap: false
        }
      }
      return {
        ok: true,
        actor: cfEmail,
        user: null,
        role: 'bootstrap_admin',
        isAdmin: true,
        isBootstrap: false
      }
    }
  }

  return { ok: false }
}

export async function verifyAdminRequest(
  request: Request,
  env: Env
): Promise<({ ok: true } & AuthIdentity) | { ok: false; status: 401 | 403 }> {
  const owner = await verifyOwnerRequest(request, env)
  if (!owner.ok) return { ok: false, status: 401 }
  if (!owner.isAdmin) return { ok: false, status: 403 }
  return owner
}

export async function canReadArtifact(
  artifact: ArtifactRow,
  request: Request,
  env: Env,
  tokenParam: string | null
): Promise<{ allowed: boolean; isOwner: boolean; isAdmin: boolean; actor: string }> {
  const owner = await verifyOwnerRequest(request, env)
  if (owner.ok) {
    return { allowed: true, isOwner: true, isAdmin: owner.isAdmin, actor: owner.actor }
  }
  if (artifact.visibility === 'public') {
    return { allowed: true, isOwner: false, isAdmin: false, actor: 'guest' }
  }
  if (artifact.visibility === 'unlisted' && tokenParam && tokenParam.trim().length > 0) {
    if (await timingSafeEqualStr(tokenParam.trim(), artifact.share_token)) {
      return { allowed: true, isOwner: false, isAdmin: false, actor: 'reviewer' }
    }
  }
  return { allowed: false, isOwner: false, isAdmin: false, actor: '' }
}

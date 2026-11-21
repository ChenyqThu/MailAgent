import {
  canReadArtifact,
  clearSessionCookie,
  createSessionCookie,
  verifyAdminPassword,
  verifyAdminRequest,
  verifyOwnerRequest,
  verifyPassword
} from './auth'
import { getBlob } from './blobs'
import { handleMcpRequest } from './mcp'
import {
  ArtifactServerError,
  buildArtifactLinks,
  changeUserPassword,
  createComment,
  createUser,
  deleteArtifact,
  deleteUser,
  getArtifactByShareToken,
  getArtifactBySlug,
  getUserByEmail,
  getVersion,
  guessContentType,
  hasActiveAdminUser,
  listArtifacts,
  listComments,
  listUsers,
  listVersions,
  normalizeSlug,
  resolveBaseUrl,
  resolveComment,
  sanitizeRelativePath,
  setVisibility,
  toSafeUser,
  updateUser
} from './storage'
import type { CommentStatus, Env, UserRole } from './types'
import { renderGalleryPage, renderLoginPage, renderReviewPage, renderSettingsPage } from './ui'

const RAW_SANDBOX_CSP = 'sandbox allow-scripts allow-popups allow-forms allow-modals'

function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders
    }
  })
}

function htmlResponse(html: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders
    }
  })
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ArtifactServerError('E_INVALID_ARG', 'Expected JSON object request body', 400)
    }
    return body as Record<string, unknown>
  } catch (err) {
    if (err instanceof ArtifactServerError) throw err
    throw new ArtifactServerError('E_INVALID_ARG', 'Invalid JSON request body', 400)
  }
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const serverName = env.SERVER_NAME?.trim() || 'Canvas Artifact Server'
  const baseUrl = resolveBaseUrl(request, env)
  const isHttps = url.protocol === 'https:' || baseUrl.startsWith('https://')

  try {
    if (path === '/health' && request.method === 'GET') {
      return jsonResponse({ ok: true, service: 'canvas-artifact-server', version: '1.0.0' })
    }

    if (path === '/mcp') {
      return await handleMcpRequest(request, env)
    }

    // ── Raw versioned artifact serving (opaque sandbox origin + CORS for Vite ESM) ──
    if (path.startsWith('/raw/') && (request.method === 'GET' || request.method === 'HEAD')) {
      const rest = path.slice('/raw/'.length)
      const parts = rest.split('/')
      let pathToken: string | null = null
      let slugPart: string | undefined
      let verPart: string | undefined
      let relParts: string[]
      if (parts[0] === 't' && parts.length >= 5) {
        pathToken = decodeURIComponent(parts[1] || '')
        slugPart = parts[2]
        verPart = parts[3]
        relParts = parts.slice(4)
      } else {
        if (parts.length < 3) {
          return new Response('Not Found', { status: 404 })
        }
        slugPart = parts[0]
        verPart = parts[1]
        relParts = parts.slice(2)
      }
      const slug = normalizeSlug(decodeURIComponent(slugPart || ''))
      const verMatch = /^v(\d+)$/.exec(verPart || '')
      if (!slug || !verMatch || relParts.length === 0) {
        return new Response('Not Found', { status: 404 })
      }
      const versionNum = Number(verMatch[1])
      const relRaw = relParts.map((s) => decodeURIComponent(s)).join('/')
      const relPath = sanitizeRelativePath(relRaw)

      const artifact = await getArtifactBySlug(env, slug)
      if (!artifact) return new Response('Not Found', { status: 404 })

      const tokenParam = pathToken ?? url.searchParams.get('t')
      const access = await canReadArtifact(artifact, request, env, tokenParam)
      if (!access.allowed) {
        return new Response('Forbidden', { status: 403 })
      }

      const key = `artifacts/${artifact.slug}/v${versionNum}/${relPath}`
      const object = await getBlob(env, key)
      if (!object) return new Response('Not Found', { status: 404 })

      const headers = new Headers()
      const contentType = object.contentType || guessContentType(relPath)
      headers.set('content-type', contentType)
      headers.set('content-security-policy', RAW_SANDBOX_CSP)
      headers.set('x-content-type-options', 'nosniff')
      headers.set('access-control-allow-origin', '*')
      headers.set(
        'cache-control',
        artifact.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, no-store'
      )
      return new Response(request.method === 'HEAD' ? null : object.body, {
        status: 200,
        headers
      })
    }

    // ── Auth endpoints & Login UI ──
    if (path === '/login' && request.method === 'GET') {
      const next = url.searchParams.get('next') || '/'
      const hasD1Admin = await hasActiveAdminUser(env)
      return htmlResponse(renderLoginPage(serverName, next, undefined, hasD1Admin))
    }

    if (path === '/api/auth/login' && request.method === 'POST') {
      const body = await readJsonBody(request)
      const email = typeof body.email === 'string' ? body.email.trim() : ''
      const password = typeof body.password === 'string' ? body.password : ''

      if (email) {
        const user = await getUserByEmail(env, email)
        if (!user || user.disabled || !(await verifyPassword(password, user.password_hash))) {
          return jsonResponse({ error: 'Invalid email or password' }, 401)
        }
        const cookie = await createSessionCookie(env, user, { secure: isHttps })
        if (!cookie) {
          return jsonResponse({ error: 'Session secret unavailable on server' }, 500)
        }
        return jsonResponse({ ok: true, user: toSafeUser(user) }, 200, { 'set-cookie': cookie })
      }

      if (await hasActiveAdminUser(env)) {
        return jsonResponse({ error: 'Email and password are required' }, 401)
      }
      const ok = await verifyAdminPassword(password, env)
      if (!ok) {
        return jsonResponse({ error: 'Invalid password' }, 401)
      }
      const cookie = await createSessionCookie(env, 'owner', { secure: isHttps })
      if (!cookie) {
        return jsonResponse({ error: 'Session secret unavailable on server' }, 500)
      }
      return jsonResponse({ ok: true }, 200, { 'set-cookie': cookie })
    }

    if (path === '/api/auth/logout' && request.method === 'POST') {
      return jsonResponse({ ok: true }, 200, { 'set-cookie': clearSessionCookie({ secure: isHttps }) })
    }

    // ── Account & Team Settings UI + Self-Service APIs ──
    if (path === '/settings' && request.method === 'GET') {
      const owner = await verifyOwnerRequest(request, env)
      if (!owner.ok) {
        return Response.redirect(`${baseUrl}/login?next=${encodeURIComponent('/settings')}`, 302)
      }
      const [hasD1Admin, users] = await Promise.all([
        hasActiveAdminUser(env),
        owner.isAdmin ? listUsers(env) : Promise.resolve([])
      ])
      return htmlResponse(
        renderSettingsPage({
          serverName,
          identity: owner,
          users,
          hasD1Admin
        })
      )
    }

    if (path === '/api/me' && request.method === 'GET') {
      const owner = await verifyOwnerRequest(request, env)
      if (!owner.ok) return jsonResponse({ error: 'Unauthorized' }, 401)
      return jsonResponse({
        ok: true,
        actor: owner.actor,
        role: owner.role,
        is_admin: owner.isAdmin,
        is_bootstrap: owner.isBootstrap,
        user: owner.user
      })
    }

    if (path === '/api/account/bootstrap-admin' && request.method === 'POST') {
      const owner = await verifyOwnerRequest(request, env)
      if (!owner.ok) return jsonResponse({ error: 'Unauthorized' }, 401)
      if (!owner.isBootstrap) {
        return jsonResponse({ error: 'Only bootstrap admin sessions can claim the initial D1 admin account' }, 409)
      }
      if (await hasActiveAdminUser(env)) {
        return jsonResponse({ error: 'A D1 admin account already exists' }, 409)
      }
      const body = await readJsonBody(request)
      const email = typeof body.email === 'string' ? body.email : ''
      const displayName = typeof body.display_name === 'string' ? body.display_name : ''
      const newPassword =
        typeof body.new_password === 'string'
          ? body.new_password
          : typeof body.password === 'string'
            ? body.password
            : ''
      const user = await createUser(env, {
        email,
        display_name: displayName,
        role: 'admin',
        password: newPassword
      })
      const cookie = await createSessionCookie(env, user, { secure: isHttps })
      if (!cookie) {
        return jsonResponse({ error: 'Session secret unavailable on server' }, 500)
      }
      return jsonResponse({ ok: true, user: toSafeUser(user) }, 201, { 'set-cookie': cookie })
    }

    if (path === '/api/account/password' && request.method === 'POST') {
      const owner = await verifyOwnerRequest(request, env)
      if (!owner.ok) return jsonResponse({ error: 'Unauthorized' }, 401)
      if (!owner.user) {
        return jsonResponse(
          { error: 'Bootstrap session must first create a personal D1 admin account at /settings' },
          400
        )
      }
      const body = await readJsonBody(request)
      const currentPassword = typeof body.current_password === 'string' ? body.current_password : ''
      const newPassword = typeof body.new_password === 'string' ? body.new_password : ''
      const updated = await changeUserPassword(env, owner.user.id, currentPassword, newPassword)
      const cookie = await createSessionCookie(env, updated, { secure: isHttps })
      if (!cookie) {
        return jsonResponse({ error: 'Session secret unavailable on server' }, 500)
      }
      return jsonResponse({ ok: true, user: toSafeUser(updated) }, 200, { 'set-cookie': cookie })
    }

    // ── Admin Team User Management APIs ──
    if (path === '/api/admin/users' && request.method === 'GET') {
      const admin = await verifyAdminRequest(request, env)
      if (!admin.ok) return jsonResponse({ error: admin.status === 401 ? 'Unauthorized' : 'Forbidden' }, admin.status)
      const users = await listUsers(env)
      return jsonResponse({ users })
    }

    if (path === '/api/admin/users' && request.method === 'POST') {
      const admin = await verifyAdminRequest(request, env)
      if (!admin.ok) return jsonResponse({ error: admin.status === 401 ? 'Unauthorized' : 'Forbidden' }, admin.status)
      const body = await readJsonBody(request)
      const user = await createUser(env, {
        email: typeof body.email === 'string' ? body.email : '',
        display_name: typeof body.display_name === 'string' ? body.display_name : undefined,
        role: typeof body.role === 'string' ? (body.role as UserRole) : 'member',
        password: typeof body.password === 'string' ? body.password : ''
      })
      return jsonResponse({ ok: true, user: toSafeUser(user) }, 201)
    }

    const adminUserMatch = /^\/api\/admin\/users\/([^/]+)$/.exec(path)
    if (adminUserMatch) {
      const admin = await verifyAdminRequest(request, env)
      if (!admin.ok) return jsonResponse({ error: admin.status === 401 ? 'Unauthorized' : 'Forbidden' }, admin.status)
      const targetId = decodeURIComponent(adminUserMatch[1] || '')
      if (request.method === 'PATCH') {
        const body = await readJsonBody(request)
        const user = await updateUser(
          env,
          targetId,
          {
            display_name: typeof body.display_name === 'string' ? body.display_name : undefined,
            role: typeof body.role === 'string' ? (body.role as UserRole) : undefined,
            disabled: typeof body.disabled === 'boolean' ? body.disabled : undefined,
            password: typeof body.password === 'string' ? body.password : undefined
          },
          admin.user?.id
        )
        return jsonResponse({ ok: true, user })
      }
      if (request.method === 'DELETE') {
        const res = await deleteUser(env, targetId, admin.user?.id)
        return jsonResponse({ ok: true, ...res })
      }
    }

    // ── Gallery root ──
    if (path === '/' && request.method === 'GET') {
      const owner = await verifyOwnerRequest(request, env)
      if (!owner.ok) {
        return Response.redirect(`${baseUrl}/login?next=${encodeURIComponent('/')}`, 302)
      }
      const items = await listArtifacts(env, {
        project: url.searchParams.get('project') || undefined,
        artifact_type: url.searchParams.get('type') || undefined,
        query: url.searchParams.get('q') || undefined,
        limit: 100
      })
      return htmlResponse(renderGalleryPage(serverName, baseUrl, items, owner))
    }

    // ── Tokenized share link (/s/:shareToken) ──
    if (path.startsWith('/s/') && request.method === 'GET') {
      const shareToken = decodeURIComponent(path.slice('/s/'.length).split('/')[0] || '')
      const artifact = await getArtifactByShareToken(env, shareToken)
      if (!artifact || artifact.visibility === 'private') {
        const owner = await verifyOwnerRequest(request, env)
        if (!artifact || !owner.ok) {
          return htmlResponse('<h1>404 Not Found</h1>', 404)
        }
      }
      const versions = await listVersions(env, artifact.slug)
      const reqVer = Number(url.searchParams.get('v') || '')
      const targetVer =
        Number.isInteger(reqVer) && reqVer > 0 ? reqVer : Math.max(1, artifact.latest_version)
      const activeVersion =
        versions.find((v) => v.version === targetVer) ??
        versions[0] ??
        (await getVersion(env, artifact.slug, Math.max(1, artifact.latest_version)))
      if (!activeVersion) {
        return htmlResponse('<h1>404 Version Not Found</h1>', 404)
      }
      const comments = await listComments(env, artifact.slug)
      const owner = await verifyOwnerRequest(request, env)
      const links = buildArtifactLinks(baseUrl, artifact, activeVersion.version, activeVersion.entry_path)
      return htmlResponse(
        renderReviewPage({
          serverName,
          artifact,
          versions,
          activeVersion,
          comments,
          links,
          isOwner: owner.ok,
          isAdmin: owner.ok ? owner.isAdmin : false,
          shareToken: owner.ok ? null : artifact.share_token,
          defaultAuthor: owner.ok ? owner.actor : 'Reviewer'
        })
      )
    }

    // ── Review UI (/a/:slug and /a/:slug/v/:version) ──
    if (path.startsWith('/a/') && request.method === 'GET') {
      const parts = path.slice('/a/'.length).split('/').filter(Boolean)
      const slug = decodeURIComponent(parts[0] || '')
      const artifact = await getArtifactBySlug(env, slug)
      if (!artifact) {
        return htmlResponse('<h1>404 Artifact Not Found</h1>', 404)
      }
      const tokenParam = url.searchParams.get('t')
      const access = await canReadArtifact(artifact, request, env, tokenParam)
      if (!access.allowed) {
        return Response.redirect(
          `${baseUrl}/login?next=${encodeURIComponent(path + url.search)}`,
          302
        )
      }
      const versions = await listVersions(env, artifact.slug)
      let reqVer = Math.max(1, artifact.latest_version)
      if (parts[1] === 'v' && parts[2]) {
        const parsed = Number(parts[2])
        if (Number.isInteger(parsed) && parsed > 0) reqVer = parsed
      }
      const activeVersion = versions.find((v) => v.version === reqVer) ?? versions[0]
      if (!activeVersion) {
        return htmlResponse('<h1>404 Version Not Found</h1>', 404)
      }
      const comments = await listComments(env, artifact.slug)
      const links = buildArtifactLinks(baseUrl, artifact, activeVersion.version, activeVersion.entry_path)
      return htmlResponse(
        renderReviewPage({
          serverName,
          artifact,
          versions,
          activeVersion,
          comments,
          links,
          isOwner: access.isOwner,
          isAdmin: access.isAdmin,
          shareToken: access.isOwner ? null : tokenParam,
          defaultAuthor: access.isOwner ? access.actor : 'Reviewer'
        })
      )
    }

    // ── REST API for Gallery / Review UI ──
    if (path === '/api/artifacts' && request.method === 'GET') {
      const owner = await verifyOwnerRequest(request, env)
      if (!owner.ok) return jsonResponse({ error: 'Unauthorized' }, 401)
      const items = await listArtifacts(env, {
        project: url.searchParams.get('project') || undefined,
        artifact_type: url.searchParams.get('type') || undefined,
        query: url.searchParams.get('q') || undefined
      })
      return jsonResponse({ artifacts: items })
    }

    const apiArtifactMatch = /^\/api\/artifacts\/([^/]+)(?:\/(visibility|comments))?(?:\/([^/]+))?$/.exec(
      path
    )
    if (apiArtifactMatch) {
      const slug = decodeURIComponent(apiArtifactMatch[1] || '')
      const sub = apiArtifactMatch[2] || ''
      const subId = apiArtifactMatch[3] ? decodeURIComponent(apiArtifactMatch[3]) : ''

      if (sub === 'visibility' && request.method === 'PATCH' && !subId) {
        const admin = await verifyAdminRequest(request, env)
        if (!admin.ok) return jsonResponse({ error: admin.status === 401 ? 'Unauthorized' : 'Forbidden' }, admin.status)
        const body = await readJsonBody(request)
        const res = await setVisibility(
          env,
          baseUrl,
          slug,
          body.visibility,
          body.rotate_share_token === true
        )
        return jsonResponse({ ok: true, artifact: res.artifact, links: res.links })
      }

      if (sub === 'comments') {
        const artifact = await getArtifactBySlug(env, slug)
        if (!artifact) return jsonResponse({ error: 'Not Found' }, 404)
        const access = await canReadArtifact(artifact, request, env, url.searchParams.get('t'))
        if (!access.allowed) return jsonResponse({ error: 'Forbidden' }, 403)

        if (!subId && request.method === 'GET') {
          const verParam = Number(url.searchParams.get('version') || '')
          const comments = await listComments(env, artifact.slug, {
            version: Number.isInteger(verParam) && verParam > 0 ? verParam : undefined
          })
          return jsonResponse({ comments })
        }
        if (!subId && request.method === 'POST') {
          const body = await readJsonBody(request)
          const comment = await createComment(env, artifact.slug, {
            version: typeof body.version === 'number' ? body.version : undefined,
            author:
              typeof body.author === 'string' && body.author.trim()
                ? body.author.trim()
                : access.isOwner
                  ? access.actor
                  : 'Reviewer',
            body: typeof body.body === 'string' ? body.body : '',
            anchor: typeof body.anchor === 'string' ? body.anchor : null,
            parent_id: typeof body.parent_id === 'string' ? body.parent_id : null
          })
          return jsonResponse({ ok: true, comment }, 201)
        }
        if (subId && request.method === 'PATCH') {
          const body = await readJsonBody(request)
          const status = (typeof body.status === 'string' ? body.status : 'resolved') as CommentStatus
          const comment = await resolveComment(env, artifact.slug, subId, status)
          return jsonResponse({ ok: true, comment })
        }
      }

      if (!sub && !subId) {
        if (request.method === 'GET') {
          const artifact = await getArtifactBySlug(env, slug)
          if (!artifact) return jsonResponse({ error: 'Not Found' }, 404)
          const access = await canReadArtifact(artifact, request, env, url.searchParams.get('t'))
          if (!access.allowed) return jsonResponse({ error: 'Forbidden' }, 403)
          const versions = await listVersions(env, artifact.slug)
          const comments = await listComments(env, artifact.slug)
          const latestVer = versions[0]
          const links = buildArtifactLinks(
            baseUrl,
            artifact,
            Math.max(1, artifact.latest_version),
            latestVer?.entry_path || 'index.html'
          )
          return jsonResponse({ artifact, versions, comments, links })
        }
        if (request.method === 'DELETE') {
          const admin = await verifyAdminRequest(request, env)
          if (!admin.ok) return jsonResponse({ error: admin.status === 401 ? 'Unauthorized' : 'Forbidden' }, admin.status)
          const res = await deleteArtifact(env, slug)
          return jsonResponse(res)
        }
      }
    }

    return jsonResponse({ error: 'Not Found', path }, 404)
  } catch (err) {
    if (err instanceof ArtifactServerError) {
      return jsonResponse({ error: err.message, code: err.code }, err.status)
    }
    const msg = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ event: 'unhandled_error', path, error: msg }))
    return jsonResponse({ error: 'Internal Server Error', code: 'E_INTERNAL' }, 500)
  }
}

export default {
  fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env)
  }
} satisfies ExportedHandler<Env>

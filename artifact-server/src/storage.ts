import { deleteBlobPrefix, putBlob } from './blobs'
import {
  ARTIFACT_TYPES,
  ARTIFACT_VISIBILITIES,
  ArtifactServerError,
  COMMENT_STATUSES,
  type ArtifactFileInput,
  type ArtifactLinks,
  type ArtifactListItem,
  type ArtifactRow,
  type ArtifactType,
  type ArtifactVisibility,
  type CommentRow,
  type CommentStatus,
  type Env,
  type PublishArtifactInput,
  type PublishArtifactResult,
  type VersionRow
} from './types'

export { ArtifactServerError }

const SLUG_MAX_LEN = 64
const MAX_FILES_PER_PUBLISH = 100
const MAX_TOTAL_BYTES = 10 * 1024 * 1024 // 10 MiB

const encoder = new TextEncoder()

export function resolveBaseUrl(request: Request, env: Env): string {
  const configured = env.PUBLIC_BASE_URL?.trim()
  if (configured && /^https?:\/\//i.test(configured)) {
    return configured.replace(/\/+$/, '')
  }
  return new URL(request.url).origin.replace(/\/+$/, '')
}

export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN)
}

export function sanitizeRelativePath(raw: string): string {
  const trimmed = raw.trim().replace(/^\.\//, '')
  if (!trimmed || trimmed.length > 240) {
    throw new ArtifactServerError('E_INVALID_ARG', `Invalid file path: ${JSON.stringify(raw)}`, 400)
  }
  if (trimmed.startsWith('/') || trimmed.includes('\\') || /[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new ArtifactServerError('E_INVALID_ARG', `Unsafe file path: ${JSON.stringify(raw)}`, 400)
  }
  const segments = trimmed.split('/')
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw new ArtifactServerError('E_INVALID_ARG', `Invalid path segment in ${JSON.stringify(raw)}`, 400)
    }
  }
  return segments.join('/')
}

export function guessContentType(path: string): string {
  const lower = path.toLowerCase()
  const extIdx = lower.lastIndexOf('.')
  const ext = extIdx >= 0 ? lower.slice(extIdx) : ''
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8'
    case '.svg':
      return 'image/svg+xml; charset=utf-8'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.ico':
      return 'image/x-icon'
    case '.woff2':
      return 'font/woff2'
    case '.woff':
      return 'font/woff'
    case '.ttf':
      return 'font/ttf'
    case '.txt':
    case '.csv':
      return 'text/plain; charset=utf-8'
    case '.md':
      return 'text/markdown; charset=utf-8'
    case '.xml':
      return 'application/xml; charset=utf-8'
    case '.wasm':
      return 'application/wasm'
    case '.pdf':
      return 'application/pdf'
    case '.mp4':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    default:
      return 'application/octet-stream'
  }
}

export function randomShareToken(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i])
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function decodeBase64(b64: string): Uint8Array {
  try {
    const cleaned = b64.replace(/\s+/g, '')
    const bin = atob(cleaned)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i)
    }
    return out
  } catch {
    throw new ArtifactServerError('E_INVALID_ARG', 'Invalid base64 content payload', 400)
  }
}

function validateArtifactType(raw: unknown): ArtifactType {
  if (raw === undefined || raw === null) return 'app'
  if (typeof raw === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(raw)) {
    return raw as ArtifactType
  }
  throw new ArtifactServerError(
    'E_INVALID_ARG',
    `artifact_type must be one of: ${ARTIFACT_TYPES.join(', ')}`,
    400
  )
}

export function validateVisibility(raw: unknown): ArtifactVisibility {
  if (typeof raw === 'string' && (ARTIFACT_VISIBILITIES as readonly string[]).includes(raw)) {
    return raw as ArtifactVisibility
  }
  throw new ArtifactServerError(
    'E_INVALID_ARG',
    `visibility must be one of: ${ARTIFACT_VISIBILITIES.join(', ')}`,
    400
  )
}

export function buildArtifactLinks(
  baseUrl: string,
  artifact: Pick<ArtifactRow, 'slug' | 'visibility' | 'share_token'>,
  version: number,
  entryPath: string
): ArtifactLinks {
  const base = baseUrl.replace(/\/+$/, '')
  const encodedSlug = encodeURIComponent(artifact.slug)
  const encodedEntry = entryPath
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/')
  const tokenQuery = artifact.visibility === 'unlisted' ? `?t=${encodeURIComponent(artifact.share_token)}` : ''
  const versionUrl = `${base}/a/${encodedSlug}/v/${version}${tokenQuery}`
  const artifactUrl = `${base}/a/${encodedSlug}${tokenQuery}`
  const shareUrl =
    artifact.visibility === 'public'
      ? `${base}/a/${encodedSlug}/v/${version}`
      : `${base}/s/${encodeURIComponent(artifact.share_token)}?v=${version}`
  const rawUrl =
    artifact.visibility === 'unlisted'
      ? `${base}/raw/t/${encodeURIComponent(artifact.share_token)}/${encodedSlug}/v${version}/${encodedEntry}`
      : `${base}/raw/${encodedSlug}/v${version}/${encodedEntry}`
  return {
    review_url: versionUrl,
    share_url: shareUrl,
    raw_url: rawUrl,
    artifact_url: artifactUrl
  }
}

interface NormalizedUploadFile {
  path: string
  bytes: Uint8Array
  contentType: string
}

function prepareUploadFiles(input: PublishArtifactInput): {
  entryPath: string
  files: NormalizedUploadFile[]
  totalBytes: number
} {
  const hasFiles = Array.isArray(input.files) && input.files.length > 0
  if (hasFiles) {
    const rawFiles = input.files as ArtifactFileInput[]
    if (rawFiles.length > MAX_FILES_PER_PUBLISH) {
      throw new ArtifactServerError(
        'E_PAYLOAD_TOO_LARGE',
        `Too many files in bundle (max ${MAX_FILES_PER_PUBLISH})`,
        413
      )
    }
    const seen = new Set<string>()
    const normalized: NormalizedUploadFile[] = []
    let totalBytes = 0
    for (const file of rawFiles) {
      if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
        throw new ArtifactServerError('E_INVALID_ARG', 'Each file must include string path and content', 400)
      }
      const rel = sanitizeRelativePath(file.path)
      if (seen.has(rel)) {
        throw new ArtifactServerError('E_INVALID_ARG', `Duplicate file path: ${rel}`, 400)
      }
      seen.add(rel)
      const bytes = file.encoding === 'base64' ? decodeBase64(file.content) : encoder.encode(file.content)
      totalBytes += bytes.byteLength
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new ArtifactServerError(
          'E_PAYLOAD_TOO_LARGE',
          `Total bundle size exceeds ${MAX_TOTAL_BYTES} bytes`,
          413
        )
      }
      const contentType = file.content_type?.trim() || guessContentType(rel)
      normalized.push({ path: rel, bytes, contentType })
    }
    const entryPath = sanitizeRelativePath(input.entry_path?.trim() || 'index.html')
    if (!seen.has(entryPath)) {
      throw new ArtifactServerError(
        'E_INVALID_ARG',
        `entry_path ${JSON.stringify(entryPath)} must exist in uploaded files`,
        400
      )
    }
    normalized.sort((a, b) => a.path.localeCompare(b.path))
    return { entryPath, files: normalized, totalBytes }
  }

  if (typeof input.html !== 'string' || input.html.trim().length === 0) {
    throw new ArtifactServerError('E_INVALID_ARG', 'Provide either non-empty html or files array', 400)
  }
  const bytes = encoder.encode(input.html)
  if (bytes.byteLength > MAX_TOTAL_BYTES) {
    throw new ArtifactServerError('E_PAYLOAD_TOO_LARGE', `HTML exceeds ${MAX_TOTAL_BYTES} bytes`, 413)
  }
  const entryPath = sanitizeRelativePath(input.entry_path?.trim() || 'index.html')
  return {
    entryPath,
    files: [{ path: entryPath, bytes, contentType: guessContentType(entryPath) }],
    totalBytes: bytes.byteLength
  }
}

async function computeBundleSha256(files: NormalizedUploadFile[]): Promise<string> {
  let manifest = ''
  for (const file of files) {
    const fileDigest = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', file.bytes)))
    manifest += `${file.path}:${file.bytes.byteLength}:${fileDigest}\n`
  }
  const rootDigest = await crypto.subtle.digest('SHA-256', encoder.encode(manifest))
  return bytesToHex(new Uint8Array(rootDigest))
}

export async function getArtifactBySlug(env: Env, slug: string): Promise<ArtifactRow | null> {
  const normalized = normalizeSlug(slug)
  if (!normalized) return null
  return env.DB.prepare(
    `SELECT slug, title, artifact_type, project, visibility, share_token, latest_version, created_at, updated_at
     FROM artifacts WHERE slug = ?`
  )
    .bind(normalized)
    .first<ArtifactRow>()
}

export async function getArtifactByShareToken(env: Env, shareToken: string): Promise<ArtifactRow | null> {
  const token = shareToken.trim()
  if (!token) return null
  return env.DB.prepare(
    `SELECT slug, title, artifact_type, project, visibility, share_token, latest_version, created_at, updated_at
     FROM artifacts WHERE share_token = ?`
  )
    .bind(token)
    .first<ArtifactRow>()
}

export async function listArtifacts(
  env: Env,
  opts: { project?: string; artifact_type?: string; query?: string; limit?: number } = {}
): Promise<ArtifactListItem[]> {
  const where: string[] = []
  const bindings: unknown[] = []
  if (opts.project && opts.project.trim()) {
    where.push('a.project = ?')
    bindings.push(opts.project.trim())
  }
  if (opts.artifact_type && opts.artifact_type.trim()) {
    where.push('a.artifact_type = ?')
    bindings.push(opts.artifact_type.trim())
  }
  if (opts.query && opts.query.trim()) {
    const escaped = `%${opts.query.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%`
    where.push("(LOWER(a.slug) LIKE ? ESCAPE '\\' OR LOWER(a.title) LIKE ? ESCAPE '\\')")
    bindings.push(escaped, escaped)
  }
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 50)))
  bindings.push(limit)

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const sql = `
    SELECT
      a.slug,
      a.title,
      a.artifact_type,
      a.project,
      a.visibility,
      a.share_token,
      a.latest_version,
      a.created_at,
      a.updated_at,
      COALESCE(SUM(CASE WHEN c.status = 'open' THEN 1 ELSE 0 END), 0) AS open_comment_count,
      COUNT(c.id) AS total_comment_count
    FROM artifacts a
    LEFT JOIN artifact_comments c ON c.slug = a.slug
    ${whereSql}
    GROUP BY a.slug
    ORDER BY a.updated_at DESC
    LIMIT ?
  `
  const res = await env.DB.prepare(sql).bind(...bindings).all<ArtifactListItem>()
  return res.results ?? []
}

export async function listVersions(env: Env, slug: string): Promise<VersionRow[]> {
  const normalized = normalizeSlug(slug)
  if (!normalized) return []
  const res = await env.DB.prepare(
    `SELECT id, slug, version, entry_path, r2_prefix, file_count, size_bytes, sha256, change_note, created_by, created_at
     FROM artifact_versions
     WHERE slug = ?
     ORDER BY version DESC`
  )
    .bind(normalized)
    .all<VersionRow>()
  return res.results ?? []
}

export async function getVersion(env: Env, slug: string, version: number): Promise<VersionRow | null> {
  const normalized = normalizeSlug(slug)
  if (!normalized || !Number.isInteger(version) || version < 1) return null
  return env.DB.prepare(
    `SELECT id, slug, version, entry_path, r2_prefix, file_count, size_bytes, sha256, change_note, created_by, created_at
     FROM artifact_versions
     WHERE slug = ? AND version = ?`
  )
    .bind(normalized, version)
    .first<VersionRow>()
}

export async function publishArtifact(
  env: Env,
  baseUrl: string,
  input: PublishArtifactInput
): Promise<PublishArtifactResult> {
  const slug = normalizeSlug(input.slug || '')
  if (!slug) {
    throw new ArtifactServerError('E_INVALID_ARG', 'slug must contain ASCII letters or digits', 400)
  }

  const prepared = prepareUploadFiles(input)
  const sha256 = await computeBundleSha256(prepared.files)
  const now = Math.floor(Date.now() / 1000)

  let existing = await getArtifactBySlug(env, slug)
  const artifactType =
    input.artifact_type !== undefined
      ? validateArtifactType(input.artifact_type)
      : existing?.artifact_type ?? 'app'
  const title = input.title?.trim() || existing?.title || slug
  const project = input.project?.trim() || existing?.project || 'default'
  const visibility =
    input.visibility !== undefined
      ? validateVisibility(input.visibility)
      : existing?.visibility ?? 'unlisted'
  const createdBy = input.created_by?.trim() || 'agent'
  const changeNote = input.change_note?.trim() || null

  if (!existing) {
    const shareToken = randomShareToken()
    await env.DB.prepare(
      `INSERT OR IGNORE INTO artifacts
       (slug, title, artifact_type, project, visibility, share_token, latest_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
      .bind(slug, title, artifactType, project, visibility, shareToken, now, now)
      .run()
    existing = await getArtifactBySlug(env, slug)
    if (!existing) {
      throw new ArtifactServerError('E_INTERNAL', 'Failed to initialize artifact record', 500)
    }
  }

  let targetVersion = Math.max(0, existing.latest_version) + 1
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const r2Prefix = `artifacts/${slug}/v${targetVersion}`
    await Promise.all(
      prepared.files.map((file) => putBlob(env, `${r2Prefix}/${file.path}`, file.bytes, file.contentType))
    )

    try {
      await env.DB.prepare(
        `INSERT INTO artifact_versions
         (slug, version, entry_path, r2_prefix, file_count, size_bytes, sha256, change_note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          slug,
          targetVersion,
          prepared.entryPath,
          r2Prefix,
          prepared.files.length,
          prepared.totalBytes,
          sha256,
          changeNote,
          createdBy,
          now
        )
        .run()

      await env.DB.prepare(
        `UPDATE artifacts
         SET title = ?, artifact_type = ?, project = ?, visibility = ?,
             latest_version = MAX(latest_version, ?), updated_at = ?
         WHERE slug = ?`
      )
        .bind(title, artifactType, project, visibility, targetVersion, now, slug)
        .run()

      const updated = await getArtifactBySlug(env, slug)
      const links = buildArtifactLinks(
        baseUrl,
        updated ?? existing,
        targetVersion,
        prepared.entryPath
      )
      return {
        ok: true,
        slug,
        title,
        artifact_type: artifactType,
        project,
        visibility,
        version: targetVersion,
        entry_path: prepared.entryPath,
        file_count: prepared.files.length,
        size_bytes: prepared.totalBytes,
        sha256,
        links,
        review_url: links.review_url,
        share_url: links.share_url,
        raw_url: links.raw_url
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt === 0 && /unique|constraint/i.test(msg)) {
        const refreshed = await getArtifactBySlug(env, slug)
        targetVersion = Math.max(targetVersion + 1, (refreshed?.latest_version ?? 0) + 1)
        continue
      }
      throw err
    }
  }

  throw new ArtifactServerError('E_CONFLICT', 'Version conflict while publishing artifact', 409)
}

export async function setVisibility(
  env: Env,
  baseUrl: string,
  slug: string,
  visibilityRaw: unknown,
  rotateShareToken = false
): Promise<{ artifact: ArtifactRow; links: ArtifactLinks }> {
  const existing = await getArtifactBySlug(env, slug)
  if (!existing) {
    throw new ArtifactServerError('E_NOT_FOUND', `Artifact not found: ${slug}`, 404)
  }
  const visibility = validateVisibility(visibilityRaw)
  const shareToken = rotateShareToken ? randomShareToken() : existing.share_token
  const now = Math.floor(Date.now() / 1000)

  await env.DB.prepare(
    `UPDATE artifacts SET visibility = ?, share_token = ?, updated_at = ? WHERE slug = ?`
  )
    .bind(visibility, shareToken, now, existing.slug)
    .run()

  const updated = (await getArtifactBySlug(env, existing.slug)) ?? {
    ...existing,
    visibility,
    share_token: shareToken,
    updated_at: now
  }
  const ver = await getVersion(env, updated.slug, Math.max(1, updated.latest_version))
  const links = buildArtifactLinks(
    baseUrl,
    updated,
    Math.max(1, updated.latest_version),
    ver?.entry_path || 'index.html'
  )
  return { artifact: updated, links }
}

export async function deleteArtifact(env: Env, slug: string): Promise<{ deleted: true; objects_removed: number }> {
  const existing = await getArtifactBySlug(env, slug)
  if (!existing) {
    throw new ArtifactServerError('E_NOT_FOUND', `Artifact not found: ${slug}`, 404)
  }
  const objectsRemoved = await deleteBlobPrefix(env, `artifacts/${existing.slug}/`)

  await env.DB.prepare('DELETE FROM artifact_comments WHERE slug = ?').bind(existing.slug).run()
  await env.DB.prepare('DELETE FROM artifact_versions WHERE slug = ?').bind(existing.slug).run()
  await env.DB.prepare('DELETE FROM artifacts WHERE slug = ?').bind(existing.slug).run()
  return { deleted: true, objects_removed: objectsRemoved }
}

export async function listComments(
  env: Env,
  slug: string,
  opts: { version?: number; status?: CommentStatus } = {}
): Promise<CommentRow[]> {
  const existing = await getArtifactBySlug(env, slug)
  if (!existing) {
    throw new ArtifactServerError('E_NOT_FOUND', `Artifact not found: ${slug}`, 404)
  }
  const where = ['slug = ?']
  const bindings: unknown[] = [existing.slug]
  if (opts.version !== undefined && Number.isInteger(opts.version) && opts.version > 0) {
    where.push('version = ?')
    bindings.push(opts.version)
  }
  if (opts.status !== undefined) {
    if (!(COMMENT_STATUSES as readonly string[]).includes(opts.status)) {
      throw new ArtifactServerError('E_INVALID_ARG', 'status must be open or resolved', 400)
    }
    where.push('status = ?')
    bindings.push(opts.status)
  }
  const res = await env.DB.prepare(
    `SELECT id, slug, version, author, body, anchor, status, parent_id, created_at, updated_at
     FROM artifact_comments
     WHERE ${where.join(' AND ')}
     ORDER BY created_at ASC`
  )
    .bind(...bindings)
    .all<CommentRow>()
  return res.results ?? []
}

export async function createComment(
  env: Env,
  slug: string,
  input: {
    version?: number
    author?: string
    body: string
    anchor?: string | null
    parent_id?: string | null
  }
): Promise<CommentRow> {
  const existing = await getArtifactBySlug(env, slug)
  if (!existing) {
    throw new ArtifactServerError('E_NOT_FOUND', `Artifact not found: ${slug}`, 404)
  }
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (!body || body.length > 4000) {
    throw new ArtifactServerError('E_INVALID_ARG', 'Comment body must be 1..4000 characters', 400)
  }
  const version =
    input.version !== undefined && Number.isInteger(input.version) && input.version > 0
      ? input.version
      : Math.max(1, existing.latest_version)
  const author = (input.author?.trim() || 'Reviewer').slice(0, 80)
  const anchor = input.anchor?.trim() ? input.anchor.trim().slice(0, 200) : null
  const parentId = input.parent_id?.trim() || null
  const id = `cmt_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  const now = Math.floor(Date.now() / 1000)

  await env.DB.prepare(
    `INSERT INTO artifact_comments (id, slug, version, author, body, anchor, status, parent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
  )
    .bind(id, existing.slug, version, author, body, anchor, parentId, now, now)
    .run()

  return {
    id,
    slug: existing.slug,
    version,
    author,
    body,
    anchor,
    status: 'open',
    parent_id: parentId,
    created_at: now,
    updated_at: now
  }
}

export async function resolveComment(
  env: Env,
  slug: string,
  commentId: string,
  status: CommentStatus = 'resolved'
): Promise<CommentRow> {
  if (!(COMMENT_STATUSES as readonly string[]).includes(status)) {
    throw new ArtifactServerError('E_INVALID_ARG', 'status must be open or resolved', 400)
  }
  const normalized = normalizeSlug(slug)
  const existing = await env.DB.prepare(
    `SELECT id, slug, version, author, body, anchor, status, parent_id, created_at, updated_at
     FROM artifact_comments
     WHERE slug = ? AND id = ?`
  )
    .bind(normalized, commentId)
    .first<CommentRow>()
  if (!existing) {
    throw new ArtifactServerError('E_NOT_FOUND', `Comment not found: ${commentId}`, 404)
  }
  const now = Math.floor(Date.now() / 1000)
  await env.DB.prepare(`UPDATE artifact_comments SET status = ?, updated_at = ? WHERE slug = ? AND id = ?`)
    .bind(status, now, normalized, commentId)
    .run()
  return { ...existing, status, updated_at: now }
}

import { describe, expect, it } from 'vitest'

import { handleRequest } from '../src/index'
import type {
  ArtifactRow,
  ArtifactType,
  ArtifactVisibility,
  CommentRow,
  CommentStatus,
  Env,
  VersionRow
} from '../src/types'

class MemoryR2Bucket {
  readonly objects = new Map<string, { body: Uint8Array; httpMetadata?: R2HTTPMetadata }>()

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string | ReadableStream | null,
    options?: R2PutOptions
  ): Promise<R2Object> {
    let bytes: Uint8Array
    if (value instanceof Uint8Array) {
      bytes = value
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value)
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    } else if (typeof value === 'string') {
      bytes = new TextEncoder().encode(value)
    } else {
      bytes = new Uint8Array()
    }
    this.objects.set(key, {
      body: bytes,
      httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined
    })
    return {
      key,
      size: bytes.byteLength
    } as unknown as R2Object
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const entry = this.objects.get(key)
    if (!entry) return null
    const copy = new Uint8Array(entry.body)
    return {
      key,
      size: copy.byteLength,
      httpMetadata: entry.httpMetadata ?? {},
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(copy)
          controller.close()
        }
      }),
      arrayBuffer: async () => copy.buffer,
      text: async () => new TextDecoder().decode(copy)
    } as unknown as R2ObjectBody
  }

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? ''
    const matched = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((key) => ({ key, size: this.objects.get(key)?.body.byteLength ?? 0 }) as unknown as R2Object)
    return {
      objects: matched,
      truncated: false,
      delimitedPrefixes: []
    } as unknown as R2Objects
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys]
    for (const k of list) {
      this.objects.delete(k)
    }
  }
}

class MemoryKVNamespace {
  readonly entries = new Map<string, { value: Uint8Array; metadata?: Record<string, unknown> }>()

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions
  ): Promise<void> {
    let bytes: Uint8Array
    if (value instanceof Uint8Array) {
      bytes = value
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value)
    } else if (ArrayBuffer.isView(value)) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    } else if (typeof value === 'string') {
      bytes = new TextEncoder().encode(value)
    } else {
      bytes = new Uint8Array()
    }
    this.entries.set(key, {
      value: bytes,
      metadata: options?.metadata as Record<string, unknown> | undefined
    })
  }

  async getWithMetadata<M = unknown>(
    key: string,
    _type: 'stream'
  ): Promise<{ value: ReadableStream<Uint8Array> | null; metadata: M | null }> {
    const row = this.entries.get(key)
    if (!row) return { value: null, metadata: null }
    const copy = new Uint8Array(row.value)
    return {
      value: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(copy)
          controller.close()
        }
      }),
      metadata: (row.metadata ?? null) as M | null
    }
  }

  async list(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult<unknown>> {
    const prefix = options?.prefix ?? ''
    const keys = [...this.entries.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((name) => ({ name }))
    return { keys, list_complete: true, cacheStatus: null }
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }
}

class MemoryD1Database {
  artifacts = new Map<string, ArtifactRow>()
  versions: VersionRow[] = []
  comments: CommentRow[] = []
  nextVersionId = 1

  prepare(sqlRaw: string): D1PreparedStatement {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim()
    let args: unknown[] = []
    const db = this

    const stmt = {
      bind(...values: unknown[]) {
        args = values
        return stmt
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        if (sql.includes('FROM artifacts WHERE slug = ?')) {
          return (db.artifacts.get(String(args[0])) ?? null) as unknown as T | null
        }
        if (sql.includes('FROM artifacts WHERE share_token = ?')) {
          const tok = String(args[0])
          for (const row of db.artifacts.values()) {
            if (row.share_token === tok) return row as unknown as T
          }
          return null
        }
        if (sql.includes('FROM artifact_versions WHERE slug = ? AND version = ?')) {
          const [slug, ver] = args
          return (db.versions.find((v) => v.slug === slug && v.version === ver) ?? null) as unknown as T | null
        }
        if (sql.includes('FROM artifact_comments WHERE slug = ? AND id = ?')) {
          const [slug, id] = args
          return (db.comments.find((c) => c.slug === slug && c.id === id) ?? null) as unknown as T | null
        }
        throw new Error(`Unsupported first() SQL in test D1: ${sql}`)
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        if (sql.includes('FROM artifacts a LEFT JOIN artifact_comments c')) {
          let rows = [...db.artifacts.values()]
          let idx = 0
          if (sql.includes('a.project = ?')) {
            const p = String(args[idx++])
            rows = rows.filter((r) => r.project === p)
          }
          if (sql.includes('a.artifact_type = ?')) {
            const t = String(args[idx++])
            rows = rows.filter((r) => r.artifact_type === t)
          }
          if (sql.includes('LOWER(a.slug) LIKE ?')) {
            const rawLike = String(args[idx++]).slice(1, -1).replace(/\\/g, '')
            idx++ // second identical binding
            rows = rows.filter(
              (r) => r.slug.toLowerCase().includes(rawLike) || r.title.toLowerCase().includes(rawLike)
            )
          }
          const limit = Number(args[idx] ?? 50)
          const results = rows
            .sort((a, b) => b.updated_at - a.updated_at)
            .slice(0, limit)
            .map((a) => {
              const cmts = db.comments.filter((c) => c.slug === a.slug)
              return {
                ...a,
                open_comment_count: cmts.filter((c) => c.status === 'open').length,
                total_comment_count: cmts.length
              }
            })
          return { results: results as unknown as T[], success: true, meta: {} as D1Result['meta'] }
        }
        if (sql.includes('FROM artifact_versions WHERE slug = ?')) {
          const slug = String(args[0])
          const results = db.versions
            .filter((v) => v.slug === slug)
            .sort((a, b) => b.version - a.version)
          return { results: results as unknown as T[], success: true, meta: {} as D1Result['meta'] }
        }
        if (sql.includes('FROM artifact_comments WHERE')) {
          let idx = 0
          const slug = String(args[idx++])
          let results = db.comments.filter((c) => c.slug === slug)
          if (sql.includes('AND version = ?')) {
            const ver = Number(args[idx++])
            results = results.filter((c) => c.version === ver)
          }
          if (sql.includes('AND status = ?')) {
            const status = String(args[idx++])
            results = results.filter((c) => c.status === status)
          }
          results.sort((a, b) => a.created_at - b.created_at)
          return { results: results as unknown as T[], success: true, meta: {} as D1Result['meta'] }
        }
        throw new Error(`Unsupported all() SQL in test D1: ${sql}`)
      },
      async run(): Promise<D1Result> {
        if (sql.startsWith('INSERT OR IGNORE INTO artifacts')) {
          const [slug, title, artifactType, project, visibility, shareToken, createdAt, updatedAt] = args
          const key = String(slug)
          if (!db.artifacts.has(key)) {
            db.artifacts.set(key, {
              slug: key,
              title: String(title),
              artifact_type: artifactType as ArtifactType,
              project: String(project),
              visibility: visibility as ArtifactVisibility,
              share_token: String(shareToken),
              latest_version: 0,
              created_at: Number(createdAt),
              updated_at: Number(updatedAt)
            })
          }
          return { results: [], success: true, meta: {} as D1Result['meta'] }
        }
        if (sql.startsWith('INSERT INTO artifact_versions')) {
          const [slug, version, entryPath, r2Prefix, fileCount, sizeBytes, sha256, changeNote, createdBy, createdAt] =
            args
          if (db.versions.some((v) => v.slug === slug && v.version === version)) {
            throw new Error('UNIQUE constraint failed: artifact_versions.slug, artifact_versions.version')
          }
          db.versions.push({
            id: db.nextVersionId++,
            slug: String(slug),
            version: Number(version),
            entry_path: String(entryPath),
            r2_prefix: String(r2Prefix),
            file_count: Number(fileCount),
            size_bytes: Number(sizeBytes),
            sha256: String(sha256),
            change_note: changeNote === null ? null : String(changeNote),
            created_by: String(createdBy),
            created_at: Number(createdAt)
          })
          return { results: [], success: true, meta: {} as D1Result['meta'] }
        }
        if (sql.startsWith('UPDATE artifacts SET title = ?')) {
          const [title, artifactType, project, visibility, targetVersion, updatedAt, slug] = args
          const row = db.artifacts.get(String(slug))
          if (row) {
            row.title = String(title)
            row.artifact_type = artifactType as ArtifactType
            row.project = String(project)
            row.visibility = visibility as ArtifactVisibility
            row.latest_version = Math.max(row.latest_version, Number(targetVersion))
            row.updated_at = Number(updatedAt)
          }
          return { results: [], success: true, meta: {} as D1Result['meta'] }
        }
        if (sql.startsWith('UPDATE artifacts SET visibility = ?')) {
          const [visibility, shareToken, updatedAt, slug] = args
          const row = db.artifacts.get(String(slug))
          if (row) {
            row.visibility = visibility as ArtifactVisibility
            row.share_token = String(shareToken)
            row.updated_at = Number(updatedAt)
          }
          return { results: [], success: true, meta: {} as D1Result['meta'] }
        }
        if (sql.startsWith('DELETE FROM artifact_comments WHERE slug = ?')) {
          const slug = String(args[0])
          db.comments = db.comments.filter((c) => c.slug !== slug)
          return { results: [], success: true, meta: {} as D1Result['meta'] }
        }
        if (sql.startsWith('DELETE FROM artifact_versions WHERE slug = ?')) {
          const slug = String(args[0])
          db.versions = db.versions.filter((v) => v.slug !== slug)
          return { results: [], success: true, meta: {} as D1Result['meta'] }
        }
        if (sql.startsWith('DELETE FROM artifacts WHERE slug = ?')) {
          db.artifacts.delete(String(args[0]))
          return { results: [], success: true, meta: {} as D1Result['meta'] }
        }
        if (sql.startsWith('INSERT INTO artifact_comments')) {
          const [id, slug, version, author, body, anchor, parentId, createdAt, updatedAt] = args
          db.comments.push({
            id: String(id),
            slug: String(slug),
            version: Number(version),
            author: String(author),
            body: String(body),
            anchor: anchor === null ? null : String(anchor),
            status: 'open',
            parent_id: parentId === null ? null : String(parentId),
            created_at: Number(createdAt),
            updated_at: Number(updatedAt)
          })
          return { results: [], success: true, meta: {} as D1Result['meta'] }
        }
        if (sql.startsWith('UPDATE artifact_comments SET status = ?')) {
          const [status, updatedAt, slug, id] = args
          const found = db.comments.find((c) => c.slug === slug && c.id === id)
          if (found) {
            found.status = status as CommentStatus
            found.updated_at = Number(updatedAt)
          }
          return { results: [], success: true, meta: {} as D1Result['meta'] }
        }
        throw new Error(`Unsupported run() SQL in test D1: ${sql}`)
      }
    }

    return stmt as unknown as D1PreparedStatement
  }
}

function makeTestEnv(overrides: Partial<Env> = {}): {
  env: Env
  bucket: MemoryR2Bucket
  db: MemoryD1Database
} {
  const bucket = new MemoryR2Bucket()
  const db = new MemoryD1Database()
  const env: Env = {
    DB: db as unknown as D1Database,
    BUCKET: bucket as unknown as R2Bucket,
    PUBLIC_BASE_URL: 'https://canvas.chenge.ink',
    SERVER_NAME: 'Canvas Artifact Server',
    ALLOW_CF_ACCESS: 'false',
    AGENT_API_TOKEN: 'agent-secret-token-for-tests-123456',
    ADMIN_PASSWORD: 'admin-password-for-tests',
    SESSION_SECRET: 'session-hmac-secret-for-tests',
    ...overrides
  }
  return { env, bucket, db }
}

async function callMcp(
  env: Env,
  body: Record<string, unknown>,
  token = env.AGENT_API_TOKEN
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  return handleRequest(
    new Request('https://canvas.chenge.ink/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }),
    env
  )
}

describe('artifact-server worker', () => {
  it('returns health check JSON', async () => {
    const { env } = makeTestEnv()
    const res = await handleRequest(new Request('https://canvas.chenge.ink/health'), env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      service: 'canvas-artifact-server',
      version: '1.0.0'
    })
  })

  it('enforces Bearer token on /mcp and handles initialize + notifications + tools/list', async () => {
    const { env } = makeTestEnv()

    const unauth = await callMcp(env, { jsonrpc: '2.0', id: 1, method: 'initialize' }, '')
    expect(unauth.status).toBe(401)

    const init = await callMcp(env, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' }
    })
    expect(init.status).toBe(200)
    const initJson = (await init.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } }
    expect(initJson.result.protocolVersion).toBe('2025-06-18')
    expect(initJson.result.serverInfo.name).toBe('Canvas Artifact Server')

    const notif = await callMcp(env, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(notif.status).toBe(202)

    const toolsRes = await callMcp(env, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const toolsJson = (await toolsRes.json()) as {
      result: { tools: Array<{ name: string; annotations: { destructiveHint: boolean; readOnlyHint: boolean } }> }
    }
    const names = toolsJson.result.tools.map((t) => t.name)
    expect(names).toContain('artifact_publish')
    expect(names).toContain('comment_list')
    const del = toolsJson.result.tools.find((t) => t.name === 'artifact_delete')
    expect(del?.annotations.destructiveHint).toBe(true)
    const listTool = toolsJson.result.tools.find((t) => t.name === 'artifact_list')
    expect(listTool?.annotations.readOnlyHint).toBe(true)
  })

  it('publishes versioned HTML + multi-file ESM bundle and serves /raw with sandbox CSP + CORS', async () => {
    const { env } = makeTestEnv()

    const v1Res = await callMcp(env, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'artifact_publish',
        arguments: {
          slug: 'Q4 Renewal Board',
          title: 'Q4 Renewal Dashboard',
          artifact_type: 'dashboard',
          html: '<!doctype html><html><body><h1>V1</h1></body></html>',
          change_note: 'Initial draft'
        }
      }
    })
    const v1Rpc = (await v1Res.json()) as {
      result: { structuredContent: { version: number; slug: string; share_url: string; raw_url: string }; isError: boolean }
    }
    expect(v1Rpc.result.isError).toBe(false)
    expect(v1Rpc.result.structuredContent.slug).toBe('q4-renewal-board')
    expect(v1Rpc.result.structuredContent.version).toBe(1)
    expect(v1Rpc.result.structuredContent.share_url).toMatch(/^https:\/\/canvas\.chenge\.ink\/s\//)

    // Multi-file v2 bundle (simulating omada-ui-kit Vite dist/)
    const v2Res = await callMcp(env, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'artifact_publish',
        arguments: {
          slug: 'q4-renewal-board',
          title: 'Q4 Renewal Dashboard v2',
          artifact_type: 'dashboard',
          files: [
            {
              path: 'index.html',
              content: '<!doctype html><html><script type="module" src="./assets/app.js"></script></html>'
            },
            {
              path: 'assets/app.js',
              content: 'export const ready = true;'
            }
          ]
        }
      }
    })
    const v2Rpc = (await v2Res.json()) as {
      result: { structuredContent: { version: number; file_count: number; raw_url: string } }
    }
    expect(v2Rpc.result.structuredContent.version).toBe(2)
    expect(v2Rpc.result.structuredContent.file_count).toBe(2)

    const v2RawUrl = v2Rpc.result.structuredContent.raw_url
    expect(v2RawUrl).toMatch(/^https:\/\/canvas\.chenge\.ink\/raw\/t\/[^/]+\/q4-renewal-board\/v2\/index\.html$/)

    // Unauthenticated without token is forbidden on unlisted
    const rawForbidden = await handleRequest(
      new Request('https://canvas.chenge.ink/raw/q4-renewal-board/v2/assets/app.js'),
      env
    )
    expect(rawForbidden.status).toBe(403)

    // Entry HTML serves under token path prefix
    const rawIndex = await handleRequest(new Request(v2RawUrl), env)
    expect(rawIndex.status).toBe(200)
    expect(await rawIndex.text()).toContain('./assets/app.js')

    // Relative ESM module resolution preserves /raw/t/<token>/... prefix without needing ?t=
    const relativeAssetUrl = new URL('./assets/app.js', v2RawUrl).toString()
    const rawOk = await handleRequest(new Request(relativeAssetUrl), env)
    expect(rawOk.status).toBe(200)
    expect(rawOk.headers.get('content-type')).toContain('application/javascript')
    expect(rawOk.headers.get('access-control-allow-origin')).toBe('*')
    expect(rawOk.headers.get('content-security-policy')).toBe(
      'sandbox allow-scripts allow-popups allow-forms allow-modals'
    )
    expect(await rawOk.text()).toBe('export const ready = true;')

    // Path traversal blocked
    const traversal = await callMcp(env, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'artifact_publish',
        arguments: {
          slug: 'bad-path',
          files: [{ path: '../secrets.txt', content: 'oops' }]
        }
      }
    })
    const traversalRpc = (await traversal.json()) as { result: { isError: boolean } }
    expect(traversalRpc.result.isError).toBe(true)
  })

  it('supports share link review UI, reviewer comments, resolve loop, visibility changes, and cleanup on delete', async () => {
    const { env, bucket } = makeTestEnv()

    const pub = await callMcp(env, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'artifact_publish',
        arguments: {
          slug: 'switch-config-proto',
          title: 'Switch Config Prototype <script>alert(1)</script>',
          html: '<!doctype html><html><body>Proto</body></html>'
        }
      }
    })
    const pubJson = (await pub.json()) as {
      result: { structuredContent: { share_url: string } }
    }
    const shareUrl = pubJson.result.structuredContent.share_url
    const shareToken = new URL(shareUrl).pathname.split('/').pop()!

    // Unlisted share link renders review UI and escapes inline script injection
    const sharePage = await handleRequest(new Request(shareUrl), env)
    expect(sharePage.status).toBe(200)
    const html = await sharePage.text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('Proto')

    // Reviewer posts a comment via tokenized REST endpoint
    const postCmt = await handleRequest(
      new Request(
        `https://canvas.chenge.ink/api/artifacts/switch-config-proto/comments?t=${encodeURIComponent(shareToken)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version: 1, author: 'Alice', anchor: 'Header', body: 'Make table sortable' })
        }
      ),
      env
    )
    expect(postCmt.status).toBe(201)
    const cmtJson = (await postCmt.json()) as { comment: { id: string; status: string } }
    expect(cmtJson.comment.status).toBe('open')

    // Agent resolves comment via MCP
    const resolveRes = await callMcp(env, {
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'comment_resolve',
        arguments: { slug: 'switch-config-proto', comment_id: cmtJson.comment.id, status: 'resolved' }
      }
    })
    const resolveRpc = (await resolveRes.json()) as {
      result: { structuredContent: { comment: { status: string } } }
    }
    expect(resolveRpc.result.structuredContent.comment.status).toBe('resolved')

    // Switch visibility to private -> share link stops working for anonymous reviewer
    await callMcp(env, {
      jsonrpc: '2.0',
      id: 22,
      method: 'tools/call',
      params: {
        name: 'artifact_set_visibility',
        arguments: { slug: 'switch-config-proto', visibility: 'private' }
      }
    })
    const blockedShare = await handleRequest(new Request(shareUrl), env)
    expect(blockedShare.status).toBe(404)

    // Delete artifact cleans R2 objects too
    expect(bucket.objects.size).toBe(1)
    const delRes = await callMcp(env, {
      jsonrpc: '2.0',
      id: 23,
      method: 'tools/call',
      params: {
        name: 'artifact_delete',
        arguments: { slug: 'switch-config-proto' }
      }
    })
    const delRpc = (await delRes.json()) as {
      result: { structuredContent: { deleted: boolean; objects_removed: number } }
    }
    expect(delRpc.result.structuredContent.deleted).toBe(true)
    expect(delRpc.result.structuredContent.objects_removed).toBe(1)
    expect(bucket.objects.size).toBe(0)
  })

  it('supports password login session cookie for gallery', async () => {
    const { env } = makeTestEnv()
    const unauthRoot = await handleRequest(new Request('https://canvas.chenge.ink/'), env)
    expect(unauthRoot.status).toBe(302)

    const loginRes = await handleRequest(
      new Request('https://canvas.chenge.ink/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'admin-password-for-tests' })
      }),
      env
    )
    expect(loginRes.status).toBe(200)
    const setCookie = loginRes.headers.get('set-cookie') || ''
    expect(setCookie).toContain('canvas_session=')

    const authedRoot = await handleRequest(
      new Request('https://canvas.chenge.ink/', {
        headers: { cookie: setCookie.split(';')[0] }
      }),
      env
    )
    expect(authedRoot.status).toBe(200)
    expect(await authedRoot.text()).toContain('Canvas Artifact Server')
  })

  it('supports KV-backed blob storage when R2 BUCKET is unbound', async () => {
    const kv = new MemoryKVNamespace()
    const { env } = makeTestEnv({
      BUCKET: undefined,
      ARTIFACTS_KV: kv as unknown as KVNamespace
    })

    const pub = await callMcp(env, {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: {
        name: 'artifact_publish',
        arguments: {
          slug: 'kv-omada-demo',
          title: 'KV Multi-file Demo',
          files: [
            {
              path: 'index.html',
              content: '<!doctype html><html><script type="module" src="./assets/main.js"></script></html>'
            },
            {
              path: 'assets/main.js',
              content: 'console.log("kv-ok");'
            }
          ]
        }
      }
    })
    const pubJson = (await pub.json()) as {
      result: { structuredContent: { raw_url: string; file_count: number } }
    }
    expect(pubJson.result.structuredContent.file_count).toBe(2)
    expect(kv.entries.size).toBe(2)

    const assetUrl = new URL('./assets/main.js', pubJson.result.structuredContent.raw_url).toString()
    const assetRes = await handleRequest(new Request(assetUrl), env)
    expect(assetRes.status).toBe(200)
    expect(assetRes.headers.get('content-type')).toContain('application/javascript')
    expect(assetRes.headers.get('access-control-allow-origin')).toBe('*')
    expect(assetRes.headers.get('content-security-policy')).toBe(
      'sandbox allow-scripts allow-popups allow-forms allow-modals'
    )
    expect(await assetRes.text()).toBe('console.log("kv-ok");')

    const delRes = await callMcp(env, {
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: {
        name: 'artifact_delete',
        arguments: { slug: 'kv-omada-demo' }
      }
    })
    const delJson = (await delRes.json()) as {
      result: { structuredContent: { deleted: boolean; objects_removed: number } }
    }
    expect(delJson.result.structuredContent.deleted).toBe(true)
    expect(delJson.result.structuredContent.objects_removed).toBe(2)
    expect(kv.entries.size).toBe(0)
  })
})

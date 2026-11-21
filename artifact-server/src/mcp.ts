import { verifyAgentBearer } from './auth'
import {
  ArtifactServerError,
  buildArtifactLinks,
  createComment,
  deleteArtifact,
  getArtifactBySlug,
  getVersion,
  listArtifacts,
  listComments,
  listVersions,
  publishArtifact,
  resolveBaseUrl,
  resolveComment,
  setVisibility
} from './storage'
import {
  ARTIFACT_TYPES,
  ARTIFACT_VISIBILITIES,
  COMMENT_STATUSES,
  type ArtifactFileInput,
  type ArtifactType,
  type ArtifactVisibility,
  type CommentStatus,
  type Env
} from './types'

const MCP_PROTOCOL_VERSION = '2025-06-18'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: {
    title: string
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
}

const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'artifact_publish',
    description:
      'Publish a new artifact or create an immutable next version (v1 -> v2 -> ...) for an existing slug. Supports either single self-contained HTML or a multi-file Vite/ESM bundle via `files`. Always share the returned `share_url` or `review_url` with the user.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug'],
      properties: {
        slug: {
          type: 'string',
          description: 'ASCII kebab-case identifier (e.g. "q4-renewal-dashboard"). Reuse across revisions.'
        },
        title: { type: 'string', description: 'Human-readable title of the artifact.' },
        artifact_type: { type: 'string', enum: [...ARTIFACT_TYPES] },
        project: { type: 'string', description: 'Project or workspace grouping label (default: "default").' },
        visibility: {
          type: 'string',
          enum: [...ARTIFACT_VISIBILITIES],
          description: 'Access mode: unlisted (tokenized share link, default on create), public, or private.'
        },
        html: { type: 'string', description: 'Complete self-contained HTML5 document for single-file artifacts.' },
        files: {
          type: 'array',
          description: 'Multi-file static/ESM bundle entries (e.g. index.html + assets/*).',
          items: {
            type: 'object',
            required: ['path', 'content'],
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              content_type: { type: 'string' },
              encoding: { type: 'string', enum: ['utf8', 'base64'] }
            }
          }
        },
        entry_path: { type: 'string', description: 'Entry HTML path within bundle (default: "index.html").' },
        change_note: { type: 'string', description: 'Short summary of what changed in this version.' }
      }
    },
    annotations: {
      title: 'Publish Artifact',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'artifact_list',
    description: 'List artifacts stored on the server with latest version, visibility, open comment count, and links.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        project: { type: 'string' },
        artifact_type: { type: 'string', enum: [...ARTIFACT_TYPES] },
        query: { type: 'string', description: 'Optional substring match on slug or title.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      }
    },
    annotations: {
      title: 'List Artifacts',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'artifact_get',
    description: 'Fetch metadata, share/review/raw links, version history, and comments for an artifact slug.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug'],
      properties: {
        slug: { type: 'string' },
        version: { type: 'integer', minimum: 1, description: 'Optional specific version (defaults to latest).' }
      }
    },
    annotations: {
      title: 'Get Artifact Details',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'artifact_versions',
    description: 'List all immutable version snapshots (v1..vN) with review/raw links and change notes for an artifact.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug'],
      properties: {
        slug: { type: 'string' }
      }
    },
    annotations: {
      title: 'List Artifact Versions',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'artifact_set_visibility',
    description: 'Update artifact sharing visibility (private, unlisted, public) or rotate the unlisted share token.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'visibility'],
      properties: {
        slug: { type: 'string' },
        visibility: { type: 'string', enum: [...ARTIFACT_VISIBILITIES] },
        rotate_share_token: { type: 'boolean', description: 'Generate a fresh share link token and invalidate the old one.' }
      }
    },
    annotations: {
      title: 'Set Artifact Visibility',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'artifact_delete',
    description: 'Permanently delete an artifact, all of its versioned files in R2, and all comments.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug'],
      properties: {
        slug: { type: 'string' }
      }
    },
    annotations: {
      title: 'Delete Artifact',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'comment_list',
    description: 'Read team review comments for an artifact, optionally filtered by version or status (open/resolved).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug'],
      properties: {
        slug: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        status: { type: 'string', enum: [...COMMENT_STATUSES] }
      }
    },
    annotations: {
      title: 'List Review Comments',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: 'comment_create',
    description: 'Post a comment or reply on a specific artifact version.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'body'],
      properties: {
        slug: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        author: { type: 'string' },
        body: { type: 'string' },
        anchor: { type: 'string', description: 'Optional section or UI element reference.' },
        parent_id: { type: 'string' }
      }
    },
    annotations: {
      title: 'Create Comment',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: 'comment_resolve',
    description: 'Mark an artifact review comment as resolved or reopen it after addressing feedback.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['slug', 'comment_id'],
      properties: {
        slug: { type: 'string' },
        comment_id: { type: 'string' },
        status: { type: 'string', enum: [...COMMENT_STATUSES], description: 'Default: "resolved".' }
      }
    },
    annotations: {
      title: 'Resolve Comment',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }
]

function mcpCorsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization, mcp-session-id, mcp-protocol-version'
  }
}

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...mcpCorsHeaders()
    }
  })
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  status = 200
): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...mcpCorsHeaders()
    }
  })
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function asFiles(v: unknown): ArtifactFileInput[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: ArtifactFileInput[] = []
  for (const row of v) {
    if (!row || typeof row !== 'object') {
      throw new ArtifactServerError('E_INVALID_ARG', 'Each entry in files must be an object', 400)
    }
    const rec = row as Record<string, unknown>
    out.push({
      path: typeof rec.path === 'string' ? rec.path : '',
      content: typeof rec.content === 'string' ? rec.content : '',
      content_type: typeof rec.content_type === 'string' ? rec.content_type : undefined,
      encoding: rec.encoding === 'base64' ? 'base64' : 'utf8'
    })
  }
  return out
}

async function runMcpTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  baseUrl: string
): Promise<unknown> {
  switch (name) {
    case 'artifact_publish':
      return publishArtifact(env, baseUrl, {
        slug: asStr(args.slug) ?? '',
        title: asStr(args.title),
        artifact_type: asStr(args.artifact_type) as ArtifactType | undefined,
        project: asStr(args.project),
        visibility: asStr(args.visibility) as ArtifactVisibility | undefined,
        html: asStr(args.html),
        files: asFiles(args.files),
        entry_path: asStr(args.entry_path),
        change_note: asStr(args.change_note),
        created_by: 'agent'
      })

    case 'artifact_list': {
      const rows = await listArtifacts(env, {
        project: asStr(args.project),
        artifact_type: asStr(args.artifact_type),
        query: asStr(args.query),
        limit: asInt(args.limit)
      })
      return {
        artifacts: rows.map((row) => ({
          slug: row.slug,
          title: row.title,
          artifact_type: row.artifact_type,
          project: row.project,
          visibility: row.visibility,
          latest_version: row.latest_version,
          open_comment_count: Number(row.open_comment_count ?? 0),
          total_comment_count: Number(row.total_comment_count ?? 0),
          updated_at: row.updated_at,
          links: buildArtifactLinks(baseUrl, row, Math.max(1, row.latest_version), 'index.html')
        }))
      }
    }

    case 'artifact_get': {
      const slug = asStr(args.slug) ?? ''
      const artifact = await getArtifactBySlug(env, slug)
      if (!artifact) {
        throw new ArtifactServerError('E_NOT_FOUND', `Artifact not found: ${slug}`, 404)
      }
      const versions = await listVersions(env, artifact.slug)
      const targetVersion = asInt(args.version) ?? Math.max(1, artifact.latest_version)
      const activeVer =
        versions.find((v) => v.version === targetVersion) ?? (await getVersion(env, artifact.slug, targetVersion))
      const entryPath = activeVer?.entry_path || 'index.html'
      const comments = await listComments(env, artifact.slug)
      return {
        artifact: {
          slug: artifact.slug,
          title: artifact.title,
          artifact_type: artifact.artifact_type,
          project: artifact.project,
          visibility: artifact.visibility,
          latest_version: artifact.latest_version,
          created_at: artifact.created_at,
          updated_at: artifact.updated_at
        },
        active_version: activeVer,
        links: buildArtifactLinks(baseUrl, artifact, targetVersion, entryPath),
        versions,
        comments
      }
    }

    case 'artifact_versions': {
      const slug = asStr(args.slug) ?? ''
      const artifact = await getArtifactBySlug(env, slug)
      if (!artifact) {
        throw new ArtifactServerError('E_NOT_FOUND', `Artifact not found: ${slug}`, 404)
      }
      const versions = await listVersions(env, artifact.slug)
      return {
        slug: artifact.slug,
        versions: versions.map((v) => ({
          ...v,
          links: buildArtifactLinks(baseUrl, artifact, v.version, v.entry_path)
        }))
      }
    }

    case 'artifact_set_visibility': {
      const slug = asStr(args.slug) ?? ''
      const res = await setVisibility(
        env,
        baseUrl,
        slug,
        args.visibility,
        asBool(args.rotate_share_token) === true
      )
      return {
        ok: true,
        slug: res.artifact.slug,
        visibility: res.artifact.visibility,
        links: res.links
      }
    }

    case 'artifact_delete': {
      const slug = asStr(args.slug) ?? ''
      return { slug, ...(await deleteArtifact(env, slug)) }
    }

    case 'comment_list': {
      const slug = asStr(args.slug) ?? ''
      const statusRaw = asStr(args.status) as CommentStatus | undefined
      const comments = await listComments(env, slug, {
        version: asInt(args.version),
        status: statusRaw
      })
      return { slug, comments }
    }

    case 'comment_create': {
      const slug = asStr(args.slug) ?? ''
      const comment = await createComment(env, slug, {
        version: asInt(args.version),
        author: asStr(args.author) ?? 'Agent',
        body: asStr(args.body) ?? '',
        anchor: asStr(args.anchor),
        parent_id: asStr(args.parent_id)
      })
      return { ok: true, comment }
    }

    case 'comment_resolve': {
      const slug = asStr(args.slug) ?? ''
      const commentId = asStr(args.comment_id) ?? ''
      const status = (asStr(args.status) as CommentStatus | undefined) ?? 'resolved'
      const comment = await resolveComment(env, slug, commentId, status)
      return { ok: true, comment }
    }

    default:
      throw new ArtifactServerError('E_NOT_FOUND', `Unknown tool: ${name}`, 404)
  }
}

export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: mcpCorsHeaders() })
  }
  if (request.method === 'DELETE') {
    return new Response(null, { status: 204, headers: mcpCorsHeaders() })
  }
  if (request.method === 'GET') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST, DELETE, OPTIONS', ...mcpCorsHeaders() }
    })
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'POST, DELETE, OPTIONS', ...mcpCorsHeaders() }
    })
  }

  const auth = await verifyAgentBearer(request, env)
  if (!auth.ok) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized: valid Bearer token required for /mcp' }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'www-authenticate': 'Bearer realm="artifact-server"',
          ...mcpCorsHeaders()
        }
      }
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonRpcError(null, -32700, 'Parse error: invalid JSON', 400)
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonRpcError(null, -32600, 'Invalid Request: expected JSON-RPC object', 400)
  }

  const req = body as JsonRpcRequest
  const hasId = Object.prototype.hasOwnProperty.call(req, 'id') && req.id !== undefined
  const rpcId = hasId ? req.id ?? null : null
  const method = typeof req.method === 'string' ? req.method : ''

  if (!hasId || method.startsWith('notifications/')) {
    return new Response(null, { status: 202, headers: mcpCorsHeaders() })
  }

  const baseUrl = resolveBaseUrl(request, env)
  const serverName = env.SERVER_NAME?.trim() || 'Canvas Artifact Server'

  switch (method) {
    case 'initialize': {
      const requestedProtocol =
        req.params && typeof req.params.protocolVersion === 'string'
          ? req.params.protocolVersion
          : MCP_PROTOCOL_VERSION
      return jsonRpcResult(rpcId, {
        protocolVersion: requestedProtocol || MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: '1.0.0' },
        instructions:
          'Use artifact_publish to publish or revise interactive HTML or multi-file Vite bundles. Always present share_url or review_url first so reviewers can view full-screen and leave versioned comments. Check comment_list before iterating to vN+1, and mark addressed feedback via comment_resolve.'
      })
    }

    case 'ping':
      return jsonRpcResult(rpcId, {})

    case 'tools/list':
      return jsonRpcResult(rpcId, { tools: MCP_TOOLS })

    case 'tools/call': {
      const toolName = req.params && typeof req.params.name === 'string' ? req.params.name : ''
      const rawArgs =
        req.params && req.params.arguments && typeof req.params.arguments === 'object'
          ? (req.params.arguments as Record<string, unknown>)
          : {}
      if (!toolName) {
        return jsonRpcError(rpcId, -32602, 'Invalid params: tools/call requires name', 400)
      }
      try {
        const result = await runMcpTool(toolName, rawArgs, env, baseUrl)
        return jsonRpcResult(rpcId, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const code = err instanceof ArtifactServerError ? err.code : 'E_TOOL_ERROR'
        return jsonRpcResult(rpcId, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: code, message }) }],
          isError: true
        })
      }
    }

    default:
      return jsonRpcError(rpcId, -32601, `Method not found: ${method}`)
  }
}

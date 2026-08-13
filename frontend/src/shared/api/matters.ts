import { request } from './http_client'
import type {
  MatterDetailResponse,
  MatterAttentionListResponse,
  MatterAttentionSignal,
  MatterCreateDraftRequest,
  MatterCreateDraftResponse,
  MatterNotifyLevel,
  MatterNotifyLevelResponse,
  MatterItem,
  MatterListOptions,
  MatterListResponse,
  MatterMutationOptions,
  MatterMutationResult,
  MatterRun,
  MatterRunListResponse,
  MatterRunStartResult,
  MatterTagListResponse,
  MatterTagMutationResult,
  MatterDuplicateCandidate,
  MatterRelation,
  MatterResourceAttachment,
  MatterResourceCandidateResult,
  MatterResourceDiscoveryResult,
  MatterResourceListItem,
  MatterResourceLookupResponse,
  MatterStakeholder,
  MatterSuggestionBulkResult,
  MatterTimelineResponse,
  MatterUpdate,
  MatterUpdateListResponse,
  MattersApi,
  MutationEnvelope
} from './types/matter'

const DEFAULT_SOURCE = 'desktop_ui'
let fallbackKeyCounter = 0

/** P3 (Matter Chat undo) — the mutation envelope gained an optional `reverses_event_id` on the
 *  Python side (`src/api/schemas/matters.py::MutationEnvelope`, P1 column, D9 today). Kept as a
 *  LOCAL widening of the shared `MutationEnvelope` / `MatterMutationOptions` types because
 *  `api/types/matter.ts` is the cross-language contract mirror (parity gate:
 *  tests/matters/test_matters_contract_parity.py) and this lane must not edit it. */
export type MatterUndoMutationOptions = MatterMutationOptions & {
  /** matter_event id this write reverses — carried straight through to the event row so an undo
   *  is auditable in the timeline (D9). */
  reversesEventId?: number | null
}

type MutationEnvelopeWithUndo = MutationEnvelope & { reverses_event_id?: number | null }

function segment(value: string | number): string {
  return encodeURIComponent(String(value))
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  fallbackKeyCounter += 1
  return `matter-${Date.now()}-${fallbackKeyCounter}`
}

function mutation(options: MatterUndoMutationOptions = {}): MutationEnvelopeWithUndo {
  return {
    source: options.source ?? DEFAULT_SOURCE,
    idempotency_key: uuid(),
    expected_version: options.expectedVersion ?? null,
    reason: options.reason ?? null,
    // Only send the key when the caller has one: the Python model is `extra="forbid"` but the
    // field is optional, so an explicit null is legal — still, omitting keeps every pre-P3 write
    // byte-identical on the wire.
    ...(options.reversesEventId != null ? { reverses_event_id: options.reversesEventId } : {})
  }
}

function mutationRequest(
  options: MatterUndoMutationOptions,
  fields: object = {}
): { body: Record<string, unknown>; headers: Record<string, string> } {
  const envelope = mutation(options)
  return {
    body: { ...fields, mutation: envelope },
    headers: { 'Idempotency-Key': envelope.idempotency_key }
  }
}

export function createMattersApi(baseUrl: string): MattersApi {
  return {
    list(options: MatterListOptions = {}): Promise<MatterListResponse> {
      return request(baseUrl, 'GET', '/matters', {
        query: {
          q: options.q,
          status: options.status,
          health: options.health,
          priority: options.priority,
          type: options.type,
          tag: options.tag,
          view: options.view,
          archived: options.archived,
          deleted: options.deleted,
          cursor: options.cursor,
          limit: options.limit,
          sort: options.sort
        }
      })
    },

    create(input, options = {}): Promise<MatterMutationResult> {
      return request(baseUrl, 'POST', '/matters', mutationRequest(options, input))
    },

    createDraft(
      input: MatterCreateDraftRequest,
      signal?: AbortSignal
    ): Promise<MatterCreateDraftResponse> {
      return request(baseUrl, 'POST', '/matters/create-draft', { body: input, signal })
    },

    async duplicateCandidates(input): Promise<MatterDuplicateCandidate[]> {
      const result = await request<{ items: MatterDuplicateCandidate[] }>(
        baseUrl,
        'POST',
        '/matters/duplicate-candidates',
        { body: input }
      )
      return result.items
    },

    listTags(): Promise<MatterTagListResponse> {
      return request(baseUrl, 'GET', '/matters/tags')
    },

    setTagStyle(name, input, options = {}): Promise<MatterTagMutationResult> {
      return request(
        baseUrl,
        'PUT',
        `/matters/tags/${segment(name)}`,
        mutationRequest(options, input)
      )
    },

    renameTag(name, nextName, options = {}): Promise<MatterTagMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/tags/${segment(name)}/rename`,
        mutationRequest(options, { name: nextName })
      )
    },

    deleteTag(name, options = {}): Promise<MatterTagMutationResult> {
      return request(baseUrl, 'DELETE', `/matters/tags/${segment(name)}`, mutationRequest(options))
    },

    get(matterId, include = []): Promise<MatterDetailResponse> {
      return request(baseUrl, 'GET', `/matters/${segment(matterId)}`, {
        query: { include: include.length > 0 ? include.join(',') : undefined }
      })
    },

    patch(matterId, input, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'PATCH',
        `/matters/${segment(matterId)}`,
        mutationRequest(options, input)
      )
    },

    archive(matterId, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/archive`,
        mutationRequest(options)
      )
    },

    reopen(matterId, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/reopen`,
        mutationRequest(options)
      )
    },

    trash(matterId, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/trash`,
        mutationRequest(options)
      )
    },

    restore(matterId, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/restore`,
        mutationRequest(options)
      )
    },

    permanentDelete(matterId, confirmation, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'DELETE',
        `/matters/${segment(matterId)}/trash`,
        mutationRequest(options, { confirmation })
      )
    },

    async listItems(matterId, options = {}): Promise<MatterItem[]> {
      const result = await request<{ items: MatterItem[] }>(
        baseUrl,
        'GET',
        `/matters/${segment(matterId)}/items`,
        {
          query: {
            kind: options.kind,
            status: options.status,
            include_deleted: options.includeDeleted
          }
        }
      )
      return result.items
    },

    createItem(matterId, input, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/items`,
        mutationRequest(options, input)
      )
    },

    patchItem(matterId, itemId, input, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'PATCH',
        `/matters/${segment(matterId)}/items/${segment(itemId)}`,
        mutationRequest(options, input)
      )
    },

    deleteItem(matterId, itemId, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'DELETE',
        `/matters/${segment(matterId)}/items/${segment(itemId)}`,
        mutationRequest(options)
      )
    },

    restoreItem(matterId, itemId, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/items/${segment(itemId)}/restore`,
        mutationRequest(options)
      )
    },

    async listResources(matterId, options = {}): Promise<MatterResourceListItem[]> {
      const result = await request<{ items: MatterResourceListItem[] }>(
        baseUrl,
        'GET',
        `/matters/${segment(matterId)}/resources`,
        {
          query: {
            kind: options.kind,
            pinned: options.pinned,
            access_policy: options.accessPolicy,
            sub_state: options.subState,
            include_unavailable: options.includeUnavailable
          }
        }
      )
      return result.items
    },

    linkResource(matterId, input, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/resources`,
        mutationRequest(options, input)
      )
    },

    patchResource(matterId, resourceId, input, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'PATCH',
        `/matters/${segment(matterId)}/resources/${segment(resourceId)}`,
        mutationRequest(options, input)
      )
    },

    unlinkResource(matterId, resourceId, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'DELETE',
        `/matters/${segment(matterId)}/resources/${segment(resourceId)}`,
        mutationRequest(options)
      )
    },

    restoreResource(matterId, resourceId, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/resources/${segment(resourceId)}/restore`,
        mutationRequest(options)
      )
    },

    rejectResourceSuggestion(matterId, resourceId, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/resources/${segment(resourceId)}/reject-suggestion`,
        mutationRequest(options)
      )
    },

    bulkResolveResourceSuggestions(matterId, input, options): Promise<MatterSuggestionBulkResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/resource-suggestions/bulk`,
        mutationRequest(options, { action: input.action, resource_ids: input.resourceIds })
      )
    },

    discoverResourceSuggestions(matterId, input = {}): Promise<MatterResourceDiscoveryResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/resource-suggestions/discover`,
        {
          body: {
            query: input.query,
            expand_reason: input.expandReason,
            limit: input.limit
          }
        }
      )
    },

    listResourceCandidates(matterId, options = {}): Promise<MatterResourceCandidateResult> {
      return request(baseUrl, 'GET', `/matters/${segment(matterId)}/resource-candidates`, {
        query: { limit: options.limit }
      })
    },

    async listResourceAttachments(matterId, options = {}): Promise<MatterResourceAttachment[]> {
      const result = await request<{ items: MatterResourceAttachment[] }>(
        baseUrl,
        'GET',
        `/matters/${segment(matterId)}/resource-attachments`,
        { query: { limit: options.limit } }
      )
      return result.items
    },

    async listRelations(matterId, options = {}): Promise<MatterRelation[]> {
      const result = await request<{ items: MatterRelation[] }>(
        baseUrl,
        'GET',
        `/matters/${segment(matterId)}/relations`,
        { query: { direction: options.direction } }
      )
      return result.items
    },

    createRelation(matterId, input, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/relations`,
        mutationRequest(options, input)
      )
    },

    deleteRelation(matterId, relationId, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'DELETE',
        `/matters/${segment(matterId)}/relations/${segment(relationId)}`,
        mutationRequest(options)
      )
    },

    async listStakeholders(matterId, options = {}): Promise<MatterStakeholder[]> {
      const result = await request<{ items: MatterStakeholder[] }>(
        baseUrl,
        'GET',
        `/matters/${segment(matterId)}/stakeholders`,
        {
          query: {
            waiting_only: options.waitingOnly,
            include_deleted: options.includeDeleted
          }
        }
      )
      return result.items
    },

    createStakeholder(matterId, input, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/stakeholders`,
        mutationRequest(options, input)
      )
    },

    patchStakeholder(matterId, stakeholderId, input, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'PATCH',
        `/matters/${segment(matterId)}/stakeholders/${segment(stakeholderId)}`,
        mutationRequest(options, input)
      )
    },

    deleteStakeholder(matterId, stakeholderId, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'DELETE',
        `/matters/${segment(matterId)}/stakeholders/${segment(stakeholderId)}`,
        mutationRequest(options)
      )
    },

    restoreStakeholder(matterId, stakeholderId, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/stakeholders/${segment(stakeholderId)}/restore`,
        mutationRequest(options)
      )
    },

    lookupResourceLinks(provider, keys): Promise<MatterResourceLookupResponse> {
      return request(baseUrl, 'GET', '/matters/links/by-resource', {
        query: { provider, keys: keys.join(',') }
      })
    },

    timeline(matterId, cursor, limit = 50): Promise<MatterTimelineResponse> {
      return request(baseUrl, 'GET', `/matters/${segment(matterId)}/timeline`, {
        query: { cursor, limit }
      })
    },

    addNote(matterId, input, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/notes`,
        mutationRequest(options, input)
      )
    },
    listRuns(matterId): Promise<MatterRunListResponse> {
      return request(baseUrl, 'GET', `/matters/${segment(matterId)}/runs`)
    },
    async getRun(matterId, runId): Promise<MatterRun> {
      const result = await request<{ run: MatterRun }>(
        baseUrl,
        'GET',
        `/matters/${segment(matterId)}/runs/${segment(runId)}`
      )
      return result.run
    },
    startRun(matterId, options): Promise<MatterRunStartResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/runs`,
        mutationRequest(options)
      )
    },
    cancelRun(matterId, runId): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/runs/${segment(runId)}/cancel`,
        mutationRequest({ expectedVersion: null })
      )
    },
    listUpdates(matterId, reviewStatus): Promise<MatterUpdateListResponse> {
      return request(baseUrl, 'GET', `/matters/${segment(matterId)}/updates`, {
        query: { review_status: reviewStatus }
      })
    },
    async getUpdate(matterId, updateId): Promise<MatterUpdate> {
      const result = await request<{ update: MatterUpdate }>(
        baseUrl,
        'GET',
        `/matters/${segment(matterId)}/updates/${segment(updateId)}`
      )
      return result.update
    },
    acceptUpdate(matterId, updateId, input, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/updates/${segment(updateId)}/accept`,
        mutationRequest(options, input)
      )
    },
    rejectUpdate(matterId, updateId, reason, options): Promise<MatterMutationResult> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/updates/${segment(updateId)}/reject`,
        mutationRequest(options, { reason })
      )
    },
    listAttention(state = 'open', kind): Promise<MatterAttentionListResponse> {
      return request(baseUrl, 'GET', '/matters/attention', { query: { state, kind } })
    },
    listMatterAttention(matterId, state = 'open', kind): Promise<MatterAttentionListResponse> {
      return request(baseUrl, 'GET', `/matters/${segment(matterId)}/attention`, {
        query: { state, kind }
      })
    },
    resolveAttention(matterId, signalId): Promise<MatterAttentionSignal> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/attention/${segment(signalId)}/resolve`,
        mutationRequest({ expectedVersion: null })
      )
    },
    snoozeAttention(matterId, signalId, input): Promise<MatterAttentionSignal> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/attention/${segment(signalId)}/snooze`,
        mutationRequest({ expectedVersion: null }, input)
      )
    },
    dismissAttention(matterId, signalId, reason): Promise<MatterAttentionSignal> {
      return request(
        baseUrl,
        'POST',
        `/matters/${segment(matterId)}/attention/${segment(signalId)}/dismiss`,
        mutationRequest({ expectedVersion: null }, reason ? { reason } : {})
      )
    },
    getNotifyLevel(): Promise<MatterNotifyLevelResponse> {
      return request(baseUrl, 'GET', '/matters/notify-level')
    },
    setNotifyLevel(level: MatterNotifyLevel): Promise<MatterNotifyLevelResponse> {
      return request(baseUrl, 'PUT', '/matters/notify-level', { body: { level } })
    }
  }
}

// ── Matter Chat (P3) ───────────────────────────────────────────────────────────────────────────
// The two endpoints the chat panel owns (lane ②: routers/matters.py :186 / :197) plus the undo
// executor remain a separate API surface because they serve Matter Chat rather than aggregate CRUD.

/** Bounded matter projection served by `GET /matters/{public_id}/context-snapshot` (D5). Fields
 *  mirror `MatterService.context_snapshot`; everything is already capped server-side (items ≤50,
 *  stakeholders ≤20, pinned resources ≤10 with ≤2000-char excerpts, events ≤30). */
export interface MatterContextSnapshotPayload {
  matter: {
    id: number
    public_id: string
    title: string
    type: string | null
    tags: string[]
    status: string
    health: string
    priority: string
    due_at: number | null
    waiting_context: Record<string, unknown> | null
    description: string
    current_summary: string | null
    version: number
    summary_accepted_at: number | null
  }
  items: Array<Record<string, unknown>>
  stakeholders: Array<Record<string, unknown>>
  resources: Array<{
    id: number
    kind: string
    provider: string
    external_key: string
    title: string | null
    canonical_url: string | null
    revision: string | null
    access_policy: string
    metadata: Record<string, unknown>
    excerpt: string | null
  }>
  /** 🔴 `resources` 上面那个数组是**投影**（pinned 或未确认的 agent 建议），不是「这个事项
   *  有多少资料」。这里是不受该投影限制的真实计数 —— 判断「缺不缺上下文」必须用它，
   *  用 `resources.length === 0` 会形成自噬循环（把 agent 建议全确认掉 ⇒ 投影归零 ⇒
   *  弹缺上下文卡 ⇒ 外扩灌垃圾）。旧后端不发此字段 ⇒ optional。 */
  resource_counts?: {
    linked_resources: number
    confirmed_resources: number
    unconfirmed_suggestions: number
  }
  events: Array<{
    kind: string
    happened_at: number
    actor_kind: string
    summary: string
  }>
}

/** The `undo` descriptor a matter write tool returns (service.py `_undo_descriptor`). */
export interface MatterUndoDescriptor {
  tool: string
  input: Record<string, unknown>
  label: string
}

/** A resolved undo → one REST call. Split out from the executor so the tool→REST mapping is a
 *  pure function with its own unit test (the executor is just `request()` + envelope). */
export interface MatterUndoRequest {
  method: 'POST' | 'PATCH' | 'DELETE'
  /** Path relative to the api base (already URL-encoded). */
  path: string
  /** Body fields sent alongside the mutation envelope. */
  fields: Record<string, unknown>
  expectedVersion: number | null
  reversesEventId: number | null
}

export interface MatterChatApi {
  contextSnapshot(matterId: string): Promise<MatterContextSnapshotPayload>
  /** Execute one undo descriptor (renderer-direct REST, no LLM). Resolves to the mutation result;
   *  rejects with `Error & {code}` — `E_VERSION_CONFLICT` when the matter moved on. */
  applyUndo(
    descriptor: MatterUndoDescriptor,
    options?: MatterMutationOptions
  ): Promise<MatterMutationResult>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/** child-entity undo shapes are structurally identical across item / resource / stakeholder /
 *  relation — one mapper, four collection names + four id/create-payload keys. */
function resolveChildUndo(
  publicId: string,
  collection: 'items' | 'resources' | 'stakeholders' | 'relations',
  idKey: string,
  createKey: string,
  createOperation: 'create' | 'link',
  deleteOperation: 'delete' | 'unlink',
  input: Record<string, unknown>
): Pick<MatterUndoRequest, 'method' | 'path' | 'fields'> | null {
  const base = `/matters/${segment(publicId)}/${collection}`
  const operation = input.operation
  if (operation === createOperation) {
    const fields = asRecord(input[createKey])
    // resource link may carry a bare resource_id instead of a full resource payload.
    const resourceId = asPositiveInt(input[idKey])
    return {
      method: 'POST',
      path: base,
      fields:
        Object.keys(fields).length > 0 ? fields : resourceId != null ? { [idKey]: resourceId } : {}
    }
  }
  const childId = asPositiveInt(input[idKey])
  if (childId == null) return null
  const childPath = `${base}/${segment(childId)}`
  if (operation === 'update')
    return { method: 'PATCH', path: childPath, fields: asRecord(input.patch) }
  if (operation === deleteOperation) return { method: 'DELETE', path: childPath, fields: {} }
  if (operation === 'restore') return { method: 'POST', path: `${childPath}/restore`, fields: {} }
  return null
}

/**
 * Map an undo descriptor onto the REST call that performs it. Returns null for a descriptor this
 * client cannot execute (unknown tool / operation / missing child id) — the caller surfaces that as
 * a plain failure rather than firing a half-understood write.
 *
 * 🔴 The tool→REST table mirrors `ai-gateway/python/domainClient.ts` (the gateway's own matter
 * methods); both talk to the SAME `/api/matters/*` routes, and the undo path deliberately does NOT
 * go through the model.
 */
export function resolveMatterUndoRequest(
  descriptor: MatterUndoDescriptor
): MatterUndoRequest | null {
  const input = asRecord(descriptor.input)
  const publicId = typeof input.public_id === 'string' ? input.public_id : ''
  if (publicId.length === 0) return null
  const expectedVersion = asPositiveInt(input.expected_version)
  const reversesEventId = asPositiveInt(input.reverses_event_id)
  const operation = input.operation

  let resolved: Pick<MatterUndoRequest, 'method' | 'path' | 'fields'> | null = null
  if (descriptor.tool === 'matter_update') {
    const path = `/matters/${segment(publicId)}`
    if (operation === 'patch') {
      resolved = { method: 'PATCH', path, fields: asRecord(input.patch) }
    } else if (
      operation === 'archive' ||
      operation === 'reopen' ||
      operation === 'trash' ||
      operation === 'restore'
    ) {
      resolved = { method: 'POST', path: `${path}/${operation}`, fields: {} }
    }
  } else if (descriptor.tool === 'matter_item_mutate') {
    resolved = resolveChildUndo(publicId, 'items', 'item_id', 'item', 'create', 'delete', input)
  } else if (descriptor.tool === 'matter_resource_mutate') {
    resolved = resolveChildUndo(
      publicId,
      'resources',
      'resource_id',
      'resource',
      'link',
      'unlink',
      input
    )
  } else if (descriptor.tool === 'matter_stakeholder_mutate') {
    resolved = resolveChildUndo(
      publicId,
      'stakeholders',
      'stakeholder_id',
      'stakeholder',
      'create',
      'delete',
      input
    )
  } else if (descriptor.tool === 'matter_relation_mutate') {
    resolved = resolveChildUndo(
      publicId,
      'relations',
      'relation_id',
      'relation',
      'create',
      'delete',
      input
    )
  }
  if (resolved === null) return null
  return { ...resolved, expectedVersion, reversesEventId }
}

/**
 * G-33 —— 从一次写操作的返回里读出 undo descriptor。
 *
 * 服务端 `_mutation(...)` 恒发 `undo` 键（没有反向操作时为 `null`），但 `MatterMutationResult`
 * 是跨语言契约镜像（parity gate: `tests/matters/test_matters_contract_parity.py`），P3 已经立过
 * 「本仓这一侧只做局部加宽、不改镜像文件」的先例（见本文件顶部 `MatterUndoMutationOptions`）。
 * 这里沿用同一条纪律：不改类型，改成运行时读 + 结构校验。
 *
 * 🔴 校验不是形式主义 —— 交出去的 descriptor 会被原样执行成一次真实写入。tool/label 必须是
 * 非空字符串、input 必须是对象，任何一项不符就当作"这次操作没有反向操作"（返回 null），
 * 而不是半懂不懂地发一个请求出去。
 */
export function readMatterUndoDescriptor(result: unknown): MatterUndoDescriptor | null {
  const undo = asRecord(result).undo
  if (undo == null) return null
  const record = asRecord(undo)
  const tool = typeof record.tool === 'string' ? record.tool : ''
  const label = typeof record.label === 'string' ? record.label : ''
  if (tool.length === 0 || label.length === 0) return null
  if (record.input == null || typeof record.input !== 'object' || Array.isArray(record.input)) {
    return null
  }
  const descriptor: MatterUndoDescriptor = {
    tool,
    label,
    input: record.input as Record<string, unknown>
  }
  // 🔴 「后端给了 descriptor」≠「这个客户端执行得了」：`resolveMatterUndoRequest` 认不出的
  // tool/operation 会在点下去那一刻才失败。宁可不显示撤销按钮，也不显示一个点了报错的。
  return resolveMatterUndoRequest(descriptor) === null ? null : descriptor
}

export function createMatterChatApi(baseUrl: string): MatterChatApi {
  return {
    contextSnapshot(matterId): Promise<MatterContextSnapshotPayload> {
      return request(baseUrl, 'GET', `/matters/${segment(matterId)}/context-snapshot`)
    },

    applyUndo(descriptor, options = {}): Promise<MatterMutationResult> {
      const resolved = resolveMatterUndoRequest(descriptor)
      if (resolved === null) {
        return Promise.reject(
          Object.assign(new Error(`unsupported undo descriptor: ${descriptor.tool}`), {
            code: 'E_INVALID_ARG'
          })
        )
      }
      return request(
        baseUrl,
        resolved.method,
        resolved.path,
        mutationRequest(
          {
            ...options,
            expectedVersion: resolved.expectedVersion,
            reversesEventId: resolved.reversesEventId
          },
          resolved.fields
        )
      )
    }
  }
}

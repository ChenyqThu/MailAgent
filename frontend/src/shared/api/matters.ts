import { request } from './http_client'
import type {
  MatterDetailResponse,
  MatterItem,
  MatterListOptions,
  MatterListResponse,
  MatterMutationOptions,
  MatterMutationResult,
  MatterTimelineResponse,
  MattersApi,
  MutationEnvelope
} from './types/matter'

const DEFAULT_SOURCE = 'desktop_ui'
let fallbackKeyCounter = 0

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

function mutation(options: MatterMutationOptions = {}): MutationEnvelope {
  return {
    source: options.source ?? DEFAULT_SOURCE,
    idempotency_key: uuid(),
    expected_version: options.expectedVersion ?? null,
    reason: options.reason ?? null
  }
}

function mutationRequest(
  options: MatterMutationOptions,
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

    get(matterId, include = []): Promise<MatterDetailResponse> {
      return request(baseUrl, 'GET', `/matters/${segment(matterId)}`, {
        query: { include: include.length > 0 ? include.join(',') : undefined }
      })
    },

    patch(matterId, input, options): Promise<MatterMutationResult> {
      return request(baseUrl, 'PATCH', `/matters/${segment(matterId)}`, mutationRequest(options, input))
    },

    archive(matterId, options): Promise<MatterMutationResult> {
      return request(baseUrl, 'POST', `/matters/${segment(matterId)}/archive`, mutationRequest(options))
    },

    reopen(matterId, options): Promise<MatterMutationResult> {
      return request(baseUrl, 'POST', `/matters/${segment(matterId)}/reopen`, mutationRequest(options))
    },

    trash(matterId, options): Promise<MatterMutationResult> {
      return request(baseUrl, 'POST', `/matters/${segment(matterId)}/trash`, mutationRequest(options))
    },

    restore(matterId, options): Promise<MatterMutationResult> {
      return request(baseUrl, 'POST', `/matters/${segment(matterId)}/restore`, mutationRequest(options))
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
    }
  }
}

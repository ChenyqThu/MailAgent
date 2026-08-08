export interface QueuedInputDispatchDeps {
  hasActiveRun(sessionId: number): boolean
  compactActive(sessionId: number): boolean
  listDispatchable(sessionId: number): { id: number; content: string }[]
  claim(ids: number[], now: number): number[]
  revert(ids: number[]): void
  listSessionUIMessages(sessionId: number): unknown[]
  getSessionModel(sessionId: number): string | null
  postChat(body: unknown): Promise<{ ok: boolean; drain(): Promise<void> }>
  broadcast(sessionId: number): void
  now(): number
  sleep(ms: number): Promise<void>
}

const COMPACT_WAIT_LIMIT_MS = 300_000
const COMPACT_WAIT_STEP_MS = 2_000

function escapeXmlText(content: string): string {
  return content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function buildQueuedFollowupsEnvelope(contents: string[]): string {
  return `<queued_followups>\n${contents
    .map((content) => `  <message>${escapeXmlText(content)}</message>`)
    .join('\n')}\n</queued_followups>`
}

export async function runQueuedInputDispatch(
  deps: QueuedInputDispatchDeps,
  sessionId: number
): Promise<void> {
  if (deps.hasActiveRun(sessionId)) return

  const waitStartedAt = deps.now()
  while (deps.compactActive(sessionId)) {
    if (deps.now() - waitStartedAt >= COMPACT_WAIT_LIMIT_MS) {
      console.warn('[ai-gateway] queued-input dispatch timed out waiting for compact', {
        sessionId
      })
      return
    }
    await deps.sleep(COMPACT_WAIT_STEP_MS)
    if (deps.hasActiveRun(sessionId)) return
  }

  const queued = deps.listDispatchable(sessionId)
  if (queued.length === 0) return
  const claimedIds = deps.claim(
    queued.map((item) => item.id),
    deps.now()
  )
  if (claimedIds.length === 0) return
  deps.broadcast(sessionId)

  const claimedIdSet = new Set(claimedIds)
  const claimed = queued.filter((item) => claimedIdSet.has(item.id))
  const envelope = buildQueuedFollowupsEnvelope(claimed.map((item) => item.content))
  const messages = deps.listSessionUIMessages(sessionId)
  const model = deps.getSessionModel(sessionId)
  const queuedMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: envelope }],
    metadata: { queuedInputDispatch: { rowIds: claimedIds } }
  }

  try {
    const response = await deps.postChat({
      messages: [...messages, queuedMessage],
      sessionId,
      ...(model ? { model } : {})
    })
    await response.drain()
    if (!response.ok) {
      deps.revert(claimedIds)
      deps.broadcast(sessionId)
    }
  } catch (error) {
    deps.revert(claimedIds)
    deps.broadcast(sessionId)
    console.warn('[ai-gateway] queued-input dispatch request failed', {
      sessionId,
      count: claimedIds.length,
      error: error instanceof Error ? error.name : 'unknown'
    })
  }
}

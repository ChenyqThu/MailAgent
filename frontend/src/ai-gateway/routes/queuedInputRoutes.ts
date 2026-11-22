// Queued-input and manual compact handlers.
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { type AiGatewayConfig } from '../config'
import { readJsonBody, writeJson } from '../httpUtil'
import { CompactCoordinator } from '../compact'

function queuedInputNotImplemented(res: ServerResponse): void {
  writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'queued input not enabled' })
}

function parsePositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

export async function handleQueuedInputList(
  res: ServerResponse,
  cfg: AiGatewayConfig,
  rawUrl: string
): Promise<void> {
  if (!cfg.queuedInputStore) return queuedInputNotImplemented(res)
  const raw = new URL(rawUrl, 'http://127.0.0.1').searchParams.get('sessionId')
  const sessionId = raw == null ? null : Number.parseInt(raw, 10)
  if (sessionId == null || !Number.isInteger(sessionId) || sessionId <= 0) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (integer) required' })
    return
  }
  writeJson(res, 200, { items: cfg.queuedInputStore.list(sessionId) })
}

export async function handleQueuedInputEnqueue(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.queuedInputStore) return queuedInputNotImplemented(res)
  const body = await readJsonBody(req)
  const sessionId = parsePositiveInteger(body.sessionId)
  if (sessionId == null || typeof body.content !== 'string') {
    writeJson(res, 400, { error: 'E_INVALID_ARG' })
    return
  }
  try {
    const item = cfg.queuedInputStore.enqueue(sessionId, body.content)
    cfg.onQueuedInputChanged?.(sessionId)
    if (!cfg.activeRuns?.hasActive(sessionId)) cfg.dispatchQueuedInputIfIdle?.(sessionId)
    writeJson(res, 200, { item })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'E_INVALID_ARG'
    writeJson(res, 400, { error: code === 'E_QUEUE_FULL' ? code : 'E_INVALID_ARG' })
  }
}

export async function handleQueuedInputMutation(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig,
  action: 'update' | 'cancel' | 'send'
): Promise<void> {
  if (!cfg.queuedInputStore) return queuedInputNotImplemented(res)
  const body = await readJsonBody(req)
  const id = parsePositiveInteger(body.id)
  if (id == null || (action === 'update' && typeof body.content !== 'string')) {
    writeJson(res, 400, { error: 'E_INVALID_ARG' })
    return
  }
  const existing = cfg.queuedInputStore.get(id)
  if (!existing) {
    writeJson(res, 409, { error: 'E_QUEUED_INPUT_STATE' })
    return
  }
  try {
    const changed =
      action === 'update'
        ? cfg.queuedInputStore.update(id, body.content as string)
        : action === 'cancel'
          ? cfg.queuedInputStore.cancel(id)
          : cfg.queuedInputStore.confirm(id)
    if (!changed) {
      writeJson(res, 409, { error: 'E_QUEUED_INPUT_STATE' })
      return
    }
    cfg.onQueuedInputChanged?.(existing.sessionId)
    if (action === 'send') cfg.dispatchQueuedInputIfIdle?.(existing.sessionId)
    writeJson(res, 200, { ok: true })
  } catch {
    writeJson(res, 400, { error: 'E_INVALID_ARG' })
  }
}

/**
 * `POST /api/ai/queued-input/interrupt { id }` — stop the session's current run and send this one
 * queued row now. Unlike /run/stop nothing is restored: the other queued rows stay queued and the
 * interrupt run's own onFinish drains them afterwards. Rows the stopped run had already claimed
 * (a dispatch run being interrupted) are handed to the dispatcher to CAS back to queued — an
 * aborted run never persists them — unless an approval is pending for the session, in which case
 * the claimed rows belong to the paused run and get marked sent on its resume. The dedup gate is
 * claim() alone: the dispatcher runs on the per-session post-turn chain, so an onFinish drain
 * racing this endpoint claims the row first and the interrupt dispatch then finds nothing to send.
 */
export async function handleQueuedInputInterrupt(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig
): Promise<void> {
  if (!cfg.queuedInputStore) return queuedInputNotImplemented(res)
  const body = await readJsonBody(req)
  const id = parsePositiveInteger(body.id)
  if (id == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG' })
    return
  }
  const existing = cfg.queuedInputStore.get(id)
  if (
    !existing ||
    (existing.status !== 'queued' && existing.status !== 'restored') ||
    (existing.status === 'restored' && !cfg.queuedInputStore.confirm(id))
  ) {
    writeJson(res, 409, { error: 'E_QUEUED_INPUT_STATE' })
    return
  }
  const sessionId = existing.sessionId
  const stopped = cfg.activeRuns?.stop(sessionId).stopped === true
  const approvalPending = cfg.approvalStash?.peekBySession(sessionId) != null
  const revertIds =
    stopped && !approvalPending
      ? cfg.queuedInputStore
          .list(sessionId)
          .filter((item) => item.status === 'claimed')
          .map((item) => item.id)
      : []
  cfg.onQueuedInputChanged?.(sessionId)
  cfg.dispatchQueuedInputInterrupt?.(sessionId, id, revertIds)
  writeJson(res, 200, { ok: true, stopped })
}

export async function handleCompact(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AiGatewayConfig,
  coordinator: CompactCoordinator | null
): Promise<void> {
  if (!coordinator) {
    writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'chat compact not enabled' })
    return
  }
  const body = await readJsonBody(req)
  const sessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (integer) required' })
    return
  }
  if (cfg.activeRuns?.hasActive(sessionId)) {
    writeJson(res, 409, { error: 'E_RUN_ACTIVE', hint: 'chat run active for session' })
    return
  }
  if (coordinator.hasActive(sessionId)) {
    writeJson(res, 409, { error: 'E_COMPACT_ACTIVE', hint: 'compact active for session' })
    return
  }
  try {
    writeJson(res, 200, await coordinator.run(sessionId))
  } catch (err) {
    if (err instanceof Error && err.message === 'E_COMPACT_ACTIVE') {
      writeJson(res, 409, { error: 'E_COMPACT_ACTIVE', hint: 'compact active for session' })
      return
    }
    writeJson(res, 500, {
      error: 'E_COMPACT_FAILED',
      hint: err instanceof Error ? err.message : String(err)
    })
  }
}

export async function handleCompactStop(
  req: IncomingMessage,
  res: ServerResponse,
  coordinator: CompactCoordinator | null
): Promise<void> {
  if (!coordinator) {
    writeJson(res, 404, { error: 'E_NOT_IMPLEMENTED', hint: 'chat compact not enabled' })
    return
  }
  const body = await readJsonBody(req)
  const sessionId =
    typeof body.sessionId === 'number' && Number.isInteger(body.sessionId) ? body.sessionId : null
  if (sessionId == null) {
    writeJson(res, 400, { error: 'E_INVALID_ARG', hint: 'sessionId (integer) required' })
    return
  }
  writeJson(res, 200, { stopped: coordinator.stop(sessionId) })
}

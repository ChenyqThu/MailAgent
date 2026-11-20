// Phase 5 (WP-5B.3) — Session-scoped temporary MCP connector mute store.
// Holds per-session disabled connector IDs strictly in renderer memory so turning
// a connector off for ONE chat session never mutates the global `connector.enabled`
// toggle or affects other sessions / background agents.

import { useCallback, useSyncExternalStore } from 'react'

const EMPTY_IDS: readonly string[] = Object.freeze([])

const mutedBySession = new Map<string, Set<string>>()
const snapshotBySession = new Map<string, readonly string[]>()
const listeners = new Set<() => void>()

function emitChange(): void {
  for (const listener of listeners) listener()
}

function syncSnapshot(sessionKey: string): void {
  const cur = mutedBySession.get(sessionKey)
  if (!cur || cur.size === 0) {
    mutedBySession.delete(sessionKey)
    snapshotBySession.delete(sessionKey)
    return
  }
  snapshotBySession.set(sessionKey, Object.freeze([...cur].sort()))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return (): void => {
    listeners.delete(listener)
  }
}

export function sessionKeyForId(sessionId: number | null | undefined): string {
  return sessionId != null ? String(sessionId) : 'draft'
}

export function getSessionDisabledConnectors(sessionKey: string): readonly string[] {
  return snapshotBySession.get(sessionKey) ?? EMPTY_IDS
}

export function toggleConnectorForSession(sessionKey: string, connectorId: string): void {
  if (!connectorId) return
  let set = mutedBySession.get(sessionKey)
  if (!set) {
    set = new Set<string>()
    mutedBySession.set(sessionKey, set)
  }
  if (set.has(connectorId)) {
    set.delete(connectorId)
  } else {
    set.add(connectorId)
  }
  syncSnapshot(sessionKey)
  emitChange()
}

export function clearDisabledForSession(sessionKey: string): void {
  if (!mutedBySession.has(sessionKey)) return
  mutedBySession.delete(sessionKey)
  snapshotBySession.delete(sessionKey)
  emitChange()
}

/** Move temporary draft-session mutes onto a newly-created session id on first send. */
export function promoteDraftDisabledConnectors(sessionId: number): void {
  const draftSet = mutedBySession.get('draft')
  if (!draftSet || draftSet.size === 0) return
  const nextKey = String(sessionId)
  let target = mutedBySession.get(nextKey)
  if (!target) {
    target = new Set<string>()
    mutedBySession.set(nextKey, target)
  }
  for (const id of draftSet) target.add(id)
  mutedBySession.delete('draft')
  snapshotBySession.delete('draft')
  syncSnapshot(nextKey)
  emitChange()
}

export function useSessionDisabledConnectors(sessionKey: string): {
  disabledIds: readonly string[]
  toggleConnector: (connectorId: string) => void
  clearAll: () => void
} {
  const getSnap = useCallback(
    (): readonly string[] => getSessionDisabledConnectors(sessionKey),
    [sessionKey]
  )
  const disabledIds = useSyncExternalStore(subscribe, getSnap, getSnap)
  const toggleConnector = useCallback(
    (connectorId: string): void => toggleConnectorForSession(sessionKey, connectorId),
    [sessionKey]
  )
  const clearAll = useCallback(
    (): void => clearDisabledForSession(sessionKey),
    [sessionKey]
  )
  return { disabledIds, toggleConnector, clearAll }
}

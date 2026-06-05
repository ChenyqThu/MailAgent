// Sprint 4 — backend registry. Pluggable swap point for Task #11 (Custom
// API direct fetch) + Task #12 (Notion Agent subprocess). Tests inject a
// mock backend through `registerChatBackend()`; production registers the
// real two at app boot in index.ts.

import type { BackendKind } from '../chat_db'
import type { ChatBackend } from '@shared/chat/types'

const _backends = new Map<BackendKind, ChatBackend>()

export function registerChatBackend(backend: ChatBackend): void {
  _backends.set(backend.kind, backend)
}

export function getChatBackend(kind: BackendKind): ChatBackend {
  const b = _backends.get(kind)
  if (!b) {
    throw new Error(
      `No chat backend registered for kind="${kind}". ` +
        `Sprint 4 ships notion-agent + custom-api; check main process boot.`
    )
  }
  return b
}

export function listRegisteredBackendKinds(): BackendKind[] {
  return [..._backends.keys()]
}

/** Test-only — clear all registrations between specs. */
export function __resetBackendRegistry(): void {
  _backends.clear()
}

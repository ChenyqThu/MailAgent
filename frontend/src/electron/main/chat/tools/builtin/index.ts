// Sprint 19 PR-1b — Builtin tool registration entry point.
//
// Called once at main-process boot (frontend/src/electron/main/index.ts after
// registerChatBackend()) to populate the default ToolRegistry singleton.
// Tests use a fresh registry via createToolRegistry() and call this with it
// to mirror production wiring without sharing state.

import type { ToolRegistry } from '../registry'
import { allEmailTools } from './email'
import { allAttachmentTools } from './attachment'

/** Register every M1 builtin tool. Idempotency: the registry's
 *  `register()` throws on duplicate name, so calling this twice is an
 *  error — caller must use `__reset()` first if testing re-registration. */
export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const tool of allEmailTools) {
    registry.register(tool)
  }
  for (const tool of allAttachmentTools) {
    registry.register(tool)
  }
}

export { allEmailTools, allAttachmentTools }

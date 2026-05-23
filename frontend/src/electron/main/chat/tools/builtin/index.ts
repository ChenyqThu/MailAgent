// Sprint 19 PR-1b — Builtin tool registration entry point.
//
// Called once at main-process boot (frontend/src/electron/main/index.ts after
// registerChatBackend()) to populate the default ToolRegistry singleton.
// Tests use a fresh registry via createToolRegistry() and call this with it
// to mirror production wiring without sharing state.

import type { ToolRegistry } from '../registry'
import { allEmailTools } from './email'
import { allAttachmentTools } from './attachment'
import { allWriteTools } from './write'

/** Register every M1 builtin tool. Idempotency: the registry's
 *  `register()` throws on duplicate name, so calling this twice is an
 *  error — caller must use `__reset()` first if testing re-registration.
 *
 *  M1 catalog (10 tools):
 *    Read  (7): email_search / email_get / email_body / email_list_thread /
 *               email_search_fulltext / email_get_ai_fields / attachment_list
 *    Write (3): email_flag / email_archive / email_draft_reply
 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const tool of allEmailTools) {
    registry.register(tool)
  }
  for (const tool of allAttachmentTools) {
    registry.register(tool)
  }
  for (const tool of allWriteTools) {
    registry.register(tool)
  }
}

export { allEmailTools, allAttachmentTools, allWriteTools }

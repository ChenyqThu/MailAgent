// Sprint 19 PR-1b — Builtin tool registration entry point.
//
// Called once at main-process boot (frontend/src/electron/main/index.ts after
// registerChatBackend()) to populate the default ToolRegistry singleton.
// Tests use a fresh registry via createToolRegistry() and call this with it
// to mirror production wiring without sharing state.

import type { ToolRegistry } from '../registry'
import { isKosConsumerEnabled } from '../../config'
import { allEmailTools } from './email'
import { allAttachmentTools } from './attachment'
import { allWriteTools } from './write'
import { allKosTools } from './kos'

/** Register every builtin tool. Idempotency: the registry's `register()`
 *  throws on duplicate name, so calling this twice is an error — caller
 *  must use `__reset()` first if testing re-registration.
 *
 *  Default catalog (11 tools, M1 + PR-2b):
 *    Read  (8): email_search / email_get / email_body / email_list_thread /
 *               email_search_fulltext / email_get_ai_fields /
 *               attachment_list / email_search_attachments
 *    Write (3): email_flag / email_archive / email_draft_reply
 *
 *  PR-2e gated (+2 tools when MAILAGENT_KOS_CONSUMER_ENABLED=true):
 *    Meta  (2): kos_query / kos_digest — cross-domain KOS retrieval
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
  if (isKosConsumerEnabled()) {
    for (const tool of allKosTools) {
      registry.register(tool)
    }
  }
}

export { allEmailTools, allAttachmentTools, allWriteTools, allKosTools }

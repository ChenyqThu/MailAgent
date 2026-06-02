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
 *  KOS gated (+9 tools when MAILAGENT_KOS_CONSUMER_ENABLED=true):
 *    Meta read  (7): kos_query / kos_digest / kos_recall / kos_find_experts /
 *                    kos_get_page / kos_list_skills / kos_get_skill
 *    Meta write (2): kos_extract_facts / kos_put_page (confirm-tier → ConfirmToolDialog;
 *                    write the default personal brain)
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
  const kosOn = isKosConsumerEnabled()
  if (kosOn) {
    for (const tool of allKosTools) {
      registry.register(tool)
    }
  }
  // Boot log — dogfood-checklist L3.1 用这个验证 flag + tool catalog 正确.
  // 跑 vitest 时 isVerboseTest 走 silent path 避免 noise; 实际 Electron
  // main-process 启动时会打印一行到 terminal.
  if (process.env.NODE_ENV !== 'test') {
    const names = registry.names().sort()
    // eslint-disable-next-line no-console
    console.log(
      `[Sprint 19] registered ${names.length} builtin tools (KOS consumer=${kosOn ? 'on' : 'off'}): ${names.join(', ')}`
    )
  }
}

export { allEmailTools, allAttachmentTools, allWriteTools, allKosTools }

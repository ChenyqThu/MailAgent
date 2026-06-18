// V2.1 阶段 3 — 3b-4：Builtin tool factory（从 electron `chat/tools/builtin/index.ts`
// 下沉 shared，取代 module-global `registerBuiltinTools(registry)`）。
//
// createBuiltinTools(platform) 返回 ToolDef[]（每个工具的 handler 闭包持注入的
// ChatToolPlatform）。dispatcher 持有的 ToolRegistry 注入这批工具，harness 经 registry
// 取工具 —— main / 3c renderer 各自用对应 platform（electron / http）构造一份 registry，
// 零 parity。本文件零 Electron import（不变式 1，pnpm build:web 验证）。
//
//   Default catalog (20 tools):
//     Read  (11): email_search / email_get / email_body / email_list_thread /
//                 email_search_fulltext / email_get_ai_fields / email_list_folders /
//                 attachment_list / email_search_attachments /
//                 report_list / report_get
//     Write  (9): email_flag / email_archive / email_draft_reply /
//                 email_set_reply_suggestion / email_set_ai_fields / email_pin /
//                 email_move / email_resync / report_run
//
//   KOS gated (+9 tools when platform.kosConfig().configured = true):
//     Meta read  (7): kos_query / kos_digest / kos_recall / kos_find_experts /
//                     kos_get_page / kos_list_skills / kos_get_skill
//     Meta write (2): kos_extract_facts / kos_put_page (confirm-tier → ConfirmToolDialog)

import type { ToolDef } from '../registry'
import type { ChatToolPlatform } from '../../platform'
import { createEmailTools } from './email'
import { createAttachmentTools } from './attachment'
import { createWriteTools } from './write'
import { createReportTools } from './report'
import { createKosTools } from './kos'

/** Build every builtin tool bound to the injected platform. The 20 default
 *  tools always register; the 9 KOS tools register only when
 *  `platform.kosConfig().configured` is true (electron: isKosConsumerEnabled()
 *  — zero-regression registration gate; http: serve-api kos-available). */
export function createBuiltinTools(platform: ChatToolPlatform): ToolDef[] {
  const tools: ToolDef[] = [
    ...createEmailTools(platform),
    ...createAttachmentTools(platform),
    ...createWriteTools(platform),
    ...createReportTools(platform)
  ]
  if (platform.kosConfig().configured) {
    tools.push(...createKosTools(platform))
  }
  return tools
}

export {
  createEmailTools,
  createAttachmentTools,
  createWriteTools,
  createReportTools,
  createKosTools
}

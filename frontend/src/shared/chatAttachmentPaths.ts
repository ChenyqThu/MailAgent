// 对话附件的落盘位置 —— **零依赖叶子**（只有一个 type-only import，无运行时 import、无副作用）。
//
// 两处在写「对话附件」，落点必须是同一个：
//   · renderer 侧 `shared/lib/chat-attachments.ts` —— 用户发送的附件（发送即入库）；
//   · gateway 侧 `ai-gateway/tools/image.ts` —— generate_image 生成的图片。
// 而这两个文件互相 import 不了（前者拉 renderer 的 api 层，后者顶层拉 node:fs / ai）。按
// CLAUDE.md「跨边界手抄常量先问能不能消灭镜像」的处方，落点算法下沉到这里由两侧共用，
// 而不是各写一份月份分桶再加闸。

import type { TopLevelSlug } from './libraryConstants'

/** 对话附件的落盘根。写成带类型标注的字面量而不是 `TOP_LEVEL_SLUGS[1]`：常量叶子里改了名
 *  这一行会红，而下标写法只会静默错位。 */
export const CHAT_ATTACHMENTS_SLUG: TopLevelSlug = 'chat-attachments'

/** 按月分桶的落盘目录（本地时区 —— 用户找文件时想的是「我这个月发的那份」）。 */
export function chatAttachmentParentPath(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${CHAT_ATTACHMENTS_SLUG}/${now.getFullYear()}-${month}`
}

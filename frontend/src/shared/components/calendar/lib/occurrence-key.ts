// 选中锚点 / 改期 override 的同一把尺子 —— `${id}-${occurrence_start_iso}`。
//
// 🔴 有意是**零依赖叶子模块**: 原本住在 lib/key-nav.ts, 但那个文件顶层拉
// hooks/useCalendarEvents (react-query + mailApi), 想在 node 环境直测的纯函数
// (lib/conflict.ts) 一 import 就把整条链拖进来。手抄一份 `${id}-${start}` 等于
// 用两把尺子 (形状一变 override 静默失配), 所以下沉而不是复制。
// key-nav.ts 原样再导出, 既有 4 处消费点无需改。

import type { CalendarEventOccurrence } from '@shared/api/types'

export function occurrenceKey(occ: CalendarEventOccurrence): string {
  return `${occ.id}-${occ.occurrence_start_iso}`
}

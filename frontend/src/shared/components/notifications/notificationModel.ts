// 通知面板的纯呈现逻辑（task 08-20-notification-center 步骤 7）。
//
// 与组件分家的理由和 `contactListModel.ts` / `matterTimelineModel.ts` 一样：这几个函数是
// 可单测的纯函数，留在 .tsx 里既不能 export（react-refresh/only-export-components）也不好
// 测。这里**只有**分日与相对时间口径 —— 图标/色调映射带 lucide 组件，留在组件文件。
//
// 后端 list 契约不含分组：分日是纯前端呈现（design §6.3），不加分组查询参数。

/** 相对时间与钟点的分界：更近的读「N 分钟/小时前」，更远的读 HH:MM —— 分日组头已经交代
 *  了日期，钟点不歧义。mockup 的五条时间戳（2 分钟前 / 18 分钟前 / 1 小时前 / 09:41 /
 *  20:15）就是这一个阈值的产物。 */
export const RELATIVE_WINDOW_MS = 6 * 60 * 60 * 1000

export type DayBucket = 'today' | 'yesterday' | 'earlier'

function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 本地时区分日。判据是**当地零点之差**而不是 `(now-ts)/86400000`：跨夏令时那天两者差
 *  一小时，直接除会把昨天 23:30 的条目算进「今天」。`Math.round` 在这里正是吸收那一小时
 *  的容差，不是懒惰取整。 */
export function dayBucketOf(eventMs: number, nowMs: number): DayBucket {
  const days = Math.round((startOfLocalDay(nowMs) - startOfLocalDay(eventMs)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return 'earlier'
}

/** 按分日切段。**保持入参顺序**（服务端已按 `last_event_at DESC` 排好，这里不重排）；
 *  同一 bucket 只有相邻时才合段 —— 顺序乱掉时宁可切出两段可见的异常，也不静默重排掩盖。 */
export function groupByDay<T extends { lastEventAt: number }>(
  items: readonly T[],
  nowMs: number
): Array<{ bucket: DayBucket; items: T[] }> {
  const out: Array<{ bucket: DayBucket; items: T[] }> = []
  for (const item of items) {
    const bucket = dayBucketOf(item.lastEventAt, nowMs)
    const tail = out[out.length - 1]
    if (tail && tail.bucket === bucket) tail.items.push(item)
    else out.push({ bucket, items: [item] })
  }
  return out
}

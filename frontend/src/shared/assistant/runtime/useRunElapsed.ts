// WP-14 — 回合级秒表（渲染器墙钟），给 composer 上方的运行状态条用。
//
// 与工具卡那口时钟（`tools/generic/useToolElapsed.ts`）的关系：同一套契约，不同的**起点来源**。
// 工具卡只能在自己挂载的那一刻起表；运行条还有第二种起点 —— detached（后台）run 的
// `GET /api/ai/run/active` 会给 `ageMs`（「这个 run 已经跑了多久」），换算成本地 epoch 起点后
// 传进来，秒表就能**接着**那个数往上走，而不是切走再切回时从 0:00 重新开始。
//
// 沿用的三条契约（逐条对齐 useToolElapsed 的文件头）：
//   1. 没起点就不编数 —— 本 hook 只在「运行条可见」时被挂载（调用方把它放在只在进行中渲染的
//      子组件里），所以「有实例 = 有一段真实经过的时间」；实例卸载 = 回合结束，下一回合是新实例、
//      新起点，绝不把上一回合的时长带过来。
//   2. 墙钟只在 effect / timer 回调里读，绝不在 render 里读（`Date.now()` 在 render body 里是
//      不纯调用，react-hooks/purity 会抓）。
//   3. `prefers-reduced-motion` 下整条秒表不出现（返回 null），而不是冻在一个不动的读数上 ——
//      一个不再更新的「0:00」比没有更糟。
//
// 🔴 与 useToolElapsed 的一处**有意不同**：这里没有 cleanup 取终值。工具卡结束后卡还在，需要
// 把最终耗时冻住展示；运行条在回合结束的那一刻整个消失，冻一个没人看的值只会让「上一回合的
// 读数在下一回合头几百毫秒闪一下」变成可能。

import { useEffect, useRef, useState } from 'react'

import { useReducedMotion } from '@shared/hooks/useReducedMotion'

/** 刷新节拍。运行条只显示到秒，500ms 让秒位看起来跟手，又不至于每 200ms 重渲一次整条。 */
const TICK_MS = 500

/** 已运行毫秒 → `m:ss`（超过一小时 → `h:mm:ss`）。lobe 式回合秒表读法，与工具卡的
 *  `12.3s` 刻意不同：工具是「零点几秒也有信息」的短事件，回合是分钟量级。 */
export function formatRunElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const total = Math.floor(ms / 1000)
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
  return `${minutes}:${seconds}`
}

/**
 * 本回合已运行毫秒，或 `null`（reduced-motion / 首个 tick 之前）。
 *
 * @param anchorMs 回合起点的 epoch 毫秒；`null` = 没有外部起点，以本实例第一次跑 effect 的墙钟
 *                 为起点（附着 run）。detached run 传 `Date.now() - ageMs` 换算出来的值。
 */
export function useRunElapsed(anchorMs: number | null): number | null {
  const reduce = useReducedMotion()
  const [elapsed, setElapsed] = useState<number | null>(null)
  // 起点只在 effect 里写/读，render 里碰不到（react-hooks/refs）。
  const startedAtRef = useRef<number | null>(null)

  useEffect(() => {
    if (reduce) return undefined
    // anchorMs 每次 /run/active 轮询回来都是重新换算的（差几十毫秒的网络抖动），所以它**优先**：
    // 服务端的 startedAt 才是真起点，本地推算只是没有 anchor 时的兜底。
    const start = anchorMs ?? startedAtRef.current ?? Date.now()
    startedAtRef.current = start
    const id = window.setInterval(() => setElapsed(Date.now() - start), TICK_MS)
    return (): void => window.clearInterval(id)
  }, [anchorMs, reduce])

  return reduce ? null : elapsed
}

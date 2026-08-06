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
//      一个不再更新的「0.0s」比没有更糟。（08-06 提频到 100ms 后这条只会更成立，不放开。）
//
// 🔴 与 useToolElapsed 的一处**有意不同**：这里没有 cleanup 取终值。工具卡结束后卡还在，需要
// 把最终耗时冻住展示；运行条在回合结束的那一刻整个消失，冻一个没人看的值只会让「上一回合的
// 读数在下一回合头几百毫秒闪一下」变成可能。

import { useEffect, useRef, useState } from 'react'

import { useReducedMotion } from '@shared/hooks/useReducedMotion'

// ── 08-06 owner dogfood ⑤：「计时器的跳不连贯，看起来是 200ms？是不是 100ms 流畅一些」 ──
//
// 旧形态 = 500ms 一跳 + **只显示到整秒**。两者相乘出的观感正是 owner 说的「不连贯」：读数每秒
// 才变一次，而变的时刻由 tick 网格与秒边界的相位差决定 —— 同一个秒位，有时看着 0.5s 就翻、有时
// 1.0s 才翻。**只提频率不提精度治不好它**（整秒读数照样每秒才变一次），所以两件事必须一起做：
// 节拍 500ms → 100ms，读数带一位小数。
//
// 🔴 **不改成计数器累加**。参考实现的 `setDs(d => d + 1)` 一旦重挂载就归零，会直接打死 detached
// run 的「接续」行为（切走再切回时起点由 `/run/active` 的 ageMs 折算，秒表接着走）。这里维持
// 「记起点时间戳 + 每 tick 算 now − start」的形状，顺带天然免疫 setInterval 的累积漂移。
const TICK_MS = 100

/** 一位小数的最小刻度（ms）。**先向下取整到十分位再格式化**，不靠 `toFixed` 自己四舍五入 ——
 *  59_990ms 经 `(59.99).toFixed(1)` 会变成 `"60.0s"`（一个不存在的读数，且跳过了 `1m 00.0s`）。 */
const DECI_MS = 100

/** 已运行毫秒 → `12.3s` / `1m 05.2s` / `1h 02m 03.4s`。
 *
 *  与工具卡 `formatToolDuration` 的分工不变（那边分钟以上就丢小数，工具是短事件）；这边**每一档
 *  都保留十分位**：秒表的价值就在于「它还在动」，到了分钟量级把小数丢掉，读数又会退回每秒一跳。
 *
 *  分钟/小时档把整秒位补到两位（`1m 05.2s`）：这行是 `font-mono tabular-nums`，不补的话每过
 *  10 秒整串宽度就抖一次 —— 与 ② 那条「显得不整齐」是同一类毛病。 */
export function formatRunElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const deci = Math.floor(ms / DECI_MS) // 十分之一秒为单位，先截断
  const secs = (deci % 600) / 10 // 该分钟内的秒（带十分位）
  const minutes = Math.floor(deci / 600) % 60
  const hours = Math.floor(deci / 36_000)
  const padded = secs.toFixed(1).padStart(4, '0') // '05.2' / '12.7'
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${padded}s`
  if (minutes > 0) return `${minutes}m ${padded}s`
  return `${(deci / 10).toFixed(1)}s`
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

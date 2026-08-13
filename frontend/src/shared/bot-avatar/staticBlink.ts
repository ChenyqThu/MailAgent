// 灵动 bot 头像 —— 静态档眨眼 registry（模块级单例，镜像 ticker.ts 形状；
// 0813 owner 反馈「原版还有眨眼设定，好像实现没有？」—— 眨眼此前只活在 animated 档）。
//
// 渲染档位纪律（勿回退）：
//   1. 间隙真 idle：全模块只有一枚 setTimeout 臂向「下一次最早眨眼」，眨眼之间
//      零周期唤醒、零 rAF、零样式计算；rAF 只在「有实例正在眨」的 220-420ms
//      窗口内存活，走完即 cancel（不是常驻动画）。
//   2. 成本与实例数解耦：并发眨眼上限 MAX_CONCURRENT_STATIC_BLINKS —— 列表数百
//      实例同屏时每帧最多重算这几份眼几何；名额满时顺延重试（不丢不叠），
//      实例极多时表现为「每个眨得更稀」的优雅降级。
//   3. 保真度与 animated 档一致：窗口内用 blinkScaleAt + renderAvatar 高度插值
//      重算眼 path（5px 下限、闭眼保圆角），**不是** CSS scaleY 压缩近似（那是
//      v1 式眨眼，会压扁圆角且让两档观感分裂）；走完精确回写 staticFrame 缓存帧。
//   4. 眨眼节奏 = states.ts BLINK 表逐字（per-state [min,max] 均匀采样 + 时长分档，
//      与 engine.scheduleBlink 同公式）—— 不造第二份节奏词表。
//   5. reduced-motion 在组件层闸掉（不注册；registry 不重复判档，镜像 ticker 的
//      职责边界：档位判定归 BotAvatar）。
//
// 只写眼 path 的 d：眨眼不改姿态 → 头/背层/眼可见性都不变。
// 中途注销（unmount / state 变更重注册）不回写基线：React 可能刚按新 state 写过
// 帧，晚到的回写会盖掉它 —— 注销即撒手。

import { blinkScaleAt, staticFrame } from './engine'
import { EXPRESSIONS } from './expressions'
import { poseFromExpression, renderAvatar } from './geometry'
import { BLINK } from './states'
import type { BlinkCadence, BotState } from './states'
import type { SurfaceConfig } from './surfaces'

export interface StaticBlinkClient {
  /** 静态档当前显示的表情（池首）；眨眼帧按它重算几何 */
  expressionIndex: number
  surface: SurfaceConfig
  state: BotState
  /** 眨眼帧写入目标（BotAvatar 的 refs.eyes —— 访问器身份稳定，节点可能为 null） */
  eyes: () => ReadonlyArray<SVGPathElement | null>
}

/** 同时眨眼的实例上限：把最坏情况的每帧几何重算钉成常数（与同屏实例数解耦），
 *  顺带压住「全场齐眨」的视觉噪音。名额满时顺延 RETRY_DELAY_MS 重试。 */
export const MAX_CONCURRENT_STATIC_BLINKS = 2
/** 名额满时的顺延步长；量级 ≈ 一次眨眼时长（220-420ms），几步内必能补上 */
const RETRY_DELAY_MS = 400

interface ClientMeta {
  nextBlinkAt: number
}

interface ActiveBlink {
  startedAt: number
  durationMs: number
}

const clients = new Map<StaticBlinkClient, ClientMeta>()
const active = new Map<StaticBlinkClient, ActiveBlink>()
let rafId: number | null = null
let timeoutId: ReturnType<typeof setTimeout> | null = null
/** 当前 timeout 臂向的时刻（Infinity = 未臂）；register 用它判断要不要提前重臂 */
let armedFor = Infinity
let visibilityHooked = false

const hasDom = typeof document !== 'undefined' && typeof requestAnimationFrame !== 'undefined'

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** 下一次眨眼延迟：BLINK 表 [min,max] 均匀采样（engine.scheduleBlink 同公式） */
function sampleDelay(cadence: BlinkCadence): number {
  return cadence[0] + Math.random() * (cadence[1] - cadence[0])
}

function writeEyes(client: StaticBlinkClient, eyes: ReadonlyArray<{ d: string }>): void {
  const nodes = client.eyes()
  for (let i = 0; i < eyes.length; i++) {
    nodes[i]?.setAttribute('d', eyes[i].d)
  }
}

/** 眨眼中的一帧眼几何 —— 与 animated 档同一条管线（保真度一致的关键） */
function blinkEyes(client: StaticBlinkClient, blinkValue: number): Array<{ d: string }> {
  const geometry = renderAvatar(
    poseFromExpression(EXPRESSIONS[client.expressionIndex]),
    client.surface,
    blinkValue
  )
  return [{ d: geometry.leftPath }, { d: geometry.rightPath }]
}

/** 回写基线 = staticFrame 模块缓存帧（与 React 渲染的是同一对象，严格逐字节还原） */
function restore(client: StaticBlinkClient): void {
  writeEyes(client, staticFrame(client.expressionIndex, client.surface).eyes)
}

function frame(now: number): void {
  rafId = null
  for (const [client, run] of active) {
    const t = (now - run.startedAt) / run.durationMs
    if (t >= 1) {
      restore(client)
      active.delete(client)
    } else {
      writeEyes(client, blinkEyes(client, blinkScaleAt(t < 0 ? 0 : t)))
    }
  }
  if (active.size > 0) rafId = requestAnimationFrame(frame)
}

function disarmTimer(): void {
  if (timeoutId !== null) {
    clearTimeout(timeoutId)
    timeoutId = null
  }
  armedFor = Infinity
}

/** 臂向 at；已臂且更早则保持（onTimer 空转自愈）。隐藏页不臂，visible 时再臂 */
function armTimerFor(at: number): void {
  if (!hasDom || document.hidden) return
  if (timeoutId !== null) {
    if (armedFor <= at) return
    clearTimeout(timeoutId)
  }
  armedFor = at
  timeoutId = setTimeout(onTimer, Math.max(0, at - nowMs()))
}

function armEarliest(): void {
  let earliest = Infinity
  for (const meta of clients.values()) earliest = Math.min(earliest, meta.nextBlinkAt)
  if (earliest !== Infinity) armTimerFor(earliest)
}

function onTimer(): void {
  timeoutId = null
  armedFor = Infinity
  const now = nowMs()
  for (const [client, meta] of clients) {
    if (meta.nextBlinkAt > now || active.has(client)) continue
    if (active.size >= MAX_CONCURRENT_STATIC_BLINKS) {
      meta.nextBlinkAt = now + RETRY_DELAY_MS
      continue
    }
    const cadence = BLINK[client.state]
    if (!cadence) continue // belt：注册侧已过滤 BLINK=null
    active.set(client, { startedAt: now, durationMs: cadence[2] })
    meta.nextBlinkAt = now + cadence[2] + sampleDelay(cadence)
  }
  if (active.size > 0 && rafId === null) rafId = requestAnimationFrame(frame)
  armEarliest()
}

function hookVisibility(): void {
  // 懒挂载 + 永不解绑（镜像 ticker.ts：单例监听一枚，代价恒定）
  if (visibilityHooked || !hasDom) return
  visibilityHooked = true
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // 隐藏页：进行中的眨眼直接回基线帧，全停（零后台活动）
      for (const client of active.keys()) restore(client)
      active.clear()
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
      disarmTimer()
    } else if (clients.size > 0) {
      // 回到可见：全员重采样（避免积压的到期时刻挤在同一瞬间连环补眨）
      const now = nowMs()
      for (const [client, meta] of clients) {
        const cadence = BLINK[client.state]
        if (cadence) meta.nextBlinkAt = now + sampleDelay(cadence)
      }
      armEarliest()
    }
  })
}

export function registerStaticBlink(client: StaticBlinkClient): void {
  if (!hasDom) return // SSR/纯 node：静默 no-op（镜像 ticker）
  const cadence = BLINK[client.state]
  if (!cadence) return // 闭眼/机械态（sleeping/loading…）不眨
  hookVisibility()
  const at = nowMs() + sampleDelay(cadence)
  clients.set(client, { nextBlinkAt: at })
  armTimerFor(at)
}

export function unregisterStaticBlink(client: StaticBlinkClient): void {
  clients.delete(client)
  active.delete(client) // 中途注销不回写（React 已接管该实例的 DOM）
  if (active.size === 0 && rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  if (clients.size === 0) disarmTimer()
  // 非空时不重臂：已臂时刻只可能偏早，onTimer 空转一次自愈（省掉逐卸载的全表扫描）
}

/** 测试探针：注册实例数（组件挂载/档位断言用），生产代码勿读 */
export function __staticBlinkClientCount(): number {
  return clients.size
}

/** 测试探针：正在眨眼的实例数（并发上限断言用），生产代码勿读 */
export function __staticBlinkActiveCount(): number {
  return active.size
}

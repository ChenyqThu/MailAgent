// 0805 流式动效重写（方案 B）— chat 流式正文「单推进头 reveal」引擎。
// 纯逻辑模块（零 React），组件侧接线见 ./streamWipe.tsx，mask 质感 CSS 见 index.css
// `.stream-reveal-*`，台账见 docs/motion-gsap.md §9.2。
//
// ── 为什么从「per-chunk keyframe」换成「单游标」────────────────────────────────
// 旧版给每个新到 chunk 起一个独立的 380ms mask 扫过；但 380ms 与 chunk 到达间隔
// 没有任何耦合 —— 间隔由模型出字速度决定（实测 40-80 tok/s 下句间隔 162-259ms、
// smoothStream 排空循环突发投递 11ms），并发动画数 ≈ ceil(380/间隔) 恒 ≥ 2，正是
// owner 报的「2 句话同时渲染淡出」；调时长/间隔只是挪临界速率（29 → 73 tok/s），
// 快模型下原样复发。本版把结构改掉：维护**一个**单调前进的揭示游标（字符 offset），
// rAF 按目标速率追赶 buffer 深度 —— 已定稿的部分永远静止，任意时刻正在动的元素
// 恰好 ≤ 1（推进头）。判别式测试 tests/shared/streamRevealInvariant.test.tsx
//（改前红 / 改后绿）钉住这条不变量。
//
// ── 机制三件套 ──────────────────────────────────────────────────────────────
// 1. rehype 插件（per Block 实例）：把「结构性 unwrap 边界（doneFloor）之后」的
//    文本包进 `.stream-reveal` span（携带 data-swp/-sws/-swe = 插件 id + 块内字符
//    区间），CSS 默认 visibility:hidden（与旧版「到达即占位、mask 未扫到处不可见」
//    同一布局时序）；已完全揭示的前缀输出纯文本。
// 2. controller（per 消息实例，TranslatedBody 持有）：每次 React commit 后
//    （layoutEffect，pre-paint）扫容器里的 `.stream-reveal`，按 DOM 顺序（= 阅读
//    顺序）排出 pending 队列，并对账每个元素的状态（done / head / pending）——
//    这一步同时治愈 React 复用元素时残留的运行时 class/inline style（hast key =
//    `span-N`，相邻两轮同位置的 span 会被 React 复用，而运行时 classList 改动不在
//    React 的 vnode diff 里；旧版为此发明的 a/b 双动画名交替在本模型下不再需要）。
// 3. rAF 推进：游标以 max(BASE_CPS, backlog / CATCHUP_LAG_S) 字符/秒推进 —— 比模型
//    快时贴着 live edge 走（观感≈旧版逐句扫），比模型慢时按 backlog 线性提速，滞后
//    有上界（≈CATCHUP_LAG_S 秒的扫量），大段突发（工具结果/缓存前缀）亚秒级清空。
//    每帧只写推进头一个元素的一个 CSS 变量（--sw-p）：零测量、零布局读，mask 是
//    paint-only，无 layout thrash。
//
// ── 上游 Streamdown 的相关事实（0805 调研更正过的准确表述）──────────────────────
// - 上游 animate 插件的中文问题只存在于**默认档** `sep:'word'`（按「是否空白」布尔
//   翻转切段 → 纯中文整段 1 token → 恒被判旧内容 → 零动效）；`sep:'char'` 按 code
//   point 迭代、处理中文完全正常。**坑是默认值，不是能力。** 我们仍不用上游 animate，
//   真实理由是：① 每字一个带 inline style 的 span，长回复 DOM 上千且每轮 rehype run
//   全量重建；② 其 stagger 索引每轮 run 从 0 重置，连续渲染之间的级联仍会叠加。
// - Block 的 markdown 处理是同步的（dist `runSync`）→ 本轮新产 span 与包裹组件的
//   layoutEffect 落在同一个 commit，pre-paint 对账不漏帧、不闪。
// - 处理器缓存按插件函数**名字**做 key（dist generateCacheKey），每个实例必须唯一
//   命名，否则不同 Block 的插件会撞缓存共享处理器。
//
// ── 边界语义（与旧版一致的部分）──────────────────────────────────────────────
// - 只包文本节点、永不跨节点：一句横跨 **加粗**/[链接] 时产出多个 span，markdown
//   结构由构造保证不被破坏；推进头按 DOM 顺序依次扫过它们（旧版是并行扫）。
// - code/pre/svg/math/annotation 子树整棵跳过（不包也不计数，镜像上游 skip 集）：
//   代码内容由 Streamdown 的 CodeBlock 从子树抽取原文，塞 span 会弄脏抽取/复制。
// - 纯空白节点计数但永不包裹；推进头跨过空隙时游标直接跳到下一段起点。
// - 折行正确性白拿：inline 元素的 mask 绘制区走 box-decoration-break:slice 语义
//   （假想未折行长条），mask-position 线性映射字符 offset，天然按阅读顺序跨行推进。
//
// ── 结构性 unwrap 边界为什么是 doneFloor、不是游标本身 ──────────────────────────
// 若每轮 render 都在 Math.floor(revealed) 处重切，推进头羽化区里「半亮」的字符会被
// 重新分进 p=0 的新 span —— 已经亮过的像素回到暗态（右缘可见闪烁）。故重切只发生在
// **整段揭示完成**的边界（doneFloor 单调、只由段完成推进）：正在扫的段在下一轮
// render 以同一起点原样复现（end 可随文本生长），p 按字符线性重映射，羽化位置在
// 字符空间里精确连续。

import type { BlockProps } from 'streamdown'

/** unified 是 streamdown 的传递依赖（pnpm 下不可直接 import 其类型），
 *  用索引类型从 BlockProps 反取 Pluggable，零新依赖。 */
export type RehypePlugins = NonNullable<BlockProps['rehypePlugins']>
type RehypePlugin = RehypePlugins[number]

// hast 结构性最小类型（@types/hast 非本仓依赖，且这里只碰 3 个字段）
interface HastText {
  type: 'text'
  value: string
}
interface HastElement {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children: HastNode[]
}
type HastNode = HastText | HastElement | { type: string; children?: HastNode[] }
interface HastParent {
  children: HastNode[]
}

/** 镜像上游 animate 插件的 skip 集：这些子树的文本既不包裹也不计数。 */
const SKIP_TAGS = new Set(['code', 'pre', 'svg', 'math', 'annotation'])

// ── 节奏常量 ────────────────────────────────────────────────────────────────
/** 基础揭示速率（字符/秒）。owner 选型 = 方案 C demo 的 1.5x：~22 字句 ÷ ~0.28s ≈ 80。 */
const BASE_CPS = 80
/** backlog 追赶时间常数（秒）：推进头滞后 live edge 的量被钉在 ≈ 这个秒数的扫量内。 */
const CATCHUP_LAG_S = 0.4
/** 单帧 dt 上限（秒）：后台 tab rAF 停摆恢复的第一帧不做巨额跳进，交给 backlog 提速。 */
const MAX_FRAME_DT_S = 0.1

// ── class / data 协议（CSS 与测试的耦合面）──────────────────────────────────
export const STREAM_REVEAL_CLASS = 'stream-reveal'
export const STREAM_REVEAL_HEAD_CLASS = 'stream-reveal-head'
export const STREAM_REVEAL_DONE_CLASS = 'stream-reveal-done'
const PROGRESS_VAR = '--sw-p'
const DATA_PLUGIN = 'data-swp'
const DATA_START = 'data-sws'
const DATA_END = 'data-swe'

// ── 帧调度 seam（happy-dom 测试手工推帧用；生产 = rAF）──────────────────────
export interface StreamRevealFrameScheduler {
  request(cb: (ts: number) => void): number
  cancel(id: number): void
}

const rafScheduler: StreamRevealFrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id)
}

let frameScheduler: StreamRevealFrameScheduler = rafScheduler

/** 测试 seam：换掉 rAF（虚拟时间戳全确定）。传 null 还原。 */
export function setStreamRevealFrameSchedulerForTests(s: StreamRevealFrameScheduler | null): void {
  frameScheduler = s ?? rafScheduler
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// ── 类型 ────────────────────────────────────────────────────────────────────
interface PluginState {
  /** 揭示游标（字符，可为小数），单调不减。 */
  revealed: number
  /** 结构性 unwrap 边界（整数字符），单调不减；只由「段完成」推进（见头注释）。 */
  doneFloor: number
}

export interface StreamRevealBlockPlugin {
  rehypePlugin: RehypePlugin
  /** 测试 seam：直接钉游标与 unwrap 边界（生产由 controller 的帧推进驱动）。 */
  primeForTests(revealed: number, doneFloor?: number): void
  getStateForTests(): { revealed: number; doneFloor: number }
}

export interface StreamRevealController {
  /** 容器 callback ref（TranslatedBody 的 .mail-body div）。挂上即扫一次 ——
   *  首个 commit 里子组件的 layoutEffect 先于父 div 的 ref attach 运行，彼时
   *  container 还是 null，全靠这里的补扫覆盖首帧。 */
  setContainer(el: HTMLElement | null): void
  createBlockPlugin(): StreamRevealBlockPlugin
  /** Block 包裹组件在 layoutEffect 里注册/注销（不在 createBlockPlugin 时注册：
   *  StrictMode 双 mount 会先跑一次 cleanup，注册必须可重入）。 */
  attachPlugin(p: StreamRevealBlockPlugin): void
  detachPlugin(p: StreamRevealBlockPlugin): void
  /** 每次 commit 后（layoutEffect）调用。用「transformer 在本轮 render 里跑过」的
   *  dirty 标志合并：span 只可能由 transformer 产生/变动，没跑过就没有可对账的变化。
   *  🔴 不能用 microtask 计时合并 —— act()/flushSync 会把多个 commit 压进同一个
   *  同步任务，microtask 到不了场，第二个 commit 的扫会被上一个的标志吞掉
   *  （实测：续写 commit 的 React 复用元素残留 done class 就此漏对账）。 */
  sync(): void
}

interface Segment {
  el: HTMLElement
  state: PluginState
  start: number
  end: number
}

const isElement = (n: HastNode): n is HastElement => n.type === 'element'
const isText = (n: HastNode): n is HastText => n.type === 'text'
const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

function makeRevealSpan(pluginId: string, text: string, absStart: number): HastElement {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: [STREAM_REVEAL_CLASS],
      // hast camelCase 属性 → DOM data-* attribute（property-information 标准映射）
      dataSwp: pluginId,
      dataSws: String(absStart),
      dataSwe: String(absStart + text.length)
    },
    children: [{ type: 'text', value: text }]
  }
}

/** 深度优先走 hast 树，把 doneFloor 之后的文本包成 reveal 段。counter 语义与旧版
 *  一致：文本字符累计 offset（skip 子树不计入），跨 render 稳定才能让边界有意义。 */
function revealWalk(
  node: HastParent,
  pluginId: string,
  floor: number,
  counter: { count: number }
): void {
  const children = node.children
  if (!Array.isArray(children)) return
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (isElement(child)) {
      if (SKIP_TAGS.has(child.tagName)) continue
      revealWalk(child, pluginId, floor, counter)
      continue
    }
    if (!isText(child)) continue
    const value = child.value
    const start = counter.count
    counter.count += value.length
    if (value.trim().length === 0) continue // 纯空白：计数但永不包裹（镜像上游）
    const end = start + value.length
    if (end <= floor) continue // 整节点都在 unwrap 边界之前 → 纯文本，不碰
    let cut = Math.max(0, floor - start)
    // 切点不落在 surrogate pair 中间：往下挪一位，整个 emoji 留在段里（宁可重扫半个
    // 字符宽，不产出两个各持半对 surrogate 的节点 —— 那会渲染成替换符）。
    if (
      cut > 0 &&
      cut < value.length &&
      isHighSurrogate(value.charCodeAt(cut - 1)) &&
      isLowSurrogate(value.charCodeAt(cut))
    ) {
      cut -= 1
    }
    if (cut === 0) {
      // 整个节点都在边界之后 → 原位替换成 reveal span
      children[i] = makeRevealSpan(pluginId, value, start)
    } else {
      // 边界落在节点内部 → 前缀留纯文本，后缀进 span
      children.splice(
        i,
        1,
        { type: 'text', value: value.slice(0, cut) } satisfies HastText,
        makeRevealSpan(pluginId, value.slice(cut), start + cut)
      )
      i++ // 跳过刚插入的 span（其文本已随原节点计过数，勿二次遍历）
    }
  }
}

let pluginSerial = 0

export function createStreamRevealController(): StreamRevealController {
  const plugins = new Map<string, PluginState>()
  const pluginMeta = new WeakMap<StreamRevealBlockPlugin, { id: string; state: PluginState }>()
  let container: HTMLElement | null = null
  let segments: Segment[] = []
  let rafId: number | null = null
  let lastTs: number | null = null
  /** 本轮 render 有 transformer 跑过（= DOM 里的 span 可能变了），等待一次对账扫。 */
  let scanDirty = false

  const setDone = (el: HTMLElement): void => {
    el.classList.add(STREAM_REVEAL_DONE_CLASS)
    el.classList.remove(STREAM_REVEAL_HEAD_CLASS)
    el.style.removeProperty(PROGRESS_VAR)
  }
  const setPending = (el: HTMLElement): void => {
    el.classList.remove(STREAM_REVEAL_DONE_CLASS)
    el.classList.remove(STREAM_REVEAL_HEAD_CLASS)
    el.style.removeProperty(PROGRESS_VAR)
  }
  const setHead = (el: HTMLElement, p: number): void => {
    el.classList.remove(STREAM_REVEAL_DONE_CLASS)
    el.classList.add(STREAM_REVEAL_HEAD_CLASS)
    el.style.setProperty(PROGRESS_VAR, p.toFixed(4))
  }

  const stopLoop = (): void => {
    if (rafId !== null) {
      frameScheduler.cancel(rafId)
      rafId = null
    }
    lastTs = null
  }

  const ensureLoop = (): void => {
    if (rafId === null) rafId = frameScheduler.request(frame)
  }

  /** 让队首成为推进头：跳过空隙（空白节点造成的 offset 缺口）+ 写进度变量。 */
  const applyHead = (): void => {
    const head = segments[0]
    if (!head) return
    if (head.state.revealed < head.start) head.state.revealed = head.start
    const len = head.end - head.start
    setHead(head.el, len <= 0 ? 1 : (head.state.revealed - head.start) / len)
  }

  const completeSegment = (seg: Segment): void => {
    seg.state.revealed = Math.max(seg.state.revealed, seg.end)
    seg.state.doneFloor = Math.max(seg.state.doneFloor, seg.end)
    setDone(seg.el)
  }

  const scanNow = (): void => {
    const root = container
    if (!root) return
    if (prefersReducedMotion()) {
      // reduce：全部直出。rehype 侧同样短路（不再产 span），这里治愈运行时切换。
      for (const el of root.querySelectorAll<HTMLElement>(`.${STREAM_REVEAL_CLASS}`)) {
        setDone(el)
      }
      segments = []
      stopLoop()
      return
    }
    const els = root.querySelectorAll<HTMLElement>(`.${STREAM_REVEAL_CLASS}`)
    segments = []
    for (const el of els) {
      const pid = el.getAttribute(DATA_PLUGIN)
      const state = pid ? plugins.get(pid) : undefined
      const start = Number(el.getAttribute(DATA_START))
      const end = Number(el.getAttribute(DATA_END))
      if (!state || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        // 孤儿（block 已卸载 / 属性异常）：宁可立即可见，绝不吞字。
        setDone(el)
        continue
      }
      if (end <= state.revealed) {
        // 游标已过（含 memo 惰性留存的旧 span）：对账成 done，unwrap 边界跟上。
        state.doneFloor = Math.max(state.doneFloor, end)
        setDone(el)
        continue
      }
      // pending：清掉 React 复用元素上可能残留的 head/done/进度
      setPending(el)
      segments.push({ el, state, start, end })
    }
    if (segments.length > 0) {
      applyHead()
      ensureLoop()
    } else {
      stopLoop()
    }
  }

  const frame = (ts: number): void => {
    rafId = null
    if (segments.length === 0) {
      lastTs = null
      return
    }
    if (prefersReducedMotion()) {
      // 运行时切到 reduce：一帧内全部直出（CSS reduce 块在此之前就已强制可见，
      // 这里是 JS 侧状态机的收尾）。
      for (const s of segments) completeSegment(s)
      segments = []
      lastTs = null
      return
    }
    if (lastTs === null) {
      // 第一帧只记时间基准，不推进（dt 未知）
      lastTs = ts
      ensureLoop()
      return
    }
    let dt = (ts - lastTs) / 1000
    lastTs = ts
    if (dt <= 0) {
      ensureLoop()
      return
    }
    if (dt > MAX_FRAME_DT_S) dt = MAX_FRAME_DT_S

    let backlog = 0
    for (const s of segments) backlog += s.end - Math.max(s.start, s.state.revealed)
    let budget = Math.max(BASE_CPS, backlog / CATCHUP_LAG_S) * dt

    while (budget > 0 && segments.length > 0) {
      const head = segments[0]
      if (!head.el.isConnected) {
        // React 替换过 DOM 而扫描尚未跟上（正常路径会在同 commit 内重扫，这是兜底）
        segments.shift()
        continue
      }
      if (head.state.revealed < head.start) head.state.revealed = head.start
      const remaining = head.end - head.state.revealed
      if (remaining <= budget) {
        budget -= remaining
        completeSegment(head)
        segments.shift()
      } else {
        head.state.revealed += budget
        budget = 0
      }
    }

    if (segments.length > 0) {
      applyHead()
      ensureLoop()
    } else {
      lastTs = null
    }
  }

  return {
    setContainer(el) {
      container = el
      if (el) {
        // 首个 commit：子组件 layoutEffect（sync）先于父 div 的 ref attach 运行，
        // 彼时 container 还是 null、dirty 被保留 —— 这里补扫覆盖首帧。
        scanDirty = false
        scanNow()
      } else {
        segments = []
        stopLoop()
      }
    },
    createBlockPlugin() {
      const id = `sr${pluginSerial++}`
      const state: PluginState = { revealed: 0, doneFloor: 0 }
      const rehypePlugin = (): ((tree: HastParent) => void) => (tree: HastParent) => {
        scanDirty = true // render 期打标，commit 后的 sync 据此决定要不要扫
        if (prefersReducedMotion()) return // 直出：零 span 零动画
        const counter = { count: 0 }
        // doneFloor 单调不减 → useTransition 中断重放天然安全（重放只会包得更少），
        // 旧版的 beginRender/commit 冻结协议在本模型下不再需要。
        revealWalk(tree, id, state.doneFloor, counter)
      }
      // 处理器缓存按插件函数名字做 key（上游 generateCacheKey）：每实例唯一命名
      Object.defineProperty(rehypePlugin, 'name', { value: `rehypeStreamReveal$${id}` })
      const plugin: StreamRevealBlockPlugin = {
        rehypePlugin: rehypePlugin as RehypePlugin,
        primeForTests(revealed, doneFloor = Math.floor(revealed)) {
          state.revealed = revealed
          state.doneFloor = doneFloor
        },
        getStateForTests() {
          return { revealed: state.revealed, doneFloor: state.doneFloor }
        }
      }
      pluginMeta.set(plugin, { id, state })
      return plugin
    },
    attachPlugin(p) {
      const meta = pluginMeta.get(p)
      if (meta) plugins.set(meta.id, meta.state)
    },
    detachPlugin(p) {
      const meta = pluginMeta.get(p)
      if (!meta) return
      plugins.delete(meta.id)
      segments = segments.filter((s) => s.state !== meta.state)
      if (segments.length === 0) stopLoop()
    },
    sync() {
      // dirty 合并：同一 commit 内多 Block 的调用只有第一次真的扫（transformer 全在
      // render 期跑完、layout 阶段 DOM 已定）；没有 transformer 跑过的 commit 不可能
      // 改变 span 集，直接跳过。container 未就位时保留 dirty，交给 setContainer 补扫。
      if (!scanDirty || !container) return
      scanDirty = false
      scanNow()
    }
  }
}

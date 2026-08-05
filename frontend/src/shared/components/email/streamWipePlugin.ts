// 0804 dogfood 1c — chat 流式正文「chunk 内左→右 reveal」（方案 C）的 rehype 层。
// 纯逻辑模块（零 React），组件侧接线见 ./streamWipe.tsx，动画 CSS 见 index.css
// `.stream-wipe-*`，台账见 docs/motion-gsap.md §9.2。
//
// ── 为什么能拿到 per-chunk 边界（当初评估认为拿不到）─────────────────────────────
// Streamdown 自己的 animate 插件就有一套「新旧边界」协议：Block 在 render body 里
// `getLastRenderCharCount() → setPrevContentLength()`，rehype 插件按字符 offset 判定
// 哪些 token 是旧内容。它对中文失效的根因不是协议，而是切分器：`sep:'word'` 按空白
// 翻转切段 → 纯中文整段 1 个 token，token 起点恒 < prev → 永远被判旧（W1 验尸结论）。
// 本模块复用同一协议、换掉切分：**按边界切**——每个文本节点至多切成「旧前缀（纯文本）
// + 新尾巴（wipe span）」，不按词/字爆 DOM，也不会把续写句误判成旧内容。
//
// ── 与上游 Block 协议的三处刻意偏离（都是修上游的坑）────────────────────────────
// 1. 插件实例 per-Block（不是 per-Streamdown 共享）：上游共享实例下，新 block 挂载时
//    会读到前一个 block 刚跑完的字符数当自己的 prev → 新段落的第一句永远不动画。
// 2. 计数读写非破坏性 + prev 只由「已 commit 的计数」驱动（beginRender/commit 协议）：
//    上游是 render body 里的破坏性读，而 Streamdown 流式无 animate 插件时块更新走
//    useTransition（可中断重放），破坏性读在重放下会把边界读成 0/脏值。这里 beginRender
//    幂等，重放安全。
// 3. a/b 双动画名交替：hast-util-to-jsx-runtime 给元素发 key = `tagName-同名序号`，
//    相邻两轮的 wipe span 在同一父节点里会拿到同一个 key（span-0）→ React 复用 DOM
//    元素 → 同名 CSS 动画不重启 → 新 chunk 直接全亮。交替 animation-name 强制重启。
//    parity 只在 prev 变化时翻转（同一边界的 transition 重放不会多翻）。
//
// ── 边界语义 ────────────────────────────────────────────────────────────────
// - 只包文本节点、且永不跨节点：一个句级 chunk 若横跨 **加粗**/[链接] 等 inline 结构，
//   会产出多个 span（每个文本节点的新尾巴各一个），markdown 结构由构造保证不被破坏。
// - code/pre/svg/math/annotation 子树整棵跳过（不包也不计数，镜像上游 skip 集）：
//   代码内容由 Streamdown 的 CodeBlock 从子树抽取原文，塞 span 会弄脏抽取。
//   代价 = 代码内容不做 wipe、直接出现（与上游 animate 行为一致）。
// - 折行正确性是白拿的：inline 元素的 mask 绘制区走 box-decoration-break:slice 语义
//   （假想未折行的连续长条），一条 to-right 渐变天然按阅读顺序跨行推进。

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

export interface StreamWipePlugin {
  rehypePlugin: RehypePlugin
  /** render body 每轮调用：把边界钉在「最近一次 commit 的字符数」上。幂等 ——
   *  useTransition 中断重放会重复调用，值不变。 */
  beginRender: () => void
  /** commit 后（useEffect）调用：把本轮 run 的计数落为已提交边界。 */
  commit: () => void
  /** 直接钉边界（beginRender 的底层；测试驱动用）。 */
  setPrevContentLength: (length: number) => void
  /** 最近一次 rehype run 的文本字符数；非破坏性读。 */
  getLastRunCharCount: () => number
}

/** 镜像上游 animate 插件的 skip 集：这些子树的文本既不包裹也不计数。 */
const SKIP_TAGS = new Set(['code', 'pre', 'svg', 'math', 'annotation'])

const isElement = (n: HastNode): n is HastElement => n.type === 'element'
const isText = (n: HastNode): n is HastText => n.type === 'text'

function makeWipeSpan(text: string, parity: number): HastElement {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['stream-wipe', parity === 0 ? 'stream-wipe-a' : 'stream-wipe-b'] },
    children: [{ type: 'text', value: text }]
  }
}

/** 深度优先走 hast 树，按 prev 边界就地改写文本节点。counter 与上游同语义：
 *  文本字符累计 offset（skip 子树不计入），跨 render 一致才能让 prev 有意义。 */
function wipeWalk(
  node: HastParent,
  prev: number,
  parity: number,
  counter: { count: number }
): void {
  const children = node.children
  if (!Array.isArray(children)) return
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (isElement(child)) {
      if (SKIP_TAGS.has(child.tagName)) continue
      wipeWalk(child, prev, parity, counter)
      continue
    }
    if (!isText(child)) continue
    const value = child.value
    const start = counter.count
    counter.count += value.length
    if (value.trim().length === 0) continue // 纯空白：计数但永不包裹（镜像上游）
    const end = start + value.length
    if (end <= prev) continue // 整节点都是已定稿内容 → 不碰
    const cut = Math.max(0, prev - start)
    if (cut === 0) {
      // 整个节点都是新内容 → 原位替换成 wipe span
      children[i] = makeWipeSpan(value, parity)
    } else {
      // 边界落在节点内部 → 旧前缀留纯文本，新尾巴进 span
      children.splice(
        i,
        1,
        { type: 'text', value: value.slice(0, cut) } satisfies HastText,
        makeWipeSpan(value.slice(cut), parity)
      )
      i++ // 跳过刚插入的 span（其文本已随原节点计过数，勿二次遍历）
    }
  }
}

// 处理器缓存按插件函数 **名字** 做 key（Streamdown dist 的 generateCacheKey），
// 每个实例必须唯一命名，否则不同 Block 的插件会撞缓存共享处理器（上游
// `rehypeAnimate$n` 同款处理）。
let pluginSerial = 0

export function createStreamWipePlugin(): StreamWipePlugin {
  const state = { prev: 0, committed: 0, lastCount: 0, lastPrevSeen: -1, parity: 0 }
  const rehypePlugin = () => (tree: HastParent) => {
    if (state.lastPrevSeen !== state.prev) {
      // 每个新边界翻一次 parity；同边界的重放（transition 中断重 render）不翻
      state.parity ^= 1
      state.lastPrevSeen = state.prev
    }
    const counter = { count: 0 }
    wipeWalk(tree, state.prev, state.parity, counter)
    state.lastCount = counter.count
  }
  Object.defineProperty(rehypePlugin, 'name', { value: `rehypeStreamWipe$${pluginSerial++}` })
  return {
    rehypePlugin: rehypePlugin as RehypePlugin,
    beginRender() {
      state.prev = state.committed
    },
    commit() {
      state.committed = state.lastCount
    },
    setPrevContentLength(length: number) {
      state.prev = length
    },
    getLastRunCharCount() {
      return state.lastCount
    }
  }
}

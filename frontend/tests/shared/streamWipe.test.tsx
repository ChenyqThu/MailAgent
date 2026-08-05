// @vitest-environment happy-dom
//
// 0805 流式动效重写（方案 B）— 单推进头 reveal 回归。
//
// 三层：
// A. rehype 插件纯函数级 —— unwrap 边界切分 / skip 集 / 空白 / surrogate 保护 /
//    reduce 短路。这是「包裹永不破坏 markdown 结构、offset 跨 render 稳定」的机械保证。
// B. controller DOM 级（手工建 DOM + 手工推帧）—— 扫描对账（孤儿直出 / React 复用
//    残留 class 的治愈）/ 推进头唯一且按 DOM 顺序推进 / backlog 追赶提速。
// C. TranslatedBody + 真 Streamdown（streaming 模式）集成 —— BlockComponent 接线、
//    续写 unwrap、代码块/表格/嵌套列表结构保真、settle 清零、reduce 直出、多速率不丢字。
//
// 🔴 核心不变量（任意时刻正在动的元素 ≤ 1）的判别式测试在
// tests/shared/streamRevealInvariant.test.tsx —— 那个文件对新旧两代实现都能跑
// （旧实现红 / 本实现绿），本文件只测本实现的行为细节。
//
// happy-dom 不跑 CSS：visibility/mask 的观感（羽化、折行 slice 推进）需打包后人工
// 确认；这里锁的是 DOM 形状、class 状态机与包裹边界。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

import {
  createStreamRevealController,
  setStreamRevealFrameSchedulerForTests,
  type StreamRevealFrameScheduler
} from '@shared/components/email/streamWipePlugin'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'

// ── 测试环境：matchMedia 与帧调度 ──────────────────────────────────────────────
// 全局 setup（tests/setup.ts）强制 prefers-reduced-motion: reduce；本套要测真实
// 动画路径，按 useExitAnimation.test.tsx 先例覆盖。reduce 用例把 reduceMatches
// 翻 true。
let reduceMatches = false

function mockMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('reduce') ? reduceMatches : false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false
      }) as unknown as MediaQueryList
  )
}

interface ManualScheduler {
  scheduler: StreamRevealFrameScheduler
  pump(ms: number): void
}

function makeManualScheduler(): ManualScheduler {
  let nextId = 1
  let now = 0
  const pending = new Map<number, (ts: number) => void>()
  return {
    scheduler: {
      request(cb) {
        const id = nextId++
        pending.set(id, cb)
        return id
      },
      cancel(id) {
        pending.delete(id)
      }
    },
    pump(ms) {
      now += ms
      const cbs = [...pending.values()]
      pending.clear()
      for (const cb of cbs) cb(now)
    }
  }
}

let manual: ManualScheduler

function pumpUntil(cond: () => boolean, maxFrames = 400): void {
  for (let i = 0; i < maxFrames; i++) {
    if (cond()) return
    manual.pump(16)
  }
  if (!cond()) throw new Error('pumpUntil: 条件在 maxFrames 内未达成')
}

beforeEach(() => {
  reduceMatches = false
  mockMatchMedia()
  manual = makeManualScheduler()
  setStreamRevealFrameSchedulerForTests(manual.scheduler)
})

afterEach(() => {
  setStreamRevealFrameSchedulerForTests(null)
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

// ── hast 测试脚手架 ───────────────────────────────────────────────────────────

interface Node {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: Node[]
}

const text = (value: string): Node => ({ type: 'text', value })
const el = (tagName: string, ...children: Node[]): Node => ({ type: 'element', tagName, children })
const root = (...children: Node[]): Node => ({ type: 'root', children })

type Plugin = ReturnType<ReturnType<typeof createStreamRevealController>['createBlockPlugin']>

/** rehypePlugin 是 unified 插件工厂：调用一次拿 transformer。 */
function run(plugin: Plugin, tree: Node): void {
  const factory = plugin.rehypePlugin as unknown as () => (t: Node) => void
  factory()(tree)
}

const revealSpans = (node: Node): Node[] => {
  const out: Node[] = []
  const visit = (n: Node): void => {
    const cls = (n.properties?.className ?? []) as string[]
    if (n.type === 'element' && cls.includes('stream-reveal')) out.push(n)
    for (const c of n.children ?? []) visit(c)
  }
  visit(node)
  return out
}
const spanText = (n: Node): string => n.children?.[0]?.value ?? ''
const spanRange = (n: Node): [number, number] => [
  Number(n.properties?.dataSws),
  Number(n.properties?.dataSwe)
]

// ── A. 插件纯函数级 ────────────────────────────────────────────────────────────

describe('rehype 插件 — unwrap 边界切分', () => {
  const makePlugin = (): Plugin => createStreamRevealController().createBlockPlugin()

  test('doneFloor=0：整个文本节点包进一个 reveal span，data 区间 = [0, len)', () => {
    const plugin = makePlugin()
    const tree = root(el('p', text('第一句话。')))
    run(plugin, tree)
    const spans = revealSpans(tree)
    expect(spans).toHaveLength(1)
    expect(spanText(spans[0])).toBe('第一句话。')
    expect(spanRange(spans[0])).toEqual([0, 5])
  })

  test('边界落在节点内部：前缀留纯文本，后缀进 span（start = 边界）', () => {
    const plugin = makePlugin()
    plugin.primeForTests(5, 5)
    const tree = root(el('p', text('第一句话。第二句到了。')))
    run(plugin, tree)
    const p = tree.children![0]
    expect(p.children).toHaveLength(2)
    expect(p.children![0]).toMatchObject({ type: 'text', value: '第一句话。' })
    const spans = revealSpans(tree)
    expect(spans).toHaveLength(1)
    expect(spanText(spans[0])).toBe('第二句到了。')
    expect(spanRange(spans[0])).toEqual([5, 11])
  })

  test('整节点都在边界之前 → 原样不碰（同一对象引用）', () => {
    const plugin = makePlugin()
    plugin.primeForTests(99, 99)
    const node = text('全是旧的')
    const tree = root(el('p', node))
    run(plugin, tree)
    expect(revealSpans(tree)).toHaveLength(0)
    expect(tree.children![0].children![0]).toBe(node)
  })

  test('一句横跨 inline 结构：每个文本节点各自成 span、offset 连续，结构不被破坏', () => {
    const plugin = makePlugin()
    plugin.primeForTests(3, 3)
    const strong = el('strong', text('重点'))
    const tree = root(el('p', text('前文。看'), strong, text('内容。')))
    run(plugin, tree)
    const spans = revealSpans(tree)
    expect(spans.map(spanText)).toEqual(['看', '重点', '内容。'])
    // offset 跨节点连续（前文。看 = 0..4，重点 = 4..6，内容。= 6..9）
    expect(spans.map(spanRange)).toEqual([
      [3, 4],
      [4, 6],
      [6, 9]
    ])
    // strong 元素仍在原位，reveal span 在它内部（wrapper 永不跨结构边界）
    expect(strong.children).toHaveLength(1)
    expect(strong.children![0].tagName).toBe('span')
  })

  test('skip 集：code/pre 子树不包裹也不计数（后续节点 offset 证明未计入）', () => {
    const plugin = makePlugin()
    const code = el('code', text('pm2 status'))
    const tree = root(el('p', text('先看'), code, text('的输出')))
    run(plugin, tree)
    expect(code.children![0]).toMatchObject({ type: 'text', value: 'pm2 status' })
    const spans = revealSpans(tree)
    expect(spans.map(spanText)).toEqual(['先看', '的输出'])
    // 的输出 起点 = 2（code 的 10 个字符未计入）
    expect(spans.map(spanRange)).toEqual([
      [0, 2],
      [2, 5]
    ])
  })

  test('纯空白文本节点：计数但永不包裹（后续 offset 含空白）', () => {
    const plugin = makePlugin()
    const tree = root(el('p', text('a'), text('  \n'), text('b')))
    run(plugin, tree)
    const spans = revealSpans(tree)
    expect(spans.map(spanText)).toEqual(['a', 'b'])
    expect(spans.map(spanRange)).toEqual([
      [0, 1],
      [4, 5]
    ])
  })

  test('切点落在 surrogate pair 中间 → 下移一位，emoji 完整留在段里', () => {
    const plugin = makePlugin()
    plugin.primeForTests(3, 3) // 😀 = 😀 占 [2,4)，3 在正中
    const tree = root(el('p', text('AB😀CD')))
    run(plugin, tree)
    const p = tree.children![0]
    expect(p.children![0]).toMatchObject({ type: 'text', value: 'AB' })
    const spans = revealSpans(tree)
    expect(spans).toHaveLength(1)
    expect(spanText(spans[0])).toBe('😀CD')
    expect(spanRange(spans[0])).toEqual([2, 6])
  })

  test('reduce-motion：不包任何 span（文本直出）', () => {
    reduceMatches = true
    const plugin = makePlugin()
    const tree = root(el('p', text('第一句话。')))
    run(plugin, tree)
    expect(revealSpans(tree)).toHaveLength(0)
    expect(tree.children![0].children![0]).toMatchObject({ type: 'text', value: '第一句话。' })
  })
})

// ── B. controller DOM 级 ──────────────────────────────────────────────────────

/** 把插件 rehype 产出的 span hast 手工物化成 DOM（真实链路由 Streamdown 渲染，
 *  集成层在 C 节；这里只为把 controller 的扫描/推进单拎出来测）。 */
function materialize(span: Node): HTMLElement {
  const dom = document.createElement('span')
  dom.className = 'stream-reveal'
  dom.setAttribute('data-swp', String(span.properties?.dataSwp))
  dom.setAttribute('data-sws', String(span.properties?.dataSws))
  dom.setAttribute('data-swe', String(span.properties?.dataSwe))
  dom.textContent = spanText(span)
  return dom
}

function mountSpans(spans: Node[]): { container: HTMLElement; doms: HTMLElement[] } {
  const container = document.createElement('div')
  const p = document.createElement('p')
  const doms = spans.map((s) => {
    const dom = materialize(s)
    p.appendChild(dom)
    return dom
  })
  container.appendChild(p)
  document.body.appendChild(container)
  return { container, doms }
}

describe('controller — 扫描对账与单推进头推进', () => {
  test('推进头唯一、按 DOM 顺序推进：前段 done 后后段才成为 head', () => {
    const controller = createStreamRevealController()
    const plugin = controller.createBlockPlugin()
    controller.attachPlugin(plugin)
    const tree = root(el('p', text('前六个字来了'), text('后面四字')))
    run(plugin, tree)
    const { container, doms } = mountSpans(revealSpans(tree))
    controller.setContainer(container)

    // 挂上即对账：首段 head（p=0），次段 pending
    expect(doms[0].classList.contains('stream-reveal-head')).toBe(true)
    expect(doms[1].classList.contains('stream-reveal-head')).toBe(false)
    expect(container.querySelectorAll('.stream-reveal-head')).toHaveLength(1)

    manual.pump(16) // 基准帧（只记时间）
    manual.pump(16)
    const p1 = parseFloat(doms[0].style.getPropertyValue('--sw-p'))
    expect(p1).toBeGreaterThan(0)
    expect(p1).toBeLessThan(1)

    pumpUntil(() => doms[0].classList.contains('stream-reveal-done'))
    expect(doms[0].classList.contains('stream-reveal-head')).toBe(false)
    expect(doms[1].classList.contains('stream-reveal-head')).toBe(true)
    expect(container.querySelectorAll('.stream-reveal-head')).toHaveLength(1)

    pumpUntil(() => doms[1].classList.contains('stream-reveal-done'))
    expect(container.querySelectorAll('.stream-reveal-head')).toHaveLength(0)
    expect(plugin.getStateForTests().doneFloor).toBe(10)
  })

  test('孤儿 span（plugin 未注册）→ 立即 done：宁可直出，绝不吞字', () => {
    const controller = createStreamRevealController()
    const container = document.createElement('div')
    const ghost = document.createElement('span')
    ghost.className = 'stream-reveal'
    ghost.setAttribute('data-swp', 'ghost')
    ghost.setAttribute('data-sws', '0')
    ghost.setAttribute('data-swe', '5')
    ghost.textContent = '你好世界啊'
    container.appendChild(ghost)
    document.body.appendChild(container)
    controller.setContainer(container)
    expect(ghost.classList.contains('stream-reveal-done')).toBe(true)
    expect(ghost.classList.contains('stream-reveal-head')).toBe(false)
  })

  test('React 复用元素残留的 done class 被对账治愈（vnode diff 看不见运行时 class）', () => {
    const controller = createStreamRevealController()
    const plugin = controller.createBlockPlugin()
    controller.attachPlugin(plugin)
    const tree = root(el('p', text('五个字内容')))
    run(plugin, tree)
    const { container, doms } = mountSpans(revealSpans(tree))
    doms[0].classList.add('stream-reveal-done') // 模拟复用元素上的残留
    controller.setContainer(container)
    expect(doms[0].classList.contains('stream-reveal-done')).toBe(false)
    expect(doms[0].classList.contains('stream-reveal-head')).toBe(true)
  })

  test('backlog 追赶：大段突发按 backlog 提速清空，但绝不瞬间直出', () => {
    const controller = createStreamRevealController()
    const plugin = controller.createBlockPlugin()
    controller.attachPlugin(plugin)
    const big = '字'.repeat(800) // 纯 BASE_CPS(80) 需 10s
    const tree = root(el('p', text(big)))
    run(plugin, tree)
    const { doms, container } = mountSpans(revealSpans(tree))
    controller.setContainer(container)

    let frames = 0
    for (; frames < 300 && !doms[0].classList.contains('stream-reveal-done'); frames++) {
      manual.pump(16)
    }
    expect(doms[0].classList.contains('stream-reveal-done')).toBe(true)
    // 追赶生效：远快于 10s（625 帧）
    expect(frames).toBeLessThan(150)
    // 但仍是动画不是直出：至少推了 10 帧（>160ms）
    expect(frames).toBeGreaterThan(10)
  })

  test('运行时切到 reduce：下一帧全部直出、推进头退场（CSS reduce 块另有即时兜底）', () => {
    const controller = createStreamRevealController()
    const plugin = controller.createBlockPlugin()
    controller.attachPlugin(plugin)
    const tree = root(el('p', text('第一句话。')))
    run(plugin, tree)
    const { container, doms } = mountSpans(revealSpans(tree))
    controller.setContainer(container)
    expect(doms[0].classList.contains('stream-reveal-head')).toBe(true)
    reduceMatches = true
    manual.pump(16)
    expect(doms[0].classList.contains('stream-reveal-done')).toBe(true)
    expect(container.querySelectorAll('.stream-reveal-head')).toHaveLength(0)
  })
})

// ── C. TranslatedBody + 真 Streamdown 集成 ─────────────────────────────────────

const doneCount = (c: HTMLElement): number =>
  c.querySelectorAll('.stream-reveal.stream-reveal-done').length
const allDone = (c: HTMLElement): boolean =>
  [...c.querySelectorAll('.stream-reveal')].every((s) => s.classList.contains('stream-reveal-done'))

describe('TranslatedBody streaming — 接线与结构保真', () => {
  test('续写：已完成前缀解包成裸文本；新尾巴成段；推进头唯一；strong 结构完好', async () => {
    const { container, rerender } = render(<TranslatedBody text="第一句话。" streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-reveal').length).toBeGreaterThan(0)
    })
    pumpUntil(() => allDone(container)) // 第一段揭示完 → doneFloor 推到 5

    rerender(<TranslatedBody text="第一句话。这里有**重点**内容。" streaming />)
    await waitFor(() => {
      const spans = [...container.querySelectorAll('.stream-reveal')].filter(
        (s) => !s.classList.contains('stream-reveal-done')
      )
      expect(spans.map((s) => s.textContent)).toEqual(['这里有', '重点', '内容。'])
    })
    // 旧句已解包成裸文本（不在任何 span 里）→ 不参与任何后续状态机
    const p = container.querySelector('p')
    expect(p?.textContent).toBe('第一句话。这里有重点内容。')
    expect(p?.firstChild?.nodeType).toBe(3) // Text node
    expect(p?.firstChild?.textContent).toBe('第一句话。')
    // markdown 结构未被 wrapper 破坏；推进头恰好 1 个（队首「这里有」）
    const strong = container.querySelector('[data-streamdown="strong"]')
    expect(strong).not.toBeNull()
    expect(strong?.querySelector('.stream-reveal')?.textContent).toBe('重点')
    expect(container.querySelectorAll('.stream-reveal-head')).toHaveLength(1)
    expect(container.querySelector('.stream-reveal-head')?.textContent).toBe('这里有')

    // 推到完：按 DOM 顺序依次 done，全程头数 ≤ 1（不变量测试另有专文件，这里抽查）
    pumpUntil(() => allDone(container))
    expect(container.querySelectorAll('.stream-reveal-head')).toHaveLength(0)
  })

  test('新段落（新 block 挂载）：自己的游标从 0 起，第一句整句成段', async () => {
    const { container, rerender } = render(<TranslatedBody text="第一段落的话。" streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-reveal').length).toBeGreaterThan(0)
    })
    rerender(<TranslatedBody text={'第一段落的话。\n\n短句。'} streaming />)
    await waitFor(() => {
      const ps = [...container.querySelectorAll('p')]
      expect(ps).toHaveLength(2)
      const span = ps[1].querySelector('.stream-reveal')
      expect(span?.textContent).toBe('短句。')
    })
  })

  test('代码块：code/pre 子树零 span，复制拿到完整代码', async () => {
    const md = '先跑一下：\n\n```bash\npm2 status mail-sync\n```\n\n再看输出。'
    const { container } = render(<TranslatedBody text={md} streaming />)
    await waitFor(() => {
      expect(container.querySelector('code')).not.toBeNull()
    })
    const code = container.querySelector('code')
    expect(code?.querySelectorAll('.stream-reveal')).toHaveLength(0)
    expect(code?.textContent).toContain('pm2 status mail-sync')
    const pre = container.querySelector('pre')
    expect(pre?.querySelectorAll('.stream-reveal') ?? []).toHaveLength(0)
  })

  test('表格：span 只在 th/td 内且不含元素子节点；文本保真；settle 清空 memo 留存', async () => {
    // Streamdown 的 th/td 子组件按「className+position」memo（比较器不看 children）：
    // 新行流入时旧单元格跳过重渲，其 span 惰性留存（本实现下是 done 态：可见、无
    // mask、无动画）。钉住：① span 只出现在单元格内、无元素子节点；② textContent
    // 保真；③ settle 后连惰性 span 一起清零。
    const t1 = '| 列甲 | 列乙 |\n| --- | --- |\n| 第一格 | 第二'
    const t2 = '| 列甲 | 列乙 |\n| --- | --- |\n| 第一格 | 第二格满了。 |\n| 新行左 | 新行右 |'
    const { container, rerender } = render(<TranslatedBody text={t1} streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-reveal').length).toBeGreaterThan(0)
    })
    rerender(<TranslatedBody text={t2} streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('td')).toHaveLength(4)
    })
    expect(container.querySelectorAll('th')).toHaveLength(2)
    for (const span of container.querySelectorAll('.stream-reveal')) {
      expect(['TH', 'TD']).toContain(span.parentElement?.tagName)
      expect(span.children).toHaveLength(0) // 只包文本，永不包元素（无非法嵌套）
    }
    expect(container.querySelector('table')?.textContent).toBe(
      '列甲列乙第一格第二格满了。新行左新行右'
    )
    rerender(<TranslatedBody text={t2} streaming={false} />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-reveal')).toHaveLength(0)
    })
    expect(container.querySelectorAll('td')).toHaveLength(4)
  })

  test('嵌套列表：span 不包裹 li/ul，层级完好，各 li 文本保真', async () => {
    const t1 = '- 甲项内容\n  - 子项一'
    const t2 = '- 甲项内容\n  - 子项一\n  - 子项二来了\n- 乙项'
    const { container, rerender } = render(<TranslatedBody text={t1} streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-reveal').length).toBeGreaterThan(0)
    })
    rerender(<TranslatedBody text={t2} streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('li')).toHaveLength(4)
    })
    expect(container.querySelector('ul ul')).not.toBeNull() // 嵌套层级在
    for (const span of container.querySelectorAll('.stream-reveal')) {
      expect(span.children).toHaveLength(0) // span 永不包住 li/ul 等元素
      expect(span.closest('li')).not.toBeNull()
    }
    const liTexts = [...container.querySelectorAll('li')].map((li) => li.textContent)
    expect(liTexts.slice(1)).toEqual(['子项一', '子项二来了', '乙项'])
    // 推到完：全部揭示、推进头退场、文本不变
    pumpUntil(() => allDone(container))
    expect(container.querySelectorAll('.stream-reveal-head')).toHaveLength(0)
    expect([...container.querySelectorAll('li')].map((li) => li.textContent).slice(1)).toEqual([
      '子项一',
      '子项二来了',
      '乙项'
    ])
  })

  test('settle（streaming=false）：零 span 零 mask 残留，已完成消息无动画', async () => {
    const { container, rerender } = render(<TranslatedBody text="正文。" streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-reveal').length).toBeGreaterThan(0)
    })
    rerender(<TranslatedBody text="正文。" streaming={false} />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-reveal')).toHaveLength(0)
    })
    const body = container.querySelector('.mail-body') as HTMLElement
    expect(body.getAttribute('style') ?? '').not.toContain('mask')
  })

  test('历史消息（从头 streaming=false）：无任何包裹', () => {
    const { container } = render(<TranslatedBody text="历史**消息**正文。" streaming={false} />)
    expect(container.querySelectorAll('.stream-reveal')).toHaveLength(0)
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('消息')
  })

  test('reduce-motion：流式渲染零 span，文本立即完整可见', async () => {
    reduceMatches = true
    const { container } = render(<TranslatedBody text="第一句。第二句。" streaming />)
    await waitFor(() => {
      expect(container.textContent).toContain('第二句')
    })
    expect(container.querySelectorAll('.stream-reveal')).toHaveLength(0)
  })

  test('不丢字：中英混排 + emoji + markdown、多速率投递，DOM 文本恒等于静态渲染', async () => {
    const steps = [
      '你好👋，这是第一句。',
      '你好👋，这是第一句。Here is **bold** English.',
      '你好👋，这是第一句。Here is **bold** English.\n\n- 列表项甲\n- 列表项乙',
      '你好👋，这是第一句。Here is **bold** English.\n\n- 列表项甲\n- 列表项乙\n\n最后一段完结。'
    ]
    // 四种到达节奏：同帧突发（0ms）/ smoothStream 排空突发（11ms）/ 常见句间隔
    // （200ms）/ 慢速（1000ms，练 dt clamp）。
    const cadences = [0, 11, 200, 1000]

    // 🔴 ground truth 必须在 waitFor 之外算：waitFor 的回调会被 document 上的
    // MutationObserver 在每次 DOM 变化时重新调起，回调里 render+unmount 会自己
    // 制造 mutation → 无限互激（实测直接把 worker 撑到 4GB OOM）。
    //
    // 流式期的 ground truth 用「reduce 短路的 streaming 渲染」（零 span、全文直出）：
    // streaming 与 static 两条渲染路径的**块间空白文本节点**本就不同（\n vs \n\n，
    // Streamdown 分块 vs 单趟的既有差异，与 reveal 无关），只有同模式对比才是
    // 「span 不吃字」的字节级判据。settle 后则与 static 渲染逐字比。
    const streamingFullText = (md: string): string => {
      reduceMatches = true
      const gt = render(<TranslatedBody text={md} streaming />)
      const txt = gt.container.textContent ?? ''
      gt.unmount()
      reduceMatches = false
      return txt
    }
    const staticText = (md: string): string => {
      const gt = render(<TranslatedBody text={md} streaming={false} />)
      const txt = gt.container.textContent ?? ''
      gt.unmount()
      return txt
    }
    const expected = steps.map(streamingFullText)
    const expectedFinal = staticText(steps[3])

    const first = render(<TranslatedBody text={steps[0]} streaming />)
    const { container, rerender } = first
    await waitFor(() => {
      expect(container.textContent).toContain('第一句')
    })
    expect(container.textContent).toBe(expected[0])

    for (let i = 1; i < steps.length; i++) {
      if (cadences[i] > 0) manual.pump(cadences[i])
      rerender(<TranslatedBody text={steps[i]} streaming />)
      await waitFor(() => {
        expect(container.textContent).toBe(expected[i])
      })
      // 任意瞬间推进头 ≤ 1（详尽的逐帧采样在 invariant 专文件）
      expect(container.querySelectorAll('.stream-reveal-head').length).toBeLessThanOrEqual(1)
    }

    pumpUntil(() => allDone(container))
    expect(container.textContent).toBe(expected[3])
    expect(doneCount(container)).toBeGreaterThan(0)

    rerender(<TranslatedBody text={steps[3]} streaming={false} />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-reveal')).toHaveLength(0)
    })
    expect(container.textContent).toBe(expectedFinal)
  })
})

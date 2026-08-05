// @vitest-environment happy-dom
//
// 0804 dogfood 1c — chat 流式正文「chunk 内左→右 reveal」（方案 C）回归。
//
// 两层：
// A. rehype 插件纯函数级 —— 边界切分 / skip 集 / 空白 / parity 翻转（含 transition
//    重放不多翻）。这是「per-chunk wrapper 不破坏 markdown 结构」的机械保证。
// B. TranslatedBody + 真 Streamdown（streaming 模式）集成 —— 验证 BlockComponent
//    接线真的把插件送进了渲染管线（当初评估认为拿不到 per-chunk 边界，这条测试
//    钉住「拿到了」）：续写后只有新尾巴在 .stream-wipe 里、旧文本裸出、strong
//    结构完好；settle（static）后零 span 零 mask 残留。
//
// happy-dom 不跑 CSS 动画：mask/keyframes 的观感（羽化、折行 slice 推进、reduce
// 直出）需打包后人工确认；这里锁的是 DOM 形状与包裹边界。

import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

import { createStreamWipePlugin } from '@shared/components/email/streamWipePlugin'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'

afterEach(cleanup)

// ── A. 插件纯函数级 ────────────────────────────────────────────────────────────

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

/** rehypePlugin 是 unified 插件工厂：调用一次拿 transformer。 */
function run(plugin: ReturnType<typeof createStreamWipePlugin>, tree: Node): void {
  const factory = plugin.rehypePlugin as unknown as () => (t: Node) => void
  factory()(tree)
}

const wipeSpans = (node: Node): Node[] => {
  const out: Node[] = []
  const visit = (n: Node): void => {
    const cls = (n.properties?.className ?? []) as string[]
    if (n.type === 'element' && cls.includes('stream-wipe')) out.push(n)
    for (const c of n.children ?? []) visit(c)
  }
  visit(node)
  return out
}
const spanText = (n: Node): string => n.children?.[0]?.value ?? ''
const parityClass = (n: Node): string => {
  const cls = (n.properties?.className ?? []) as string[]
  return cls.find((c) => c === 'stream-wipe-a' || c === 'stream-wipe-b') ?? ''
}

describe('createStreamWipePlugin — 边界切分', () => {
  test('首轮 prev=0：整个文本节点包进一个 wipe span，计数=文本长度', () => {
    const plugin = createStreamWipePlugin()
    const tree = root(el('p', text('第一句话。')))
    plugin.setPrevContentLength(0)
    run(plugin, tree)
    const spans = wipeSpans(tree)
    expect(spans).toHaveLength(1)
    expect(spanText(spans[0])).toBe('第一句话。')
    expect(plugin.getLastRunCharCount()).toBe(5)
  })

  test('边界落在节点内部：旧前缀留纯文本，新尾巴进 span；不跨节点', () => {
    const plugin = createStreamWipePlugin()
    const tree = root(el('p', text('第一句话。第二句到了。')))
    plugin.setPrevContentLength(5)
    run(plugin, tree)
    const p = tree.children![0]
    expect(p.children).toHaveLength(2)
    expect(p.children![0]).toMatchObject({ type: 'text', value: '第一句话。' })
    const spans = wipeSpans(tree)
    expect(spans).toHaveLength(1)
    expect(spanText(spans[0])).toBe('第二句到了。')
    expect(plugin.getLastRunCharCount()).toBe(11)
  })

  test('一句横跨 inline 结构：每个文本节点的新尾巴各自成 span，结构不被破坏', () => {
    const plugin = createStreamWipePlugin()
    // 旧内容 "前文。"(3) + 新句 "看" + <strong>重点</strong> + "内容。"
    const strong = el('strong', text('重点'))
    const tree = root(el('p', text('前文。看'), strong, text('内容。')))
    plugin.setPrevContentLength(3)
    run(plugin, tree)
    const spans = wipeSpans(tree)
    expect(spans.map(spanText)).toEqual(['看', '重点', '内容。'])
    // strong 元素仍在原位，wipe span 在它内部（wrapper 永不跨结构边界）
    expect(strong.children).toHaveLength(1)
    expect(strong.children![0].tagName).toBe('span')
  })

  test('整节点都是旧内容 → 原样不碰', () => {
    const plugin = createStreamWipePlugin()
    const node = text('全是旧的')
    const tree = root(el('p', node))
    plugin.setPrevContentLength(99)
    run(plugin, tree)
    expect(wipeSpans(tree)).toHaveLength(0)
    expect(tree.children![0].children![0]).toBe(node)
  })

  test('skip 集：code/pre 子树不包裹也不计数（镜像上游 animate 插件）', () => {
    const plugin = createStreamWipePlugin()
    const code = el('code', text('pm2 status'))
    const tree = root(el('p', text('先看'), code, text('的输出')))
    plugin.setPrevContentLength(0)
    run(plugin, tree)
    // code 内文本原样保留（塞 span 会弄脏 CodeBlock 的原文抽取）
    expect(code.children![0]).toMatchObject({ type: 'text', value: 'pm2 status' })
    expect(wipeSpans(tree).map(spanText)).toEqual(['先看', '的输出'])
    // 计数不含 code 内文本：先看(2) + 的输出(3)
    expect(plugin.getLastRunCharCount()).toBe(5)
  })

  test('纯空白文本节点：计数但永不包裹', () => {
    const plugin = createStreamWipePlugin()
    const tree = root(el('p', text('a'), text('  \n'), text('b')))
    plugin.setPrevContentLength(0)
    run(plugin, tree)
    expect(wipeSpans(tree).map(spanText)).toEqual(['a', 'b'])
    expect(plugin.getLastRunCharCount()).toBe(5)
  })
})

describe('createStreamWipePlugin — parity（a/b 动画名交替）', () => {
  test('边界推进 → parity 翻转；同边界重放（useTransition 中断重渲）→ 不翻', () => {
    const plugin = createStreamWipePlugin()

    const t1 = root(el('p', text('第一句。')))
    plugin.setPrevContentLength(0)
    run(plugin, t1)
    const p1 = parityClass(wipeSpans(t1)[0])

    // transition 重放：同 prev 再跑 → parity 必须不变（否则重放会翻名重启动画）
    const t1b = root(el('p', text('第一句。')))
    plugin.setPrevContentLength(0)
    run(plugin, t1b)
    expect(parityClass(wipeSpans(t1b)[0])).toBe(p1)

    // 新 chunk（prev 推进）→ parity 翻转，React 复用同 key span 时动画名变化才会重启
    const t2 = root(el('p', text('第一句。第二句。')))
    plugin.setPrevContentLength(4)
    run(plugin, t2)
    const p2 = parityClass(wipeSpans(t2)[0])
    expect(p2).not.toBe(p1)
    expect([p1, p2].sort()).toEqual(['stream-wipe-a', 'stream-wipe-b'])
  })

  test('getLastRunCharCount 非破坏性读（连续读同值，重放安全）', () => {
    const plugin = createStreamWipePlugin()
    const tree = root(el('p', text('四个字啊')))
    plugin.setPrevContentLength(0)
    run(plugin, tree)
    expect(plugin.getLastRunCharCount()).toBe(4)
    expect(plugin.getLastRunCharCount()).toBe(4)
  })
})

// ── B. TranslatedBody + 真 Streamdown 集成 ─────────────────────────────────────

describe('TranslatedBody streaming — wipe 接线', () => {
  test('续写后只有新尾巴进 .stream-wipe；旧文本裸出；strong 结构完好', async () => {
    const { container, rerender } = render(<TranslatedBody text="第一句话。" streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-wipe').length).toBeGreaterThan(0)
    })

    rerender(<TranslatedBody text="第一句话。这里有**重点**内容。" streaming />)
    await waitFor(() => {
      const spans = [...container.querySelectorAll('.stream-wipe')]
      expect(spans.map((s) => s.textContent)).toEqual(['这里有', '重点', '内容。'])
    })
    // 旧句已被解包成裸文本（不在任何 wipe span 里）→ 不会重播动画
    const p = container.querySelector('p')
    expect(p?.textContent).toBe('第一句话。这里有重点内容。')
    expect(p?.firstChild?.nodeType).toBe(3) // Text node
    expect(p?.firstChild?.textContent).toBe('第一句话。')
    // markdown 结构未被 wrapper 破坏：strong 在（Streamdown 默认把 strong 渲染成
    // span[data-streamdown=strong]，hast 层 tagName 仍是 strong），wipe span 在其内部
    const strong = container.querySelector('[data-streamdown="strong"]')
    expect(strong).not.toBeNull()
    expect(strong?.querySelector('.stream-wipe')?.textContent).toBe('重点')
  })

  test('新段落（新 block 挂载）：第一句整句进 wipe span —— per-block 插件实例修的上游坑', async () => {
    // 上游共享插件实例时，新 block 挂载会读到前一 block 的字符数当 prev → 新段落
    // 第一句被误判成旧内容、永不动画。per-block 实例下新 block 的 prev=0。
    const { container, rerender } = render(<TranslatedBody text="第一段落的话。" streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-wipe').length).toBeGreaterThan(0)
    })
    rerender(<TranslatedBody text={'第一段落的话。\n\n短句。'} streaming />)
    await waitFor(() => {
      const ps = [...container.querySelectorAll('p')]
      expect(ps).toHaveLength(2)
      const wipeInSecond = ps[1].querySelector('.stream-wipe')
      expect(wipeInSecond?.textContent).toBe('短句。')
    })
  })

  test('表格：span 只在 th/td 内且不含元素子节点；结构/复制文本完好；settle 清空 memo 保留的旧 span', async () => {
    // 复核实测（2026-08-05）：Streamdown 的 th/td 子组件按「className+position」memo
    // （比较器不看 children）——新行流入时旧单元格跳过重渲，上一轮的 wipe span 会
    // **惰性留存**（动画已放完、无 mask、类名不变不重放）。这条测试钉住的语义是：
    // ① span 永远只出现在单元格内、不含任何元素子节点（结构由构造保证）；
    // ② textContent 不受包裹影响（复制保真）；③ settle 后连惰性 span 一起清零。
    const t1 = '| 列甲 | 列乙 |\n| --- | --- |\n| 第一格 | 第二'
    const t2 = '| 列甲 | 列乙 |\n| --- | --- |\n| 第一格 | 第二格满了。 |\n| 新行左 | 新行右 |'
    const { container, rerender } = render(<TranslatedBody text={t1} streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-wipe').length).toBeGreaterThan(0)
    })
    rerender(<TranslatedBody text={t2} streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('td')).toHaveLength(4)
    })
    expect(container.querySelectorAll('th')).toHaveLength(2)
    for (const span of container.querySelectorAll('.stream-wipe')) {
      expect(['TH', 'TD']).toContain(span.parentElement?.tagName)
      expect(span.children).toHaveLength(0) // 只包文本，永不包元素（无非法嵌套）
    }
    expect(container.querySelector('table')?.textContent).toBe(
      '列甲列乙第一格第二格满了。新行左新行右'
    )
    rerender(<TranslatedBody text={t2} streaming={false} />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-wipe')).toHaveLength(0)
    })
    expect(container.querySelectorAll('td')).toHaveLength(4)
  })

  test('嵌套列表：span 不包裹 li/ul，ul>li>ul 层级完好，各 li 文本保真', async () => {
    const t1 = '- 甲项内容\n  - 子项一'
    const t2 = '- 甲项内容\n  - 子项一\n  - 子项二来了\n- 乙项'
    const { container, rerender } = render(<TranslatedBody text={t1} streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-wipe').length).toBeGreaterThan(0)
    })
    rerender(<TranslatedBody text={t2} streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('li')).toHaveLength(4)
    })
    expect(container.querySelector('ul ul')).not.toBeNull() // 嵌套层级在
    for (const span of container.querySelectorAll('.stream-wipe')) {
      expect(span.children).toHaveLength(0) // span 永不包住 li/ul 等元素
      expect(span.closest('li')).not.toBeNull()
    }
    const liTexts = [...container.querySelectorAll('li')].map((li) => li.textContent)
    // li[0] 含嵌套子列表的文本；末三项为叶子
    expect(liTexts.slice(1)).toEqual(['子项一', '子项二来了', '乙项'])
    // 生长中的 li 正确二分：旧前缀「子项」裸文本 + 新尾巴「二来了」进 span
    const growingLi = [...container.querySelectorAll('li')].find(
      (li) => li.textContent === '子项二来了'
    )
    expect(growingLi?.querySelector('.stream-wipe')?.textContent).toBe('二来了')
  })

  test('settle（streaming=false）：零 span 零 mask 残留，已完成消息无动画', async () => {
    const { container, rerender } = render(<TranslatedBody text="正文。" streaming />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-wipe').length).toBeGreaterThan(0)
    })
    rerender(<TranslatedBody text="正文。" streaming={false} />)
    await waitFor(() => {
      expect(container.querySelectorAll('.stream-wipe')).toHaveLength(0)
    })
    // 老 D 方案（尾部渐变 STREAMING_TAIL_MASK inline style）已退役：容器不再带 mask
    const body = container.querySelector('.mail-body') as HTMLElement
    expect(body.getAttribute('style') ?? '').not.toContain('mask')
  })

  test('历史消息（从头 streaming=false）：无任何 wipe 包裹', () => {
    const { container } = render(<TranslatedBody text="历史**消息**正文。" streaming={false} />)
    expect(container.querySelectorAll('.stream-wipe')).toHaveLength(0)
    expect(container.querySelector('[data-streamdown="strong"]')?.textContent).toBe('消息')
  })
})

// @vitest-environment happy-dom
//
// 标签条（task 08-27-l4-tab-workspace P2 Lane U）。
//
// 钉的是 owner 最在意的观感面背后的**几何契约**与主标签契约：
//   1. 主标签面包屑单段不显分隔符 / 双段显（prd「主标签」）；
//   2. 对象标签的渲染、激活切换、关闭、锁定琥珀点、空标题兜底；
//   3. morphing 滑动面与 hairline 断口的坐标 —— 断口 = [surfLeft-12, surfLeft+surfW+12]
//      （±12 是外凹圆角宽度）。这组数错一个就是「hairline 没断开 / 断口跟不上面」，
//      正是 owner 报过的「还有条分割线」的回归形态。
//
// happy-dom 没有 ResizeObserver，也不做布局（offset* 恒 0）——用可手动触发的
// FakeResizeObserver + defineProperty 喂几何（对照 tests/shared/SectionAnchorNav.test.tsx
// 的先例）。store 的持久化走 try/catch 静默降级，UI 测试不断言持久化，无需 stub。

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// ─── ResizeObserver 替身 ─────────────────────────────────────────────────────

const roInstances: FakeResizeObserver[] = []

class FakeResizeObserver {
  private readonly cb: ResizeObserverCallback

  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    roInstances.push(this)
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}

  /** 组件的 measure 直接读元素 offset*，entries 用不上，给空数组即可。 */
  trigger(): void {
    this.cb([], this as unknown as ResizeObserver)
  }
}

vi.stubGlobal('ResizeObserver', FakeResizeObserver)

import i18n from '../../../src/shared/i18n'
import { TabStrip } from '@shared/components/tabs/TabStrip'
import {
  MAIN_SLOT,
  SEARCH_TAB_ID,
  SEARCH_TARGET_ID,
  useTabWorkspace
} from '@shared/state/tab-workspace'
import { _resetTabBridgeForTest, useTabCloseGuard } from '@shared/state/tab-workspace-bridge'

await i18n.changeLanguage('zh-CN')

beforeEach(() => {
  roInstances.length = 0
  useTabWorkspace.setState({
    tabs: [],
    active: MAIN_SLOT,
    mainPage: 'today',
    mainBreadcrumb: null,
    maxTabs: 8
  })
  _resetTabBridgeForTest()
})

afterEach(cleanup)

/** 给 .tstrip-tabs 喂实测几何（left = tabs 区在 .tstrip 内的 offsetLeft）并触发 RO。 */
function wireGeometry(container: HTMLElement, left = 195, width = 600): void {
  const wrap = container.querySelector('.tstrip-tabs')
  if (!(wrap instanceof HTMLElement)) throw new Error('.tstrip-tabs 不在')
  Object.defineProperty(wrap, 'offsetLeft', { value: left, configurable: true })
  Object.defineProperty(wrap, 'offsetWidth', { value: width, configurable: true })
  act(() => {
    for (const ro of roInstances) ro.trigger()
  })
}

function surface(container: HTMLElement): HTMLElement {
  const el = container.querySelector('.tstrip-surface')
  if (!(el instanceof HTMLElement)) throw new Error('.tstrip-surface 不在')
  return el
}

function hairs(container: HTMLElement): [HTMLElement, HTMLElement] {
  const els = container.querySelectorAll('.tstrip-hair')
  if (els.length !== 2) throw new Error(`hairline 应是两段，实际 ${els.length}`)
  return [els[0] as HTMLElement, els[1] as HTMLElement]
}

describe('TabStrip — 主标签', () => {
  test('单段面包屑：只有域名，不显分隔符', () => {
    const { container } = render(<TabStrip />)
    const main = screen.getAllByRole('tab')[0]
    expect(main.textContent).toContain('今日')
    expect(main.getAttribute('aria-selected')).toBe('true')
    expect(container.querySelector('.tcrumb-sep')).toBeNull()
  })

  test('双段面包屑：域名 / 第二段（icon 与文本随承载切换）', () => {
    const { container } = render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().setMainPage('calendar')
      useTabWorkspace.getState().setMainBreadcrumb('2026 年 8 月')
    })
    const main = screen.getAllByRole('tab')[0]
    expect(main.textContent).toContain('日历')
    expect(main.textContent).toContain('2026 年 8 月')
    expect(container.querySelector('.tcrumb-sep')?.textContent).toBe('/')
  })
})

describe('TabStrip — 对象标签', () => {
  test('渲染 store 里的全部标签（maxTabs 内），点击切换激活', () => {
    render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().openTab('email', 1, '周报确认')
      useTabWorkspace.getState().openTab('matter', 2, '供应商合同')
    })
    const tabsEls = screen.getAllByRole('tab')
    expect(tabsEls.length).toBe(3) // 主标签 + 2 对象标签
    // 最后打开的是激活的那个
    expect(tabsEls[2].getAttribute('aria-selected')).toBe('true')
    fireEvent.click(tabsEls[1])
    expect(useTabWorkspace.getState().active).toBe('email:1')
    expect(screen.getAllByRole('tab')[1].getAttribute('aria-selected')).toBe('true')
  })

  test('开满 maxTabs 个都渲染', () => {
    render(<TabStrip />)
    act(() => {
      for (let i = 1; i <= 8; i++) useTabWorkspace.getState().openTab('email', i, `邮件 ${i}`)
    })
    expect(screen.getAllByRole('tab').length).toBe(9) // 主标签 + 8
  })

  test('关闭钮关掉对应标签，不冒泡成激活', () => {
    render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().openTab('email', 1, '周报确认')
      useTabWorkspace.getState().openTab('email', 2, '供应商合同')
    })
    const closes = screen.getAllByRole('button', { name: '关闭标签（⌘W）' })
    expect(closes.length).toBe(2)
    fireEvent.click(closes[0]) // 关第一个（非激活）
    const state = useTabWorkspace.getState()
    expect(state.tabs.map((tb) => tb.id)).toEqual(['email:2'])
    expect(state.active).toBe('email:2')
  })

  test('锁定标签带琥珀点（title 提示），未锁定没有', () => {
    const { container } = render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().openTab('email', 1, '写一半的回复')
      useTabWorkspace.getState().openTab('email', 2, '只是看看')
      useTabWorkspace.getState().updateTab('email:1', { locked: true })
    })
    expect(container.querySelectorAll('.ttab-lock').length).toBe(1)
    expect(screen.getByTitle('有未完成的工作，不会被自动关闭')).toBeTruthy()
  })

  test('空标题（deeplink 先开着）显示未命名兜底文案', () => {
    render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().openTab('matter', 9)
    })
    expect(screen.getAllByRole('tab')[1].textContent).toContain('未命名')
  })

  test('搜索标签标题恒「新标签页」（按 kind 取 i18n，不读快照）', () => {
    render(<TabStrip />)
    act(() => {
      // 快照故意塞别的字 —— 渲染必须无视它（切语言即时跟的前提）。
      useTabWorkspace.getState().openTab('search', SEARCH_TARGET_ID, '快照里的旧标题')
    })
    const tab = screen.getAllByRole('tab')[1]
    expect(tab.textContent).toContain('新标签页')
    expect(tab.textContent).not.toContain('快照里的旧标题')
    // 可关（⌘W / 关闭钮），与对象标签同款
    expect(screen.getAllByRole('button', { name: '关闭标签（⌘W）' })).toHaveLength(1)
  })
})

describe('TabStrip — 「+」新标签页钮', () => {
  test('点击开搜索单例并激活；再点只激活不重复开', () => {
    render(<TabStrip />)
    const plus = screen.getByRole('button', { name: '新标签页（⌘T）' })
    fireEvent.click(plus)
    expect(useTabWorkspace.getState().tabs.map((tb) => tb.id)).toEqual([SEARCH_TAB_ID])
    expect(useTabWorkspace.getState().active).toBe(SEARCH_TAB_ID)
    act(() => {
      useTabWorkspace.getState().activateMain()
    })
    fireEvent.click(plus)
    expect(useTabWorkspace.getState().tabs).toHaveLength(1)
    expect(useTabWorkspace.getState().active).toBe(SEARCH_TAB_ID)
  })

  test('钮在 .tstrip-tabs 内、恒为最后一个子节点（Chrome 式跟在最后一个标签右侧）', () => {
    const { container } = render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().openTab('email', 1, 'A')
      useTabWorkspace.getState().openTab('email', 2, 'B')
    })
    const wrap = container.querySelector('.tstrip-tabs')
    const plus = container.querySelector('.tstrip-plus')
    expect(plus).not.toBeNull()
    expect(plus?.parentElement).toBe(wrap)
    expect(wrap?.lastElementChild).toBe(plus)
  })
})

describe('TabStrip — morphing 滑动面与 hairline 断口', () => {
  test('主标签激活：面压在主标签上（left 10 / width 168），断口含两侧外凹圆角', () => {
    const { container } = render(<TabStrip />)
    wireGeometry(container)
    const surf = surface(container)
    expect(surf.style.left).toBe('10px')
    expect(surf.style.width).toBe('168px')
    const [hairL, hairR] = hairs(container)
    // 左段被夹到 0（10-12 < 0），右段从 10+168+12 起
    expect(hairL.style.width).toBe('0px')
    expect(hairR.style.left).toBe('190px')
  })

  test('对象标签激活：面滑到对应格，断口跟随（宽度按容器实测 clamp 84-190）', () => {
    const { container } = render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().openTab('email', 1, 'A')
      useTabWorkspace.getState().openTab('email', 2, 'B')
    })
    // left 195 / width 600、n=2 ⇒ floor((600-28-2×2)/2)=284 → clamp 84-190 = 190
    // （「+」钮在 tabs 区内，宽 28 + 一个 gap 从可用宽度里扣掉）
    wireGeometry(container)
    const surf = surface(container)
    // 激活的是第二个：surfLeft = 195 + 1×(190+2) = 387
    expect(surf.style.left).toBe('387px')
    expect(surf.style.width).toBe('190px')
    const [hairL, hairR] = hairs(container)
    expect(hairL.style.width).toBe('375px') // 387 - 12
    expect(hairR.style.left).toBe('589px') // 387 + 190 + 12
    // 对象标签本体吃同一个 tabW
    expect(screen.getAllByRole('tab')[1].style.width).toBe('190px')
  })

  test('窄容器把标签压到 84 下限', () => {
    const { container } = render(<TabStrip />)
    act(() => {
      for (let i = 1; i <= 4; i++) useTabWorkspace.getState().openTab('email', i, `邮件 ${i}`)
    })
    wireGeometry(container, 195, 200) // floor((200-28-8)/4)=41 → clamp 到 84
    expect(screen.getAllByRole('tab')[1].style.width).toBe('84px')
  })
})

describe('TabStrip — 改动点与关闭守卫（dogfood 波3）', () => {
  test('draft.dirty 的 email 标签渲染改动点；与锁定点互斥，dirty 优先', () => {
    const { container } = render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().openTab('email', 1, '写一半的草稿')
      useTabWorkspace.getState().openTab('email', 2, '聊过的邮件')
      // dirty 快照在场（真实链路里 live 写快照 + recompute 会顺带 locked=true）
      useTabWorkspace
        .getState()
        .updateTab('email:1', { draft: { kind: 'compose', dirty: true }, locked: true })
      useTabWorkspace.getState().updateTab('email:2', { locked: true })
    })
    // email:1 dirty+locked → 只画 dirty 点；email:2 只 locked → 琥珀点
    expect(container.querySelectorAll('.ttab-dirty').length).toBe(1)
    expect(container.querySelectorAll('.ttab-lock').length).toBe(1)
    expect(screen.getByTitle('有未保存的修改')).toBeTruthy()
  })

  test('× 对 dirty 草稿标签走关闭守卫：不直接关，先激活 + 挂起请求', () => {
    render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().openTab('email', 1, '草稿')
      useTabWorkspace.getState().openTab('email', 2, '别的')
      useTabWorkspace.getState().updateTab('email:1', { draft: { kind: 'compose', dirty: true } })
    })
    const closes = screen.getAllByRole('button', { name: '关闭标签（⌘W）' })
    fireEvent.click(closes[0]) // × 第一个（dirty、非激活）
    const state = useTabWorkspace.getState()
    expect(state.tabs.some((t) => t.id === 'email:1')).toBe(true)
    expect(state.active).toBe('email:1')
    expect(useTabCloseGuard.getState().pending?.tabId).toBe('email:1')
  })
})

// setup.ts 全局强制 reduce（组件测试断言最终 DOM）—— 本组测的就是动画中间态，
// 按 setup.ts 注释的约定自行覆盖 matchMedia（useExitAnimation.test 同款先例）。
describe('TabStrip — 开合动效（dogfood 轮4：关闭收缩淡出 / 新开长出 / 原位换身不播）', () => {
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    vi.useRealTimers()
  })

  test('关闭：标签先以幽灵态留在 DOM（.ttab-closing，宽 0、退出 a11y 树），到点卸载', () => {
    vi.useFakeTimers()
    const { container } = render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().openTab('email', 1, 'A')
      useTabWorkspace.getState().openTab('email', 2, 'B')
    })
    act(() => {
      useTabWorkspace.getState().closeTab('email:1')
    })
    const ghost = container.querySelector('.ttab-closing')
    expect(ghost).not.toBeNull()
    expect((ghost as HTMLElement).style.width).toBe('0px')
    expect(ghost?.getAttribute('aria-hidden')).toBe('true')
    // 幽灵不是 tab：可交互序列 = 主标签 + email:2
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    act(() => {
      vi.runAllTimers()
    })
    expect(container.querySelector('.ttab-closing')).toBeNull()
  })

  test('新开：入场标签带 .ttab-enter（从 0 宽长出）；挂载时的存量标签不播', () => {
    act(() => {
      useTabWorkspace.getState().openTab('email', 1, 'A')
    })
    const { container } = render(<TabStrip />)
    // boot 存量：直接入列，不闪一排入场动画
    expect(container.querySelector('.ttab-enter')).toBeNull()
    act(() => {
      useTabWorkspace.getState().openTab('email', 2, 'B')
    })
    const entering = container.querySelectorAll('.ttab-enter')
    expect(entering).toHaveLength(1)
    expect(entering[0].textContent).toContain('B')
  })

  test('满员驱逐 = 幽灵收缩 + 新标签长出同帧并存（静默驱逐的观感面）', () => {
    vi.useFakeTimers()
    const { container } = render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().setMaxTabs(4)
      for (let i = 1; i <= 4; i++) useTabWorkspace.getState().openTab('email', i, `邮件 ${i}`)
    })
    // 先让这一批的入场标记到点摘除，隔离出「第 5 个」这次开合
    act(() => {
      vi.runAllTimers()
    })
    expect(container.querySelector('.ttab-enter')).toBeNull()
    act(() => {
      useTabWorkspace.getState().openTab('email', 5, '邮件 5')
    })
    const ghost = container.querySelector('.ttab-closing')
    expect(ghost?.textContent).toContain('邮件 1')
    const entering = container.querySelectorAll('.ttab-enter')
    expect(entering).toHaveLength(1)
    expect(entering[0].textContent).toContain('邮件 5')
  })

  test('原位换目标（J/K 的 replaceActiveTab）不播动画：无幽灵、无入场', () => {
    const { container } = render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().openTab('email', 1, 'A')
    })
    act(() => {
      useTabWorkspace.getState().replaceActiveTab('email', 2, 'B')
    })
    expect(container.querySelector('.ttab-closing')).toBeNull()
    // openTab('email',1) 播过的入场标记在换身时一并清掉（换身不是新开）
    expect(container.querySelector('.ttab-enter')).toBeNull()
    expect(screen.getAllByRole('tab')[1].textContent).toContain('B')
  })

  test('幽灵期间重开同一目标（⌘⇧T 秒回）：幽灵让位，存活序与 store 一致', () => {
    vi.useFakeTimers()
    const { container } = render(<TabStrip />)
    act(() => {
      useTabWorkspace.getState().openTab('email', 1, 'A')
      useTabWorkspace.getState().openTab('email', 2, 'B')
    })
    act(() => {
      useTabWorkspace.getState().closeTab('email:1')
    })
    expect(container.querySelector('.ttab-closing')).not.toBeNull()
    act(() => {
      useTabWorkspace.getState().reopenLastClosed()
    })
    // 同一个 id 不能一边是幽灵一边是活标签 —— 幽灵当场让位（含定时器取消）
    expect(container.querySelector('.ttab-closing')).toBeNull()
    const tabsEls = screen.getAllByRole('tab')
    expect(tabsEls).toHaveLength(3)
    // store 序 = [email:2, email:1]（重开走 append）——渲染序必须跟 store，滑动面才指得对格
    expect(tabsEls[1].textContent).toContain('B')
    expect(tabsEls[2].textContent).toContain('A')
    act(() => {
      vi.runAllTimers()
    })
    expect(screen.getAllByRole('tab')).toHaveLength(3)
  })
})

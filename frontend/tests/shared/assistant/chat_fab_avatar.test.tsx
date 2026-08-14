// @vitest-environment happy-dom
//
// AI FAB 头像的纪律网。0813 dogfood 后契约改成五条（owner：「白色亮弧太丑了去掉吧。默认加点
// 外阴影，不然看不出来区分。hover 不要改表情啊，只是头像放大 + tips」）：
//   ① **光环整层已删** —— 亮弧与底环一起，且 CSS 里的 `.chat-fab-halo-*` / keyframes 同步清掉。
//      这条是「别留一半装饰」的机器判据：只删 TSX 不删 CSS（或反过来）都会红。
//   ② **外投影** —— 头像挂 `.chat-fab-avatar`，且 index.css 里那条用的是 `drop-shadow`
//      （异形剪影套不了 box-shadow，见组件文件头）。
//   ③ **hover 只放大 + tips，不换表情** —— 在 ChatModalFab 层实测：mouseEnter 后 tooltip 出现、
//      眼睛 path 逐字节不变。这是本轮 owner 反馈的核心，故断在真组件上而非 prop 形状上。
//   ④ **上传图回落圆角方形** —— 圆角与批 Z 的头像容器口径同源，不是正圆。
//   ⑤ **reduced-motion + 低频换脸** —— 旋光已无，但换脸 interval 的 reduce 短路仍在 JS 层。
//
// 套件默认 reduced-motion（tests/setup.ts 全局），测真动画路径要 allowMotion() 显式退出。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { AssistantIdentity } from '@shared/api/types'
import {
  __resetAssistantIdentity,
  primeAssistantIdentity
} from '@shared/assistant/assistantIdentity'
import {
  ChatFabAvatar,
  FAB_AVATAR_PX,
  FAB_FACE_INTERVAL_MS,
  FAB_IMAGE_RADIUS_PX
} from '@shared/assistant/modal/ChatFabAvatar'
import { ChatModalFab } from '@shared/assistant/modal/ChatModalFab'
import { AVATAR_SHELL_RADIUS_RATIO } from '@shared/components/agents/avatarShell'
import { useActiveEmail } from '@shared/state/active-email'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'

const getAssistantIdentity = vi.fn(
  async (): Promise<AssistantIdentity> => ({
    name: null,
    avatar: null
  })
)

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ chat: { getAssistantIdentity } })
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

/** 退出套件默认的 reduced-motion（先例：TurnPresence.test.tsx）。afterEach 统一 unstub。 */
function allowMotion(): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null
      }) as unknown as MediaQueryList
  )
}

function headPath(): string {
  return document.querySelector('[data-bot-head]')?.getAttribute('d') ?? ''
}
function eyePath(): string {
  return document.querySelector('[data-bot-eye="0"]')?.getAttribute('d') ?? ''
}

// 读法沿用 tests/components/ComposeEditor.test.tsx 的既有先例（happy-dom 下 import.meta.url
// 不是 file: scheme，`new URL(...)` 会炸）。
// 🔴 剥掉注释再断言：这些闸问的是「还有没有活的规则」，而讲清「为什么删」的注释里必然要
//    点这些类名 —— 不剥的话，写下那段来龙去脉本身就会把闸弄红（首次跑真踩了）。
const INDEX_CSS = readFileSync(
  resolve(process.cwd(), 'src/electron/renderer/index.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '')

beforeEach(() => {
  __resetAssistantIdentity()
  getAssistantIdentity.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ChatFabAvatar — 光环已整层删除', () => {
  test('bot 身份：只剩头像本体，DOM 里没有任何光环层', () => {
    render(<ChatFabAvatar />)
    expect(headPath().length).toBeGreaterThan(0)
    expect(document.querySelectorAll('[data-fab-halo]')).toHaveLength(0)
    expect(document.querySelector('[data-testid="chat-fab-halo"]')).toBeNull()
    expect(document.body.innerHTML).not.toMatch(/chat-fab-halo/)
  })

  test('上传图身份同样没有光环层（回落轮廓那条分支也一并删了）', () => {
    primeAssistantIdentity({
      name: null,
      avatar: { type: 'image', data: 'data:image/webp;base64,AAAA' }
    })
    render(<ChatFabAvatar />)
    expect(screen.getByTestId('chat-fab-avatar-image')).toBeTruthy()
    expect(document.querySelectorAll('[data-fab-halo]')).toHaveLength(0)
  })

  test('index.css 里 `.chat-fab-halo-*` 与其 keyframes 一起清干净（防只删 TSX 留死 CSS）', () => {
    expect(INDEX_CSS).not.toMatch(/chat-fab-halo/)
    expect(INDEX_CSS).not.toMatch(/rb-star-border|rb-star-spin/)
  })
})

describe('ChatFabAvatar — 外投影', () => {
  test('头像挂 .chat-fab-avatar', () => {
    render(<ChatFabAvatar />)
    const shell = document.querySelector('.chat-fab-avatar')
    expect(shell).not.toBeNull()
    // 投影必须罩住真正的钮面（bot svg 在它里面），不是挂在某个空壳上。
    expect(shell?.querySelector('[data-bot-head]')).not.toBeNull()
  })

  test('index.css 里该类用 drop-shadow —— 异形剪影套不了 box-shadow', () => {
    const rule = /\.chat-fab-avatar\s*\{([^}]*)\}/.exec(INDEX_CSS)
    expect(rule).not.toBeNull()
    expect(rule?.[1]).toMatch(/filter:\s*drop-shadow\(/)
    expect(rule?.[1]).not.toMatch(/box-shadow/)
  })
})

describe('ChatModalFab — hover 只放大 + tips，不换表情', () => {
  beforeEach(() => {
    useAIChatPanel.setState({ visible: false })
    useActiveEmail.setState({ activeInternalId: 42 })
  })

  test('hover：出 tooltip，且表情逐字节不变（0813 owner：hover 不要改表情）', () => {
    // 🔴 必须 allowMotion —— reduce 下换脸 interval 本来就不挂，脸不变会是**假绿**：
    //    测不出「hover 换表情」这条已删路径究竟有没有回来。
    allowMotion()
    render(<ChatModalFab />)
    const before = eyePath()
    expect(before.length).toBeGreaterThan(0)
    expect(screen.queryByRole('tooltip')).toBeNull()

    // HoverTip 的 hover 态挂在包住头像的 wrapper 上。
    const wrapper = document.querySelector('.chat-fab-avatar')?.parentElement
    expect(wrapper).not.toBeNull()
    fireEvent.mouseEnter(wrapper as Element)

    expect(screen.getByRole('tooltip').textContent).toBe('chat.fab.hint')
    expect(eyePath()).toBe(before)

    fireEvent.mouseLeave(wrapper as Element)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(eyePath()).toBe(before)
  })

  test('放大走 group-hover 类（无 JS hover 态，故 hover 不可能驱动第二条表情路径）', () => {
    render(<ChatModalFab />)
    const shell = document.querySelector('.chat-fab-avatar')
    expect(shell?.getAttribute('class')).toMatch(/group-hover:scale-110/)
    // 按钮提供 group 上下文，否则 group-hover 是死类。
    expect(shell?.closest('button')?.getAttribute('class')).toMatch(/(?:^|\s)group(?:\s|$)/)
  })

  test('无正文 / modal 已展开时不渲染（旧行为不因换 tooltip 而变）', () => {
    useActiveEmail.setState({ activeInternalId: null })
    const { container } = render(<ChatModalFab />)
    expect(container.innerHTML).toBe('')
    expect(document.querySelector('.chat-fab-avatar')).toBeNull()

    cleanup()
    useActiveEmail.setState({ activeInternalId: 42 })
    useAIChatPanel.setState({ visible: true })
    render(<ChatModalFab />)
    expect(document.querySelector('.chat-fab-avatar')).toBeNull()
  })
})

describe('ChatFabAvatar — 上传图回落', () => {
  const image: AssistantIdentity = {
    name: null,
    avatar: { type: 'image', data: 'data:image/webp;base64,AAAA' }
  }

  test('渲染静态 img、不渲染 bot 头像，圆角跟批 Z 的容器口径同源（不是正圆）', () => {
    primeAssistantIdentity(image)
    render(<ChatFabAvatar />)
    const img = screen.getByTestId('chat-fab-avatar-image') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('data:image/webp;base64,AAAA')
    expect(document.querySelector('[data-bot-head]')).toBeNull()

    // 🔴 圆角不是自己拍的数：它由 `AVATAR_SHELL_RADIUS_RATIO` 派生，换尺寸不会各调各的。
    const radius = Number.parseFloat(img.style.borderRadius)
    expect(radius).toBeCloseTo(FAB_IMAGE_RADIUS_PX, 6)
    expect(radius).toBeCloseTo(
      Number.parseFloat(img.style.width) * AVATAR_SHELL_RADIUS_RATIO,
      6
    )
    // 不是正圆（rounded-full 会是 9999px / 50%），也没胀出头像盒。
    expect(radius).toBeLessThan(Number.parseFloat(img.style.width) / 2)
    expect(Number.parseFloat(img.style.width)).toBeLessThan(FAB_AVATAR_PX)
  })

  test('上传图身份不挂换脸 interval（图片没有表情可换）', () => {
    allowMotion()
    // 判据是「根本没排这个 timer」而非「画面没变」—— 图片本来就与表情无关，
    // 只断言画面不变会在 interval 真的挂着时也通过（假绿）。同一个 spy 先跑 bot 身份
    // 当正对照，证明 spy 确实盯得住这条排程。
    const setInterval = vi.spyOn(window, 'setInterval')
    const bot = render(<ChatFabAvatar />)
    expect(setInterval).toHaveBeenCalled()
    bot.unmount()

    setInterval.mockClear()
    primeAssistantIdentity(image)
    render(<ChatFabAvatar />)
    expect(setInterval).not.toHaveBeenCalled()
  })
})

describe('ChatFabAvatar — reduced-motion 与低频换脸', () => {
  test('reduce 下换脸 interval 不挂：既没排 timer，推进 3 个周期脸也不变', () => {
    // 🔴 先装假时钟再 spy —— 反过来的话 useFakeTimers 会把（被 spy 的）window.setInterval
    //    整个换掉，spy 从此看不到任何调用，`not.toHaveBeenCalled()` 变成必过的假绿。
    vi.useFakeTimers()
    const setInterval = vi.spyOn(window, 'setInterval')
    render(<ChatFabAvatar />)
    const before = eyePath()
    expect(before.length).toBeGreaterThan(0)
    expect(setInterval).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(FAB_FACE_INTERVAL_MS * 3)
    })
    expect(eyePath()).toBe(before)
  })

  test('到点才换：差 1ms 不换，满一个周期换（45s 低频换脸这条需求保留）', () => {
    allowMotion()
    vi.useFakeTimers()
    // 池里剔掉当前脸之后取第一个 → 确定性
    vi.spyOn(Math, 'random').mockReturnValue(0)
    // cube 的 head path 随表情变（sphere 的轮廓是姿态无关的，换脸只动眼睛）
    primeAssistantIdentity({ name: null, avatar: { type: 'bot', shape: 'cube', color: 'blue' } })
    render(<ChatFabAvatar />)

    const first = headPath()
    act(() => {
      vi.advanceTimersByTime(FAB_FACE_INTERVAL_MS - 1)
    })
    expect(headPath()).toBe(first)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(headPath()).not.toBe(first)
  })
})

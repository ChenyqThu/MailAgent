// @vitest-environment happy-dom
//
// AI FAB 头像 + 轮廓光环（0813）的纪律网。四条契约，逐条对应改动的理由：
//   ① **同源** —— 光环两层的 `d` 必须与头像本体的 head path 逐字节相等（换形状/换表情后依然相等）。
//      这是「不许另画一条近似轮廓」的机器判据。
//   ② **上传图回落圆角方形** —— 没有轮廓 path 的身份不许去猜一条，改喂一条与照片自身圆角
//      同源的圆角方形 path（同一套描边；圆角档跟批 Z 的头像容器口径）。
//   ③ **reduced-motion** —— 旋光类不挂、换脸 interval 不挂（两者都在 JS 层短路，不只靠 CSS media）。
//   ④ **低频换脸** —— 到点才换；换完 ① 仍成立。
//
// 套件默认 reduced-motion（tests/setup.ts 全局），测真动画路径要 allowMotion() 显式退出。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import type { AssistantIdentity } from '@shared/api/types'
import {
  __resetAssistantIdentity,
  primeAssistantIdentity
} from '@shared/assistant/assistantIdentity'
import {
  ChatFabAvatar,
  FAB_AVATAR_PX,
  FAB_FACE_INTERVAL_MS
} from '@shared/assistant/modal/ChatFabAvatar'
import { BOT_VIEW_BOX } from '@shared/bot-avatar/shapes'

const getAssistantIdentity = vi.fn(
  async (): Promise<AssistantIdentity> => ({
    name: null,
    avatar: null
  })
)

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ chat: { getAssistantIdentity } })
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
function haloPath(kind: 'rim' | 'arc'): string {
  return document.querySelector(`[data-fab-halo="${kind}"]`)?.getAttribute('d') ?? ''
}
function haloPaths(kind: 'rim' | 'arc'): string[] {
  return Array.from(document.querySelectorAll(`[data-fab-halo="${kind}"]`)).map(
    (node) => node.getAttribute('d') ?? ''
  )
}
function botBackPaths(): string[] {
  return Array.from(document.querySelectorAll('[data-bot-back]')).map(
    (node) => node.getAttribute('d') ?? ''
  )
}
function eyePath(): string {
  return document.querySelector('[data-bot-eye="0"]')?.getAttribute('d') ?? ''
}

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

describe('ChatFabAvatar — 光环与头像同源', () => {
  test('未配置身份（官方 sphere）：光环两层的 d 与 head path 逐字节相等', () => {
    render(<ChatFabAvatar />)
    const head = headPath()
    expect(head.length).toBeGreaterThan(0)
    expect(haloPath('rim')).toBe(head)
    expect(haloPath('arc')).toBe(head)
  })

  test('异形（cube）：光环跟着换轮廓，不是回落成方/圆兜底形', () => {
    primeAssistantIdentity({ name: null, avatar: { type: 'bot', shape: 'cube', color: 'blue' } })
    render(<ChatFabAvatar />)
    const head = headPath()
    expect(haloPath('rim')).toBe(head)
    expect(haloPath('arc')).toBe(head)
    // 回落形是「直边 + 四段圆角 A 弧」；真轮廓不是（cube 是折线凸包，无 A 段）
    expect(haloPath('arc')).not.toMatch(/ A /)
  })

  test('mickey：底环把背层（耳朵）也描上，条数与 BotAvatar 实际画的背层一致；亮弧只跑主轮廓', () => {
    primeAssistantIdentity({
      name: null,
      avatar: { type: 'bot', shape: 'mickey', color: 'orange' }
    })
    render(<ChatFabAvatar />)
    const back = botBackPaths()
    expect(back.length).toBe(2)
    // 底环 = head + 每条背层，且逐条与 BotAvatar 画的那条逐字节相等
    expect(haloPaths('rim')).toEqual([headPath(), ...back])
    // 亮弧恒只有一条（三盏灯各转各的太吵）
    expect(haloPaths('arc')).toEqual([headPath()])
  })

  test('hover：表情换成确定性的一张脸，光环同步跟随（同源不因 hover 断）', () => {
    allowMotion()
    const view = render(<ChatFabAvatar />)
    const restingEye = eyePath()
    view.rerender(<ChatFabAvatar hovered />)
    expect(eyePath()).not.toBe(restingEye)
    expect(haloPath('arc')).toBe(headPath())
  })
})

describe('ChatFabAvatar — 上传图回落', () => {
  const image: AssistantIdentity = {
    name: null,
    avatar: { type: 'image', data: 'data:image/webp;base64,AAAA' }
  }

  test('渲染静态 img、不渲染 bot 头像，光环回落成圆角方形（跟批 Z 的容器口径，不是正圆）', () => {
    primeAssistantIdentity(image)
    render(<ChatFabAvatar />)
    const img = screen.getByTestId('chat-fab-avatar-image') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('data:image/webp;base64,AAAA')
    expect(document.querySelector('[data-bot-head]')).toBeNull()

    const arc = haloPath('arc')
    // 圆角方形 = 4 段圆角 A 弧 + 直边 H/V；正圆只有 2 段 A、没有直边
    expect((arc.match(/ A /g) ?? []).length).toBe(4)
    expect(arc).toMatch(/ H /)
    expect(haloPaths('rim')).toEqual([arc])
    // 🔴 照片的圆角与光环的圆角必须同源：两者都从同一个比例派生，换尺寸不会各调各的。
    const radiusUnits = Number(/ A ([\d.]+) /.exec(arc)?.[1])
    const viewBoxSize = Number(BOT_VIEW_BOX.split(' ')[2])
    expect(Number.parseFloat(img.style.borderRadius)).toBeCloseTo(
      (radiusUnits * FAB_AVATAR_PX) / viewBoxSize,
      6
    )
    // 不是正圆（rounded-full 会是 9999px / 50%）
    expect(Number.parseFloat(img.style.borderRadius)).toBeLessThan(img.offsetWidth || 44)
  })

  test('上传图身份不挂换脸 interval（图片没有表情可换）', () => {
    allowMotion()
    // 判据是「根本没排这个 timer」而非「画面没变」—— 圆形回落本来就与表情无关，
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

describe('ChatFabAvatar — reduced-motion', () => {
  test('默认（套件全局 reduce）：亮弧不挂旋光类', () => {
    render(<ChatFabAvatar />)
    const arc = document.querySelector('[data-fab-halo="arc"]')
    expect(arc?.getAttribute('class')).toBeNull()
  })

  test('allowMotion：亮弧挂 .chat-fab-halo-arc（纯 CSS 动画，不进 rAF ticker）', () => {
    allowMotion()
    render(<ChatFabAvatar />)
    const arc = document.querySelector('[data-fab-halo="arc"]')
    expect(arc?.getAttribute('class')).toBe('chat-fab-halo-arc')
    // 🔴 匀速的全部依据：pathLength 把周长归一到 100 ⇒ dasharray 是百分点、keyframe 里的
    //    dashoffset -100 恰好一圈。少了 pathLength 不会报错，只会让不同形状/表情的绕圈速度
    //    静默漂掉 —— 故在这里钉死。
    expect(arc?.getAttribute('pathLength')).toBe('100')
    expect(arc?.getAttribute('stroke-dasharray')).toBe('16 84')
  })

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
})

describe('ChatFabAvatar — 低频换脸', () => {
  test('到点才换：差 1ms 不换，满一个周期换，且换完光环仍与新 head 同源', () => {
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
    const second = headPath()
    expect(second).not.toBe(first)
    expect(haloPath('rim')).toBe(second)
    expect(haloPath('arc')).toBe(second)
  })
})

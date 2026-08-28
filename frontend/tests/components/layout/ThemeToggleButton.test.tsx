// @vitest-environment happy-dom
//
// 顶栏亮暗单 icon 钮（08-27 dogfood 修正批：三态 popover 退役）。
//
// 两条判据都压在**同一个锚点**上——`resolvedTheme` 而不是 `themeMode`：
//   · 点击 = 从「现在实际是亮还是暗」翻转，落成显式值；
//   · icon = 「现在实际是亮还是暗」。
// 用 themeMode 当锚点在显式态下碰巧等价，只有 themeMode='system' 那一支会露馅
// （点击不动 / 两个 icon 都不亮），所以下面每条都从 system 态入手。

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import i18n from '../../../src/shared/i18n'
import { useAppearance } from '@shared/state/appearance'
import { ThemeToggleButton } from '@shared/components/layout/ThemeToggleButton'

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  // setThemeMode → applyResolvedTheme 走 rAF；happy-dom 不一定有。
  if (!('requestAnimationFrame' in globalThis)) {
    ;(globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
      cb: FrameRequestCallback
    ) => setTimeout(() => cb(0), 0) as unknown as number
  }
})

beforeEach(() => {
  useAppearance.setState({ themeMode: 'system', resolvedTheme: 'dark' })
})
afterEach(cleanup)

/** icon-swap 的两个 item：[Sun, Moon]，data-active 指示哪个可见。 */
function iconActive(container: HTMLElement): { sun: boolean; moon: boolean } {
  const items = [...container.querySelectorAll('.icon-swap-item')]
  expect(items).toHaveLength(2)
  return {
    sun: items[0].getAttribute('data-active') === 'true',
    moon: items[1].getAttribute('data-active') === 'true'
  }
}

describe('ThemeToggleButton', () => {
  test('system 态点击 = 离开 system，落到与当前实际亮暗相反的显式值', () => {
    const { container } = render(<ThemeToggleButton />)
    fireEvent.click(container.querySelector('button')!)
    // resolved 是 dark ⇒ 落 light。按 themeMode('system') 判的实现会落 dark。
    expect(useAppearance.getState().themeMode).toBe('light')
  })

  test('显式态点击在 light / dark 之间互切', () => {
    useAppearance.setState({ themeMode: 'dark', resolvedTheme: 'dark' })
    const { container, rerender } = render(<ThemeToggleButton />)
    fireEvent.click(container.querySelector('button')!)
    expect(useAppearance.getState().themeMode).toBe('light')

    useAppearance.setState({ themeMode: 'light', resolvedTheme: 'light' })
    rerender(<ThemeToggleButton />)
    fireEvent.click(container.querySelector('button')!)
    expect(useAppearance.getState().themeMode).toBe('dark')
  })

  test('icon 跟 resolvedTheme：system + 实际暗 = 月亮亮着（不是两个都灭）', () => {
    const { container, rerender } = render(<ThemeToggleButton />)
    expect(iconActive(container)).toEqual({ sun: false, moon: true })

    useAppearance.setState({ themeMode: 'system', resolvedTheme: 'light' })
    rerender(<ThemeToggleButton />)
    expect(iconActive(container)).toEqual({ sun: true, moon: false })
  })

  test('hover 文案报当前选择：system 态把实际解析出的亮暗一并写出来', () => {
    const { container, rerender } = render(<ThemeToggleButton />)
    const btn = container.querySelector('button')!
    expect(btn.getAttribute('title')).toContain(i18n.t('settings.theme.system'))
    expect(btn.getAttribute('title')).toContain(i18n.t('settings.theme.dark'))
    // aria 与 title 同串（icon-only 钮，读屏拿不到别的）。
    expect(btn.getAttribute('aria-label')).toBe(btn.getAttribute('title'))

    useAppearance.setState({ themeMode: 'light', resolvedTheme: 'light' })
    rerender(<ThemeToggleButton />)
    const title = container.querySelector('button')!.getAttribute('title')
    expect(title).toContain(i18n.t('settings.theme.light'))
    expect(title).not.toContain(i18n.t('settings.theme.system'))
  })
})

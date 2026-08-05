// @vitest-environment happy-dom
//
// ProgressiveImage — beUI image-generation state-table adaptation (see module header for the
// 5-state → 4-state mapping rationale). Covers: per-state style output, state transitions
// (idle→loading→loaded / →error), and reduced-motion snapping to the final state without an
// animated transition.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import { ProgressiveImage } from '@shared/components/media/ProgressiveImage'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
})

// tests/setup.ts forces `matches: true` for every `prefers-reduced-motion` query globally, so by
// default every test below runs in the reduced-motion branch. `mockMatchMedia` (same pattern as
// tests/shared/useExitAnimation.test.tsx) lets the one test that needs the animated branch opt out.
let reduceMatches = true
function mockMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion') ? reduceMatches : false,
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

describe('ProgressiveImage — idle (no src yet)', () => {
  test('src 为 null 时不挂载 <img>，只渲染占位骨架', () => {
    const { container } = render(<ProgressiveImage src={null} alt="pending" />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.animate-pulse')).not.toBeNull()
  })
})

describe('ProgressiveImage — loading → loaded', () => {
  test('挂载时 opacity/scale 为 pending 态，骨架占位在场', () => {
    render(<ProgressiveImage src="https://example.test/pic.png" alt="a photo" />)
    const img = screen.getByAltText('a photo') as HTMLImageElement
    expect(img.style.opacity).toBe('0')
    expect(img.style.transform).toBe('scale(1.015)')
  })

  test('onLoad 触发后：opacity/scale 变为最终态，骨架消失', () => {
    const onLoad = vi.fn()
    const { container } = render(
      <ProgressiveImage src="https://example.test/pic.png" alt="a photo" onLoad={onLoad} />
    )
    const img = screen.getByAltText('a photo') as HTMLImageElement
    fireEvent.load(img)

    expect(img.style.opacity).toBe('1')
    expect(img.style.transform).toBe('scale(1)')
    expect(container.querySelector('.animate-pulse')).toBeNull()
    expect(onLoad).toHaveBeenCalledTimes(1)
  })

  test('切换到不同 src：重新进入 loading（不沿用旧 src 的 loaded/error 态）', () => {
    const { rerender } = render(<ProgressiveImage src="https://example.test/a.png" alt="a" />)
    fireEvent.load(screen.getByAltText('a'))
    expect((screen.getByAltText('a') as HTMLImageElement).style.opacity).toBe('1')

    rerender(<ProgressiveImage src="https://example.test/b.png" alt="a" />)
    const img = screen.getByAltText('a') as HTMLImageElement
    expect(img.style.opacity).toBe('0')
    expect(img.style.transform).toBe('scale(1.015)')
  })
})

describe('ProgressiveImage — error', () => {
  test('onError 触发后：<img> 被卸载，改渲染 ImageOff 回退（不是永远 blur 的幽灵图）', () => {
    const onError = vi.fn()
    const { container } = render(
      <ProgressiveImage src="https://example.test/broken.png" alt="broken" onError={onError} />
    )
    fireEvent.error(screen.getByAltText('broken'))

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('img', { name: '图片加载失败' })).toBeTruthy()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  test('自定义 errorFallback 覆盖默认图标', () => {
    render(
      <ProgressiveImage
        src="https://example.test/broken.png"
        alt="broken"
        errorFallback={<div data-testid="custom-fallback">custom</div>}
      />
    )
    fireEvent.error(screen.getByAltText('broken'))
    expect(screen.getByTestId('custom-fallback')).toBeTruthy()
  })
})

describe('ProgressiveImage — reduced motion', () => {
  test('默认（全局强制 reduced）：<img> 用 transition-none，最终态一步到位', () => {
    render(<ProgressiveImage src="https://example.test/pic.png" alt="a photo" />)
    const img = screen.getByAltText('a photo') as HTMLImageElement
    expect(img.className).toMatch(/\btransition-none\b/)

    fireEvent.load(img)
    expect(img.style.opacity).toBe('1')
    expect(img.style.transform).toBe('scale(1)')
  })

  test('非 reduced-motion：走 duration-base + standard 曲线的过渡类', () => {
    reduceMatches = false
    mockMatchMedia()
    try {
      render(<ProgressiveImage src="https://example.test/pic.png" alt="a photo" />)
      const img = screen.getByAltText('a photo') as HTMLImageElement
      expect(img.className).toMatch(/transition-\[opacity,transform\]/)
      expect(img.className).toMatch(/\bduration-base\b/)
      expect(img.className).toMatch(/\bease-standard\b/)
      expect(img.className).not.toMatch(/\btransition-none\b/)
    } finally {
      reduceMatches = true
      vi.unstubAllGlobals()
    }
  })
})

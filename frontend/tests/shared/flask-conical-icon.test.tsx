// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { FlaskConicalIcon } from '@shared/components/icons'

afterEach(cleanup)

describe('FlaskConicalIcon', () => {
  test('动画图标模块可导入并保留 lucide 三段描边', () => {
    const { container } = render(<FlaskConicalIcon size={20} strokeWidth={1.5} />)
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
    expect(container.querySelectorAll('path')).toHaveLength(3)
  })
})

// @vitest-environment happy-dom
//
// Sprint 7 D4 — EmptyState renders title + optional hint + optional action.

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'

import { EmptyState } from '../../src/shared/components/feedback/EmptyState'

describe('EmptyState', () => {
  test('renders title only', () => {
    render(<EmptyState title="Nothing here" />)
    expect(screen.getByText('Nothing here')).toBeTruthy()
  })

  test('renders hint when provided', () => {
    render(<EmptyState title="Empty" hint="Try a different query" />)
    expect(screen.getByText('Try a different query')).toBeTruthy()
  })

  test('renders action node when provided', () => {
    render(
      <EmptyState
        title="Failed"
        action={<button type="button">Retry</button>}
      />
    )
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  test('takes full slot when fill=true', () => {
    const { container } = render(<EmptyState title="x" fill />)
    expect(container.firstChild).toHaveProperty('className')
    const klass = (container.firstChild as HTMLElement).className
    expect(klass).toContain('flex-1')
  })
})

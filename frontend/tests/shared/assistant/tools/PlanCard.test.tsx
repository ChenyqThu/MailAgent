// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import i18n from '@shared/i18n'
import { PlanCard } from '@shared/assistant/tools/generic/PlanCard'

await i18n.changeLanguage('en-US')

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'plan_update',
    toolCallId: 'plan-1',
    args: {},
    argsText: '{}',
    result: undefined,
    isError: undefined,
    status: { type: 'complete' },
    approval: undefined,
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(),
    ...over
  } as unknown as ToolCallMessagePartProps
}

afterEach(cleanup)

describe('PlanCard', () => {
  test('renders the normalized result with all statuses including unavailable', () => {
    render(
      <PlanCard
        {...mockProps({
          result: {
            goal: 'Prepare the launch review',
            steps: [
              { id: 's1', title: 'Read the email', status: 'done' },
              { id: 's2', title: 'Check Notion', status: 'in_progress', note: 'Two pages left' },
              { id: 's3', title: 'Add calendar event', status: 'unavailable' }
            ]
          }
        })}
      />
    )

    expect(screen.getByText('Prepare the launch review')).toBeTruthy()
    expect(screen.getByText('Two pages left')).toBeTruthy()
    expect(screen.getByText('Unavailable')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  test('renders legacy persisted parts whose plan exists only in args', () => {
    render(
      <PlanCard
        {...mockProps({
          args: {
            goal: 'Legacy plan',
            steps: [{ id: 'legacy-1', title: 'Recover history', status: 'blocked' }]
          }
        })}
      />
    )

    expect(screen.getByText('Legacy plan')).toBeTruthy()
    expect(screen.getByText('Recover history')).toBeTruthy()
    expect(screen.getByText('Blocked')).toBeTruthy()
  })
})

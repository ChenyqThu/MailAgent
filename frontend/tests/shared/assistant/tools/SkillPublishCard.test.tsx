// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { SkillPublishCard } from '@shared/assistant/tools/generic/SkillPublishCard'

await i18n.changeLanguage('en-US')

function props(): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'skill_draft_publish',
    toolCallId: 'tc-publish',
    args: { draftId: 'mail-triage-012345abcdef', enabled: false, name: 'model-lie' },
    argsText: '{}',
    result: undefined,
    isError: undefined,
    status: { type: 'requires-action', reason: 'interrupt' },
    approval: { id: 'apr-publish' },
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn()
  } as unknown as ToolCallMessagePartProps
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SkillPublishCard', () => {
  test('renders server-fetched draft facts instead of model-provided claims', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'success',
          data: {
            name: 'server-triage',
            files: [
              { path: 'SKILL.md', bytes: 42 },
              { path: 'tests/prompts.md', bytes: 77 }
            ],
            validation: {
              package_hash: 'abcdef0123456789',
              scripts: { 'scripts/run.sh': { network: 'none' } },
              tests: { positive: true, negative: true, expected_output: true }
            },
            replacesInstalled: true
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<SkillPublishCard {...props()} />)

    await waitFor(() => expect(screen.getByText(/server-triage/)).toBeTruthy())
    expect(screen.getByText(/SKILL\.md/)).toBeTruthy()
    expect(screen.getByText(/abcdef012345/)).toBeTruthy()
    expect(screen.queryByText('model-lie')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/agent/skills/drafts/mail-triage-012345abcdef'),
      { credentials: 'include' }
    )
  })
})

// @vitest-environment happy-dom
//
// RecipientField Outlook-style autocomplete — typing surfaces a contact
// dropdown (email:contactSuggest), and ↑/↓ + Tab/Enter/click fills the
// highlighted contact as a chip. Mocks useMailApi so the field exercises the
// debounce → suggest → select flow without touching the real IPC/serve-api.
//
// Companion to ComposePanel.test.tsx (which covers the plain chip-entry
// behaviour). Kept separate so the autocomplete cases own their contact mock.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockContactSuggest } = vi.hoisted(() => ({ mockContactSuggest: vi.fn() }))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ email: { contactSuggest: mockContactSuggest } })
}))

import { RecipientField } from '../../src/shared/components/email/compose/RecipientField'

const CONTACTS = [
  { email: 'alice@acme.com', name: 'Alice Zhang', score: 9 },
  { email: 'alex@acme.com', name: 'Alex Lee', score: 4 }
]

beforeEach(() => {
  vi.clearAllMocks()
  mockContactSuggest.mockResolvedValue(CONTACTS)
})

afterEach(() => {
  cleanup()
})

function renderWithClient(node: React.ReactNode): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function setup(props: Partial<React.ComponentProps<typeof RecipientField>> = {}): {
  onChange: ReturnType<typeof vi.fn>
  input: HTMLInputElement
} {
  const onChange = vi.fn()
  renderWithClient(
    <RecipientField
      label="To"
      values={[]}
      placeholder="add"
      onChange={onChange}
      selfEmail="me@acme.com"
      {...props}
    />
  )
  const input = screen.getByLabelText('To') as HTMLInputElement
  return { onChange, input }
}

describe('RecipientField — autocomplete', () => {
  test('typing surfaces the dropdown; ArrowDown + Enter fills the highlighted contact', async () => {
    const { onChange, input } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'al' } })

    const opts = await screen.findAllByRole('option')
    expect(opts).toHaveLength(2) // Alice + Alex (name highlighted via <mark>)

    fireEvent.keyDown(input, { key: 'ArrowDown' }) // highlight → Alex
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['alex@acme.com'])
  })

  test('clicking an option fills it', async () => {
    const { onChange, input } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'ali' } })

    const opts = await screen.findAllByRole('option')
    const btn = opts[0].querySelector('button') as HTMLButtonElement
    fireEvent.mouseDown(btn) // preventDefault keeps input focused
    fireEvent.click(btn)
    expect(onChange).toHaveBeenCalledWith(['alice@acme.com'])
  })

  test('Tab fills the highlighted contact instead of leaving the field', async () => {
    const { onChange, input } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'al' } })

    await screen.findByRole('listbox')
    fireEvent.keyDown(input, { key: 'Tab' }) // first highlight = Alice
    expect(onChange).toHaveBeenCalledWith(['alice@acme.com'])
  })

  test('Escape dismisses the dropdown without clearing the input', async () => {
    const { input } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'al' } })

    await screen.findByRole('listbox')
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    expect(input.value).toBe('al')
  })

  test('Escape with an open dropdown does not reach a window keydown listener', async () => {
    // ComposePanel closes itself on window-level Escape; the open dropdown must
    // swallow that Escape so it dismisses the list instead of the whole panel.
    const winSpy = vi.fn()
    window.addEventListener('keydown', winSpy)
    try {
      const { input } = setup()
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'al' } })
      await screen.findAllByRole('option')

      winSpy.mockClear()
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(winSpy).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', winSpy)
    }
  })

  test('excludes self + already-picked chips from the query', async () => {
    mockContactSuggest.mockResolvedValue([])
    const onChange = vi.fn()
    renderWithClient(
      <RecipientField
        label="Cc"
        values={['bob@acme.com']}
        placeholder="cc"
        onChange={onChange}
        selfEmail="me@acme.com"
      />
    )
    const input = screen.getByLabelText('Cc')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'x' } })

    await waitFor(() => expect(mockContactSuggest).toHaveBeenCalled())
    const lastCall = mockContactSuggest.mock.calls.at(-1) as [string, number, string[]]
    expect(lastCall[0]).toBe('x')
    expect(lastCall[2]).toEqual(expect.arrayContaining(['me@acme.com', 'bob@acme.com']))
  })

  test('dropdown closed → Enter still commits typed text as a chip', async () => {
    mockContactSuggest.mockResolvedValue([]) // no suggestions → no dropdown
    const { onChange, input } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'typed@x.com' } })

    await waitFor(() => expect(mockContactSuggest).toHaveBeenCalled())
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['typed@x.com'])
  })

  test('blur still commits a fully-typed address', () => {
    mockContactSuggest.mockResolvedValue([])
    const { onChange, input } = setup()
    fireEvent.change(input, { target: { value: 'full@x.com' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(['full@x.com'])
  })
})

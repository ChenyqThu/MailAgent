// @vitest-environment happy-dom
//
// RecipientField — the compose §2 upgrade: keyboard chip navigation, paste
// split, internal/external distinction, cross-field dedup, the "添加 xxx" raw
// row, and the chip detail popover. Companion to RecipientField.autocomplete
// (dropdown fill) and ComposePanel (plain chip entry). Mocks useMailApi so the
// field runs the debounce → suggest flow without touching IPC/serve-api.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockContactSuggest } = vi.hoisted(() => ({ mockContactSuggest: vi.fn() }))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ email: { contactSuggest: mockContactSuggest } })
}))

// chip 姓名的通讯录解析（08-28）——本文件测的是键盘/粘贴/去重，把它按「不在库」
// 短路（chip 显示裸地址，既有 getByTitle('a@x.com') 一类断言口径不变）。
vi.mock('@shared/components/contacts/hooks', () => ({
  useContactsEnabled: () => ({ enabled: true, loading: false }),
  useContactsApi: () => ({ resolve: vi.fn(async () => ({ items: {} })) })
}))

import { RecipientField } from '../../src/shared/components/email/compose/RecipientField'

beforeEach(() => {
  vi.clearAllMocks()
  mockContactSuggest.mockResolvedValue([])
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
  const { values, ...rest } = props
  renderWithClient(
    <RecipientField
      label="To"
      values={values ?? []}
      placeholder="add"
      onChange={onChange}
      selfEmail="me@acme.com"
      {...rest}
    />
  )
  const input = screen.getByLabelText('To') as HTMLInputElement
  return { onChange, input }
}

describe('RecipientField — keyboard chip navigation', () => {
  test('Backspace on empty input enters chip-select, next Backspace removes the last chip', () => {
    const { onChange, input } = setup({ values: ['a@x.com', 'b@x.com'] })
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'Backspace' }) // enter selection (last = b)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Backspace' }) // remove selected chip
    expect(onChange).toHaveBeenCalledWith(['a@x.com'])
  })

  test('←/→ move the selection and Delete removes the highlighted chip', () => {
    const { onChange, input } = setup({ values: ['a@x.com', 'b@x.com', 'c@x.com'] })
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'Backspace' }) // select last (c)
    fireEvent.keyDown(input, { key: 'ArrowLeft' }) // → b
    fireEvent.keyDown(input, { key: 'Delete' }) // remove b
    expect(onChange).toHaveBeenCalledWith(['a@x.com', 'c@x.com'])
  })

  test('ArrowLeft at input start selects the last chip, Enter opens its detail popover', async () => {
    const { input } = setup({ values: ['bob@acme.com'] })
    fireEvent.focus(input)
    fireEvent.keyDown(input, { key: 'ArrowLeft' }) // empty input, cursor at 0 → select
    fireEvent.keyDown(input, { key: 'Enter' }) // open detail
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
  })
})

describe('RecipientField — paste split', () => {
  test('pasting multiple addresses splits them into one chip each', () => {
    const { onChange, input } = setup()
    fireEvent.focus(input)
    fireEvent.paste(input, {
      clipboardData: { getData: () => 'a@x.com, b@y.com; c@z.com' }
    })
    expect(onChange).toHaveBeenCalledWith(['a@x.com', 'b@y.com', 'c@z.com'])
  })
})

describe('RecipientField — canonical address parsing (codex Finding 6)', () => {
  test('pasting a display-name parens form yields the bare address (no stray parens)', () => {
    const { onChange, input } = setup()
    fireEvent.focus(input)
    fireEvent.paste(input, {
      clipboardData: { getData: () => 'Alice (alice@example.com)' }
    })
    expect(onChange).toHaveBeenCalledWith(['alice@example.com'])
  })

  test('pasting quoted and Name <a@b.c> forms yields bare addresses', () => {
    const { onChange, input } = setup()
    fireEvent.focus(input)
    fireEvent.paste(input, {
      clipboardData: { getData: () => `"Bob Li" <bob@y.com>; 'carol@z.org'` }
    })
    expect(onChange).toHaveBeenCalledWith(['bob@y.com', 'carol@z.org'])
  })

  test('typing Name <a@b.c> and committing with Enter yields the bare address', () => {
    const { onChange, input } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Dave <dave@x.com>' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['dave@x.com'])
  })

  test('chip edit into an already-present address dedups (chip removed, case-insensitive)', async () => {
    const { onChange } = setup({ values: ['a@x.com', 'b@x.com'] })
    fireEvent.click(screen.getByTitle('b@x.com'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('编辑'))
    const editInput = (await screen.findByLabelText('edit b@x.com')) as HTMLInputElement
    fireEvent.change(editInput, { target: { value: 'A@X.com' } })
    fireEvent.blur(editInput)
    expect(onChange).toHaveBeenCalledWith(['a@x.com'])
  })

  test('chip edit into an invalid value keeps the original chip (no garbage commit)', async () => {
    const { onChange } = setup({ values: ['a@x.com'] })
    fireEvent.click(screen.getByTitle('a@x.com'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('编辑'))
    const editInput = (await screen.findByLabelText('edit a@x.com')) as HTMLInputElement
    fireEvent.change(editInput, { target: { value: 'not-an-email' } })
    fireEvent.blur(editInput)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByTitle('a@x.com')).toBeTruthy()
  })

  test('chip edit trims wrapping punctuation before committing', async () => {
    const { onChange } = setup({ values: ['a@x.com'] })
    fireEvent.click(screen.getByTitle('a@x.com'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('编辑'))
    const editInput = (await screen.findByLabelText('edit a@x.com')) as HTMLInputElement
    fireEvent.change(editInput, { target: { value: '(alan@x.com)' } })
    fireEvent.blur(editInput)
    expect(onChange).toHaveBeenCalledWith(['alan@x.com'])
  })
})

describe('RecipientField — internal / external', () => {
  test('an out-of-domain chip shows the external marker; an internal one does not', () => {
    // external
    const onChange = vi.fn()
    renderWithClient(
      <RecipientField
        label="To"
        values={['ext@other.com']}
        placeholder="add"
        onChange={onChange}
        internalDomains={['acme.com']}
      />
    )
    expect(screen.getByTitle('外部联系人')).toBeTruthy()
    cleanup()

    // internal
    renderWithClient(
      <RecipientField
        label="To"
        values={['bob@acme.com']}
        placeholder="add"
        onChange={onChange}
        internalDomains={['acme.com']}
      />
    )
    expect(screen.queryByTitle('外部联系人')).toBeNull()
  })

  test('falls back to the fixed org whitelist when no internalDomains prop is given', () => {
    const onChange = vi.fn()
    renderWithClient(
      <RecipientField
        label="To"
        values={['stranger@elsewhere.com']}
        placeholder="add"
        onChange={onChange}
        selfEmail="me@omadanetworks.com"
      />
    )
    expect(screen.getByTitle('外部联系人')).toBeTruthy()
    cleanup()

    // all three org domains classify as internal by default
    renderWithClient(
      <RecipientField
        label="To"
        values={['a@tp-link.com', 'b@tp-link.com.hk', 'c@omadanetworks.com']}
        placeholder="add"
        onChange={onChange}
      />
    )
    expect(screen.queryByTitle('外部联系人')).toBeNull()
  })
})

describe('RecipientField — cross-field dedup (excludeEmails)', () => {
  test('excludeEmails feeds the suggestion query exclude list', async () => {
    const onChange = vi.fn()
    renderWithClient(
      <RecipientField
        label="Cc"
        values={[]}
        placeholder="cc"
        onChange={onChange}
        selfEmail="me@acme.com"
        excludeEmails={['dup@x.com']}
      />
    )
    const input = screen.getByLabelText('Cc')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'd' } })
    await waitFor(() => expect(mockContactSuggest).toHaveBeenCalled())
    const lastCall = mockContactSuggest.mock.calls.at(-1) as [string, number, string[]]
    expect(lastCall[2]).toEqual(expect.arrayContaining(['me@acme.com', 'dup@x.com']))
  })

  test('an excluded address is blocked from being added and shows no "添加" row', async () => {
    const onChange = vi.fn()
    renderWithClient(
      <RecipientField
        label="Cc"
        values={[]}
        placeholder="cc"
        onChange={onChange}
        excludeEmails={['dup@x.com']}
      />
    )
    const input = screen.getByLabelText('Cc')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'dup@x.com' } })
    await waitFor(() => expect(mockContactSuggest).toHaveBeenCalled())
    expect(screen.queryByText(/添加/)).toBeNull()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('RecipientField — "添加 xxx" raw row', () => {
  test('a valid unmatched email surfaces a raw-add row that fills on click', async () => {
    const { onChange, input } = setup()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'new@x.com' } })
    const row = await screen.findByText((t) => t.includes('添加'))
    fireEvent.mouseDown(row) // preventDefault keeps input focused
    fireEvent.click(row)
    expect(onChange).toHaveBeenCalledWith(['new@x.com'])
  })
})

describe('RecipientField — detail popover', () => {
  test('clicking a chip opens the detail popover; 移除 removes it', async () => {
    const { onChange } = setup({ values: ['bob@acme.com'] })
    fireEvent.click(screen.getByTitle('bob@acme.com'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('移除'))
    expect(onChange).toHaveBeenCalledWith([])
  })

  test('编辑 turns the chip into an inline input that commits on blur', async () => {
    const { onChange } = setup({ values: ['bob@acme.com'] })
    fireEvent.click(screen.getByTitle('bob@acme.com'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByText('编辑'))
    const editInput = (await screen.findByLabelText('edit bob@acme.com')) as HTMLInputElement
    fireEvent.change(editInput, { target: { value: 'bobby@acme.com' } })
    fireEvent.blur(editInput)
    expect(onChange).toHaveBeenCalledWith(['bobby@acme.com'])
  })
})

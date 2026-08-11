// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import i18n from '../../src/shared/i18n'
import { MatterCreateDialog } from '../../src/shared/components/matters/MatterCreateDialog'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('shows explainable duplicate candidates without blocking creation', async () => {
  const reasonLabel = '关联资料重叠'
  const evidence = 'mailagent:thread:thread-1'
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    status: 'success',
    schema_version: 1,
    data: {
      items: [{
        matter: {
          public_id: 'MAT-0012',
          title: 'Existing vendor launch',
          status: 'active',
          health: 'on_track',
          priority: 'p1',
          updated_at: 1
        },
        confidence: 0.84,
        reasons: [{ kind: 'resource_overlap', label: reasonLabel, weight: 0.48, evidence: [evidence] }]
      }]
    }
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetchMock)
  const onCreate = vi.fn()
  const onUseExisting = vi.fn()
  const view = render(
    <MatterCreateDialog
      open
      source={source()}
      onClose={vi.fn()}
      onCreate={onCreate}
      onUseExisting={onUseExisting}
    />
  )

  expect(await view.findByText('Existing vendor launch')).toBeTruthy()
  expect(view.getByText(reasonLabel)).toBeTruthy()
  expect(view.getByText(new RegExp(evidence))).toBeTruthy()
  expect(view.getByText('匹配置信度 84%')).toBeTruthy()
  expect(view.getByText('没有合适的就忽略这些提示，继续创建。')).toBeTruthy()

  fireEvent.click(view.getByRole('button', { name: /加入已有事项/ }))
  await waitFor(() => expect(onUseExisting).toHaveBeenCalledWith(expect.objectContaining({
    matter: expect.objectContaining({ public_id: 'MAT-0012' })
  }), 'thread'))

  fireEvent.click(view.getByRole('button', { name: '新建事项' }))
  expect(onCreate).toHaveBeenCalledTimes(1)
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
    title: 'Vendor launch',
    resources: [{ provider: 'mailagent', kind: 'thread', external_key: 'thread:thread-1' }]
  })
})

describe('MatterCreateDialog email source scope', () => {
  test('does not render link scope without an email source', () => {
    const view = render(<MatterCreateDialog open onClose={vi.fn()} onCreate={vi.fn()} />)
    expect(view.queryByRole('tablist', { name: '关联范围' })).toBeNull()
  })

  test('defaults to the whole thread when thread id is available', async () => {
    const view = render(
      <MatterCreateDialog
        open
        source={source({ threadId: 'thread-1', threadCount: 4 })}
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />
    )
    await waitFor(() => expect(view.getByDisplayValue('Vendor launch')).toBeTruthy())
    expect(view.getByRole('tab', { name: '整条会话 · 4 封' }).getAttribute('aria-selected')).toBe('true')
  })

  test('disables thread scope and submits single when thread id is unavailable', async () => {
    const onCreate = vi.fn()
    const view = render(
      <MatterCreateDialog
        open
        source={source({ threadId: null })}
        onClose={vi.fn()}
        onCreate={onCreate}
      />
    )
    await waitFor(() => expect(view.getByDisplayValue('Vendor launch')).toBeTruthy())
    expect((view.getByRole('tab', { name: /整条会话/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByText('这封邮件没有可用会话，只能关联当前邮件')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '新建事项' }))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      source_resource: expect.objectContaining({ link_scope: 'single', internal_id: 42856 })
    }))
  })
})

describe('MatterCreateDialog create research', () => {
  test('prefills editable fields and advisory lists without changing the create payload', async () => {
    const draftResponse = {
      source: { internal_id: 42856, thread_id: 'thread-1', link_scope: 'thread' },
      draft: {
        title: 'Researched vendor launch',
        matter_type: '商务',
        description: 'Coordinate the renewal and launch plan.',
        resources: [
          {
            provider: 'mailagent',
            kind: 'email',
            external_key: 'email:42856',
            title: '[External] Vendor launch',
            url: null,
            excerpt: null,
            reason: { kind: 'source_email', label: '源邮件', evidence: ['42856'] }
          },
          {
            provider: 'notion',
            kind: 'doc',
            external_key: 'notion:page-1',
            title: 'Vendor rollout plan',
            url: 'https://notion.example/page-1',
            excerpt: null,
            reason: { kind: 'notion_search_match', label: 'Notion 搜索命中', evidence: ['Vendor launch'] }
          }
        ],
        stakeholders: [
          {
            email: 'alex@example.com',
            display_name: 'Alex',
            reason: { kind: 'sender', label: '邮件发件人', evidence: ['alex@example.com'] }
          }
        ],
        duplicate_candidates: []
      },
      research: {
        thread_email_count: 3,
        related_email_count: 1,
        notion_status: 'searched',
        warnings: []
      }
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const data = url.endsWith('/matters/create-draft') ? draftResponse : { items: [] }
      return new Response(JSON.stringify({ status: 'success', schema_version: 1, data }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onCreate = vi.fn()
    const view = render(
      <MatterCreateDialog
        open
        source={source()}
        onClose={vi.fn()}
        onCreate={onCreate}
      />
    )

    fireEvent.click(view.getByRole('button', { name: '调研并预填' }))
    expect(view.getByRole('status').textContent).toContain('正在读取邮件会话与成员')

    expect(await view.findByDisplayValue('Researched vendor launch')).toBeTruthy()
    expect(view.getByDisplayValue('Coordinate the renewal and launch plan.')).toBeTruthy()
    expect(view.getByRole('combobox', { name: '类型' }).textContent).toContain('商务')
    expect(view.getByText('Vendor rollout plan')).toBeTruthy()
    expect(view.getByText('Alex · alex@example.com')).toBeTruthy()
    expect(view.getByText('以下是 AI 建议，不会自动创建或写入；标题、类型、描述和建议清单都可以继续调整。')).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: '移除建议资源 Vendor rollout plan' }))
    fireEvent.click(view.getByRole('button', { name: '移除建议干系人 alex@example.com' }))
    expect(view.queryByText('Vendor rollout plan')).toBeNull()
    expect(view.queryByText('Alex · alex@example.com')).toBeNull()

    fireEvent.change(view.getByRole('textbox', { name: '标题' }), {
      target: { value: 'User edited title' }
    })
    fireEvent.click(view.getByRole('button', { name: '新建事项' }))

    expect(onCreate).toHaveBeenCalledTimes(1)
    const createInput = onCreate.mock.calls[0][0]
    expect(createInput).toMatchObject({
      title: 'User edited title',
      matter_type: '商务',
      description: 'Coordinate the renewal and launch plan.',
      source_resource: {
        provider: 'mailagent',
        kind: 'email',
        internal_id: 42856,
        link_scope: 'thread'
      }
    })
    expect(createInput).not.toHaveProperty('resources')
    expect(createInput).not.toHaveProperty('stakeholders')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      internal_id: 42856,
      thread_id: 'thread-1',
      link_scope: 'thread',
      title: 'Vendor launch'
    })
  })

  test('keeps manual creation available when research fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (!url.endsWith('/matters/create-draft')) {
        return new Response(JSON.stringify({ status: 'success', schema_version: 1, data: { items: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({
        status: 'error',
        schema_version: 1,
        error: { code: 'E_UPSTREAM', message: 'Email research unavailable' }
      }), { status: 502, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const onCreate = vi.fn()
    const view = render(
      <MatterCreateDialog
        open
        source={source()}
        onClose={vi.fn()}
        onCreate={onCreate}
      />
    )

    fireEvent.click(view.getByRole('button', { name: '调研并预填' }))
    expect((await view.findByRole('alert')).textContent).toContain('Email research unavailable')

    fireEvent.change(view.getByRole('textbox', { name: '标题' }), {
      target: { value: 'Manual fallback title' }
    })
    fireEvent.click(view.getByRole('button', { name: '新建事项' }))
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: 'Manual fallback title' }))
  })
})

describe('MatterCreateDialog type selection', () => {
  test('submits null when the type is not specified', () => {
    const onCreate = vi.fn()
    const view = render(<MatterCreateDialog open onClose={vi.fn()} onCreate={onCreate} />)

    fireEvent.change(view.getByRole('textbox', { name: '标题' }), {
      target: { value: 'Launch readiness' }
    })
    fireEvent.click(view.getByRole('button', { name: '新建事项' }))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ matter_type: null }))
  })

  test('submits a selected built-in type', async () => {
    const onCreate = vi.fn()
    const view = render(<MatterCreateDialog open onClose={vi.fn()} onCreate={onCreate} />)

    fireEvent.change(view.getByRole('textbox', { name: '标题' }), {
      target: { value: 'Launch readiness' }
    })
    fireEvent.click(view.getByRole('combobox', { name: '类型' }))
    fireEvent.click(await view.findByRole('option', { name: '商务' }))
    fireEvent.click(view.getByRole('button', { name: '新建事项' }))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ matter_type: '商务' }))
  })

  test('keeps the custom type escape hatch and resets it on reopen', async () => {
    const onCreate = vi.fn()
    const view = render(<MatterCreateDialog open onClose={vi.fn()} onCreate={onCreate} />)

    fireEvent.change(view.getByRole('textbox', { name: '标题' }), {
      target: { value: 'Launch readiness' }
    })
    fireEvent.click(view.getByRole('combobox', { name: '类型' }))
    fireEvent.click(await view.findByRole('option', { name: '自定义…' }))
    fireEvent.change(view.getByRole('textbox', { name: '自定义…' }), {
      target: { value: '  合规审查  ' }
    })
    fireEvent.click(view.getByRole('button', { name: '新建事项' }))

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ matter_type: '合规审查' }))

    view.rerender(<MatterCreateDialog open={false} onClose={vi.fn()} onCreate={onCreate} />)
    view.rerender(<MatterCreateDialog open onClose={vi.fn()} onCreate={onCreate} />)
    await waitFor(() => expect(view.getByRole('combobox', { name: '类型' }).textContent).toContain('未指定'))
    expect(view.queryByRole('textbox', { name: '自定义…' })).toBeNull()
  })
})

function source(overrides: Partial<React.ComponentProps<typeof MatterCreateDialog>['source'] & object> = {}) {
  return {
    internalId: 42856,
    threadId: 'thread-1',
    subject: '[External] Vendor launch',
    sender: 'Alex',
    receivedAt: '2026-08-09T10:00:00-07:00',
    threadCount: 3,
    ...overrides
  }
}

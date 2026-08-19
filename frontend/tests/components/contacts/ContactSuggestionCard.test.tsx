// @vitest-environment happy-dom
//
// WP7 建议卡：五类结论句 × pending/blocked 两态 + 模型产物的纯文本渲染。
//
// 🔴 结论句是**前端拼的**（propose 工具的 payload 只有结构化字段，没有 `text` 键），
// 所以这几条断言盯的是「同一条 payload 会被读成哪句话」—— 读错了就是把一条建议描述成
// 另一件事，owner 照着按下采纳。
// 🔴 模型能写的只有 `payload.reason` 与 `evidence[].quote`（外加 identity 的 value /
// former_email 的 email）：注入用例断言它们原样出现在文本里、且没有生成任何元素节点。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import { ContactSuggestionCard } from '@shared/components/contacts/ContactSuggestionCard'
import type {
  ContactGovernanceSuggestion,
  ContactRowDto,
  ContactSuggestionType
} from '@shared/api/types/contact'

await i18n.changeLanguage('zh-CN')

function row(id: number, name: string): ContactRowDto {
  return {
    id,
    display_name: name,
    formal_name: null,
    organization: null,
    department: null,
    role_title: null,
    function: null,
    seniority: null,
    kind: 'person',
    hidden_at: null,
    is_self: false,
    mail_count: 3,
    sent_to_count: 1,
    first_seen_at: null,
    last_seen_at: null,
    email_count: 1,
    primary_email: `${name}@corp.test`,
    manager_contact_id: null,
    manager_display_name: null,
    profile_summary: null,
    profile_min: 50,
    profile_eligible: false
  }
}

const DIRECTORY = new Map([
  [1, row(1, 'Hong Wei')],
  [2, row(2, 'Wei Hong')],
  [3, row(3, 'Sara Okafor')]
])

function suggestion(
  type: ContactSuggestionType,
  over: Partial<ContactGovernanceSuggestion> = {}
): ContactGovernanceSuggestion {
  return {
    id: 1,
    type,
    contact_ids: [1],
    payload: {},
    evidence: [{ message_id: '<a@corp.test>', quote: '往后请发到新地址' }],
    confidence: 0.82,
    status: 'pending',
    block_reason: null,
    created_at: 1_755_000_000_000,
    decided_at: null,
    ...over
  }
}

function renderCard(
  item: ContactGovernanceSuggestion,
  handlers: {
    onAdopt?: (s: ContactGovernanceSuggestion) => void
    onIgnore?: (s: ContactGovernanceSuggestion) => void
    onOpenPerson?: (id: number) => void
  } = {}
): void {
  render(
    <ContactSuggestionCard
      suggestion={item}
      personOf={(id) => DIRECTORY.get(id)}
      busy={false}
      onAdopt={handlers.onAdopt ?? vi.fn()}
      onIgnore={handlers.onIgnore ?? vi.fn()}
      onOpenPerson={handlers.onOpenPerson ?? vi.fn()}
    />
  )
}

afterEach(() => cleanup())

describe('ContactSuggestionCard · 五类结论句', () => {
  test('merge：两个人名 + 采纳钮说的是「打开合并预览」不是「采纳」', () => {
    const onAdopt = vi.fn()
    renderCard(
      suggestion('merge', {
        contact_ids: [1, 2],
        payload: { winner_contact_id: 2, loser_contact_id: 1 }
      }),
      { onAdopt }
    )
    expect(screen.getByText('「Hong Wei」与「Wei Hong」应该是同一人')).toBeTruthy()
    expect(screen.getByText('合并同人')).toBeTruthy()
    // 🔒 危险动作不静默：merge 的「采纳」只打开预览，文案必须说清这一点。
    expect(screen.queryByText('采纳')).toBeNull()
    fireEvent.click(screen.getByText('打开合并预览'))
    expect(onAdopt).toHaveBeenCalledTimes(1)
  })

  test('identity：字段名走通讯录既有词表（department → 部门）', () => {
    renderCard(
      suggestion('identity', {
        contact_ids: [3],
        payload: { field: 'department', value: 'Procurement' }
      })
    )
    expect(screen.getByText('给 Sara Okafor 补上部门「Procurement」')).toBeTruthy()
    expect(screen.getByText('补身份字段')).toBeTruthy()
  })

  test('former_email：说的是哪个地址', () => {
    renderCard(suggestion('former_email', { payload: { email: 'y.chen@ourco.test' } }))
    expect(screen.getByText('把 y.chen@ourco.test 标为曾用邮箱')).toBeTruthy()
  })

  test('relation：manager_id 有值说「设为上级」，null 说「解除」—— 两句不能读反', () => {
    renderCard(suggestion('relation', { contact_ids: [3], payload: { manager_id: 1 } }))
    expect(screen.getByText('把 Hong Wei 设为 Sara Okafor 的上级')).toBeTruthy()

    cleanup()
    renderCard(suggestion('relation', { contact_ids: [3], payload: { manager_id: null } }))
    expect(screen.getByText('解除 Sara Okafor 的上级关系')).toBeTruthy()
  })

  test('kind：kind 值也走 i18n（robot → 机器人）', () => {
    renderCard(suggestion('kind', { contact_ids: [3], payload: { kind: 'robot' } }))
    expect(screen.getByText('把 Sara Okafor 改判为机器人')).toBeTruthy()
  })

  test('置信度按百分比显示；为 null 时整段不渲染（不显示「置信度 null%」）', () => {
    renderCard(suggestion('kind', { payload: { kind: 'list' } }))
    expect(screen.getByText('置信度 82%')).toBeTruthy()

    cleanup()
    renderCard(suggestion('kind', { payload: { kind: 'list' }, confidence: null }))
    expect(screen.queryByText(/置信度/)).toBeNull()
  })

  test('头像可点跳人物页；查不到的 id 不画假头像', () => {
    const onOpenPerson = vi.fn()
    renderCard(suggestion('identity', { contact_ids: [3], payload: { field: 'phone' } }), {
      onOpenPerson
    })
    fireEvent.click(screen.getByTitle('打开 Sara Okafor'))
    expect(onOpenPerson).toHaveBeenCalledWith(3)

    cleanup()
    renderCard(suggestion('identity', { contact_ids: [999], payload: { field: 'phone' } }))
    expect(screen.queryByTitle(/^打开 /)).toBeNull()
  })
})

describe('ContactSuggestionCard · blocked 态', () => {
  test('blocked：显示「已拦下」+ 原因，且**没有**采纳/忽略按钮', () => {
    renderCard(
      suggestion('identity', {
        contact_ids: [3],
        payload: { field: 'department', value: 'Legal' },
        status: 'blocked',
        block_reason: 'E_FIELD_LOCKED: identity field is locked: department'
      })
    )
    expect(screen.getByText('已拦下')).toBeTruthy()
    expect(
      screen.getByText('原因 · E_FIELD_LOCKED: identity field is locked: department')
    ).toBeTruthy()
    // 后端只允许 pending 被 adopt/ignore —— 画出按钮就是一个必然 400 的假入口。
    expect(screen.queryByText('采纳')).toBeNull()
    expect(screen.queryByText('忽略')).toBeNull()
  })

  test('pending 反证：同一条 payload 在 pending 下两个按钮都在', () => {
    renderCard(
      suggestion('identity', { contact_ids: [3], payload: { field: 'department', value: 'Legal' } })
    )
    expect(screen.getByText('采纳')).toBeTruthy()
    expect(screen.getByText('忽略')).toBeTruthy()
    expect(screen.queryByText('已拦下')).toBeNull()
  })
})

describe('ContactSuggestionCard · 模型产物纯文本渲染', () => {
  test('reason / 引文 / 字段值里的标签与 markdown 原样呈现，不生成任何节点', () => {
    const { container } = render(
      <ContactSuggestionCard
        suggestion={suggestion('identity', {
          contact_ids: [3],
          payload: {
            field: 'department',
            value: '<img src=x onerror=alert(1)>',
            reason: '**签名档**里写着 <script>alert("xss")</script>'
          },
          evidence: [{ message_id: '<m@corp.test>', quote: '<b>Procurement</b>, Meridian' }]
        })}
        personOf={(id) => DIRECTORY.get(id)}
        busy={false}
        onAdopt={vi.fn()}
        onIgnore={vi.fn()}
        onOpenPerson={vi.fn()}
      />
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
    expect(container.textContent).toContain('<script>alert("xss")</script>')
    expect(container.textContent).toContain('**签名档**')
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.textContent).toContain('<b>Procurement</b>, Meridian')
  })

  test('reason 有则渲染、无则整行不出现（没有源就不编一句理由出来）', () => {
    const why = '最近 4 封邮件的签名档都写着 Procurement'
    renderCard(
      suggestion('kind', { contact_ids: [3], payload: { kind: 'list', reason: why } })
    )
    expect(screen.getByText(why)).toBeTruthy()

    cleanup()
    renderCard(suggestion('kind', { contact_ids: [3], payload: { kind: 'list' } }))
    expect(screen.queryByText(why)).toBeNull()
  })
})

// @vitest-environment happy-dom
//
// L4 群聊 g2 —— group_create / group_post 两张审批卡。缺卡 = 审批暂停的 tool part 落到无按钮的
// ToolTraceCard（永久 spinner），所以这里钉的是「有按钮且按得动」+「审批相把要批的东西摆出来」
// + 「完成相把真发生的事说清楚（含 config_applied=false 这种半成功）」。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { GroupCreateCard, GroupPostCard } from '@shared/assistant/tools/generic/GroupApprovalCards'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
})

function pendingProps(
  toolName: string,
  args: Record<string, unknown>,
  respond: () => void
): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName,
    toolCallId: `tc-${toolName}`,
    args,
    argsText: JSON.stringify(args),
    result: undefined,
    isError: undefined,
    status: { type: 'requires-action', reason: 'interrupt' },
    approval: { id: `apr-${toolName}` },
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: respond
  } as unknown as ToolCallMessagePartProps
}

function doneProps(
  toolName: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>
): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName,
    toolCallId: `tc-${toolName}`,
    args,
    argsText: JSON.stringify(args),
    result,
    isError: undefined,
    status: { type: 'complete' },
    approval: undefined,
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn()
  } as unknown as ToolCallMessagePartProps
}

const CREATE_ARGS = {
  title: '狼人杀第一局',
  member_agent_ids: ['judge', 'wolf-a', 'wolf-b', 'seer'],
  opening_text: '天黑请闭眼。',
  judge_agent_id: 'judge'
}

describe('GroupCreateCard', () => {
  test('K1 审批相渲染 roster / 标题 / 开场白，并把首轮唤醒上界说成一句话', () => {
    render(<GroupCreateCard {...pendingProps('group_create', CREATE_ARGS, vi.fn())} />)
    expect(screen.getByText('狼人杀第一局')).toBeTruthy()
    expect(screen.getByText('judge、wolf-a、wolf-b、seer')).toBeTruthy()
    expect(screen.getByText('天黑请闭眼。')).toBeTruthy()
    // 无 modes = 全员 realtime（服务端出厂默认），四名成员 → 最多 4 位。
    expect(screen.getByText('最多 4 位')).toBeTruthy()
  })

  test.each([
    [
      'modes 里两个 realtime → 只数 realtime',
      {
        ...CREATE_ARGS,
        modes: { judge: 'realtime', 'wolf-a': 'realtime', 'wolf-b': 'mention', seer: 'mention' }
      },
      '最多 2 位'
    ],
    [
      '无 modes 五成员 → 五位',
      { ...CREATE_ARGS, member_agent_ids: ['a', 'b', 'c', 'd', 'e'] },
      '最多 5 位'
    ],
    [
      '八成员仍在链地板（CHAIN_CAP_DEFAULT=12）之下 → 八位',
      { ...CREATE_ARGS, member_agent_ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
      '最多 8 位'
    ]
  ])('K1 %s', (_name, args, expected) => {
    render(<GroupCreateCard {...pendingProps('group_create', args, vi.fn())} />)
    expect(screen.getByText(expected)).toBeTruthy()
  })

  test('K2 批准 / 拒绝各触发一次 respondToApproval（拒绝需二次确认）', () => {
    const respond = vi.fn()
    render(<GroupCreateCard {...pendingProps('group_create', CREATE_ARGS, respond)} />)
    fireEvent.click(screen.getByText('建群'))
    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith({ approved: true })

    cleanup()
    const respond2 = vi.fn()
    render(<GroupCreateCard {...pendingProps('group_create', CREATE_ARGS, respond2)} />)
    // 第一次点「拒绝」只展开理由框，第二次点「确认拒绝」才决策。
    fireEvent.click(screen.getByText('拒绝'))
    expect(respond2).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('确认拒绝'))
    expect(respond2).toHaveBeenCalledTimes(1)
    expect(respond2).toHaveBeenCalledWith({ approved: false, reason: undefined })
  })

  test('K3 完成相：config_applied=false 显示警示文案；true 时不显示', () => {
    render(
      <GroupCreateCard
        {...doneProps('group_create', CREATE_ARGS, {
          session_id: 77,
          title: '狼人杀第一局',
          members: CREATE_ARGS.member_agent_ids,
          config_applied: false,
          woke: ['wolf-a']
        })}
      />
    )
    expect(screen.getByText(/已创建群聊「狼人杀第一局」（#77）/)).toBeTruthy()
    expect(screen.getByText(/主持人 \/ 响应模式没写进去/)).toBeTruthy()

    cleanup()
    render(
      <GroupCreateCard
        {...doneProps('group_create', CREATE_ARGS, {
          session_id: 77,
          title: '狼人杀第一局',
          members: CREATE_ARGS.member_agent_ids,
          config_applied: true,
          woke: ['wolf-a']
        })}
      />
    )
    expect(screen.queryByText(/主持人 \/ 响应模式没写进去/)).toBeNull()
  })
})

describe('GroupPostCard', () => {
  const POST_ARGS = { session_id: 42, text: '狼人请睁眼。', user_requested: true }

  test('K4 审批相渲染目标群 / 文本 / user_requested 模型声明行，批准可点', () => {
    const respond = vi.fn()
    render(<GroupPostCard {...pendingProps('group_post', POST_ARGS, respond)} />)
    expect(screen.getByText('#42')).toBeTruthy()
    expect(screen.getByText('狼人请睁眼。')).toBeTruthy()
    expect(screen.getByText('标记为「用户显式要求」——服务端未采信，仍需你确认')).toBeTruthy()
    fireEvent.click(screen.getByText('发送'))
    expect(respond).toHaveBeenCalledWith({ approved: true })
  })

  test('K4 没有 user_requested 时不显示模型声明那一行', () => {
    render(
      <GroupPostCard
        {...pendingProps('group_post', { session_id: 42, text: '狼人请睁眼。' }, vi.fn())}
      />
    )
    expect(screen.queryByText('标记为「用户显式要求」——服务端未采信，仍需你确认')).toBeNull()
  })

  test('K5 完成相渲染 message_id 与被唤醒的成员', () => {
    render(
      <GroupPostCard
        {...doneProps('group_post', POST_ARGS, {
          ok: true,
          message_id: 901,
          chain_id: 901,
          woke: ['wolf-a', 'wolf-b']
        })}
      />
    )
    expect(screen.getByText(/已发送（消息 #901）/)).toBeTruthy()
    expect(screen.getByText('已唤醒：wolf-a、wolf-b')).toBeTruthy()
  })

  test('K5 没人被唤醒时说「无」，不是空白', () => {
    render(
      <GroupPostCard
        {...doneProps('group_post', POST_ARGS, { ok: true, message_id: 901, woke: [] })}
      />
    )
    expect(screen.getByText('已唤醒：无')).toBeTruthy()
  })
})

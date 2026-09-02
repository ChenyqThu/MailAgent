// @vitest-environment happy-dom
//
// g3 lane U — 终局系统行的解析 + 落位 + 渲染。
//
//   T1 `gameOverMeta` 只认 `kind==='game_over'`（group_stop / judge_post / 脏 JSON / 非 system → null）；
//   T2 时间线里出现 `{kind:'gameOver'}` 项，且按 created_at 落在两条消息之间；
//   T3 GroupMetaRow 渲染 `groupChat.gameOver` 文案（不给展开、不给重试 —— 终局不是「被停止」）。

import { describe, expect, test } from 'vitest'
import { createElement } from 'react'
import { render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { ChatMessage } from '@shared/api/types'
import {
  buildGroupTimeline,
  gameOverMeta
} from '../../src/shared/components/agents/groups/groupTimeline'
import { GroupMetaRow } from '../../src/shared/components/agents/groups/GroupMetaRow'

await i18n.changeLanguage('zh-CN')

const DAY = 1_700_000_000_000

function message(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    session_id: 1,
    role: 'system',
    content: '',
    status: 'complete',
    created_at: DAY,
    ...over
  } as ChatMessage
}

describe('game_over 系统行', () => {
  test('T1 gameOverMeta 只认 kind=game_over', () => {
    expect(
      gameOverMeta(
        message({ metadata: JSON.stringify({ kind: 'game_over', runId: 'r1', chainId: 5 }) })
      )
    ).toEqual({ runId: 'r1' })
    // runId 缺席仍是终局行（判据是 kind），只是没有可关联的 run。
    expect(gameOverMeta(message({ metadata: JSON.stringify({ kind: 'game_over' }) }))).toEqual({
      runId: null
    })
    expect(
      gameOverMeta(
        message({ metadata: JSON.stringify({ kind: 'group_stop', reason: 'chain_cap' }) })
      )
    ).toBeNull()
    expect(
      gameOverMeta(message({ metadata: JSON.stringify({ kind: 'judge_post', runId: 'r1' }) }))
    ).toBeNull()
    expect(gameOverMeta(message({ metadata: '{not json' }))).toBeNull()
    expect(gameOverMeta(message({ metadata: null }))).toBeNull()
    expect(
      gameOverMeta(message({ role: 'assistant', metadata: JSON.stringify({ kind: 'game_over' }) }))
    ).toBeNull()
  })

  test('T2 时间线含 gameOver 项且按 created_at 落位', () => {
    const { items } = buildGroupTimeline({
      messages: [
        message({ id: 1, role: 'user', content: '@法官 开始游戏', created_at: DAY }),
        message({
          id: 2,
          metadata: JSON.stringify({ kind: 'game_over', runId: 'r9', chainId: 1 }),
          created_at: DAY + 2000
        }),
        message({
          id: 3,
          role: 'assistant',
          content: '复盘',
          speaker_agent_id: 'judge',
          created_at: DAY + 4000
        })
      ],
      turns: null,
      turnsHasMore: false,
      live: null,
      local: []
    })
    const kinds = items.map((i) => i.kind)
    expect(kinds).toEqual(['date', 'group', 'gameOver', 'group'])
    const over = items.find((i) => i.kind === 'gameOver')
    expect(over).toMatchObject({ kind: 'gameOver', ts: DAY + 2000, runId: 'r9' })
  })

  test('T3 GroupMetaRow 渲染终局文案，没有展开钮也没有重试钮', () => {
    render(
      createElement(GroupMetaRow, {
        item: { kind: 'gameOver', key: 'go:2', ts: DAY, runId: 'r9' }
      })
    )
    expect(screen.getByText('本局已结束')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

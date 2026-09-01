// @vitest-environment happy-dom
//
// task 08-27 P4a dogfood 批 — 预处理执行详情：labels_json 的详细过程要露出来。
//
// 🔴 `email:aiFields` 早就把整个 labels_json 当 `labels_raw` 送到前端了
// （src/electron/main/handlers/email.ts:684），组件此前只渲染三个 chip ⇒ owner
// 「只看到处理概要，看不到详细过程」。本文件钉两件事：
//   ① 满字段行：概括 / 判定理由 / 要点 / 建议操作 / 建议回复都渲染出来；
//   ② 缺字段行（老邮件 / 降级路径 / 形状异常）：空的节整节不渲染，且 DOM 里
//      不得出现 "undefined"。
// 变异验证目标：把 labelText 改成不判类型直接返回，缺字段那条必红。
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn()
}))

const mockAiFields = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ email: { aiFields: mockAiFields } })
}))

import i18n from '@shared/i18n'
import type { AIFields, EnrichedEmailMeta } from '@shared/api/types'
import { TeamPreprocessDetail } from '../../src/shared/components/agents/team/TeamRecordDetail'

await i18n.changeLanguage('zh-CN')

// 列表行只喂详情面的触发气泡 + 三个 chip；其余 EmailMeta 列与本用例无关。
const EMAIL = {
  internal_id: 501,
  subject: 'W35 项目周报',
  sender: 'a@x.test',
  date_received: '2026-08-30T12:00:00+08:00',
  mailbox: '收件箱',
  is_read: true,
  is_flagged: false,
  lang: 'zh',
  ai_priority: 'critical',
  ai_action: '需要回复',
  ai_category: '👥 团队协作',
  attach_count: 0,
  is_important: true,
  processing_status: null,
  snippet: null,
  llm_status: 'completed'
} as unknown as EnrichedEmailMeta

function aiFields(labels: Record<string, unknown> | null): AIFields {
  return {
    internal_id: 501,
    processing_status: null,
    mailbox: '收件箱',
    is_read: true,
    is_flagged: false,
    ai_priority: 'critical',
    ai_action: '需要回复',
    ai_review_status: 'reviewed',
    sentiment: null,
    ai_model: 'claude-fable-5',
    labels_raw: labels,
    llm_status: 'completed',
    latency_ms: 3100,
    input_tokens: 1200,
    output_tokens: 300,
    retry_count: 0,
    last_error: null
  } as AIFields
}

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('TeamPreprocessDetail — labels_json 详细过程', () => {
  test('满字段行：概括 / 判定理由 / 要点 / 建议操作 / 建议回复都在场', async () => {
    mockAiFields.mockResolvedValue(
      aiFields({
        ai_summary: '这封邮件要求本周五前确认迁移窗口。',
        urgency_reason: '窗口只剩两天，错过要等下个季度。',
        // 🔴 key_points 是 \n 分隔的一段文本（不是数组），行首带模型自己的项目符号。
        key_points: '• 周五前确认窗口\n• Alex 负责回滚脚本\n\n1. 影响两个区域',
        mail_actions: ['⭐ Starred', '🏷️ Tagged'],
        reply_suggestion_md: '收到，我周四给出确认。\n\n----\nBest,',
        category: '👥 团队协作'
      })
    )
    const { container } = render(<TeamPreprocessDetail email={EMAIL} />, {
      wrapper: makeQcWrapper()
    })
    await waitFor(() => expect(container.querySelector('[data-preprocess-labels]')).toBeTruthy())
    expect(screen.getByText('这封邮件要求本周五前确认迁移窗口。')).toBeTruthy()
    // owner 最想看的一条：为什么判成这个优先级。
    expect(screen.getByText('判定理由')).toBeTruthy()
    expect(screen.getByText('窗口只剩两天，错过要等下个季度。')).toBeTruthy()
    // 要点按行拆开，行首的 • / 1. 被剥掉（否则与列表点叠成「• •」），空行丢掉。
    const points = Array.from(container.querySelectorAll('[data-preprocess-labels] li')).map(
      (li) => li.textContent
    )
    expect(points).toEqual(['周五前确认窗口', 'Alex 负责回滚脚本', '影响两个区域'])
    expect(screen.getByText('⭐ Starred')).toBeTruthy()
    expect(screen.getByText('🏷️ Tagged')).toBeTruthy()
    expect(screen.getByText(/收到，我周四给出确认。/)).toBeTruthy()
  })

  test('recommended_actions 是对象数组：只认带 title 的条目，畸形项静默丢弃', async () => {
    mockAiFields.mockResolvedValue(
      aiFields({
        recommended_actions: [
          { id: 'create_draft', title: '起草回复', detail: '对方在等确认', confidence: 0.9 },
          { id: 'snooze_1h', confidence: 0.4 },
          'not-an-object'
        ]
      })
    )
    const { container } = render(<TeamPreprocessDetail email={EMAIL} />, {
      wrapper: makeQcWrapper()
    })
    await waitFor(() => expect(container.querySelector('[data-preprocess-labels]')).toBeTruthy())
    const items = Array.from(container.querySelectorAll('[data-preprocess-labels] li'))
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent).toContain('起草回复')
    expect(items[0]?.textContent).toContain('对方在等确认')
  })

  // 🔴 生产库实测：最少的一行只有 action_type / priority / ai_summary / category 四个键；
  // 老邮件、降级路径、8000 字符截断都会让字段缺失或形状不对。
  test('缺字段 / 形状异常：空的节不渲染，DOM 里没有 undefined', async () => {
    mockAiFields.mockResolvedValue(
      aiFields({
        ai_summary: '只有概括的老邮件。',
        urgency_reason: '',
        key_points: '   \n  ',
        // 形状异常：schema 里是数组，这里给了字符串。
        mail_actions: '⭐ Starred',
        reply_suggestion_md: null
      })
    )
    const { container } = render(<TeamPreprocessDetail email={EMAIL} />, {
      wrapper: makeQcWrapper()
    })
    await waitFor(() => expect(screen.getByText('只有概括的老邮件。')).toBeTruthy())
    expect(screen.queryByText('判定理由')).toBeNull()
    expect(screen.queryByText('要点')).toBeNull()
    expect(screen.queryByText('建议操作')).toBeNull()
    expect(screen.queryByText('建议回复')).toBeNull()
    expect(container.querySelector('[data-preprocess-labels] li')).toBeNull()
    expect(container.textContent).not.toContain('undefined')
  })

  test('labels_raw 整个为 null（失败行）：labels 区整块不渲染', async () => {
    mockAiFields.mockResolvedValue({ ...aiFields(null), llm_status: 'failed' })
    const { container } = render(<TeamPreprocessDetail email={EMAIL} />, {
      wrapper: makeQcWrapper()
    })
    await waitFor(() => expect(screen.getByText('这一封没跑通')).toBeTruthy())
    expect(container.querySelector('[data-preprocess-labels]')).toBeNull()
    expect(container.textContent).not.toContain('undefined')
  })
})

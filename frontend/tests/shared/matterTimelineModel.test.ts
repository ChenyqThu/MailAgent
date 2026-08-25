// @vitest-environment happy-dom
//
// 事项时间线叙述层的判定测试。用**真的** i18n 实例（不是 mock 的 t）—— 这一层的产出就是
// 给人读的句子，mock 掉 locale 只会测出"插值调用过了"，测不出"读起来是不是跟进历史"。

import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import i18n from '@shared/i18n'
import type { MatterActorKind, MatterEvent } from '@shared/api/types/matter'
import {
  GROUPED_TEMPLATE_KINDS,
  groupTimelineEvents,
  matterEventTier,
  narrateEvent,
  narrateGroupEntries,
  narrateTimelineGroup,
  readChanges,
  readNarrative,
  type Translate
} from '@shared/components/matters/matterTimelineModel'
import zh from '../../src/shared/i18n/locales/zh-CN/common.json'
import en from '../../src/shared/i18n/locales/en-US/common.json'

const t = ((key: string, options?: Record<string, unknown>) =>
  i18n.t(key, options as never)) as Translate

const T0 = Date.UTC(2026, 7, 12, 17, 30, 0)

let sequence = 0
function ev(partial: Partial<MatterEvent> & { kind: string }): MatterEvent {
  sequence += 1
  return {
    id: sequence,
    matter_id: 1,
    happened_at: T0,
    actor_kind: 'user' as MatterActorKind,
    actor_id: null,
    source: 'desktop_ui',
    item_id: null,
    update_id: null,
    resource_id: null,
    reverses_event_id: null,
    dedupe_key: `dedupe-${sequence}`,
    payload: {},
    created_at: T0,
    ...partial
  }
}

/**
 * 每个 kind 一份**有代表性**的 payload —— 既是 38 种句子的覆盖用例，也是这一层消费的
 * 后端契约的现场文档。新增 event kind 时这张表必须补，否则下面的覆盖测试会红。
 */
const KIND_FIXTURES: Record<string, Partial<MatterEvent>> = {
  matter_created: { payload: { public_id: 'mt_1' } },
  matter_updated: {
    payload: { fields: ['status'], changes: [{ field: 'status', from: 'active', to: 'waiting' }] }
  },
  matter_archived: {},
  matter_reopened: {},
  matter_trashed: {},
  matter_restored: {},
  item_created: { payload: { kind: 'question', title: '补充协议是否需要新加坡实体共同签署？' } },
  item_updated: {
    payload: {
      kind: 'action',
      title: '回签补充协议',
      fields: ['status'],
      changes: [{ field: 'status', from: 'open', to: 'done' }]
    }
  },
  item_deleted: {
    payload: { kind: 'note', title: '临时备注', fields: ['deleted_at'], changes: [] }
  },
  item_restored: {
    payload: { kind: 'note', title: '临时备注', fields: ['deleted_at'], changes: [] }
  },
  resource_linked: { payload: { link_id: 3, title: 'NexPay 二期启动函', resource_kind: 'email' } },
  resource_updated: { payload: { title: '二期接入技术方案', resource_kind: 'doc' } },
  resource_unlinked: { payload: { title: '二期接入技术方案', resource_kind: 'doc' } },
  resource_restored: { payload: { title: '二期接入技术方案', resource_kind: 'doc' } },
  resource_suggestion_accepted: { payload: { title: '合规回执', resource_kind: 'email' } },
  resource_suggestion_rejected: { payload: { title: '无关周报', resource_kind: 'email' } },
  resource_access_policy_changed: { payload: { title: '对账样例', resource_kind: 'file' } },
  resource_subscription_paused: { payload: { title: '联调会话', resource_kind: 'thread' } },
  resource_subscription_resumed: { payload: { title: '联调会话', resource_kind: 'thread' } },
  stakeholder_added: { payload: { stakeholder_id: 5, display_name: '陈立', changes: [] } },
  stakeholder_updated: {
    payload: {
      stakeholder_id: 5,
      display_name: '陈立',
      changes: [{ field: 'is_waiting_on', from: false, to: true }]
    }
  },
  stakeholder_removed: { payload: { stakeholder_id: 5, display_name: '陈立', changes: [] } },
  stakeholder_restored: { payload: { stakeholder_id: 5, display_name: '陈立', changes: [] } },
  relation_added: { payload: { relation_id: 2, target_title: 'NexPay 一期收尾' } },
  relation_updated: { payload: { relation_id: 2 } },
  relation_removed: { payload: { relation_id: 2 } },
  relation_restored: { payload: { relation_id: 2 } },
  chat_scope_expanded: { payload: { session_id: 's1', from: 'matter', to: 'workspace' } },
  chat_scope_restored: { payload: { session_id: 's1', from: 'workspace', to: 'matter' } },
  update_proposed: {
    actor_kind: 'agent',
    source: 'agent_run',
    payload: { update_id: 7, run_id: 3, change_count: 2 }
  },
  update_accepted: { payload: { update_id: 7, accepted_change_ids: ['c1', 'c2', 'c3'] } },
  update_rejected: { payload: { update_id: 7, reason: '证据不足，等合规回执再说' } },
  update_superseded: { payload: { update_id: 6, superseded_by: 7 } },
  agent_binding_changed: {
    payload: {
      fields: ['agent_enabled'],
      changes: [{ field: 'agent_enabled', from: false, to: true }]
    }
  },
  attention_opened: {
    actor_kind: 'system',
    payload: { signal_id: 9, kind: 'needs_review', severity: 'info' }
  },
  attention_resolved: { payload: { signal_id: 9, resolved_by: 'user' } },
  attention_snoozed: { payload: { signal_id: 9, state: 'snoozed' } },
  attention_dismissed: { payload: { signal_id: 9, state: 'dismissed' } },
  // curated 进展的**维护动作**（task 08-25）。🔴 payload 里有意没有 `body` —— 正文只有
  // 一个家（`matter_progress` 行本身），操作日志回答的是「谁动了哪一条」。
  progress_added: {
    payload: { progress_id: 4, kind: 'progress', title: 'Simon 回邮确认 Q4 预算' }
  },
  progress_updated: {
    payload: {
      progress_id: 4,
      fields: ['kind', 'title'],
      kind: 'decision',
      title: 'Q4 预算已定'
    }
  },
  progress_removed: {
    payload: { progress_id: 4, fields: ['deleted_at'], kind: 'decision', title: 'Q4 预算已定' }
  },
  progress_restored: {
    payload: { progress_id: 4, fields: ['deleted_at'], kind: 'decision', title: 'Q4 预算已定' }
  }
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('narrateEvent — 每种 kind 都有真句子', () => {
  const kinds = Object.keys(zh.matters.events)

  it('fixture 覆盖 locale 里登记的全部 kind', () => {
    // 🔴 抽取器/表本身失效就必须红：漏一个 kind 时下面的 it.each 会静默少跑一轮。
    expect(kinds.length).toBeGreaterThan(30)
    expect(Object.keys(KIND_FIXTURES).sort()).toEqual([...kinds].sort())
  })

  it.each(['zh-CN', 'en-US'])('%s 每个 kind 都产出叙述句而不是事件名', async (locale) => {
    await i18n.changeLanguage(locale)
    for (const kind of kinds) {
      const sentence = narrateEvent(ev({ kind, ...KIND_FIXTURES[kind] }), t)
      expect(sentence.text.trim(), `${locale}/${kind} 句子为空`).not.toBe('')
      // 「事件名」= 老的 audit-log 观感。有了模板就不该再落回它。
      expect(sentence.text, `${locale}/${kind} 落回了通用事件名`).not.toBe(
        i18n.t(`matters.events.${kind}`)
      )
      expect(sentence.text, `${locale}/${kind} 漏了插值`).not.toMatch(/\{[a-z_]+\}/)
    }
    await i18n.changeLanguage('zh-CN')
  })

  // 🔴 0812 —— 事项对话的「本事项 / 全库」检索范围开关整体移除后，chat_scope_* **不会再产生新
  // 事件**，但 owner 活库里已经有这样的行。narrate 分支 / AUDIT_KINDS / locale 三处因此**保留**，
  // 这条用例就是那三处的看门人：谁顺手把它们当死代码删掉，这里会红。
  it('退役的 chat_scope_* 历史事件仍叙述得出来（产出路径已死，渲染路径必须活）', async () => {
    for (const [kind, expected] of [
      ['chat_scope_expanded', '扩大了事项对话的检索范围'],
      ['chat_scope_restored', '把事项对话的检索范围收了回来']
    ] as const) {
      const event = ev({ kind, payload: { session_id: 's1', from: 'matter', to: 'global' } })
      expect(narrateEvent(event, t).text).toBe(expected)
      // 纯操作记录 —— 仍归审计档（默认收起但可达）。
      expect(matterEventTier(event)).toBe('audit')
    }
    await i18n.changeLanguage('en-US')
    expect(narrateEvent(ev({ kind: 'chat_scope_expanded' }), t).text).toBe(
      'Widened the retrieval scope for matter chat'
    )
    await i18n.changeLanguage('zh-CN')
  })
})

describe('叙述句的具体形态', () => {
  it('多字段变更压成一句，不是两行拼接', () => {
    const sentence = narrateEvent(
      ev({
        kind: 'matter_updated',
        payload: {
          fields: ['priority', 'status'],
          changes: [
            { field: 'priority', from: 'p2', to: 'p0' },
            { field: 'status', from: 'active', to: 'waiting' }
          ]
        }
      }),
      t
    )
    expect(sentence.text).toBe('优先级 P2 → P0，状态 进行中 → 等待中')
  })

  it('item 的 status 走条目词表，不会被 matter 的 status 词表串味', () => {
    const sentence = narrateEvent(
      ev({
        kind: 'item_updated',
        payload: {
          kind: 'action',
          title: '回签补充协议',
          fields: ['status'],
          changes: [{ field: 'status', from: 'open', to: 'in_progress' }]
        }
      }),
      t
    )
    // matter 的 status 里根本没有 open / in_progress —— 串了就会直出英文标识符。
    expect(sentence.text).toBe('行动项「回签补充协议」：状态 待办 → 进行中')
  })

  it('标签变更写成增减，不是两个数组', () => {
    const sentence = narrateEvent(
      ev({
        kind: 'matter_updated',
        payload: {
          fields: ['tags'],
          changes: [{ field: 'tags', from: ['联调', '待办'], to: ['联调', '合规'] }]
        }
      }),
      t
    )
    expect(sentence.text).toBe('标签 +合规 −待办')
  })

  it('长值截断在句子里有省略号提示（分侧标记）', () => {
    const long = '一'.repeat(120)
    const sentence = narrateEvent(
      ev({
        kind: 'matter_updated',
        payload: {
          fields: ['title'],
          changes: [{ field: 'title', from: '旧标题', to: long, to_truncated: true }]
        }
      }),
      t
    )
    expect(sentence.text).toBe(`标题 「旧标题」 → 「${long}…」`)
    // 没被截断的那一侧不能跟着长省略号（否则等于对用户撒谎）。
    expect(sentence.text).not.toContain('「旧标题…」')
  })

  it('长文本字段只说改写，不把 120 字塞进时间线', () => {
    const sentence = narrateEvent(
      ev({
        kind: 'matter_updated',
        payload: {
          fields: ['current_summary'],
          changes: [{ field: 'current_summary', from: '旧摘要', to: '新摘要'.repeat(40) }]
        }
      }),
      t
    )
    expect(sentence.text).toBe('改写了当前状态摘要')
  })

  it('有产出的那一轮跟进照设计稿口径叙述', () => {
    const sentence = narrateEvent(
      ev({ kind: 'update_proposed', ...KIND_FIXTURES.update_proposed }),
      t
    )
    expect(sentence.text).toBe('跟进运行完成 · 检出 2 项变化，生成 1 条更新提案')
  })

  it('拒绝提案把理由带到第二行', () => {
    const sentence = narrateEvent(
      ev({ kind: 'update_rejected', ...KIND_FIXTURES.update_rejected }),
      t
    )
    expect(sentence.text).toBe('拒绝了更新提案')
    expect(sentence.detail).toBe('证据不足，等合规回执再说')
  })
})

// ---------------------------------------------------------------------------
// 事件正文（0813 轮 3）
//
// owner：「进展仍然像操作日志」。此前时间线上**只有**「谁改了哪个字段」——longText
// 形态有意只出「改写了当前状态摘要」，正文一个字都不上时间线。这一组钉死：叙述类
// 事件带正文、技术类不带、存量老行优雅退化。
// ---------------------------------------------------------------------------
describe('事件正文（narrative）', () => {
  const PROSE = '对方法务已回签补充协议，卡在我方财务开票；下一步 8/15 前把发票寄出。'

  it('摘要改写带正文 —— 主句仍是「改写了…」，正文在 body 上', () => {
    const sentence = narrateEvent(
      ev({
        kind: 'matter_updated',
        payload: {
          fields: ['current_summary'],
          changes: [{ field: 'current_summary', from: '旧摘要', to: PROSE }],
          narrative: { text: PROSE }
        }
      }),
      t
    )
    expect(sentence.text).toBe('改写了当前状态摘要')
    expect(sentence.body).toEqual({ text: PROSE, truncated: false })
  })

  it('提案采纳带被采纳的正文 —— 不再只有「采纳 N 项」这个数字', () => {
    const sentence = narrateEvent(
      ev({
        kind: 'update_accepted',
        actor_kind: 'agent' as MatterActorKind,
        payload: {
          update_id: 7,
          accepted_change_ids: ['c1', 'c2'],
          narrative: { text: PROSE }
        }
      }),
      t
    )
    expect(sentence.text).toBe('接受了更新提案 · 采纳 2 项')
    expect(sentence.body?.text).toBe(PROSE)
  })

  it('备注：标题是正文的前缀时不引用两遍，只说「新增备注」', () => {
    // `POST /notes` 不给标题时 title = 正文的前 120 字（两次不同截断、同一个源串）。
    const sentence = narrateEvent(
      ev({
        kind: 'item_created',
        payload: { kind: 'note', title: PROSE.slice(0, 12), narrative: { text: PROSE } }
      }),
      t
    )
    expect(sentence.text).toBe('新增备注')
    expect(sentence.body?.text).toBe(PROSE)
  })

  it('备注有独立标题时标题照旧进句子，正文另起一块', () => {
    const sentence = narrateEvent(
      ev({
        kind: 'item_created',
        payload: { kind: 'note', title: '8/12 电话纪要', narrative: { text: PROSE } }
      }),
      t
    )
    expect(sentence.text).toBe('新增备注「8/12 电话纪要」')
    expect(sentence.body?.text).toBe(PROSE)
  })

  it('后端截断标记如实透传（渲染层据此才敢加省略号）', () => {
    const sentence = narrateEvent(
      ev({ kind: 'matter_updated', payload: { narrative: { text: '摘', truncated: true } } }),
      t
    )
    expect(sentence.body).toEqual({ text: '摘', truncated: true })
  })

  it('🔴 存量老行没有 narrative 键 ⇒ 退化回原句，不多出空块也不出 undefined', () => {
    const sentence = narrateEvent(
      ev({
        kind: 'matter_updated',
        payload: {
          fields: ['current_summary'],
          changes: [{ field: 'current_summary', from: '旧', to: '新' }]
        }
      }),
      t
    )
    expect(sentence.text).toBe('改写了当前状态摘要')
    expect('body' in sentence).toBe(false)
  })

  it.each([
    ['键是 null', null],
    ['键是数组', [{ text: 'x' }]],
    ['键是裸字符串', 'x'],
    ['text 不是字符串', { text: 42 }],
    ['text 是空白串', { text: '   ' }],
    ['只有 truncated 没有 text', { truncated: true }]
  ])('脏 payload（%s）一律当没有正文，不炸', (_label, narrative) => {
    const event = ev({ kind: 'matter_updated', payload: { narrative } })
    expect(readNarrative(event)).toBeNull()
    expect(narrateEvent(event, t).body).toBeUndefined()
  })

  it.each([
    [
      'matter_updated',
      { fields: ['status'], changes: [{ field: 'status', from: 'active', to: 'waiting' }] }
    ],
    ['resource_linked', { title: '技术方案', resource_kind: 'doc' }],
    ['stakeholder_added', { display_name: '陈立', changes: [] }],
    ['relation_added', { relation_id: 2, target_title: '一期收尾' }],
    ['agent_binding_changed', { fields: ['agent_enabled'] }]
  ])('技术类事件（%s）没有正文块 —— 不是所有事件都要长文', (kind, payload) => {
    expect(narrateEvent(ev({ kind, payload }), t).body).toBeUndefined()
  })

  it('合并组：净变化句取最新那条的正文（不是随便挑一条）', () => {
    // 一分钟内改了两遍摘要 ⇒ 合并成一条，正文必须是**最后**那一版。
    const group = groupTimelineEvents([
      ev({
        kind: 'matter_updated',
        happened_at: T0,
        payload: {
          fields: ['current_summary'],
          changes: [{ field: 'current_summary', from: '第一版', to: '第二版' }],
          narrative: { text: '第二版' }
        }
      }),
      ev({
        kind: 'matter_updated',
        happened_at: T0 - 5_000,
        payload: {
          fields: ['current_summary'],
          changes: [{ field: 'current_summary', from: '初稿', to: '第一版' }],
          narrative: { text: '第一版' }
        }
      })
    ])[0]
    expect(group.events).toHaveLength(2)
    expect(narrateTimelineGroup(group, t).body?.text).toBe('第二版')
  })

  it('计数句不挂正文，但展开的每条明细各带各的', () => {
    const events = [
      ev({
        kind: 'item_created',
        happened_at: T0,
        payload: { kind: 'note', title: '甲', narrative: { text: '备注甲的正文' } }
      }),
      ev({
        kind: 'item_created',
        happened_at: T0 - 3_000,
        payload: { kind: 'note', title: '乙', narrative: { text: '备注乙的正文' } }
      })
    ]
    const group = groupTimelineEvents(events)[0]
    const merged = narrateTimelineGroup(group, t)
    expect(merged.text).toBe('新增了 2 个条目')
    // 替用户挑一条当"进展"是撒谎；正文全在明细里。
    expect(merged.body).toBeUndefined()
    expect(narrateGroupEntries(group, t).map((entry) => entry.sentence.body?.text)).toEqual([
      '备注甲的正文',
      '备注乙的正文'
    ])
  })
})

describe('后端契约的三条语义', () => {
  it('`changes` 键不在 = 老行 ⇒ 降级到字段名，不炸也不空', () => {
    const event = ev({ kind: 'matter_updated', payload: { fields: ['status', 'priority'] } })
    expect(readChanges(event)).toBeNull()
    const sentence = narrateEvent(event, t)
    expect(sentence.text).toBe('更新了事项')
    expect(sentence.detail).toBe('改动：状态、优先级')
  })

  it('老行的 item / 干系人事件（连标识都没有）也不炸', () => {
    for (const kind of ['item_updated', 'stakeholder_updated', 'resource_linked']) {
      const sentence = narrateEvent(ev({ kind, payload: { fields: ['title'] } }), t)
      expect(sentence.text.trim()).not.toBe('')
    }
  })

  it('`changes: []` 是有效值，不能当成老行', () => {
    const event = ev({
      kind: 'item_deleted',
      payload: { kind: 'question', title: '补充协议签署主体', fields: ['deleted_at'], changes: [] }
    })
    // 读出来是空数组，不是 null —— 这是与老行唯一的结构性区别。
    expect(readChanges(event)).toEqual([])
    // 标识在 title 上、动作由 kind 自己叙述 ⇒ 仍然是完整句子。
    expect(narrateEvent(event, t).text).toBe('删除了待解问题「补充协议签署主体」')
  })

  it('`changes: []` 的 matter_updated（只动结构化字段）仍说得出改了什么', () => {
    const event = ev({
      kind: 'matter_updated',
      payload: { fields: ['schedule_json'], changes: [] }
    })
    expect(readChanges(event)).toEqual([])
    const sentence = narrateEvent(event, t)
    expect(sentence.text).toBe('更新了事项')
    expect(sentence.detail).toBe('改动：跟进规则')
  })

  it('`from` 缺失 / `from: null` / `from` 有值 三种句式互不相同', () => {
    const due = Date.UTC(2026, 8, 1, 17, 0, 0)
    const older = Date.UTC(2026, 7, 20, 17, 0, 0)
    const say = (change: Record<string, unknown>): string =>
      narrateEvent(
        ev({ kind: 'matter_updated', payload: { fields: ['due_at'], changes: [change] } }),
        t
      ).text

    const missing = say({ field: 'due_at', to: due })
    const wasEmpty = say({ field: 'due_at', from: null, to: due })
    const wasSet = say({ field: 'due_at', from: older, to: due })
    // 日期串跟随运行时 locale（沿用时间线时间戳既有的 toLocale* 惯例），
    // 所以断言句式而不是硬写 "2026/9/1"。
    const dueText = new Date(due).toLocaleDateString()
    const olderText = new Date(older).toLocaleDateString()

    expect(missing).toBe(`截止时间设为 ${dueText}`)
    expect(wasEmpty).toBe(`补上了截止时间 ${dueText}`)
    expect(wasSet).toBe(`截止时间 ${olderText} → ${dueText}`)
    expect(new Set([missing, wasEmpty, wasSet]).size).toBe(3)
  })

  it('payload 脏数据不炸：changes 不是数组 / 条目缺 field', () => {
    expect(readChanges(ev({ kind: 'matter_updated', payload: { changes: 'nope' } }))).toBeNull()
    // 🔴 非空数组里混进非法条目 ⇒ 整份不可信（见下面「非法条目不许静默跳过」那组）。
    expect(
      readChanges(ev({ kind: 'matter_updated', payload: { changes: [null, { to: 1 }, 3] } }))
    ).toBeNull()
    expect(narrateEvent(ev({ kind: 'matter_updated', payload: { changes: [null] } }), t).text).toBe(
      '更新了事项'
    )
  })
})

describe('业务 / 审计分档', () => {
  it('matter_updated 按触及的字段二次判定', () => {
    expect(matterEventTier(ev({ kind: 'matter_updated', payload: { fields: ['status'] } }))).toBe(
      'business'
    )
    expect(
      matterEventTier(ev({ kind: 'matter_updated', payload: { fields: ['description'] } }))
    ).toBe('business')
    expect(matterEventTier(ev({ kind: 'matter_updated', payload: { fields: ['tags'] } }))).toBe(
      'audit'
    )
    expect(
      matterEventTier(ev({ kind: 'matter_updated', payload: { fields: ['schedule_json'] } }))
    ).toBe('audit')
    // 业务 + 配置混在一个 patch 里 ⇒ 业务优先，不许把真变更藏进折叠区。
    expect(
      matterEventTier(ev({ kind: 'matter_updated', payload: { fields: ['tags', 'status'] } }))
    ).toBe('business')
    // 老行连 fields 都没有 ⇒ 判据缺失时算业务级。
    expect(matterEventTier(ev({ kind: 'matter_updated', payload: {} }))).toBe('business')
  })

  it('纯操作记录进审计档，业务事件不进', () => {
    const audit = [
      'chat_scope_expanded',
      'chat_scope_restored',
      'resource_access_policy_changed',
      'resource_subscription_paused',
      'resource_subscription_resumed',
      'agent_binding_changed',
      'attention_snoozed',
      'attention_dismissed'
    ]
    for (const kind of audit) expect(matterEventTier(ev({ kind })), kind).toBe('audit')
    for (const kind of Object.keys(zh.matters.events)) {
      if (audit.includes(kind) || kind === 'matter_updated') continue
      expect(matterEventTier(ev({ kind, ...KIND_FIXTURES[kind] })), kind).toBe('business')
    }
  })
})

describe('同类合并（活库实测的四种重复形态）', () => {
  it('一次 run 产出 6 条同毫秒 resource_linked → 一条带计数', () => {
    const events = Array.from({ length: 6 }, (_, index) =>
      ev({
        kind: 'resource_linked',
        actor_kind: 'agent',
        source: 'matter_followup',
        resource_id: 100 + index,
        payload: { link_id: index, title: `资料 ${index}`, resource_kind: 'email' }
      })
    )
    const groups = groupTimelineEvents(events)
    expect(groups).toHaveLength(1)
    expect(groups[0].events).toHaveLength(6)
    expect(narrateTimelineGroup(groups[0], t).text).toBe('关联了 6 份资料')
  })

  it('7 秒内连点 6 次「接受资料建议」→ 一条', () => {
    const events = Array.from({ length: 6 }, (_, index) =>
      ev({
        kind: 'resource_suggestion_accepted',
        happened_at: T0 - index * 1_200,
        payload: { title: `建议 ${index}`, resource_kind: 'email' }
      })
    )
    const groups = groupTimelineEvents(events)
    expect(groups).toHaveLength(1)
    expect(narrateTimelineGroup(groups[0], t).text).toBe('采纳了 6 条资料建议')
  })

  it('25 秒内连改 4 次标签 → 合成净变化，不是四行一样的文案', () => {
    const versions = [['联调', '合规'], ['联调', '待办', '合规'], ['联调', '待办'], ['联调']]
    const events = versions.map((to, index) =>
      ev({
        kind: 'matter_updated',
        happened_at: T0 - index * 8_000,
        payload: {
          fields: ['tags'],
          changes: [{ field: 'tags', from: versions[index + 1] ?? ['联调'], to }]
        }
      })
    )
    const groups = groupTimelineEvents(events)
    expect(groups).toHaveLength(1)
    expect(groups[0].events).toHaveLength(4)
    // 净变化：最早的 from(['联调']) → 最新的 to(['联调','合规'])。
    expect(narrateTimelineGroup(groups[0], t).text).toBe('标签 +合规')
  })

  it('接受提案的扇出：同毫秒的三种 kind 各自收拢，不搅成一条', () => {
    // id DESC 的真实顺序：superseded ×2 → per-change ×3（kind 交替）→ update_accepted。
    const events = [
      ev({ kind: 'update_superseded', payload: { update_id: 5, superseded_by: 7 } }),
      ev({ kind: 'update_superseded', payload: { update_id: 6, superseded_by: 7 } }),
      ev({
        kind: 'matter_updated',
        payload: {
          fields: ['priority'],
          via_update_id: 7,
          changes: [{ field: 'priority', from: 'p2', to: 'p0' }]
        }
      }),
      ev({
        kind: 'item_created',
        payload: { kind: 'action', title: '补合规回执', via_update_id: 7 }
      }),
      ev({
        kind: 'matter_updated',
        payload: {
          fields: ['status'],
          via_update_id: 7,
          changes: [{ field: 'status', from: 'active', to: 'waiting' }]
        }
      }),
      ev({
        kind: 'update_accepted',
        payload: { update_id: 7, accepted_change_ids: ['a', 'b', 'c'] }
      })
    ]
    const groups = groupTimelineEvents(events)
    // 🔴 per-change 的两条 matter_updated 在数组里**不相邻**（中间夹着 item_created）——
    // 严格「相邻同类才合并」会把它们切成两条，burst 内聚合才收得住。
    expect(groups.map((group) => group.head.kind)).toEqual([
      'update_superseded',
      'matter_updated',
      'item_created',
      'update_accepted'
    ])
    expect(groups.map((group) => narrateTimelineGroup(group, t).text)).toEqual([
      '2 条待审提案被新提案取代',
      // 合并组的子句按字段名排序 —— 同一组事件换个到达顺序不该产出不同的句子。
      '优先级 P2 → P0，状态 进行中 → 等待中',
      '新增行动项「补合规回执」',
      '接受了更新提案 · 采纳 3 项'
    ])
  })
})

describe('不会误合语义上独立的事件', () => {
  it('间隔超过 60 秒 ⇒ 两条', () => {
    const groups = groupTimelineEvents([
      ev({ kind: 'matter_updated', happened_at: T0, payload: { fields: ['status'], changes: [] } }),
      ev({
        kind: 'matter_updated',
        happened_at: T0 - 61_000,
        payload: { fields: ['status'], changes: [] }
      })
    ])
    expect(groups).toHaveLength(2)
  })

  it('每 50 秒操作一次也不会无限链成一组（跨度上限 120 秒）', () => {
    const events = Array.from({ length: 8 }, (_, index) =>
      ev({ kind: 'resource_linked', happened_at: T0 - index * 50_000, payload: {} })
    )
    const groups = groupTimelineEvents(events)
    expect(groups.length).toBeGreaterThan(1)
    for (const group of groups) {
      const span = group.events[0].happened_at - group.events[group.events.length - 1].happened_at
      expect(span).toBeLessThanOrEqual(120_000)
    }
  })

  it('同一毫秒但不同 actor / 不同 source ⇒ 不合并', () => {
    expect(
      groupTimelineEvents([
        ev({ kind: 'resource_linked', actor_kind: 'user' }),
        ev({ kind: 'resource_linked', actor_kind: 'agent' })
      ])
    ).toHaveLength(2)
    expect(
      groupTimelineEvents([
        ev({ kind: 'resource_linked', source: 'desktop_ui' }),
        ev({ kind: 'resource_linked', source: 'matter_followup' })
      ])
    ).toHaveLength(2)
  })

  it('改了又改回来的一组回到计数句式（不谎报净变化）', () => {
    const groups = groupTimelineEvents([
      ev({
        kind: 'matter_updated',
        payload: {
          fields: ['status'],
          changes: [{ field: 'status', from: 'waiting', to: 'active' }]
        }
      }),
      ev({
        kind: 'matter_updated',
        payload: {
          fields: ['status'],
          changes: [{ field: 'status', from: 'active', to: 'waiting' }]
        }
      })
    ])
    expect(groups).toHaveLength(1)
    expect(narrateTimelineGroup(groups[0], t).text).toBe('更新事项 · 2 条')
  })

  it('组里混进老行 ⇒ 净变化不可信，回到计数句式', () => {
    const groups = groupTimelineEvents([
      ev({ kind: 'matter_updated', payload: { fields: ['status'] } }),
      ev({
        kind: 'matter_updated',
        payload: {
          fields: ['status'],
          changes: [{ field: 'status', from: 'active', to: 'waiting' }]
        }
      })
    ])
    expect(groups).toHaveLength(1)
    expect(narrateTimelineGroup(groups[0], t).text).toBe('更新事项 · 2 条')
  })

  it('单条事件不走合并句式', () => {
    const groups = groupTimelineEvents([ev({ kind: 'matter_archived' })])
    expect(narrateTimelineGroup(groups[0], t).text).toBe('归档了事项')
  })
})

/**
 * codex（0812 时间线审查）构造的反例。每一条都是**当时的实现会说出一句假话**的路径，
 * 而既有测试网一条都没盖到 —— 所以它们各自钉死的是「不许再合成虚假业务陈述 /
 * 不许隐藏真实业务事件」，不是某个实现细节。
 */
describe('反例：不许合成假句子、不许藏起真事件', () => {
  it('#0 源文件里不许有裸 NUL 字节', () => {
    // 裸 NUL 会让 `file` 把这个 .ts 判成 data、grep/rg 默认跳过它；git 的二进制探测只看
    // 前 8000 字节，位置一往后挪 `git diff` 就变成 Binary files differ，review 直接瞎掉。
    for (const file of TIMELINE_SOURCE_FILES) {
      expect(readSource(file).includes('\u0000'), `${file} 里有裸 NUL 字节`).toBe(false)
    }
  })

  it('#1 同一分钟改了两个条目 ⇒ 两条，不合成一句谁身上都没发生过的净变化', () => {
    const groups = groupTimelineEvents([
      ev({
        kind: 'item_updated',
        item_id: 2,
        payload: {
          kind: 'action',
          title: '条目 B',
          fields: ['status'],
          changes: [{ field: 'status', from: 'waiting', to: 'blocked' }]
        }
      }),
      ev({
        kind: 'item_updated',
        item_id: 1,
        payload: {
          kind: 'action',
          title: '条目 A',
          fields: ['status'],
          changes: [{ field: 'status', from: 'open', to: 'done' }]
        }
      })
    ])
    const texts = groups.map((group) => narrateTimelineGroup(group, t).text)
    // 先钉这句：分组键少了对象身份时，净变化取「最早那条的 from（条目 A 的 待办）」到
    // 「最新那条的 to（条目 B 的 受阻）」⇒ 说出「状态 待办 → 受阻」，还挂在条目 B 名下。
    // 这个变化在两个条目上都没发生过（A 是 待办→已完成，B 是 等待中→受阻）。
    expect(texts.join('|')).not.toContain('待办 → 受阻')
    expect(groups).toHaveLength(2)
    expect(texts).toEqual([
      '行动项「条目 B」：状态 等待中 → 受阻',
      '行动项「条目 A」：状态 待办 → 已完成'
    ])
  })

  it('#1 同一个条目连改多次仍合并，并且合并句带着条目标题', () => {
    const groups = groupTimelineEvents([
      ev({
        kind: 'item_updated',
        item_id: 1,
        payload: {
          kind: 'action',
          title: '回签补充协议',
          fields: ['status'],
          changes: [{ field: 'status', from: 'in_progress', to: 'done' }]
        }
      }),
      ev({
        kind: 'item_updated',
        item_id: 1,
        happened_at: T0 - 5_000,
        payload: {
          kind: 'action',
          title: '回签补充协议',
          fields: ['status'],
          changes: [{ field: 'status', from: 'open', to: 'in_progress' }]
        }
      })
    ])
    expect(groups).toHaveLength(1)
    expect(narrateTimelineGroup(groups[0], t).text).toBe(
      '行动项「回签补充协议」：状态 待办 → 已完成'
    )
  })

  it('#1 身份不可知的两条（连 item_id 都没有）宁可不合并', () => {
    const groups = groupTimelineEvents([
      ev({
        kind: 'item_updated',
        payload: {
          fields: ['status'],
          changes: [{ field: 'status', from: 'waiting', to: 'blocked' }]
        }
      }),
      ev({
        kind: 'item_updated',
        payload: { fields: ['status'], changes: [{ field: 'status', from: 'open', to: 'done' }] }
      })
    ])
    expect(groups).toHaveLength(2)
  })

  it('#2 组里最新一条是审计档、更早一条改了状态 ⇒ 整组按业务档', () => {
    const groups = groupTimelineEvents([
      ev({
        kind: 'matter_updated',
        happened_at: T0,
        payload: {
          fields: ['tags'],
          changes: [{ field: 'tags', from: ['联调'], to: ['联调', '合规'] }]
        }
      }),
      ev({
        kind: 'matter_updated',
        happened_at: T0 - 10_000,
        payload: {
          fields: ['status'],
          changes: [{ field: 'status', from: 'active', to: 'waiting' }]
        }
      })
    ])
    expect(groups).toHaveLength(1)
    // 只看 bucket[0]（最新那条，纯 tags）会判成 audit ⇒ 真业务变更被当操作记录。
    expect(groups[0].tier).toBe('business')
  })

  it('#3 时钟漂移（更老的行带更晚的时间戳）不许让相隔一小时的两条合并', () => {
    const groups = groupTimelineEvents([
      ev({
        kind: 'resource_linked',
        happened_at: T0,
        payload: { title: '甲', resource_kind: 'email' }
      }),
      ev({
        kind: 'resource_linked',
        happened_at: T0 + 3_600_000,
        payload: { title: '乙', resource_kind: 'email' }
      })
    ])
    // 夹取（Math.max(0, …)）只防住「burst 被无限拉长」，防不住这种误合并。
    expect(groups).toHaveLength(2)
  })

  it('#4 一次接受提案确认两份资料 ⇒ 说「确认关联」，不说「有新版本」', () => {
    const groups = groupTimelineEvents([
      ev({
        kind: 'resource_updated',
        payload: { title: '甲', resource_kind: 'doc', confirmed: true }
      }),
      ev({
        kind: 'resource_updated',
        payload: { title: '乙', resource_kind: 'doc', confirmed: true }
      }),
      ev({ kind: 'resource_updated', payload: { title: '丙', resource_kind: 'doc' } }),
      ev({ kind: 'resource_updated', payload: { title: '丁', resource_kind: 'doc' } })
    ])
    // 混合组必须拆开：两种语义不是一句话。
    expect(groups).toHaveLength(2)
    expect(groups.map((group) => narrateTimelineGroup(group, t).text)).toEqual([
      '确认了 2 份资料的关联',
      '2 份资料检出新版本'
    ])
  })

  it('#5 changes 里混进非法条目 ⇒ 整份不可信，降级到字段名（不许只说半句）', () => {
    const event = ev({
      kind: 'matter_updated',
      payload: {
        fields: ['status', 'priority'],
        changes: [{ field: 'status', from: 'active', to: 'waiting' }, null]
      }
    })
    expect(readChanges(event)).toBeNull()
    const sentence = narrateEvent(event, t)
    // 跳过坏条目的话：只叙述状态、优先级整个消失，而句子读起来像完整的。
    expect(sentence.text).toBe('更新了事项')
    expect(sentence.detail).toBe('改动：状态、优先级')
    expect(sentence.text).not.toContain('等待中')
  })

  it('#5 条目缺 `to` 键同样判为不可信', () => {
    expect(
      readChanges(
        ev({ kind: 'matter_updated', payload: { changes: [{ field: 'status', from: 'active' }] } })
      )
    ).toBeNull()
  })

  it('#6 两侧等长时不许靠长度猜是哪一侧被截断', () => {
    const from = '一'.repeat(120)
    const to = '二'.repeat(120)
    const sentence = narrateEvent(
      ev({
        kind: 'matter_updated',
        payload: { fields: ['title'], changes: [{ field: 'title', from, to, truncated: true }] }
      }),
      t
    )
    // 老 payload 只有一个布尔 ⇒ 给中性提示，不指侧别，也不给任何一侧加省略号。
    expect(sentence.text).toBe(`标题 「${from}」 → 「${to}」（值已截断）`)
    expect(sentence.text).not.toContain('…')
  })

  it('#6 新老由 entry 整体判：`truncated` 键在=老行，键不在=新行只认分侧键', () => {
    const from = '一'.repeat(120)
    const to = '二'.repeat(120)
    const say = (change: Record<string, unknown>): string =>
      narrateEvent(
        ev({ kind: 'matter_updated', payload: { fields: ['title'], changes: [change] } }),
        t
      ).text

    // 新行：0 / 1 / 2 个分侧键。
    expect(say({ field: 'title', from, to })).toBe(`标题 「${from}」 → 「${to}」`)
    expect(say({ field: 'title', from, to, from_truncated: true })).toBe(
      `标题 「${from}…」 → 「${to}」`
    )
    expect(say({ field: 'title', from, to, to_truncated: true })).toBe(
      `标题 「${from}」 → 「${to}…」`
    )
    expect(say({ field: 'title', from, to, from_truncated: true, to_truncated: true })).toBe(
      `标题 「${from}…」 → 「${to}…」`
    )

    // 老行：`truncated` 键在就整条按老行处理 —— 🔴 逐侧回落（`from_truncated ?? truncated`）
    // 会在「只有 to 被截」的行上把 truncated 派给 from 侧，正是本条要修的谎话。
    expect(say({ field: 'title', from, to, truncated: true })).toBe(
      `标题 「${from}」 → 「${to}」（值已截断）`
    )
    expect(say({ field: 'title', from, to, truncated: true, to_truncated: true })).toBe(
      `标题 「${from}」 → 「${to}」（值已截断）`
    )
    expect(say({ field: 'title', from, to, truncated: false })).toBe(`标题 「${from}」 → 「${to}」`)
  })

  it('#10 同 burst 新到一条更新的事件后，组的标识不变（head 变了也不变）', () => {
    const older = Array.from({ length: 6 }, (_, index) =>
      ev({
        kind: 'resource_linked',
        happened_at: T0 - (index + 1) * 1_000,
        payload: { title: `资料 ${index}`, resource_kind: 'email' }
      })
    )
    const before = groupTimelineEvents(older)
    const after = groupTimelineEvents([
      ev({
        kind: 'resource_linked',
        happened_at: T0,
        payload: { title: '资料 6', resource_kind: 'email' }
      }),
      ...older
    ])
    expect(before).toHaveLength(1)
    expect(after).toHaveLength(1)
    expect(after[0].head.id).not.toBe(before[0].head.id) // head 确实换了
    expect(after[0].id).toBe(before[0].id) // 标识仍然认得出是同一组
  })
})

describe('locale 覆盖', () => {
  const narrativeKeys = (bundle: typeof zh): string[] =>
    Object.entries(bundle.matters.narrative)
      .flatMap(([key, value]) =>
        typeof value === 'string' ? [key] : Object.keys(value).map((child) => `${key}.${child}`)
      )
      .sort()

  it('两份 locale 的 narrative 子树 key 完全一致', () => {
    expect(narrativeKeys(zh)).toEqual(narrativeKeys(en as unknown as typeof zh))
    expect(narrativeKeys(zh).length).toBeGreaterThan(60)
  })

  it('声明了复数模板的 kind 在两份 locale 里都真的有模板', () => {
    for (const kind of GROUPED_TEMPLATE_KINDS) {
      for (const [locale, bundle] of [
        ['zh-CN', zh],
        ['en-US', en as unknown as typeof zh]
      ] as const) {
        const grouped = bundle.matters.narrative.grouped as Record<string, string>
        expect(grouped[kind]?.trim(), `${locale} 缺 grouped.${kind}`).toBeTruthy()
      }
    }
  })

  it('组件里没有硬编码中文', () => {
    // 叙述层的产出全是给人读的文案，一旦有人图省事写死中文，en-US 就是坏的。
    for (const file of TIMELINE_SOURCE_FILES) {
      const source = readSource(file)
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
      expect(code, `${file} 出现了硬编码 CJK`).not.toMatch(/['"`][^'"`]*[一-龥]/)
    }
  })

  it('后端写进事件的每个 source 都有文案（不然时间线直出标识符）', () => {
    // 实测到的坑：`agent_run` / `matter_followup` 从来没进过 locale，Agent 跑出来的
    // 每条事件底下都在显示 "matters.eventSource.agent_run"。判据必须从 Python 抽，
    // 不能照抄一份清单 —— 抄的那份不会跟着后端新增的 source 走。
    const dir = resolve(__dirname, '../../../src/matters')
    const sources = new Set<string>()
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.py')) continue
      for (const [, value] of readFileSync(resolve(dir, name), 'utf-8').matchAll(
        /\bsource=["']([a-z][a-z0-9_]*)["']/g
      )) {
        sources.add(value)
      }
    }
    // 🔴 抽取器抽空时下面的循环会零轮通过 —— 那是最坏的失效形态。
    expect(sources.size).toBeGreaterThanOrEqual(4)
    expect(sources).toContain('agent_run')
    for (const source of sources) {
      for (const [locale, bundle] of [
        ['zh-CN', zh],
        ['en-US', en as unknown as typeof zh]
      ] as const) {
        const labels = bundle.matters.eventSource as Record<string, string>
        expect(labels[source]?.trim(), `${locale} 缺 eventSource.${source}`).toBeTruthy()
      }
    }
  })
})

/**
 * 叙述层的源文件清单 —— 两条结构闸（裸 NUL / 硬编码中文）盯的就是这几份。
 *
 * task 08-25：`MatterTimeline.tsx` 拆成了三件 —— 事件那一路进操作日志弹窗
 * （`MatterAuditLogModal`），curated 进展是新的 `MatterProgressLane`，正文块与按天分组
 * 抽成两份共用模块。🔴 新增同层文件时加进这张表，漏加 = 那份文件不在任何闸下面。
 */
const TIMELINE_SOURCE_FILES = [
  'matterTimelineModel.ts',
  'matterDayGroups.ts',
  'MatterAuditLogModal.tsx',
  'MatterNarrativeBody.tsx',
  'MatterProgressLane.tsx',
  // 进展五类的图标 / 色调表。今天只有 token 与符号，但它是「五类长什么样」的家 ——
  // 下一个人往里加 `label: '目标'` 是最自然的动作，那正是 en-US 坏掉的方式。
  'matterProgressVocab.ts'
] as const

function readSource(name: string): string {
  return readFileSync(resolve(__dirname, '../../src/shared/components/matters', name), 'utf-8')
}

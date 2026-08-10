// P2-8 — the queryKeys factory is a pure byte-for-byte rename of the ~150
// hand-typed query-key literals it replaced. These tests pin each builder's
// output to the exact literal, so any drift (reordered element, singular vs
// plural root, wrong tag) that would silently break TanStack prefix matching
// fails loudly here instead of at runtime.

import { describe, expect, test } from 'vitest'

import { qk } from '../../src/shared/lib/queryKeys'
import { EMAIL_SUPPLEMENT_TAG } from '../../src/shared/lib/emailInvalidation'
import {
  CALENDAR_EVENTS_KEY,
  CALENDAR_SYNC_STATUS_KEY,
  CALENDAR_NAMES_KEY
} from '../../src/shared/components/calendar/hooks/useCalendarEvents'

describe('qk.emails — primary list + supplements', () => {
  test('root + list + four supplement families', () => {
    expect(qk.emails.all()).toEqual(['emails'])
    // sortKey/sortDir 是 2026-08 排序下沉 SQL 时追加的尾部元素 —— 排序换了就是
    // 换一份结果集，不进 key 会命中旧缓存（「点了没反应」）。
    expect(qk.emails.list('inbox', null, '收件箱', 100, 'date', 'desc')).toEqual([
      'emails',
      'inbox',
      null,
      '收件箱',
      100,
      'date',
      'desc'
    ])
    expect(qk.emails.list('inbox', null, '收件箱', 100, 'sender', 'asc')).not.toEqual(
      qk.emails.list('inbox', null, '收件箱', 100, 'date', 'desc')
    )
    expect(qk.emails.cross('发件箱', 100)).toEqual(['emails', 'cross', '发件箱', 100])
    expect(qk.emails.pinnedSupplement([9])).toEqual(['emails', 'pinned-supplement', [9]])
    expect(qk.emails.threadBatch(['t1'])).toEqual(['emails', 'thread-batch', ['t1']])
    expect(qk.emails.threadEnriched([1, 5])).toEqual(['emails', 'thread-enriched', [1, 5]])
  })

  test('supplement tags stay in sync with the classifier authority', () => {
    expect(qk.emails.cross('m', 1)[1]).toBe(EMAIL_SUPPLEMENT_TAG.cross)
    expect(qk.emails.pinnedSupplement([])[1]).toBe(EMAIL_SUPPLEMENT_TAG.pinnedSupplement)
    expect(qk.emails.threadBatch([])[1]).toBe(EMAIL_SUPPLEMENT_TAG.threadBatch)
    expect(qk.emails.threadEnriched([])[1]).toBe(EMAIL_SUPPLEMENT_TAG.threadEnriched)
  })
})

describe('qk.email — single-email families (singular root)', () => {
  test('detail / ai / translation / body / bodyPreview / threadCount / thread', () => {
    expect(qk.email.detail(7)).toEqual(['email', 7])
    expect(qk.email.ai(7)).toEqual(['email', 7, 'ai'])
    expect(qk.email.translation(7, 'zh')).toEqual(['email', 7, 'translation', 'zh'])
    expect(qk.email.body(7, 'html')).toEqual(['email', 7, 'body', 'html'])
    expect(qk.email.body(7, 'markdown')).toEqual(['email', 7, 'body', 'markdown'])
    expect(qk.email.bodyPreview(7, 'html')).toEqual(['email', 7, 'body-preview', 'html'])
    expect(qk.email.threadCount('t1')).toEqual(['email', 't1', 'thread-count'])
    expect(qk.email.thread('t1')).toEqual(['email', 'thread', 't1'])
  })
})

describe('qk — top-level singletons', () => {
  test('mailboxes / pinnedIds / skills', () => {
    expect(qk.mailboxes()).toEqual(['mailboxes'])
    expect(qk.pinnedIds()).toEqual(['pinnedIds'])
    expect(qk.skills()).toEqual(['skills'])
  })
})

describe('qk.chat', () => {
  test('allSessions / messages / kosAvailable / config', () => {
    expect(qk.chat.allSessions()).toEqual(['chat', 'allSessions'])
    expect(qk.chat.messages('s1')).toEqual(['chat', 'messages', 's1'])
    expect(qk.chat.kosAvailable()).toEqual(['chat', 'kosAvailable'])
    expect(qk.chat.config('opennessFlags')).toEqual(['chat', 'config', 'opennessFlags'])
  })
})

describe('qk.folder', () => {
  test('all / discover / whitelist', () => {
    expect(qk.folder.all()).toEqual(['folder'])
    expect(qk.folder.discover()).toEqual(['folder', 'discover'])
    expect(qk.folder.whitelist()).toEqual(['folder', 'whitelist'])
  })
})

describe('qk.calendar — and useCalendarEvents re-exports consume the factory', () => {
  test('factory builders', () => {
    expect(qk.calendar.events()).toEqual(['calendar', 'events'])
    expect(qk.calendar.syncStatus()).toEqual(['calendar', 'syncStatus'])
    expect(qk.calendar.names()).toEqual(['calendar', 'names'])
    expect(qk.calendar.event()).toEqual(['calendar', 'event'])
    expect(qk.calendar.eventDetail('uid', 'rid', 'src')).toEqual([
      'calendar',
      'event',
      'uid',
      'rid',
      'src'
    ])
    expect(qk.calendar.recurring()).toEqual(['calendar', 'recurring'])
    expect(qk.calendar.recurringSince('2026-01-01')).toEqual([
      'calendar',
      'recurring',
      '2026-01-01'
    ])
    expect(qk.calendar.recurringStatus90d('2026-01-01')).toEqual([
      'calendar',
      'recurring',
      'status-90d',
      '2026-01-01'
    ])
  })

  test('CALENDAR_*_KEY re-exports are the same literals as the builders', () => {
    expect(CALENDAR_EVENTS_KEY).toEqual(qk.calendar.events())
    expect(CALENDAR_SYNC_STATUS_KEY).toEqual(qk.calendar.syncStatus())
    expect(CALENDAR_NAMES_KEY).toEqual(qk.calendar.names())
  })
})

describe('qk — settings / skill / notionAgent / policy / llm / admin', () => {
  test('settings + skill config/secrets', () => {
    expect(qk.settings.all()).toEqual(['settings'])
    expect(qk.settings.secretsStatus()).toEqual(['settings', 'secrets-status'])
    expect(qk.skillSecrets('s')).toEqual(['skillSecrets', 's'])
    expect(qk.skillConfig('s')).toEqual(['skillConfig', 's'])
  })

  test('notionAgent / standingDocs', () => {
    expect(qk.notionAgent.config()).toEqual(['notionAgent', 'config'])
    expect(qk.notionAgent.models()).toEqual(['notionAgent', 'models'])
    expect(qk.notionAgent.agents()).toEqual(['notionAgent', 'agents'])
    expect(qk.standingDocs.list()).toEqual(['standingDocs', 'list'])
  })

  test('policy / execPolicy', () => {
    expect(qk.policy.rules('a1')).toEqual(['policy', 'rules', 'a1'])
    expect(qk.policy.skillEntrypoints()).toEqual(['policy', 'skill-entrypoints'])
    expect(qk.execPolicy.rules()).toEqual(['execPolicy', 'rules'])
  })

  test('llm / admin', () => {
    expect(qk.llm.upstreamModels('anthropic')).toEqual(['llm', 'upstream-models', 'anthropic'])
    expect(qk.llm.stats()).toEqual(['llm', 'stats'])
    expect(qk.llm.statsDays(7)).toEqual(['llm', 'stats', 7])
    expect(qk.llm.providers()).toEqual(['llm', 'providers'])
    expect(qk.llm.providerModels('dash')).toEqual(['llm', 'providers', 'dash', 'models'])
    expect(qk.admin.stats()).toEqual(['admin', 'stats'])
    expect(qk.admin.deadLetter()).toEqual(['admin', 'deadLetter'])
    expect(qk.admin.systemAlerts()).toEqual(['admin', 'systemAlerts'])
    expect(qk.admin.health()).toEqual(['admin', 'health'])
    expect(qk.admin.davmailHealth()).toEqual(['admin', 'davmailHealth'])
  })
})

describe('qk — agent-runs / agent / ai-gateway / compose / report / misc', () => {
  test('agentRuns', () => {
    expect(qk.agentRuns.all()).toEqual(['agent-runs'])
    expect(qk.agentRuns.list('a1', 20)).toEqual(['agent-runs', 'a1', 20])
    expect(qk.agentRuns.list(null, 20)).toEqual(['agent-runs', 'all', 20])
    expect(qk.agentRuns.toolOptions()).toEqual(['agent-runs', 'tool-options'])
    expect(qk.agentRuns.pendingCount()).toEqual(['agent-runs', 'pending-count'])
    expect(qk.agentRuns.pausedPending()).toEqual(['agent-runs', 'list', 'paused_pending'])
  })

  test('agent / ai-gateway / agentApprovalPending', () => {
    expect(qk.agent.skillsRegistry()).toEqual(['agent', 'skills', 'registry'])
    expect(qk.aiGateway.health('http://x')).toEqual(['ai-gateway', 'health', 'http://x'])
    expect(qk.aiGateway.approvalPending('http://x', 's1', 3)).toEqual([
      'ai-gateway',
      'approval-pending',
      'http://x',
      's1',
      3
    ])
    expect(qk.agentApprovalPending('s1')).toEqual(['agent-approval-pending', 's1'])
  })

  test('compose / report / project-progress', () => {
    expect(qk.compose.plan(7)).toEqual(['compose', 'plan', 7])
    expect(qk.compose.planMode(7, 'reply')).toEqual(['compose', 'plan', 7, 'reply'])
    expect(qk.compose.draftEdit(7)).toEqual(['compose', 'draft-edit', 7])
    expect(qk.report.list()).toEqual(['report', 'list'])
    expect(qk.report.listCadence('all')).toEqual(['report', 'list', 'all'])
    expect(qk.report.config()).toEqual(['report', 'config'])
    expect(qk.report.get('r1')).toEqual(['report', 'get', 'r1'])
    expect(qk.projectProgressRuns(50)).toEqual(['project-progress-runs', 50])
  })

  test('palette / mention / contactSuggest / attachment', () => {
    expect(qk.palette.search('q')).toEqual(['palette', 'search', 'q'])
    expect(qk.mention.search('q')).toEqual(['mention', 'search', 'q'])
    expect(qk.contactSuggest('q', ['a@x'])).toEqual(['contactSuggest', 'q', ['a@x']])
    expect(qk.attachment.dataUrl('att1')).toEqual(['attachment', 'att1', 'dataUrl'])
  })

  test('matters', () => {
    expect(qk.matters.all()).toEqual(['matters'])
    expect(qk.matters.list()).toEqual(['matters', 'list'])
    expect(qk.matters.list('vendor')).toEqual(['matters', 'list', 'vendor'])
    expect(qk.matters.paletteSearch('vendor')).toEqual(['matters', 'palette-search', 'vendor'])
    expect(qk.matters.detail('MAT-0001')).toEqual(['matters', 'detail', 'MAT-0001'])
    expect(qk.matters.resources('MAT-0001')).toEqual(['matters', 'detail', 'MAT-0001', 'resources'])
    expect(qk.matters.stakeholders('MAT-0001')).toEqual(['matters', 'detail', 'MAT-0001', 'stakeholders'])
    expect(qk.matters.resourceLookup('mailagent', ['email:1', 'thread:t1'])).toEqual([
      'matters',
      'links',
      'mailagent',
      'email:1',
      'thread:t1'
    ])
    expect(qk.matters.captureCandidates('vendor')).toEqual(['matters', 'capture-candidates', 'vendor'])
    expect(qk.matters.config()).toEqual(['matters', 'config'])
  })
})

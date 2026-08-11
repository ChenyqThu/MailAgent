import { describe, expect, test } from 'vitest'

import {
  BUILTIN_MATTER_TYPES,
  MATTER_ACCESS_POLICIES,
  MATTER_ACTOR_KINDS,
  MATTER_ATTENTION_KINDS,
  MATTER_ATTENTION_STATES,
  MATTER_CHANGE_KINDS,
  MATTER_HEALTH_VALUES,
  MATTER_ITEM_KINDS,
  MATTER_ITEM_STATUSES,
  MATTER_PRIORITIES,
  MATTER_RELATION_TYPES,
  MATTER_RESOURCE_KINDS,
  MATTER_RESOURCE_SUBSCRIPTION_STATES,
  MATTER_RUN_STATUSES,
  MATTER_RUN_TRIGGERS,
  MATTER_SEARCH_FIELDS,
  MATTER_STATUSES,
  MATTER_UPDATE_REVIEW_STATUSES
} from '../../src/shared/api/types/matter'
import { qk } from '../../src/shared/lib/queryKeys'

describe('Matter TypeScript vocabulary', () => {
  test('pins every canonical array and member count', () => {
    expect(MATTER_STATUSES).toEqual(['inbox', 'planned', 'active', 'waiting', 'blocked', 'monitoring', 'done', 'canceled'])
    expect(MATTER_HEALTH_VALUES).toEqual(['unknown', 'on_track', 'at_risk', 'off_track'])
    expect(MATTER_PRIORITIES).toEqual(['p0', 'p1', 'p2', 'p3'])
    expect(MATTER_ITEM_KINDS).toEqual(['action', 'milestone', 'decision', 'blocker', 'question', 'note'])
    expect(MATTER_ITEM_STATUSES).toHaveLength(6)
    expect(MATTER_RESOURCE_KINDS).toHaveLength(6)
    expect(MATTER_RELATION_TYPES).toHaveLength(5)
    expect(MATTER_ATTENTION_KINDS).toHaveLength(7)
    expect(MATTER_ATTENTION_STATES).toHaveLength(4)
    expect(MATTER_CHANGE_KINDS).toHaveLength(5)
    expect(MATTER_RUN_STATUSES).toEqual(['ok', 'noop', 'warn', 'fail'])
    expect(MATTER_RUN_TRIGGERS).toEqual(['manual', 'schedule', 'event', 'condition'])
    expect(MATTER_ACCESS_POLICIES).toEqual(['allowed', 'metadata_only', 'excluded'])
    expect(MATTER_UPDATE_REVIEW_STATUSES).toHaveLength(4)
    expect(MATTER_ACTOR_KINDS).toEqual(['user', 'agent', 'system'])
    expect(MATTER_RESOURCE_SUBSCRIPTION_STATES).toEqual(['none', 'active', 'paused'])
    expect(MATTER_SEARCH_FIELDS).toEqual(['title', 'description', 'current_summary', 'status', 'items', 'stakeholders', 'notes'])
    expect(BUILTIN_MATTER_TYPES).toEqual(['客户交付', '商务', '售前', '问题', '内部', '产品'])
  })

  test('pins Matters query-key family', () => {
    expect(qk.matters.all()).toEqual(['matters'])
    expect(qk.matters.list()).toEqual(['matters', 'list'])
    expect(qk.matters.list('vendor')).toEqual(['matters', 'list', 'vendor'])
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

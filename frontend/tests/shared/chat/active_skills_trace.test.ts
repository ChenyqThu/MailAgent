// R7 (task 06-22) — the active-skills trace accessor the Phase 0 recorder reads (so the
// active_skills_hash is no longer console-only). Trivial set/get contract.

import { describe, expect, test } from 'vitest'

import {
  getActiveSkillsSnapshot,
  setActiveSkillsSnapshot
} from '../../../src/shared/chat/active_skills_trace'

describe('active_skills_trace accessor (R7)', () => {
  test('set → get round-trips the snapshot; last write wins', () => {
    setActiveSkillsSnapshot({ activeSkills: ['calendar', 'report'], activeSkillsHash: 'abc' })
    expect(getActiveSkillsSnapshot()).toEqual({
      activeSkills: ['calendar', 'report'],
      activeSkillsHash: 'abc'
    })
    setActiveSkillsSnapshot({ activeSkills: ['calendar'], activeSkillsHash: 'def' })
    expect(getActiveSkillsSnapshot()?.activeSkillsHash).toBe('def')
  })
})

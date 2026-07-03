// R3 (task 06-22) → S3 W2 — @mention parsing.
//
// The PER-SCOPE activation store (state/skill-activation.ts) was dropped with
// the legacy runtime (D4: the ai-sdk path never consumed activatedSkills —
// @mention is a composer-content prefix now). parseSkillMentions survives in
// skill_enablement.ts (Settings + composer mention chips still parse mentions).

import { describe, expect, test } from 'vitest'

import { parseSkillMentions } from '../../../src/shared/chat/skill_enablement'

describe('parseSkillMentions', () => {
  test('extracts @skill tokens, lowercased + deduped', () => {
    expect(parseSkillMentions('ping @calendar about @Report and @calendar again')).toEqual([
      'calendar',
      'report'
    ])
  })
  test('no mentions → []', () => {
    expect(parseSkillMentions('just a normal message')).toEqual([])
    expect(parseSkillMentions('')).toEqual([])
  })
  test('an @ mid-word (email-like) is not a mention', () => {
    // "@" must not be preceded by an identifier char — "user@example.com" must NOT match.
    expect(parseSkillMentions('mail me at user@example.com')).toEqual([])
  })
  test('matches at start and after a paren', () => {
    expect(parseSkillMentions('@email (@report)')).toEqual(['email', 'report'])
  })
  test('R3 — matches after CJK / fullwidth punctuation, not only space/paren', () => {
    expect(parseSkillMentions('请@report')).toEqual(['report'])
    expect(parseSkillMentions('日程，@calendar 一下')).toEqual(['calendar'])
  })
})

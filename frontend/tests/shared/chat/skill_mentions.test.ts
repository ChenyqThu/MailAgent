// PR7 — @mention parsing + the per-session skill activation store.

import { afterEach, describe, expect, test, vi } from 'vitest'

import { parseSkillMentions } from '../../../src/shared/chat/skill_enablement'
import {
  applySkillMentions,
  getActivatedSkillOverrides,
  useSkillActivation
} from '../../../src/shared/state/skill-activation'

afterEach(() => {
  useSkillActivation.getState().clear()
})

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
    // "@" must follow a start/space/paren — "user@example.com" must NOT match "example".
    expect(parseSkillMentions('mail me at user@example.com')).toEqual([])
  })
  test('matches at start and after a paren', () => {
    expect(parseSkillMentions('@email (@report)')).toEqual(['email', 'report'])
  })
})

describe('skill activation store', () => {
  test('activate is additive + sorted + deduped; getActivatedSkillOverrides reflects it', () => {
    useSkillActivation.getState().activate(['report'])
    useSkillActivation.getState().activate(['calendar', 'report'])
    expect(useSkillActivation.getState().activated).toEqual(['calendar', 'report'])
    expect(getActivatedSkillOverrides()).toEqual({ calendar: true, report: true })
  })
  test('deactivate removes one; clear empties', () => {
    useSkillActivation.getState().activate(['a', 'b'])
    useSkillActivation.getState().deactivate('a')
    expect(useSkillActivation.getState().activated).toEqual(['b'])
    useSkillActivation.getState().clear()
    expect(getActivatedSkillOverrides()).toEqual({})
  })
})

describe('applySkillMentions', () => {
  test('activates mentions + fires onActivated on a NEW activation', () => {
    const onActivated = vi.fn()
    applySkillMentions('please @calendar this', onActivated)
    expect(useSkillActivation.getState().activated).toEqual(['calendar'])
    expect(onActivated).toHaveBeenCalledTimes(1)
  })
  test('no mentions → no activation, no callback', () => {
    const onActivated = vi.fn()
    applySkillMentions('plain message', onActivated)
    expect(onActivated).not.toHaveBeenCalled()
  })
  test('re-mentioning an already-active skill does NOT re-fire onActivated', () => {
    applySkillMentions('@report', vi.fn())
    const onActivated = vi.fn()
    applySkillMentions('@report again', onActivated)
    expect(onActivated).not.toHaveBeenCalled() // set unchanged → no engine rebuild
  })
})

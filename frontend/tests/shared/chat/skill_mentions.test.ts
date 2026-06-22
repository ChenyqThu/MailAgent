// R3 (task 06-22) — @mention parsing + the PER-SCOPE skill activation store. The core
// fix: an activation in one conversation scope must never leak into another (two surfaces
// share one runtime), so the store is keyed by scopeKey and applySkillMentions takes one.

import { afterEach, describe, expect, test } from 'vitest'

import { parseSkillMentions } from '../../../src/shared/chat/skill_enablement'
import {
  applySkillMentions,
  getActivatedSkillNames,
  useSkillActivation
} from '../../../src/shared/state/skill-activation'

const A = 'email:1:custom-api'
const B = 'email:2:custom-api'
const G = 'general:7'

afterEach(() => {
  useSkillActivation.setState({ byScope: {} })
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

describe('per-scope activation store (R3)', () => {
  test('activate is per-scope, additive, sorted, deduped', () => {
    useSkillActivation.getState().activate(A, ['report'])
    useSkillActivation.getState().activate(A, ['calendar', 'report'])
    expect(getActivatedSkillNames(A)).toEqual(['calendar', 'report'])
    expect(getActivatedSkillNames(B)).toEqual([]) // a different scope is untouched
  })
  test('deactivate removes one from its scope only', () => {
    useSkillActivation.getState().activate(A, ['a', 'b'])
    useSkillActivation.getState().activate(B, ['a'])
    useSkillActivation.getState().deactivate(A, 'a')
    expect(getActivatedSkillNames(A)).toEqual(['b'])
    expect(getActivatedSkillNames(B)).toEqual(['a']) // B unaffected
  })
  test('clearScope empties only that scope', () => {
    useSkillActivation.getState().activate(A, ['x'])
    useSkillActivation.getState().activate(G, ['y'])
    useSkillActivation.getState().clearScope(A)
    expect(getActivatedSkillNames(A)).toEqual([])
    expect(getActivatedSkillNames(G)).toEqual(['y'])
  })
})

describe('applySkillMentions (R3)', () => {
  test('activates mentions into the given scope + returns that scope list', () => {
    const out = applySkillMentions(A, 'please @calendar this')
    expect(out).toEqual(['calendar'])
    expect(getActivatedSkillNames(A)).toEqual(['calendar'])
  })
  test('a mention in scope A does NOT leak into scope B (the core R3 fix)', () => {
    applySkillMentions(A, '@report') // general session / other email never sees it
    expect(getActivatedSkillNames(B)).toEqual([])
    expect(getActivatedSkillNames(G)).toEqual([])
    // applying a no-mention message in B returns B's own (empty) list
    expect(applySkillMentions(B, 'plain message')).toEqual([])
  })
  test('re-applying with no new mention returns the scope’s existing list unchanged', () => {
    applySkillMentions(A, '@calendar')
    expect(applySkillMentions(A, 'plain follow-up')).toEqual(['calendar'])
  })
})

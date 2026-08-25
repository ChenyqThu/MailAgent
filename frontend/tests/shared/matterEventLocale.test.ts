import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import zh from '../../src/shared/i18n/locales/zh-CN/common.json'
import en from '../../src/shared/i18n/locales/en-US/common.json'
import {
  MATTER_CONDITION_TRIGGER_TYPES,
  MATTER_EVENT_TRIGGER_TYPES,
  MATTER_PROGRESS_KINDS
} from '@shared/api/types/matter'

/**
 * 跨语言闸：`matters.events.*` 必须覆盖 Python 侧 `MATTER_EVENT_KINDS` 的全集。
 *
 * 这个子树曾经在中英两份 locale 里**都是空对象**，而详情页时间线每条都在查它 ⇒ 所有
 * 事件名直出英文标识符。补齐一次不够 —— kind 数量会随功能增长（P6-A 加了两个资料建议
 * 事件，P6-B 的 trigger 扩展还会再加），所以判据必须是「从 events.py 抽全集比对」，
 * 而不是照某个写死的数字去补。
 */

const ROOT = resolve(__dirname, '../../..')
const EVENTS_PY = resolve(ROOT, 'src/matters/events.py')
const EVENT_CHANGES_PY = resolve(ROOT, 'src/matters/event_changes.py')

function pythonEventKinds(): string[] {
  const source = readFileSync(EVENTS_PY, 'utf-8')
  const block = source.match(/MATTER_EVENT_KINDS\s*(?::[^=]+)?=\s*\(([\s\S]*?)\)/)
  if (!block) throw new Error('MATTER_EVENT_KINDS tuple not found in events.py')
  // 元组里是常量引用（MATTER_CREATED, …），要顺着常量定义取字面量值。
  const constants = new Map<string, string>()
  for (const [, name, value] of source.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*"([a-z0-9_]+)"$/gm)) {
    constants.set(name, value)
  }
  const kinds: string[] = []
  for (const [, name] of block[1].matchAll(/([A-Z][A-Z0-9_]*)/g)) {
    const value = constants.get(name)
    if (value) kinds.push(value)
  }
  return kinds
}

/** `matter_updated` 事件的 `fields` 值域（Python `event_changes.MATTER_CHANGE_FIELDS`）。
 *  时间线与提案评审都拿它当 i18n key 查 `matters.eventField.*`，缺一条就直出裸标识符。 */
function pythonMatterChangeFields(): string[] {
  const source = readFileSync(EVENT_CHANGES_PY, 'utf-8')
  const block = source.match(/MATTER_CHANGE_FIELDS\s*=\s*frozenset\(\s*\{([\s\S]*?)\}\s*\)/)
  if (!block) throw new Error('MATTER_CHANGE_FIELDS frozenset not found in event_changes.py')
  return [...block[1].matchAll(/"([a-z0-9_]+)"/g)].map(([, name]) => name)
}

describe('matter event locale coverage', () => {
  const kinds = pythonEventKinds()

  it('extractor actually found the canonical kinds', () => {
    // 🔴 抽取器抽不到就必须红：抽到空集时下面每条断言都会"通过"，
    // 那是最坏的失效形态 —— 闸看起来是绿的，实际什么都没校验。
    expect(kinds.length).toBeGreaterThan(30)
    expect(kinds).toContain('matter_created')
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it.each([
    ['zh-CN', zh],
    ['en-US', en]
  ])('%s covers every event kind', (_locale, bundle) => {
    const events = (bundle as { matters: { events: Record<string, string> } }).matters.events
    const missing = kinds.filter((kind) => !events[kind]?.trim())
    expect(missing).toEqual([])
  })

  it.each([
    ['zh-CN', zh],
    ['en-US', en]
  ])('%s covers every actor kind', (_locale, bundle) => {
    const actors = (bundle as { matters: { eventActor: Record<string, string> } }).matters
      .eventActor
    for (const kind of ['user', 'agent', 'system']) {
      expect(actors[kind]?.trim()).toBeTruthy()
    }
  })

  describe('matters.eventField covers every changeable field', () => {
    const fields = pythonMatterChangeFields()

    it('extractor actually found the canonical fields', () => {
      // 🔴 抽不到就必须红：空集会让下面的断言全"通过"。
      expect(fields.length).toBeGreaterThan(10)
      expect(fields).toContain('background')
      expect(fields).toContain('goal')
      expect(new Set(fields).size).toBe(fields.length)
    })

    it.each([
      ['zh-CN', zh],
      ['en-US', en]
    ])('%s labels every field', (_locale, bundle) => {
      const labels = (bundle as { matters: { eventField: Record<string, string> } }).matters
        .eventField
      expect(fields.filter((field) => !labels[field]?.trim())).toEqual([])
    })

    it.each([
      ['zh-CN', zh],
      ['en-US', en]
    ])('%s still labels the retired v61 `description` field', (_locale, bundle) => {
      // 🔴 v61 把 matter.description 拆成 background + goal，但**升级前写下的事件行**
      // 里 field 仍是 'description'。删掉这条 key = 老时间线那几行直出裸英文标识符。
      const labels = (bundle as { matters: { eventField: Record<string, string> } }).matters
        .eventField
      expect(labels.description?.trim()).toBeTruthy()
    })
  })

  /**
   * 跟进规则编辑器把 `MATTER_EVENT_TRIGGER_TYPES` / `MATTER_CONDITION_TRIGGER_TYPES`
   * 逐项拿去查 `matters.trigger.event.*` / `matters.trigger.condition.*`（`MatterTriggerEditor`
   * 的下拉项）。词表本身有 Python↔TS 的 parity 闸，但 locale 是**第三份手抄** —— 少一条
   * key，下拉里就直出裸标识符（i18next 的 key 回落），而两侧词表仍然一致、闸全绿。
   */
  describe('matters.trigger.* labels every trigger option', () => {
    it.each([
      ['zh-CN', zh],
      ['en-US', en]
    ])('%s covers every event / condition trigger type', (_locale, bundle) => {
      const trigger = (
        bundle as {
          matters: { trigger: { event: Record<string, string>; condition: Record<string, string> } }
        }
      ).matters.trigger
      expect(MATTER_EVENT_TRIGGER_TYPES.filter((type) => !trigger.event[type]?.trim())).toEqual([])
      expect(
        MATTER_CONDITION_TRIGGER_TYPES.filter((type) => !trigger.condition[type]?.trim())
      ).toEqual([])
    })
  })

  /**
   * curated 进展的五类（task 08-25）是 locale 的**第三份手抄**：词表本身两侧有 pytest 的
   * parity 闸，但少一条 `matters.progress.kind.*` 的 key，进展 tab 的 kind picker 与行尾
   * 标签就直出裸标识符（i18next 的 key 回落），而两侧词表仍然一致、闸全绿。
   */
  describe('matters.progress.kind.* labels every curated progress kind', () => {
    it.each([
      ['zh-CN', zh],
      ['en-US', en]
    ])('%s covers every progress kind', (_locale, bundle) => {
      const labels = (bundle as { matters: { progress: { kind: Record<string, string> } } }).matters
        .progress.kind
      expect(MATTER_PROGRESS_KINDS.filter((kind) => !labels[kind]?.trim())).toEqual([])
    })
  })

  it('both locales expose the same event keys', () => {
    const zhKeys = Object.keys((zh as { matters: { events: object } }).matters.events).sort()
    const enKeys = Object.keys((en as { matters: { events: object } }).matters.events).sort()
    expect(zhKeys).toEqual(enKeys)
  })
})

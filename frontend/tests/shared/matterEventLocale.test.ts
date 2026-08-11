import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import zh from '../../src/shared/i18n/locales/zh-CN/common.json'
import en from '../../src/shared/i18n/locales/en-US/common.json'

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

  it('both locales expose the same event keys', () => {
    const zhKeys = Object.keys((zh as { matters: { events: object } }).matters.events).sort()
    const enKeys = Object.keys((en as { matters: { events: object } }).matters.events).sort()
    expect(zhKeys).toEqual(enKeys)
  })
})

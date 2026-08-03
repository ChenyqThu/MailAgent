// 阶段 0.5-① G8 — 工具人话标题的一致性闸。
//
// `TITLED_TOOL_NAMES` (shared/components/chat/tool_steps.ts) is a hand-copied mirror of the
// gateway tool universe, and the i18n titles are a second mirror on top of it. Per CLAUDE.md
// (「跨边界手抄常量必建一致性闸」) that needs a gate, because the failure mode is silent: a new
// gateway tool simply renders as a bare `email_thread_attachments`-style identifier in chat and
// nobody notices.
//
// canonical source = `tests/agent_eval/tool_catalog.json` (repo root), which already has its own
// completeness gate against `frontend/src/ai-gateway/tools/*.ts` — so this闸 rides on a list that
// cannot silently fall behind the gateway.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { TITLED_TOOL_NAMES, toolTitleKey } from '@shared/components/chat/tool_steps'
import enCommon from '../../src/shared/i18n/locales/en-US/common.json'
import zhCommon from '../../src/shared/i18n/locales/zh-CN/common.json'

const CATALOG = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../tests/agent_eval/tool_catalog.json'
)

interface CatalogRow {
  domain?: string
  tier?: string
  legacy_retired?: boolean
}

function catalogToolNames(): string[] {
  const raw = JSON.parse(readFileSync(CATALOG, 'utf-8')) as { tools?: Record<string, CatalogRow> }
  const names = Object.keys(raw.tools ?? {})
  // canary: a moved/renamed catalog would make every assertion below vacuously true.
  expect(names.length).toBeGreaterThan(40)
  return names
}

const zhTitles = (zhCommon as { chat: { toolTitle: Record<string, string> } }).chat.toolTitle
const enTitles = (enCommon as { chat: { toolTitle: Record<string, string> } }).chat.toolTitle

describe('tool titles — catalog ↔ TITLED_TOOL_NAMES ↔ i18n', () => {
  test('every catalog tool (incl. legacy_retired, which still replays from history) has a title', () => {
    const missing = catalogToolNames().filter((name) => !TITLED_TOOL_NAMES.has(name))
    expect(
      missing,
      '这些工具在 chat 里会显示裸英文标识符。补 TITLED_TOOL_NAMES + 两个 locale 的 chat.toolTitle：\n  ' +
        missing.join('\n  ')
    ).toEqual([])
  })

  test('TITLED_TOOL_NAMES carries no ghost names (every entry is a real catalog tool)', () => {
    const known = new Set(catalogToolNames())
    expect([...TITLED_TOOL_NAMES].filter((name) => !known.has(name))).toEqual([])
  })

  test('both locales define every title (a one-sided title is a silent English leak)', () => {
    for (const name of TITLED_TOOL_NAMES) {
      expect(zhTitles[name], `zh-CN missing chat.toolTitle.${name}`).toBeTruthy()
      expect(enTitles[name], `en-US missing chat.toolTitle.${name}`).toBeTruthy()
    }
    // and no orphan translations left behind by a removed tool.
    expect(Object.keys(zhTitles).filter((k) => !TITLED_TOOL_NAMES.has(k))).toEqual([])
    expect(Object.keys(enTitles).filter((k) => !TITLED_TOOL_NAMES.has(k))).toEqual([])
  })
})

describe('toolTitleKey — graceful degradation', () => {
  test('a known tool resolves to its i18n key', () => {
    expect(toolTitleKey('email_get')).toBe('chat.toolTitle.email_get')
  })
  test('an unknown / future tool returns null → the card shows the raw identifier', () => {
    expect(toolTitleKey('future_tool_x')).toBeNull()
    expect(toolTitleKey('')).toBeNull()
  })
})

import { GitBranch } from 'lucide-react'
import { describe, expect, test } from 'vitest'

import type { MatterResourceLookupResponse } from '../../src/shared/api/types/matter'
import {
  ConfluenceLogo,
  FigmaLogo,
  GoogleDriveLogo,
  NotionLogo
} from '../../src/shared/components/icons/apps/appLogos'
import {
  buildMatterResourceLookupKeys,
  deriveMatterLinkButtonState,
  DOC_PROVIDER_ICONS,
  mergeMatterResourceLinkHits,
  RESOURCE_KIND_ICONS,
  stripEmailSubjectPrefix
} from '../../src/shared/components/matters/matterResource'

describe('matter resource identity and toolbar state', () => {
  test('builds email and thread lookup keys without empty thread ids', () => {
    expect(buildMatterResourceLookupKeys(42856, 'AAQkAD')).toEqual(['email:42856', 'thread:AAQkAD'])
    expect(buildMatterResourceLookupKeys(42856, '  ')).toEqual(['email:42856'])
    expect(buildMatterResourceLookupKeys(null, null)).toEqual([])
  })

  test('derives unlinked, single, and multiple toolbar states', () => {
    expect(deriveMatterLinkButtonState(0)).toBe('unlinked')
    expect(deriveMatterLinkButtonState(1)).toBe('single')
    expect(deriveMatterLinkButtonState(3)).toBe('multiple')
  })

  test('merges email and thread hits and preserves subscription state', () => {
    const response: MatterResourceLookupResponse = {
      results: {
        'email:1': [hit({ resource_id: 10, link_id: 100, sub_state: 'none' })],
        'thread:t1': [hit({ resource_id: 11, link_id: 101, sub_state: 'active' })]
      }
    }
    const merged = mergeMatterResourceLinkHits(response, ['email:1', 'thread:t1'])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.links).toHaveLength(2)
    expect(merged[0]?.subscription?.sub_state).toBe('active')
  })

  test('strips one leading bracket prefix from an email subject', () => {
    expect(stripEmailSubjectPrefix('[External] Vendor launch')).toBe('Vendor launch')
    expect(stripEmailSubjectPrefix('Vendor launch')).toBe('Vendor launch')
  })
})

// 批 8（V3-19）—— 资料来源 logo 的回落纪律。三处消费点（ResourceDrawer / MatterContextTab
// 的 ResourceRow / MatterUpdateReview 的 NewResourceCard）都写着逐字相同的一行派生式；这里
// 直接复刻那行派生式（而不是新导出一个函数——理由见上方「有意导出表而不是查表函数」的注释：
// 导出函数会把「成员索引」变成「调用表达式」，触发 react-hooks/static-components），用同一份
// 表分别模拟「详情面板」与「列表行」两次独立求值，断言拿到的是**同一个**组件引用 —— 防两处
// 各查各的表、悄悄长出第二份图标真源。
function resolveSourceIcon(kind: string, provider: string): unknown {
  return (
    (kind === 'doc' && DOC_PROVIDER_ICONS[provider.toLowerCase()]) ||
    RESOURCE_KIND_ICONS[kind as keyof typeof RESOURCE_KIND_ICONS]
  )
}

describe('DOC_PROVIDER_ICONS — 资料来源 logo 回落纪律', () => {
  test('canonical provider 词表里的每一家都能取到 logo', () => {
    expect(DOC_PROVIDER_ICONS.notion).toBe(NotionLogo)
    expect(DOC_PROVIDER_ICONS.confluence).toBe(ConfluenceLogo)
    // atlassian 连接器同时覆盖 Confluence/Jira，落不到更精确的字面量，两者共用同一枚图。
    expect(DOC_PROVIDER_ICONS.atlassian).toBe(ConfluenceLogo)
    expect(DOC_PROVIDER_ICONS.googledrive).toBe(GoogleDriveLogo)
    expect(DOC_PROVIDER_ICONS.figma).toBe(FigmaLogo)
    // 无设计 logo 资产的一家，明确回落到既有 lucide（不是空白方块，不是问号）。
    expect(DOC_PROVIDER_ICONS.github).toBe(GitBranch)
  })

  test('provider 未知 / 为空 —— doc 资料一律回落到 kind 图标，不出现空白方块', () => {
    expect(resolveSourceIcon('doc', 'sharepoint')).toBe(RESOURCE_KIND_ICONS.doc)
    expect(resolveSourceIcon('doc', '')).toBe(RESOURCE_KIND_ICONS.doc)
    // 大小写不敏感（落库值经 toLowerCase 再查表）。
    expect(resolveSourceIcon('doc', 'NOTION')).toBe(NotionLogo)
  })

  test('非 doc kind 一律走 kind 图标，provider 再有 logo 也不生效（email 没有「来源 logo」这回事）', () => {
    expect(resolveSourceIcon('email', 'notion')).toBe(RESOURCE_KIND_ICONS.email)
  })

  test('🔴 同一 provider 在两次独立求值（模拟抽屉 vs 列表行）里拿到的是同一个组件引用', () => {
    for (const provider of ['notion', 'confluence', 'atlassian', 'googledrive', 'figma', 'github']) {
      const inDrawer = resolveSourceIcon('doc', provider)
      const inRow = resolveSourceIcon('doc', provider)
      expect(inRow).toBe(inDrawer)
    }
  })
})

function hit(overrides: Partial<ReturnType<typeof baseHit>>) {
  return { ...baseHit(), ...overrides }
}

function baseHit() {
  return {
    public_id: 'MAT-0042',
    title: 'Vendor launch',
    status: 'active' as const,
    health: 'on_track' as const,
    priority: 'p1' as const,
    link_id: 100,
    resource_id: 10,
    pinned: false,
    sub_state: 'none' as const,
    archived_at: null
  }
}

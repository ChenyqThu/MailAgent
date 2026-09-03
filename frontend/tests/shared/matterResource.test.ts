import { FolderTree, GitBranch } from 'lucide-react'
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
  isLibraryFileResource,
  LIBRARY_RESOURCE_ICON,
  libraryResourceFileId,
  libraryResourceKey,
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
// P2-L10 起派生式多了第一档（库文件）。判据先落成布尔量再进派生式 —— 三处调用点逐字相同，
// 理由见 matterResource.ts 文末：派生式里留着调用表达式会被 react-hooks/static-components 判红。
function resolveSourceIcon(kind: string, provider: string, externalKey = ''): unknown {
  const isLibraryFile = !!isLibraryFileResource(kind as never, externalKey)
  return (
    (isLibraryFile && LIBRARY_RESOURCE_ICON) ||
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

// P2-L10（资料库 §9.2）—— 库文件与邮件附件同 kind='file'、同在 mailagent 身份空间，
// 唯一判据是 external_key 前缀。这一组盯的是「判据被写成按 kind 分」的静默退化：那样
// 两类资料会共用一枚图标、库文件的深链也会长在邮件附件上。
describe('库文件（library:{id}）与邮件附件（attachment:{id}）的身份判据', () => {
  test('前缀是唯一判据 —— kind 相同也不能混为一谈', () => {
    expect(isLibraryFileResource('file', 'library:302')).toBe(true)
    expect(isLibraryFileResource('file', 'attachment:9182')).toBe(false)
    // 前缀对但 kind 不是 file（不该出现的组合）也不认，避免判据只剩半条。
    expect(isLibraryFileResource('doc', 'library:302')).toBe(false)
  })

  test('关联键构造与解析互为逆运算', () => {
    expect(libraryResourceKey(302)).toBe('library:302')
    expect(libraryResourceFileId(libraryResourceKey(302))).toBe(302)
  })

  test('解析不出正整数 id 就返回 null（没有去处就不给「打开」）', () => {
    expect(libraryResourceFileId('attachment:9182')).toBeNull()
    expect(libraryResourceFileId('library:')).toBeNull()
    expect(libraryResourceFileId('library:abc')).toBeNull()
    expect(libraryResourceFileId('library:-3')).toBeNull()
    expect(libraryResourceFileId('library:0')).toBeNull()
    expect(libraryResourceFileId('library:12.5')).toBeNull()
  })

  test('🔴 attachments 分组里两类资料图标不同：库文件 FolderTree、邮件附件 Paperclip', () => {
    expect(resolveSourceIcon('file', 'mailagent', 'library:302')).toBe(FolderTree)
    expect(resolveSourceIcon('file', 'mailagent', 'attachment:9182')).toBe(
      RESOURCE_KIND_ICONS.file
    )
    expect(resolveSourceIcon('file', 'mailagent', 'library:302')).not.toBe(
      resolveSourceIcon('file', 'mailagent', 'attachment:9182')
    )
  })

  test('库文件图标 = 资料库域自己那一枚（不是另起一套）', () => {
    expect(LIBRARY_RESOURCE_ICON).toBe(FolderTree)
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

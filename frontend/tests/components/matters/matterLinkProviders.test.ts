// G-14 tab ② —— provider 识别与**连接态判定**的纯逻辑闸。
//
// 这里最要紧的一条不是「Notion 域名认得出来」，而是：**任何拿不准的情况都不许说「已连接」**。
// 设计原型那份 `PROVIDERS` 表把 conn 写死成常量，照抄过来就会在闸关 / 没连 / 数据还没回来时
// 渲染出一句假的「已连接 Notion」。

import { FileText, GitBranch, Globe } from 'lucide-react'
import { describe, expect, test } from 'vitest'

import {
  ConfluenceLogo,
  FigmaLogo,
  GoogleDriveLogo,
  JiraLogo,
  NotionLogo
} from '@shared/components/icons/apps/appLogos'
import {
  detectMatterLinkProvider,
  deriveMatterLinkTitle,
  isMatterLinkUrlish,
  MATTER_LINK_PROVIDERS,
  matterLinkConnectionState,
  normalizeMatterLinkUrl
} from '@shared/components/matters/matterLinkProviders'

const connectedNotion = [{ connector_id: 'notion', enabled: true, status: 'connected' }]

describe('detectMatterLinkProvider', () => {
  test('按域名识别，认不出的一律落到「网页」而不是报错', () => {
    expect(detectMatterLinkProvider('https://www.notion.so/team/spec-a91f28').key).toBe('notion')
    expect(detectMatterLinkProvider('https://docs.google.com/document/d/1kQ7/edit').key).toBe(
      'googleDocs'
    )
    expect(detectMatterLinkProvider('https://www.figma.com/file/abc').key).toBe('figma')
    expect(detectMatterLinkProvider('https://example.com/whatever').key).toBe('web')
    expect(detectMatterLinkProvider('not a url at all').key).toBe('web')
  })

  test('Jira 与 Confluence 同域，按路径分', () => {
    expect(detectMatterLinkProvider('https://ourco.atlassian.net/wiki/spaces/DEV/x').key).toBe(
      'confluence'
    )
    expect(detectMatterLinkProvider('https://ourco.atlassian.net/browse/ABC-1').key).toBe('jira')
  })

  test('飞书认得出来，但它没有 connector —— connectorId 恒 null', () => {
    const provider = detectMatterLinkProvider('https://ourco.feishu.cn/docx/abc')
    expect(provider.key).toBe('feishu')
    expect(provider.connectorId).toBeNull()
  })
})

describe('isMatterLinkUrlish / normalize / title', () => {
  test('裸域名算链接（用户粘贴常丢协议），纯文本不算', () => {
    expect(isMatterLinkUrlish('notion.so/team/spec')).toBe(true)
    expect(isMatterLinkUrlish('https://example.com')).toBe(true)
    expect(isMatterLinkUrlish('随手写的一句话')).toBe(false)
    expect(isMatterLinkUrlish('')).toBe(false)
  })

  test('规范化补协议、去 hash', () => {
    expect(normalizeMatterLinkUrl('notion.so/spec#block-1')).toBe('https://notion.so/spec')
  })

  test('标题从末段路径推，推不出用主机名', () => {
    expect(deriveMatterLinkTitle('https://www.notion.so/team/data-export-a91f28c4e7b1')).toBe(
      'data export'
    )
    expect(deriveMatterLinkTitle('https://example.com/')).toBe('example.com')
  })
})

describe('matterLinkConnectionState', () => {
  test('🔴 闸未知 / 闸关 / 行未回来 —— 一律 unknown，绝不说「已连接」也不说「未连接」', () => {
    const base = { connectorId: 'notion', rows: connectedNotion, rowsLoaded: true }
    expect(matterLinkConnectionState({ ...base, flagEnabled: undefined })).toBe('unknown')
    expect(matterLinkConnectionState({ ...base, flagEnabled: false })).toBe('unknown')
    expect(matterLinkConnectionState({ ...base, flagEnabled: true, rowsLoaded: false })).toBe(
      'unknown'
    )
  })

  test('没有对应 connector 的 provider（网页 / 飞书）恒 unknown', () => {
    expect(
      matterLinkConnectionState({
        connectorId: null,
        flagEnabled: true,
        rowsLoaded: true,
        rows: connectedNotion
      })
    ).toBe('unknown')
  })

  test('闸开 + 行已回来：connected 要求 enabled 且 status=connected', () => {
    const base = { connectorId: 'notion', flagEnabled: true, rowsLoaded: true }
    expect(matterLinkConnectionState({ ...base, rows: connectedNotion })).toBe('connected')
    expect(
      matterLinkConnectionState({
        ...base,
        rows: [{ connector_id: 'notion', enabled: false, status: 'connected' }]
      })
    ).toBe('disconnected')
    expect(
      matterLinkConnectionState({
        ...base,
        rows: [{ connector_id: 'notion', enabled: true, status: 'needs_reauth' }]
      })
    ).toBe('disconnected')
    // 一行都没有 = 从来没连过，这个否定是确定的。
    expect(matterLinkConnectionState({ ...base, rows: [] })).toBe('disconnected')
  })
})

// 批 8（V3-19）—— canonical provider 词表的 logo 回落纪律：5 家有真实品牌 logo，其余 3 家
// （feishu/github/web）设计交付没有对应资产，维持中性 lucide 图标，不是漏做。
describe('MATTER_LINK_PROVIDERS — 来源 logo 回落纪律', () => {
  function iconOf(key: string): unknown {
    return MATTER_LINK_PROVIDERS.find((entry) => entry.key === key)?.icon
  }

  test('5 家有品牌 logo 的 provider 取到对应 logo 组件', () => {
    expect(iconOf('notion')).toBe(NotionLogo)
    expect(iconOf('confluence')).toBe(ConfluenceLogo)
    expect(iconOf('jira')).toBe(JiraLogo)
    expect(iconOf('figma')).toBe(FigmaLogo)
    expect(iconOf('googleDocs')).toBe(GoogleDriveLogo)
  })

  test('无设计 logo 资产的 3 家明确回落到既有 lucide 中性图标，不是空白方块', () => {
    expect(iconOf('feishu')).toBe(FileText)
    expect(iconOf('github')).toBe(GitBranch)
    expect(iconOf('web')).toBe(Globe)
  })

  test('确认与 Confluence 同枚 logo：atlassian 连接器同时覆盖 Confluence/Jira，Jira 单独用自己的标', () => {
    expect(iconOf('confluence')).not.toBe(iconOf('jira'))
    expect(iconOf('jira')).toBe(JiraLogo)
  })
})

/**
 * Synthetic data for LibraryMock (the Library domain). Every company, person
 * and file here is fictional. Interface strings that exist in the product are
 * copied verbatim from frontend/src/shared/i18n/locales/{zh-CN,en-US}/common.json
 * (`library.tree.roots.*`, `library.search.match*`, `library.mount.ro`,
 * `library.preview.relatedMatters`).
 */

export type LibRootId = 'mail-attachments' | 'chat-attachments' | 'agent-docs' | 'my-docs' | 'mounts' | 'trash'

/** One visible row of the tree, pre-flattened (depth drives the indent). */
export interface LibTreeRow {
  label: string
  kind: 'root' | 'folder' | 'file' | 'mount'
  depth: number
  root?: LibRootId
  count?: number
  open?: boolean
  selected?: boolean
  /** Small pip after the label (the mounted folder's permission). */
  badge?: string
}

export type LibMatch = 'fts' | 'vec'

/** Snippet run: plain text, or a highlighted keyword hit. */
export type LibRun = string | { mark: string }

export interface LibResult {
  name: string
  kind: 'sheet' | 'md' | 'pdf'
  snippet: LibRun[]
  match: LibMatch[]
  selected?: boolean
}

export type LibDocBlock =
  | { t: 'h1'; text: string }
  | { t: 'meta'; text: string }
  | { t: 'h2'; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; items: string[] }

export interface LibraryMockData {
  chrome: {
    title: string
    addFolder: string
    query: string
    resultCount: string
    match: Record<LibMatch, string>
    kind: string
    writtenBy: string
    version: string
    updated: string
    relatedLabel: string
    related: string
  }
  tree: LibTreeRow[]
  results: LibResult[]
  doc: { name: string; blocks: LibDocBlock[] }
}

export const libraryMock: Record<'zh-CN' | 'en', LibraryMockData> = {
  'zh-CN': {
    chrome: {
      title: '资料库',
      addFolder: '添加文件夹',
      query: '渠道伙伴 报价',
      resultCount: '3 个结果',
      match: { fts: '关键词', vec: '语义' },
      kind: 'Markdown',
      writtenBy: '由 会前准备 Agent 写入',
      version: '版本 3',
      updated: '昨天 10:02',
      relatedLabel: '关联的事项',
      related: 'Northwind 续约',
    },
    tree: [
      { label: '邮件附件', kind: 'root', root: 'mail-attachments', depth: 0, count: 312 },
      { label: '对话附件', kind: 'root', root: 'chat-attachments', depth: 0, count: 18 },
      { label: 'Agents 文档', kind: 'root', root: 'agent-docs', depth: 0, open: true },
      { label: '会前准备', kind: 'folder', depth: 1, open: true },
      { label: '会前准备 · Northwind 周会.md', kind: 'file', depth: 2, selected: true },
      { label: '会前准备 · Contoso 季度复盘.md', kind: 'file', depth: 2 },
      { label: '周报草稿', kind: 'folder', depth: 1 },
      { label: '我的文档', kind: 'root', root: 'my-docs', depth: 0, count: 46 },
      { label: '挂载的文件夹', kind: 'root', root: 'mounts', depth: 0, open: true },
      { label: '@渠道资料', kind: 'mount', depth: 1, badge: '只读' },
      { label: '废纸篓', kind: 'root', root: 'trash', depth: 0, count: 3 },
    ],
    results: [
      {
        name: '渠道伙伴报价单 2026 Q4.xlsx',
        kind: 'sheet',
        snippet: ['阶梯', { mark: '报价' }, '：', { mark: '渠道伙伴' }, ' 100 席以上八折，续约另议'],
        match: ['fts', 'vec'],
      },
      {
        name: '会前准备 · Northwind 周会.md',
        kind: 'md',
        snippet: ['上周来信要求按新的伙伴折扣档位重新核算'],
        match: ['vec'],
        selected: true,
      },
      {
        name: '伙伴计划说明 2026.pdf',
        kind: 'pdf',
        snippet: [{ mark: '渠道伙伴' }, '分级与', { mark: '报价' }, '规则，第 4 页起'],
        match: ['fts'],
      },
    ],
    doc: {
      name: '会前准备 · Northwind 周会.md',
      blocks: [
        { t: 'h1', text: 'Northwind 周会 · 会前准备' },
        { t: 'meta', text: '9月22日 周二 10:00 · Maya Lin、Daniel Cho' },
        { t: 'h2', text: '上次留下的问题' },
        {
          t: 'ul',
          items: [
            '结算 API v2 迁移：对方要在 10 月 15 日前拿到切换窗口',
            '伙伴折扣：上周来信要求按新档位重新核算',
          ],
        },
        { t: 'h2', text: '这次要带的材料' },
        {
          t: 'ol',
          items: ['渠道伙伴报价单 2026 Q4.xlsx', 'SLA 条款修订稿（第 3 版）', 'Q4 网关切换评审议程'],
        },
      ],
    },
  },
  en: {
    chrome: {
      title: 'Library',
      addFolder: 'Add folder',
      query: 'channel partner pricing',
      resultCount: '3 results',
      match: { fts: 'Keyword', vec: 'Semantic' },
      kind: 'Markdown',
      writtenBy: 'Written by the Meeting prep agent',
      version: 'Version 3',
      updated: 'Yesterday 10:02',
      relatedLabel: 'Linked matters',
      related: 'Northwind renewal',
    },
    tree: [
      { label: 'Mail attachments', kind: 'root', root: 'mail-attachments', depth: 0, count: 312 },
      { label: 'Chat attachments', kind: 'root', root: 'chat-attachments', depth: 0, count: 18 },
      { label: 'Agent docs', kind: 'root', root: 'agent-docs', depth: 0, open: true },
      { label: 'Meeting prep', kind: 'folder', depth: 1, open: true },
      { label: 'Meeting prep · Northwind weekly.md', kind: 'file', depth: 2, selected: true },
      { label: 'Meeting prep · Contoso quarterly.md', kind: 'file', depth: 2 },
      { label: 'Weekly drafts', kind: 'folder', depth: 1 },
      { label: 'My docs', kind: 'root', root: 'my-docs', depth: 0, count: 46 },
      { label: 'Mounted folders', kind: 'root', root: 'mounts', depth: 0, open: true },
      { label: '@channel-docs', kind: 'mount', depth: 1, badge: 'Read-only' },
      { label: 'Trash', kind: 'root', root: 'trash', depth: 0, count: 3 },
    ],
    results: [
      {
        name: 'Channel partner price list 2026 Q4.xlsx',
        kind: 'sheet',
        snippet: ['Tiered ', { mark: 'channel partner' }, ' ', { mark: 'pricing' }, ': 20% off above 100 seats'],
        match: ['fts', 'vec'],
      },
      {
        name: 'Meeting prep · Northwind weekly.md',
        kind: 'md',
        snippet: ['Last week they asked us to recalculate against the new reseller discount tiers'],
        match: ['vec'],
        selected: true,
      },
      {
        name: 'Partner program guide 2026.pdf',
        kind: 'pdf',
        snippet: [{ mark: 'Channel partner' }, ' tiers and ', { mark: 'pricing' }, ' rules, from page 4'],
        match: ['fts'],
      },
    ],
    doc: {
      name: 'Meeting prep · Northwind weekly.md',
      blocks: [
        { t: 'h1', text: 'Northwind weekly · meeting prep' },
        { t: 'meta', text: 'Tue, Sep 22 · 10:00 · Maya Lin, Daniel Cho' },
        { t: 'h2', text: 'Open from last time' },
        {
          t: 'ul',
          items: [
            'Settlement API v2 migration: they want a cutover window by Oct 15',
            'Partner discount: last week they asked for a recalculation against the new tiers',
          ],
        },
        { t: 'h2', text: 'Materials to bring' },
        {
          t: 'ol',
          items: [
            'Channel partner price list 2026 Q4.xlsx',
            'Revised SLA terms (v3)',
            'Q4 gateway cutover review agenda',
          ],
        },
      ],
    },
  },
}

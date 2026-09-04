// 报告 → Markdown 序列化器（`reportMarkdown.ts`）的逐块闸。
//
// 为什么值得逐块测：导出漏掉一种块 = 用户存下来的那份报告**静默少一段**，界面上看不出来
// （界面读的是原 doc，不是导出件）。所以 19 种块每种一条断言，外加两条兜底：没见过的块
// 不许抛、空 doc 不许炸。
//
// 断言盯的是「这块的内容进没进去 + 用了哪种 markdown 形态」，不逐字符锁排版 —— 锁死整段
// 输出会让任何一次措辞微调都变成红，而那不是缺陷。

import { describe, expect, test } from 'vitest'

import type { ReportBlock, ReportDoc } from '@shared/api/types'
import {
  nextFilenameCandidate,
  reportBlockToMarkdown,
  reportDocToMarkdown,
  reportExportFilename,
  sanitizeFilenamePart
} from '@shared/components/agents/reportMarkdown'

const md = (block: unknown): string => reportBlockToMarkdown(block as ReportBlock)

describe('19 种块各自的 markdown 形态', () => {
  test('header → h1 + 斜体日期标签 + 副标题', () => {
    const out = md({
      type: 'header',
      title: '今日邮件',
      subtitle: '19 封待处理',
      date_label: '2026-09-03 周四'
    })
    expect(out).toContain('# 今日邮件')
    expect(out).toContain('_2026-09-03 周四_')
    expect(out).toContain('19 封待处理')
  })

  test('overview → 原样一段（正文本身就是 markdown-lite）', () => {
    expect(md({ type: 'overview', text: '今天 **3 封**需要今天回。' })).toBe(
      '今天 **3 封**需要今天回。'
    )
  })

  test('stat_row → 一行 chip 串（不是表格）', () => {
    const out = md({
      type: 'stat_row',
      stats: [
        { key: 'total', label: '总计', value: 19, tone: 'neutral' },
        { key: 'urgent', label: '紧急', value: 3, tone: 'critical' }
      ]
    })
    expect(out).toBe('**19** 总计 · **3** 紧急')
  })

  test('section → h2 + 斜体 intro + summary 进引用块（界面上的左侧竖条）', () => {
    const out = md({
      type: 'section',
      id: 'attention',
      title: '需要你处理',
      intro: '3 封',
      summary: '合同已到 [第 2 封](#email-52)。'
    })
    expect(out).toContain('## 需要你处理')
    expect(out).toContain('_3 封_')
    // 锚点链接原样保留 —— 它标着「这句话说的是哪封」。
    expect(out).toContain('> 合同已到 [第 2 封](#email-52)。')
  })

  test('email_item → 列表项，主题链到 app deeplink，元信息与摘要缩进续行', () => {
    const out = md({
      type: 'email_item',
      internal_id: 52,
      subject: '合同待签',
      sender_name: '张三',
      sender_addr: 'z@example.com',
      time: '2026-09-03T09:12:00',
      priority: '🔴 紧急',
      category: '合同',
      ai_action: '需回复',
      badges: ['附件'],
      ai_summary: '对方要今天之前签回。',
      source: { notion_url: null, app_deeplink: 'mailagent://email/52' }
    })
    expect(out.split('\n')[0]).toBe(
      '- **[合同待签](mailagent://email/52)** · 张三 · <z@example.com> · 2026-09-03T09:12:00'
    )
    expect(out).toContain('  🔴 紧急 · 合同 · 需回复 · 附件')
    expect(out).toContain('  对方要今天之前签回。')
  })

  test('key_points → 有序列表（界面上的 01 / 02 编号）', () => {
    const out = md({ type: 'key_points', title: '要点', items: ['甲方要加钱', '工期不变'] })
    expect(out).toContain('#### 要点')
    expect(out).toContain('1. 甲方要加钱')
    expect(out).toContain('2. 工期不变')
  })

  test('callout → 引用块，标题加粗', () => {
    const out = md({ type: 'callout', tone: 'warn', title: '注意', body: '合同今天到期。' })
    expect(out).toBe('> **注意**\n>\n> 合同今天到期。')
  })

  test('kos_context → 引用块：标题 · 来源徽标 / 摘录 / 实体 slug', () => {
    const out = md({
      type: 'kos_context',
      entity_slug: 'acme-corp',
      title: 'ACME 公司',
      snippet: '长期供应商。',
      source: 'gbrain'
    })
    expect(out).toContain('> **ACME 公司** · `gbrain`')
    expect(out).toContain('> 长期供应商。')
    expect(out).toContain('> `acme-corp`')
  })

  test('action_suggestion → 未勾选的任务项（界面上是「建议但不可执行」）', () => {
    const out = md({
      type: 'action_suggestion',
      id: 'a1',
      title: '批量归档 5 封通知',
      internal_ids: [1, 2],
      action_type: 'archive',
      enabled: false,
      detail: '都来自系统通知'
    })
    expect(out).toBe('- [ ] **批量归档 5 封通知**\n  都来自系统通知')
  })

  test('trend → 指标行 + 转置表（标签一行 / 数值一行）', () => {
    const out = md({
      type: 'trend',
      metric: '每日来信',
      points: [
        { label: '周一', value: 12 },
        { label: '周二', value: 8 }
      ],
      compare: { label: '较上周', delta: -15 }
    })
    expect(out).toContain('**每日来信** · -15% · 较上周')
    expect(out).toContain('| 周一 | 周二 |')
    expect(out).toContain('| 12 | 8 |')
  })

  test('divider → ---', () => {
    expect(md({ type: 'divider' })).toBe('---')
  })

  test('markdown → 标题 + 原文透传', () => {
    const out = md({ type: 'markdown', title: '附注', text: '- 一\n- 二' })
    expect(out).toBe('#### 附注\n\n- 一\n- 二')
  })

  test('timeline → 列表项，时间用行内代码，detail 缩进续行', () => {
    const out = md({
      type: 'timeline',
      title: '今天',
      events: [
        { time: '09:00', title: '晨会', detail: '讨论了排期' },
        { time: '14:00', title: '客户来电' }
      ]
    })
    expect(out).toContain('#### 今天')
    expect(out).toContain('- `09:00` · **晨会**\n  讨论了排期')
    expect(out).toContain('- `14:00` · **客户来电**')
  })

  test('checklist → GFM 任务列表（done → [x]）', () => {
    const out = md({
      type: 'checklist',
      title: '待办',
      items: [
        { text: '回合同邮件', done: true },
        { text: '发周报', done: false }
      ]
    })
    expect(out).toContain('- [x] 回合同邮件')
    expect(out).toContain('- [ ] 发周报')
  })

  test('progress → 标签 + 值/上限 + 百分比 + 说明', () => {
    const out = md({ type: 'progress', label: '本周处理', value: 12, max: 20, caption: '还差 8' })
    expect(out).toContain('**本周处理** · 12/20（60%）')
    expect(out).toContain('还差 8')
  })

  test('quote → 引用块 + 出处链接', () => {
    const out = md({
      type: 'quote',
      text: '一切以合同为准。',
      cite: '法务部',
      url: 'https://example.com/policy'
    })
    expect(out).toBe('> 一切以合同为准。\n>\n> — [法务部](https://example.com/policy)')
  })

  test('metric_delta → 标签 + 值 + 带符号变化', () => {
    const out = md({
      type: 'metric_delta',
      label: '平均响应',
      value: '2.4h',
      delta: 12,
      deltaLabel: '较上周'
    })
    expect(out).toContain('**平均响应** · 2.4h（+12%较上周）')
  })

  test('image → markdown 图片，src 原样保留，caption 斜体', () => {
    const out = md({
      type: 'image',
      src: 'mailagent://attachment/9',
      alt: '趋势图',
      caption: '来自附件'
    })
    expect(out).toContain('![趋势图](mailagent://attachment/9)')
    expect(out).toContain('_来自附件_')
  })

  test('matter_item → 列表项：标题链到 deeplink + 原始枚举 + 字段名键的元信息', () => {
    const out = md({
      type: 'matter_item',
      public_id: 'M-12',
      title: '续签 ACME',
      status: 'in_progress',
      health: 'at_risk',
      priority: 'p1',
      deeplink: 'mailagent://matter/M-12',
      due_at: Date.UTC(2026, 8, 10, 12),
      progress: { done: 2, total: 5 },
      waiting_on: ['张三'],
      next_action: '发出报价',
      signal_count: 2,
      summary: '对方还没回。'
    })
    expect(out.split('\n')[0]).toBe('- **[续签 ACME](mailagent://matter/M-12)** · `M-12`')
    expect(out).toContain('  in_progress · at_risk · p1 · 2/5 · due 2026-09-10')
    expect(out).toContain('waiting_on: 张三 · next_action: 发出报价 · signal_count: 2')
    expect(out).toContain('  对方还没回。')
  })
})

describe('兜底', () => {
  test('未知块类型不抛，把 type 与能认出的文字留下', () => {
    const out = md({ type: 'sparkline_v2', title: '新块', text: '将来的东西' })
    expect(out).toContain('`sparkline_v2`')
    expect(out).toContain('新块')
    expect(out).toContain('将来的东西')
  })

  test('野值块（null / 数组 / 缺字段）一律返空串而不是抛', () => {
    expect(md(null)).toBe('')
    expect(md(undefined)).toBe('')
    expect(md({ type: 'stat_row' })).toBe('')
    expect(md({ type: 'checklist', items: 'nope' })).toBe('')
    expect(md({ type: 'trend', points: null })).toBe('')
  })

  test('空 doc / null doc → 空串', () => {
    expect(reportDocToMarkdown(null)).toBe('')
    expect(reportDocToMarkdown({ blocks: [] } as unknown as ReportDoc)).toBe('')
  })

  test('整份 doc：块之间空行分隔，末尾恰一个换行', () => {
    const doc = {
      blocks: [
        { type: 'header', title: '今日邮件' },
        { type: 'divider' },
        { type: 'overview', text: '没什么大事。' }
      ]
    } as unknown as ReportDoc
    expect(reportDocToMarkdown(doc)).toBe('# 今日邮件\n\n---\n\n没什么大事。\n')
  })
})

describe('文件名派生', () => {
  test('路径分隔符与非法字符换成空格并收敛空白', () => {
    expect(sanitizeFilenamePart('日报 2026/09/03: 概要')).toBe('日报 2026 09 03 概要')
  })

  test('全是非法字符 → 兜底 report（不生成空文件名）', () => {
    expect(sanitizeFilenamePart('///')).toBe('report')
    expect(sanitizeFilenamePart('   ')).toBe('report')
  })

  test('开头的点被去掉（否则是隐藏文件）', () => {
    expect(sanitizeFilenamePart('..日报')).toBe('日报')
  })

  test('标题取首个 header 块，接生成日期，扩展名 .md', () => {
    const doc = {
      generated_at: '2026-09-03T09:12:00',
      report_date: '2026-09-02',
      blocks: [
        { type: 'overview', text: 'x' },
        { type: 'header', title: '今日邮件' }
      ]
    } as unknown as ReportDoc
    expect(reportExportFilename(doc, '兜底标题')).toBe('今日邮件 2026-09-03.md')
  })

  test('没有 header 块 → 用调用方给的 fallback；没有 generated_at → 回落 report_date', () => {
    const doc = { report_date: '2026-09-02', blocks: [] } as unknown as ReportDoc
    expect(reportExportFilename(doc, '周报 W36')).toBe('周报 W36 2026-09-02.md')
  })

  test('重名候选：第 1 次原名，之后在扩展名前挂序号', () => {
    expect(nextFilenameCandidate('日报.md', 1)).toBe('日报.md')
    expect(nextFilenameCandidate('日报.md', 2)).toBe('日报 (2).md')
    expect(nextFilenameCandidate('日报.md', 3)).toBe('日报 (3).md')
  })
})

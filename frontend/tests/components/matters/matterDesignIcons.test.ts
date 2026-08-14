import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 设计原型 → 实现的 icon 对照闸（设计 §7.6「icon 全部对照原型替换」）。
 *
 * 🔴 为什么要闸：这类对照关系全靠人肉记忆，改一次漂一次。0812 dogfood 实测，
 * 视图轨 12 项里 7 项与原型不符（monitoring 用了 Monitor「显示器」表示「监控中」）、
 * 资源 kind 6 项里 4 项不符（event 用了 Users「干系人」表示「会议」）—— 都是望文生义。
 *
 * 闸的形态是**读源码文本**而不是渲染组件：这里要钉死的是「哪个 key 配哪个符号」这张表本身，
 * 渲染测试盯不住它（换个图标照样渲染得出来）。
 */

const ROOT = resolve(__dirname, '../../..')
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf-8')

/** 从 `key: <Icon .../>` 或 `key: Icon,` 形式的表里抽出映射。抽不到必须红。 */
function extractMap(
  source: string,
  marker: string,
  keys: readonly string[]
): Record<string, string> {
  const start = source.indexOf(marker)
  expect(start, `找不到 ${marker} —— 表被改名或挪走了，闸失效`).toBeGreaterThan(-1)
  const body = source.slice(start, start + 1400)
  const out: Record<string, string> = {}
  for (const key of keys) {
    const match = new RegExp(`\\b${key}:\\s*<?([A-Z][A-Za-z0-9]*)`).exec(body)
    expect(match, `${marker} 里抽不到 ${key}`).not.toBeNull()
    out[key] = match![1]
  }
  return out
}

// V3-01/V3-12 —— 左轨 12 档 `VIEW_ICONS` 已随视图列退役（v3 信息架构：两 tab + 查询模型）。
// 闸随之改盯新结构 `matterListQuery.ts` 的三张表（tab / scope / 快捷筛选），性质不变：
// 表被改名/挪走 → `extractMap` 的 indexOf 断言炸；少一项 → 逐 key 断言炸 —— 「抽取失败必须红」。
describe('tab / 范围 / 快捷筛选图标 = 设计原型 list.jsx 的 ModuleTabs / MATTER_SCOPES / QUICK 表', () => {
  const source = read('src/shared/components/matters/matterListQuery.ts')

  it('模块 tab 2 项逐位对应', () => {
    const actual = extractMap(source, 'export const MATTER_TAB_ICONS', ['list', 'board'])
    expect(actual).toEqual({
      list: 'Briefcase', // briefcase
      board: 'BarChart3' // barchart
    })
  })

  it('范围 4 项逐位对应', () => {
    const actual = extractMap(source, 'export const MATTER_SCOPE_ICONS', [
      'open',
      'done',
      'archived',
      'trash'
    ])
    expect(actual).toEqual({
      open: 'Briefcase', // briefcase
      done: 'CheckCircle2', // checkcircle
      archived: 'Archive', // archive
      trash: 'Trash2' // trash
    })
  })

  it('快捷筛选 6 项逐位对应', () => {
    const actual = extractMap(source, 'export const MATTER_QUICK_FILTER_ICONS', [
      'attn',
      'waiting',
      'due',
      'p01',
      'proposal',
      'nonext'
    ])
    expect(actual).toEqual({
      attn: 'TriangleAlert', // alert
      waiting: 'Hourglass', // hourglass
      due: 'Clock3', // clock
      p01: 'Flag', // flag
      proposal: 'Sparkles', // sparkles
      nonext: 'CircleHelp' // helpcircle
    })
  })
})

describe('资源 kind 图标 = 设计原型 helpers.jsx 的 RES_KIND 表', () => {
  it('6 项逐位对应', () => {
    const source = read('src/shared/components/matters/matterResource.ts')
    const actual = extractMap(source, 'export const RESOURCE_KIND_ICONS', [
      'email',
      'thread',
      'event',
      'doc',
      'file',
      'url'
    ])
    expect(actual).toEqual({
      email: 'Mail', // mail
      thread: 'MessageSquare', // message
      event: 'Calendar', // calendar —— 不是 Users
      doc: 'FileText', // filetext
      file: 'Paperclip', // paperclip
      url: 'Link' // link
    })
  })
})

describe('详情头 chips + tab 图标 = 设计原型 helpers.jsx 的 MATTER_STATUS/HEALTH/PRIORITY 与 detail.jsx 的 DETAIL_TABS', () => {
  const source = read('src/shared/components/matters/matterVocab.ts')

  it('状态 8 档逐位对应', () => {
    const actual = extractMap(source, 'export const MATTER_STATUS_ICONS', [
      'inbox',
      'planned',
      'active',
      'waiting',
      'blocked',
      'monitoring',
      'done',
      'canceled'
    ])
    expect(actual).toEqual({
      inbox: 'Inbox', // inbox
      planned: 'Calendar', // calendar
      active: 'Play', // play
      waiting: 'Hourglass', // hourglass
      blocked: 'Ban', // ban
      monitoring: 'Eye', // eye
      done: 'CheckCircle2', // checkcircle
      canceled: 'X' // x
    })
  })

  it('健康度 4 档逐位对应', () => {
    const actual = extractMap(source, 'export const MATTER_HEALTH_ICONS', [
      'unknown',
      'on_track',
      'at_risk',
      'off_track'
    ])
    expect(actual).toEqual({
      unknown: 'Minus', // minus
      on_track: 'ArrowUp', // arrowup
      at_risk: 'TriangleAlert', // alert
      off_track: 'ArrowDown' // arrowdown
    })
  })

  it('详情 4 个 tab 各有 icon（此前一个都没有）', () => {
    const actual = extractMap(source, 'export const MATTER_DETAIL_TAB_ICONS', [
      'state',
      'context',
      'timeline',
      'runs'
    ])
    expect(actual).toEqual({
      state: 'Target', // target
      context: 'Layers', // layers
      timeline: 'History', // history
      runs: 'Activity' // activity
    })
  })

  it('条目类型 6 档逐位对应（D8：状态 tab 分节此前一个 icon 都没有）', () => {
    const actual = extractMap(source, 'export const MATTER_ITEM_KIND_ICONS', [
      'action',
      'milestone',
      'decision',
      'blocker',
      'question',
      'note'
    ])
    // 右侧是原型 helpers.jsx `ITEM_KIND[*].icon` 写的语义名。
    expect(actual).toEqual({
      action: 'ListChecks', // listcheck
      milestone: 'Milestone', // milestone
      decision: 'Gavel', // gavel
      blocker: 'Ban', // ban
      question: 'HelpCircle', // helpcircle
      note: 'FileText' // note —— 原型画的是「带折角与横线的文档」，不是便签
    })
  })

  it('status / priority 的 tone 与原型同档（chip 不再是 8 档一个颜色）', () => {
    // tone 表的值是字符串字面量、不是组件名，所以不走 extractMap，直接钉内容（同 TIMELINE_TONE）。
    const statusStart = source.indexOf('export const MATTER_STATUS_TONES')
    expect(statusStart, '找不到 MATTER_STATUS_TONES —— 表被改名或挪走了，闸失效').toBeGreaterThan(
      -1
    )
    const statusBody = source.slice(statusStart, statusStart + 400)
    for (const [key, tone] of [
      ['inbox', 'neutral'],
      ['planned', 'info'],
      ['active', 'success'],
      ['waiting', 'warn'],
      ['blocked', 'critical'],
      ['monitoring', 'info'],
      ['done', 'success'],
      ['canceled', 'neutral']
    ] as const) {
      expect(statusBody, `status ${key} 的 tone 应为 ${tone}`).toMatch(
        new RegExp(`\\b${key}:\\s*'${tone}'`)
      )
    }
    const priorityStart = source.indexOf('export const MATTER_PRIORITY_TONES')
    expect(
      priorityStart,
      '找不到 MATTER_PRIORITY_TONES —— 表被改名或挪走了，闸失效'
    ).toBeGreaterThan(-1)
    const priorityBody = source.slice(priorityStart, priorityStart + 240)
    expect(priorityBody).toMatch(/\bp0:\s*'critical'/)
    expect(priorityBody).toMatch(/\bp1:\s*'warn'/)
    expect(priorityBody).toMatch(/\bp2:\s*'neutral'/)
    expect(priorityBody).toMatch(/\bp3:\s*'neutral'/)
  })
})

describe('时间轴节点 = 设计原型 detail.jsx 的 TL_ICON / TL_TONE', () => {
  // 时间线本体已从 MatterDetail 拆到 MatterTimeline（叙述/合并/分档三层逻辑放不进
  // 那个 2000 行的文件）。表跟着搬，闸也跟着搬 —— 上面 `indexOf` 的 -1 断言正是为了
  // 让「表挪走了但闸还在读旧文件」这种失效必须红，而不是静默变成零校验。
  const source = read('src/shared/components/matters/MatterTimeline.tsx')

  it('TL_ICON 覆盖的 9 类语义逐项落地', () => {
    // 设计只画了 9 个 mock kind，实到 38 个事件；这里只钉死设计明确画过的那几条映射。
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['matter_created\\$/, Plus', 'created→plus'],
      ['matter_updated\\$/, FileCheck', 'update→filecheck'],
      ['ArrowRight', 'status→arrowright'],
      ['^item_/, ListChecks', 'item→listcheck'],
      ['resource_updated\\$/, FileText', 'doc→filetext'],
      ['Link2', 'resource→link']
    ]
    for (const [needle, why] of expected) {
      expect(source, `TIMELINE_ICONS 缺 ${why}`).toContain(needle.replace(/\\\$/g, '$'))
    }
    expect(source, '兜底必须是设计稿的 dot').toContain('return Circle')
  })

  it('进展节点按 PROG_KIND 定色（G-18 两层复刻后，主视图节点色来自 kind 不来自 actor）', () => {
    // PROGRESS_TONE 的值是 class 字符串（不是组件名），所以不走 extractMap，直接钉内容。
    // 设计 progress.jsx `PROG_KIND[*].color`：--c-ai / --c-ok / --c-warn / --c-crit。
    // 🔴 **只上色不描边**（D13，2026-08-13 dogfood）：设计里那圈 40% alpha 发丝边成立的前提是
    // 圆底与页面同色、看不见；本仓详情壳是半透的 `bg-ink-0/35`，不透明圆底 + 描边被 owner
    // 读成「图标多了外圈」。改动前这里钉的是 `border-*\/40`，一并改判 —— 描边回归即红。
    const start = source.indexOf('const PROGRESS_TONE')
    expect(start, '找不到 PROGRESS_TONE —— 表被改名或挪走了，闸失效').toBeGreaterThan(-1)
    const body = source.slice(start, start + 400)
    expect(body).toMatch(/ai:\s*'text-ai'/)
    expect(body).toMatch(/ok:\s*'text-ok'/)
    expect(body).toMatch(/warn:\s*'text-warn'/)
    expect(body).toMatch(/crit:\s*'text-crit'/)
    expect(body, 'D13：节点不再描边').not.toMatch(/border-/)
    // 操作日志弹窗的 actor 配色沿设计 AuditLogModal：agent=--c-ai / me=--c-accent / system=fg-3。
    const auditStart = source.indexOf('const AUDIT_ACTOR_TONE')
    expect(auditStart, '找不到 AUDIT_ACTOR_TONE —— 表被改名或挪走了，闸失效').toBeGreaterThan(-1)
    const auditBody = source.slice(auditStart, auditStart + 300)
    expect(auditBody).toMatch(/agent:\s*'text-ai'/)
    expect(auditBody).toMatch(/user:\s*'text-coral'/)
    expect(auditBody).toMatch(/system:\s*'text-ink-fg-3'/)
  })

  it('时间轴有贯穿竖线（此前是一堆独立卡片，没有任何时间轴形态）', () => {
    // 设计 progress.jsx ProgressEntry：25px 圆节点；竖线 left 16px = 半径 12.5 + pl-1 的 4px。
    expect(source).toContain('left-4')
    expect(source).toContain('size-[25px]')
  })
})

describe('抽取器失效时必须红', () => {
  it('表改名 → 断言炸而不是静默放行', () => {
    expect(() => extractMap('const OTHER_NAME = {}', 'const VIEW_ICONS', ['focus'])).toThrow()
  })
  it('表里少一项 → 断言炸', () => {
    expect(() =>
      extractMap('const VIEW_ICONS = { focus: <Target /> }', 'const VIEW_ICONS', [
        'focus',
        'attention'
      ])
    ).toThrow()
  })
})

import { z } from 'zod'

import type { ReportBlock, ReportUnknownBlock } from './types/report'

export const REPORT_CADENCES = ['daily', 'weekly', 'monthly', 'custom'] as const

/** Author id stamped on a report written from manual chat, where no custom agent owns the run.
 *  It is deliberately NOT a row in `report_agent`: the assistant is not a configurable agent.
 *  Reports listing maps it to a display name; the backend accepts it alongside real agent ids.
 *  🔴 Mirrored in src/reports/models.py (MANUAL_CHAT_REPORT_AGENT_ID) — the block-contract
 *  consistency gate fails loudly on drift. */
export const MANUAL_CHAT_REPORT_AGENT_ID = 'custom_ai'

export const REPORT_BLOCK_TYPES = [
  'header',
  'overview',
  'stat_row',
  'section',
  'email_item',
  'key_points',
  'callout',
  'kos_context',
  'action_suggestion',
  'trend',
  'divider',
  'markdown',
  'timeline',
  'checklist',
  'progress',
  'quote',
  'metric_delta',
  'image'
] as const

/** Upper bound for one image block's `src`, mirroring the markdown block's 50k text cap — the only
 *  otherwise-unbounded field a model could use to push megabytes of base64 into the report table.
 *  🔴 Mirrored in src/reports/models.py (MAX_IMAGE_SRC_CHARS); the block-contract consistency gate
 *  fails loudly on drift. */
export const MAX_IMAGE_SRC_CHARS = 50_000

const toneSchema = z.enum(['neutral', 'info', 'success', 'warn', 'critical'])
const internalImageSrcSchema = z
  .string()
  .max(MAX_IMAGE_SRC_CHARS)
  .refine(
    (src) =>
      (src.startsWith('/') && !src.startsWith('//')) ||
      src.startsWith('mailagent://') ||
      src.startsWith('app://') ||
      src.startsWith('data:image/'),
    'image src must be an internal app/attachment/data-image reference'
  )

export const reportBlockSchemas = {
  header: z.object({
    type: z.literal('header'),
    title: z.string().min(1),
    subtitle: z.string().optional(),
    date_label: z.string().optional()
  }),
  overview: z.object({ type: z.literal('overview'), text: z.string() }),
  stat_row: z.object({
    type: z.literal('stat_row'),
    stats: z
      .array(z.object({ key: z.string(), label: z.string(), value: z.number(), tone: toneSchema }))
      .max(12)
  }),
  section: z.object({
    type: z.literal('section'),
    id: z.string().min(1),
    title: z.string().min(1),
    icon: z.string().optional(),
    intro: z.string().optional(),
    summary: z.string().optional()
  }),
  email_item: z.object({
    type: z.literal('email_item'),
    internal_id: z.number().int(),
    subject: z.string(),
    sender_name: z.string(),
    time: z.string(),
    sender_addr: z.string().optional(),
    category: z.string().optional(),
    priority: z.string().optional(),
    ai_summary: z.string().optional(),
    ai_action: z.string().optional(),
    source: z.object({ notion_url: z.string().nullable(), app_deeplink: z.string() }),
    badges: z.array(z.string()).optional()
  }),
  key_points: z.object({
    type: z.literal('key_points'),
    items: z.array(z.string()).max(30),
    title: z.string().optional()
  }),
  callout: z.object({
    type: z.literal('callout'),
    tone: toneSchema,
    body: z.string(),
    title: z.string().optional()
  }),
  kos_context: z.object({
    type: z.literal('kos_context'),
    entity_slug: z.string(),
    title: z.string(),
    snippet: z.string(),
    source: z.string()
  }),
  action_suggestion: z.object({
    type: z.literal('action_suggestion'),
    id: z.string(),
    title: z.string(),
    internal_ids: z.array(z.number().int()),
    action_type: z.string(),
    enabled: z.boolean(),
    detail: z.string().optional()
  }),
  trend: z.object({
    type: z.literal('trend'),
    metric: z.string().min(1),
    points: z
      .array(z.object({ label: z.string(), value: z.number() }))
      .min(1)
      .max(30),
    compare: z.object({ label: z.string(), delta: z.number() }).optional(),
    variant: z.enum(['bar', 'line', 'area']).optional()
  }),
  divider: z.object({ type: z.literal('divider') }),
  markdown: z.object({
    type: z.literal('markdown'),
    title: z.string().optional(),
    text: z.string().min(1).max(50_000)
  }),
  timeline: z.object({
    type: z.literal('timeline'),
    title: z.string().optional(),
    events: z
      .array(
        z.object({
          time: z.string(),
          title: z.string().min(1),
          detail: z.string().optional(),
          tone: toneSchema.optional(),
          icon: z.string().optional()
        })
      )
      .min(1)
      .max(40)
  }),
  checklist: z.object({
    type: z.literal('checklist'),
    title: z.string().optional(),
    items: z
      .array(z.object({ text: z.string().min(1), done: z.boolean(), tone: toneSchema.optional() }))
      .min(1)
      .max(50)
  }),
  progress: z.object({
    type: z.literal('progress'),
    label: z.string().min(1),
    title: z.string().optional(),
    value: z.number(),
    max: z.number().positive().optional(),
    tone: toneSchema.optional(),
    caption: z.string().optional()
  }),
  quote: z.object({
    type: z.literal('quote'),
    text: z.string().min(1),
    cite: z.string().optional(),
    url: z.string().url().optional()
  }),
  metric_delta: z.object({
    type: z.literal('metric_delta'),
    label: z.string().min(1),
    title: z.string().optional(),
    value: z.string(),
    delta: z.number(),
    deltaLabel: z.string().optional(),
    tone: toneSchema.optional()
  }),
  image: z.object({
    type: z.literal('image'),
    src: internalImageSrcSchema,
    title: z.string().optional(),
    alt: z.string().optional(),
    caption: z.string().optional(),
    width: z.number().int().positive().max(2400).optional()
  })
} as const

export const reportBlockInputSchema = z.discriminatedUnion('type', [
  reportBlockSchemas.header,
  reportBlockSchemas.overview,
  reportBlockSchemas.stat_row,
  reportBlockSchemas.section,
  reportBlockSchemas.email_item,
  reportBlockSchemas.key_points,
  reportBlockSchemas.callout,
  reportBlockSchemas.kos_context,
  reportBlockSchemas.action_suggestion,
  reportBlockSchemas.trend,
  reportBlockSchemas.divider,
  reportBlockSchemas.markdown,
  reportBlockSchemas.timeline,
  reportBlockSchemas.checklist,
  reportBlockSchemas.progress,
  reportBlockSchemas.quote,
  reportBlockSchemas.metric_delta,
  reportBlockSchemas.image
])

export function validateReportBlocks(value: unknown): ReportBlock[] {
  if (!Array.isArray(value)) return []
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {
        type: 'invalid',
        title: `Invalid report block ${index + 1}`,
        text: 'Expected an object.'
      } satisfies ReportUnknownBlock
    }
    const block = raw as Record<string, unknown>
    const type = typeof block.type === 'string' ? block.type : 'invalid'
    const schema = reportBlockSchemas[type as keyof typeof reportBlockSchemas]
    if (!schema) return block as ReportUnknownBlock
    const parsed = schema.safeParse(block)
    if (parsed.success) return parsed.data as ReportBlock
    return {
      ...block,
      type: 'invalid',
      original_type: type,
      title: typeof block.title === 'string' ? block.title : `Invalid ${type} block ${index + 1}`,
      text:
        typeof block.text === 'string'
          ? block.text
          : parsed.error.issues.map((issue) => issue.message).join('; ')
    } as ReportUnknownBlock
  })
}

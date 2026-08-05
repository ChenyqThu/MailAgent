// 模型能力卡（hover 显示）—— 参照 lobe-chat 的 ModelDetailPanel 搬，去掉一节做不到的。
//
// 内容对齐 lobe：描述段 + 上下文长度 + 最大输出 + 能力清单 + 定价 + 发布/知识截止。
// 🔴 **有意不做 Benchmark 雷达图**：lobe 那一节走的是它自己的 cloud 评测接口
// （`useBusinessModelRating`），开源数据集里根本没有这份数据 —— 画一个假雷达比不画更糟。
// lobe 用手风琴分节（收起时只剩标题），我们摊平成常显：少一节内容 + 卡不可交互，手风琴的
// 折叠收益为零，反而多一层要点开的操作。
//
// 🔴 必须 portal 出去：消费场地的真实宽度是 浮窗 448 / 侧栏 320-720（默认 400）/ agent 面
// 704 / popout 整窗，而 `ThreadPrimitive.Viewport` 带 `overflow-x-hidden`、
// `AssistantChatModal` 外层还有一层 `overflow-hidden` —— 非 portal 的横向浮层**必被裁**。
// 定位随之要响应式（右展开 → 翻左 → 夹进视口三档），算式在 ./modelDetailCard.lib。
//
// 🔴 材质**自成一套不透明形**（`bg-ink-2` + `border-ink-border` 实线描边 + `shadow-md`，抄
// MentionPopover 的先例），不套 `.glass-pop`。08-05 owner 拍板后 `.glass-pop` 本身也已是不透明
// 的 `rgb(--ink-2)`（见 index.css / DESIGN.md §18.1 C10），两者**表面同色**；这里仍不套那个类，
// 因为它连带的是浮层档的 hairline 描边 + 很重的 `--pop-shadow`（0 24px 60px/.55），而这张卡是
// portal 出去、贴在 ModelPicker 弹层**旁边**的纯展示卡，要的是更实的描边 + 轻一档投影。
//
// 🔴 `pointer-events-none`：卡不接受交互。除了「内容纯展示」之外还有一条硬理由 —— 卡在
// document.body 上，不在 ModelPicker 的 `ref.current.contains()` 里，能点就会被那条
// `document.mousedown` 关闭逻辑当成「点了外面」，把整个选择器关掉。

import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Brain, Eye, Paperclip, Wrench } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { ProviderBrandIcon } from '@shared/components/icons/providers'
import type { CatalogModelMeta } from '@shared/modelCatalog/lookup'
import type { LlmProviderProtocol } from '@shared/hooks/useLlmProviders'

import {
  MODEL_CARD_WIDTH,
  formatPrice,
  formatTokens,
  placeDetailCard,
  type ModelDetailAnchor
} from './modelDetailCard.lib'

/** 能力位 → 图标 + 文案 + 各自底色（lobe 的每类各带底块，我们走 token 不写裸 hex）。
 *  前三位与行内 badge 同一套词（`settings.providers.models.cap.*`），`files` 是卡上独有的
 *  第四位（行内不摆 —— 三个已经是一行图标的极限）。 */
const CAPABILITY_ROWS = [
  {
    key: 'vision',
    Icon: Eye,
    labelKey: 'settings.providers.models.cap.vision',
    tint: 'bg-info/12 text-info'
  },
  {
    key: 'tools',
    Icon: Wrench,
    labelKey: 'settings.providers.models.cap.tools',
    tint: 'bg-ok/12 text-ok'
  },
  {
    key: 'reasoning',
    Icon: Brain,
    labelKey: 'settings.providers.models.cap.reasoning',
    tint: 'bg-ai/12 text-ai'
  },
  {
    key: 'files',
    Icon: Paperclip,
    labelKey: 'chat.composer.modelCard.capFiles',
    tint: 'bg-impt/12 text-impt'
  }
] as const

const PRICE_ROW_KEYS = [
  ['chat.composer.modelCard.priceInput', 'input'],
  ['chat.composer.modelCard.priceOutput', 'output'],
  ['chat.composer.modelCard.priceCacheRead', 'cacheRead'],
  ['chat.composer.modelCard.priceCacheWrite', 'cacheWrite']
] as const

/** 一节的标题（左侧 3×12 彩色竖条 —— 抄 lobe 的分节语言，颜色走 token）。 */
function SectionTitle({ bar, children }: { bar: string; children: string }): React.JSX.Element {
  return (
    <div className="mb-1 flex items-center gap-1.5">
      <span className={cn('h-3 w-[3px] shrink-0 rounded-full', bar)} />
      <span className="text-micro font-medium text-ink-fg-2">{children}</span>
    </div>
  )
}

/** `label ····· value` 的一行（lobe 的 `alwaysShowAction` 行）。 */
function FactRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2 py-0.5 text-micro">
      <span className="shrink-0 text-ink-fg-3">{label}</span>
      <span className="min-w-0 flex-1 border-b border-dashed border-ink-border-soft" />
      <span className="shrink-0 font-mono text-ink-fg-1">{value}</span>
    </div>
  )
}

export function ModelDetailCard({
  meta,
  providerId,
  protocol,
  anchor
}: {
  meta: CatalogModelMeta
  providerId: string
  protocol: LlmProviderProtocol | null
  anchor: ModelDetailAnchor
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (typeof document === 'undefined' || typeof window === 'undefined') return null

  const pos = placeDetailCard(anchor, {
    width: window.innerWidth,
    height: window.innerHeight
  })
  const caps = meta.capabilities
  const activeCaps = caps ? CAPABILITY_ROWS.filter((c) => caps[c.key] === true) : []
  const cost = meta.cost
  // 四个价位各自可缺（models.dev 常见「有 input/output、无 cache_*」）→ 逐条过滤而不是整块
  // 二选一，缺的那行就不出现。
  const priceRows: Array<{ labelKey: string; value: number }> = []
  if (cost) {
    for (const [labelKey, field] of PRICE_ROW_KEYS) {
      const v = cost[field]
      if (typeof v === 'number') priceRows.push({ labelKey, value: v })
    }
  }

  return createPortal(
    <div
      role="tooltip"
      data-testid="model-detail-card"
      style={{
        position: 'fixed',
        left: pos.left,
        bottom: pos.bottom,
        width: MODEL_CARD_WIDTH,
        maxHeight: pos.maxHeight,
        zIndex: 100
      }}
      className={cn(
        // 不透明表面（owner 08-05）：ink-2 + 实线描边 + 轻投影，有意自成一套而不套 .glass-pop
        // （后者 08-05 起同为不透明 ink-2，但带 hairline 描边 + 重得多的 --pop-shadow）。
        'pointer-events-none flex select-none flex-col overflow-hidden',
        'rounded-[var(--r-card)] border border-ink-border bg-ink-2 shadow-md'
      )}
    >
      {/* 🔴 `min-h-0`：flex 子项默认 `min-height:auto` 不肯收缩，没有它内滚区不会滚，
          内容会被外层的 overflow-hidden 直接切掉（超长 description 的模型就会缺一截）。 */}
      <div className="scrollbar-thin flex min-h-0 flex-col gap-2.5 overflow-y-auto px-3 py-2.5">
        {/* 头：厂商 logo + 全名（+ 已弃用） */}
        <div className="flex items-center gap-2">
          <ProviderBrandIcon
            providerId={providerId}
            protocol={protocol}
            className="size-[18px] shrink-0"
          />
          <span className="min-w-0 flex-1 truncate text-meta font-medium text-ink-fg">
            {meta.displayName}
          </span>
          {meta.deprecated && (
            <span className="shrink-0 rounded bg-warn/15 px-1 text-micro text-warn">
              {t('chat.composer.modelCard.deprecated')}
            </span>
          )}
        </div>

        {meta.description && (
          <p className="whitespace-pre-wrap text-micro leading-relaxed text-ink-fg-2">
            {meta.description}
          </p>
        )}

        {(meta.contextWindow !== null || meta.maxOutput !== null) && (
          <div>
            <SectionTitle bar="bg-info">{t('chat.composer.modelCard.limits')}</SectionTitle>
            {meta.contextWindow !== null && (
              <FactRow
                label={t('chat.composer.modelCard.context')}
                value={formatTokens(meta.contextWindow)}
              />
            )}
            {meta.maxOutput !== null && (
              <FactRow
                label={t('chat.composer.modelCard.maxOutput')}
                value={formatTokens(meta.maxOutput)}
              />
            )}
          </div>
        )}

        {activeCaps.length > 0 && (
          <div>
            <SectionTitle bar="bg-ai">{t('chat.composer.modelCard.abilities')}</SectionTitle>
            <div className="flex flex-wrap gap-1">
              {activeCaps.map(({ key, Icon, labelKey, tint }) => (
                <span
                  key={key}
                  className={cn(
                    'flex items-center gap-1 rounded px-1.5 py-0.5 text-micro leading-none',
                    tint
                  )}
                >
                  <Icon size={11} strokeWidth={2} className="shrink-0" />
                  {t(labelKey)}
                </span>
              ))}
            </div>
          </div>
        )}

        {priceRows.length > 0 && (
          <div>
            <SectionTitle bar="bg-ok">{t('chat.composer.modelCard.pricing')}</SectionTitle>
            {priceRows.map(({ labelKey, value }) => (
              <FactRow key={labelKey} label={t(labelKey)} value={formatPrice(value)} />
            ))}
            <p className="pt-0.5 text-micro text-ink-fg-3">
              {t('chat.composer.modelCard.priceUnit')}
            </p>
          </div>
        )}

        {(meta.releasedAt !== null || meta.knowledgeCutoff !== null) && (
          <div>
            {meta.releasedAt !== null && (
              <FactRow label={t('chat.composer.modelCard.released')} value={meta.releasedAt} />
            )}
            {meta.knowledgeCutoff !== null && (
              <FactRow
                label={t('chat.composer.modelCard.knowledge')}
                value={meta.knowledgeCutoff}
              />
            )}
          </div>
        )}

        {/* 🔴 来源如实注明：normalized 命中时这些数字是**按归一化 id 推断**的厂商官方值，
            不是这家中转的真实配额。别让用户把它当权威。 */}
        <p className="border-t border-ink-border-soft pt-1.5 text-micro leading-snug text-ink-fg-3">
          {t('chat.composer.modelCard.source', { provider: meta.catalogProviderName })}
          {meta.match === 'normalized' &&
            ` · ${t('chat.composer.modelCard.inferred', { id: meta.matchedModelId })}`}
        </p>
      </div>
    </div>,
    document.body
  )
}

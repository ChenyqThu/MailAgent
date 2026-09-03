// /search 的结果区（palette 同组序：matter → contact → library → ai → email），从
// SearchTabPage 拆出（组件 300 行上限）。纯视图：数据数组与激活回调由页面传入；AI 展示态
// （searching / summary / phase / completed）直接读 search-tab store —— 它就是 SSoT，
// 经 props 转一手只会多一层会漂的镜像。
//
// 🔴 组渲染顺序 = SearchTabPage 里 flat 键盘序的构造顺序（matter → contact → library →
// ai → email），两边靠这条注释互指：改任一侧顺序必须同步另一侧，否则 ↑↓ 高亮会落错行。
// FLAT_BASE 让行 DOM id（`palette-opt-N`）与叠在页面上的 ⌘K 面板错开，不撞重复 id。

import { useTranslation } from 'react-i18next'
import { Loader2, Search as SearchGlyph, Sparkles } from 'lucide-react'

import type { SearchHit } from '@shared/api/types'
import type { ContactRowDto } from '@shared/api/types/contact'
import type { LibrarySearchHit } from '@shared/api/types/library'
import type { Matter } from '@shared/api/types/matter'
import { EmailHitRow } from '@shared/components/command/EmailHitRow'
import { LibraryHitRow, LibrarySearchWarnings } from '@shared/components/command/LibraryHitRow'
import { MatterHitRow } from '@shared/components/command/MatterHitRow'
import { PersonHitRow } from '@shared/components/command/PersonHitRow'
import { PaletteThinkingPhrases } from '@shared/components/command/PaletteThinkingPhrases'
import { useSearchTabPage } from '@shared/state/search-tab'

/** 页内结果行的 flatIdx 基值（DOM id 错开 ⌘K 面板的 0 基）。 */
export const FLAT_BASE = 1000

/** 组头 —— 复刻 palette GroupHeader 的 mono ASCII 形态（DESIGN §14：mono 不放 CJK，
 *  标题字面保持英文；右侧 busy 段可本地化）。 */
function GroupHead({
  title,
  count,
  busy,
  busyLabel
}: {
  title: string
  count?: number
  busy?: boolean
  busyLabel?: string
}): React.ReactElement {
  return (
    <h2 className="text-micro font-mono uppercase tracking-[0.08em] text-ink-fg-2 px-2 pt-5 pb-1.5 flex items-center gap-2">
      <span>{title}</span>
      {count !== undefined && (
        <>
          <span className="text-ink-fg-3">·</span>
          <span className="text-ink-fg-3 tabular-nums">{count}</span>
        </>
      )}
      {busy === true && (
        <span className="ml-auto flex items-center gap-1.5 text-ink-fg-3 normal-case tracking-normal">
          <Loader2
            size={12}
            strokeWidth={2}
            className="animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          <span>{busyLabel}</span>
        </span>
      )}
    </h2>
  )
}

export interface SearchResultGroupsProps {
  readonly queryTerms: ReadonlyArray<string>
  /** 页面持有的 0 基高亮光标（行侧回报的 flatIdx 已含 FLAT_BASE，父级减掉）。 */
  readonly highlight: number
  onRowHighlight(flatIdx: number): void
  /** 事项 / 联系人命中（flag off 时父级已传空数组，组按 length 自隐）。 */
  readonly matterHits: readonly Matter[]
  readonly mattersBusy: boolean
  readonly contactHits: readonly ContactRowDto[]
  readonly contactsBusy: boolean
  readonly contactOverflow: number
  /** 资料库命中（P2-L7）。🔴 `libraryWarnings` 是复数数组：中文 1 个字的 query 被服务端
   *  拦下时**出提示不出结果**，那条提示就在这里，命中为空也要渲染这一组。 */
  readonly libraryHits: readonly (LibrarySearchHit & { id: number })[]
  readonly libraryBusy: boolean
  readonly libraryWarnings: readonly string[]
  /** AI 命中与去重后的 FTS 命中（去重在页面 —— flat 序也用同两份，保证下标对齐）。 */
  readonly aiHits: readonly SearchHit[]
  readonly dedupedHits: readonly SearchHit[]
  readonly emailBusy: boolean
  onActivateHit(hit: SearchHit): void
  onActivateMatter(matter: Matter): void
  onActivateContact(contact: ContactRowDto): void
  onActivateLibraryFile(fileId: number): void
}

export function SearchResultGroups({
  queryTerms,
  highlight,
  onRowHighlight,
  matterHits,
  mattersBusy,
  contactHits,
  contactsBusy,
  contactOverflow,
  libraryHits,
  libraryBusy,
  libraryWarnings,
  aiHits,
  dedupedHits,
  emailBusy,
  onActivateHit,
  onActivateMatter,
  onActivateContact,
  onActivateLibraryFile
}: SearchResultGroupsProps): React.ReactElement {
  const { t } = useTranslation()
  const aiSearching = useSearchTabPage((s) => s.aiSearching)
  const aiSummary = useSearchTabPage((s) => s.aiSummary)
  const aiCompleted = useSearchTabPage((s) => s.aiCompleted)
  const aiPhase = useSearchTabPage((s) => s.aiPhase)

  const showAiEmpty = aiCompleted && !aiSearching && aiHits.length === 0
  const showAiGroup = aiSearching || aiHits.length > 0 || showAiEmpty
  // AI 命中存在且去重后 EMAIL 组为空 → 整组不渲染（palette G-A7 ⑤ 同规则）。
  const showEmailGroup = dedupedHits.length > 0 || aiHits.length === 0

  // flat 序的组起点（与 SearchTabPage 的 flat 构造保持同序，见文件头 🔴）。
  const matterStart = 0
  const contactStart = matterStart + matterHits.length
  const libraryStart = contactStart + contactHits.length
  const aiStart = libraryStart + libraryHits.length
  const emailStart = aiStart + aiHits.length

  return (
    <ul role="listbox" aria-label={t('tabs.searchTitle')} className="flex flex-col">
      {matterHits.length > 0 && (
        <>
          <GroupHead
            title="Matters"
            count={matterHits.length}
            busy={mattersBusy}
            busyLabel={t('palette.searching')}
          />
          <div className="space-y-px">
            {matterHits.map((matter, i) => {
              const idx = FLAT_BASE + matterStart + i
              return (
                <MatterHitRow
                  key={matter.public_id}
                  matter={matter}
                  flatIdx={idx}
                  selected={idx - FLAT_BASE === highlight}
                  setHighlight={onRowHighlight}
                  queryTerms={queryTerms}
                  onActivate={() => onActivateMatter(matter)}
                />
              )
            })}
          </div>
        </>
      )}

      {contactHits.length > 0 && (
        <>
          <GroupHead
            title="People"
            count={contactHits.length}
            busy={contactsBusy}
            busyLabel={t('palette.searching')}
          />
          <div className="space-y-px">
            {contactHits.map((contact, i) => {
              const idx = FLAT_BASE + contactStart + i
              return (
                <PersonHitRow
                  key={contact.id}
                  contact={contact}
                  flatIdx={idx}
                  selected={idx - FLAT_BASE === highlight}
                  setHighlight={onRowHighlight}
                  queryTerms={queryTerms}
                  onActivate={() => onActivateContact(contact)}
                />
              )
            })}
          </div>
          {contactOverflow > 0 && (
            <div className="px-2 pb-1 pt-0.5 text-[10px] text-ink-fg-3">
              {t('palette.contacts.moreMatches', { n: contactOverflow })}
            </div>
          )}
        </>
      )}

      {/* 资料库组（P2-L7）：命中为空但有 warning 时也要渲染 —— 那条提示就是这次搜索的
          全部结果（中文 1 个字被拦下）。 */}
      {(libraryHits.length > 0 || libraryWarnings.length > 0) && (
        <>
          <GroupHead
            title="Library"
            count={libraryHits.length}
            busy={libraryBusy}
            busyLabel={t('palette.searching')}
          />
          <LibrarySearchWarnings warnings={libraryWarnings} className="px-2 pb-1 pt-0.5" />
          {libraryHits.length > 0 && (
            <div className="space-y-px">
              {libraryHits.map((file, i) => {
                const idx = FLAT_BASE + libraryStart + i
                return (
                  <LibraryHitRow
                    key={file.id}
                    hit={file}
                    flatIdx={idx}
                    selected={idx - FLAT_BASE === highlight}
                    setHighlight={onRowHighlight}
                    queryTerms={queryTerms}
                    onActivate={() => onActivateLibraryFile(file.id)}
                  />
                )
              })}
            </div>
          )}
        </>
      )}

      {showAiGroup && (
        <>
          <GroupHead title="AI Search" count={aiHits.length > 0 ? aiHits.length : undefined} />
          {aiSearching && (
            <div className="flex items-center gap-2 px-2 py-1.5 text-aux text-ink-fg-2">
              <Sparkles size={14} strokeWidth={1.75} className="shrink-0 text-coral" aria-hidden />
              <PaletteThinkingPhrases phase={aiPhase} />
            </div>
          )}
          {!aiSearching && aiSummary && (
            <div className="flex items-start gap-2 px-2 py-1.5 text-aux text-ink-fg-1">
              <Sparkles
                size={14}
                strokeWidth={1.75}
                className="mt-px shrink-0 text-coral"
                aria-hidden
              />
              <span className="min-w-0 break-words leading-snug">
                {t('palette.ai.summary', { text: aiSummary })}
              </span>
            </div>
          )}
          {aiHits.length > 0 && (
            <div className="space-y-px">
              {aiHits.map((h, i) => {
                const idx = FLAT_BASE + aiStart + i
                return (
                  <EmailHitRow
                    key={`ai-${h.internal_id}`}
                    hit={h}
                    flatIdx={idx}
                    selected={idx - FLAT_BASE === highlight}
                    setHighlight={onRowHighlight}
                    queryTerms={queryTerms}
                    onActivate={() => onActivateHit(h)}
                  />
                )
              })}
            </div>
          )}
          {showAiEmpty && (
            <div className="px-2 pb-1">
              <div className="empty-tile">
                <Sparkles size={18} strokeWidth={1.75} className="text-ink-fg-3" aria-hidden />
                <div className="text-aux text-ink-fg-1">{t('palette.ai.emptyTitle')}</div>
                <div className="text-meta text-ink-fg-3">{t('palette.ai.emptyHint')}</div>
              </div>
            </div>
          )}
        </>
      )}

      {showEmailGroup && (
        <>
          <GroupHead
            title="Email"
            count={dedupedHits.length}
            busy={emailBusy}
            busyLabel={t('palette.searching')}
          />
          {dedupedHits.length > 0 ? (
            <div className="space-y-px">
              {dedupedHits.map((h, i) => {
                const idx = FLAT_BASE + emailStart + i
                return (
                  <EmailHitRow
                    key={h.internal_id}
                    hit={h}
                    flatIdx={idx}
                    selected={idx - FLAT_BASE === highlight}
                    setHighlight={onRowHighlight}
                    queryTerms={queryTerms}
                    onActivate={() => onActivateHit(h)}
                  />
                )
              })}
            </div>
          ) : (
            <div className="px-2">
              <div className="empty-tile">
                {emailBusy ? (
                  <Loader2
                    size={18}
                    strokeWidth={1.75}
                    className="animate-spin text-ink-fg-3 motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : (
                  <SearchGlyph size={18} strokeWidth={1.75} className="text-ink-fg-3" aria-hidden />
                )}
                <div className="text-aux text-ink-fg-1">
                  {emailBusy ? t('palette.searching') : t('palette.email.emptyTitle')}
                </div>
                {!emailBusy && (
                  <div className="text-meta text-ink-fg-3">{t('palette.email.emptyHint')}</div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </ul>
  )
}

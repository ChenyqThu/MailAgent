// task 08-27 P4d —— 事项投影的详情形态（截止日 / 有计划时间的行动项）。
//
// 四样字段全部来自现成的事项详情端点，零后端新增：
//   下一步   🔴 必须用 `matterDerive.nextAction()` 从 items 就地算 —— `matter.next_action`
//            **只有清单端点 `GET /matters` 产出**，详情端点没有这个投影，直接读会恒空。
//   负责人   `matter.owner_id`（生产库里目前普遍是空串 ⇒ 显示「未指定」）。
//   阻塞点   items 里 kind='blocker' 且未删未完成的行；另把 health='off_track' 时的
//            `attention_reason` 一并摆出来（那是「这件事为什么在偏轨」的唯一说明）。
//   最近进展 include=progress 的最新一条（curated lane），配 `current_summary` 一句话。
//
// 🔴 queryKey 与 include 必须与 `MatterDetail.tsx` 那条**逐字一致**（同 key 共享缓存）：
// include 少一项就会往共享缓存里写一份缺 timeline 的响应，事项域那边的时间线当场空掉。

import { ArrowUpRight } from 'lucide-react'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import type { AgendaEntry } from '@shared/api/types'
import type { MatterItem, MatterProgress } from '@shared/api/types/matter'
import { useMattersApi } from '@shared/components/matters/hooks'
import { useMatterNavigation } from '@shared/components/matters/navigation'
import { formatMatterAgo, nextAction } from '@shared/lib/matterDerive'
import { qk } from '@shared/lib/queryKeys'
import { navEntry, navigateToNavEntry } from '@shared/navigation/registry'

import { MetaRow } from './MetaRow'
import { ProjectionShell } from './ProjectionShell'

/** 未完成的阻塞条目（软删的不算，做完的也不算 —— 它已经不阻塞了）。 */
function openBlockers(items: readonly MatterItem[]): MatterItem[] {
  return items.filter(
    (item) => item.kind === 'blocker' && item.deleted_at === null && item.status !== 'done'
  )
}

/** 最新一条进展：按叙事时间取，不假设服务端顺序。 */
function latestProgress(progress: readonly MatterProgress[]): MatterProgress | null {
  let head: MatterProgress | null = null
  for (const row of progress) {
    if (head === null || row.happened_at > head.happened_at) head = row
  }
  return head
}

export function MatterEntryDetail({
  entry,
  onClose
}: {
  entry: AgendaEntry
  onClose: () => void
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const api = useMattersApi()
  // 相对时间的基准在挂载时冻结（react-hooks/purity: render 期间不许调 Date.now()）——
  // 与 MatterList / MatterDetail 同一模式。
  const [mountedNow] = useState(() => Date.now())
  const matterId = entry.matterId ?? null

  const detail = useQuery({
    queryKey: qk.matters.detail(matterId ?? ''),
    queryFn: async () => {
      if (matterId === null) throw new Error('missing matterId')
      return api.get(matterId, ['items', 'progress', 'timeline'])
    },
    enabled: matterId !== null,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })

  const matter = detail.data?.matter ?? null
  const items = detail.data?.items ?? []
  const progress = detail.data?.progress ?? []
  const action = matter ? nextAction(matter, items) : null
  const blockers = openBlockers(items)
  const offTrackReason =
    matter?.health === 'off_track' && matter.attention_reason ? matter.attention_reason : null
  const recent = latestProgress(progress)
  const owner = matter?.owner_id?.trim() ?? ''
  const item = entry.itemId ? (items.find((row) => String(row.id) === entry.itemId) ?? null) : null

  const handleJump = (): void => {
    if (matterId !== null) useMatterNavigation.getState().open(matterId)
    onClose()
    navigateToNavEntry(navigate, navEntry('matters'))
  }

  return (
    <ProjectionShell
      entry={entry}
      onClose={onClose}
      roleLabel={t('calendar.detail.matterRole', '事项投影')}
      timeLabel={t('calendar.detail.dueTime', '截止时间')}
      note={t('calendar.detail.matterNote', '这是事项的投影 —— 改时间或内容要去事项里改')}
      jumpLabel={t('calendar.detail.goMatter', '去事项')}
      jumpTitle={t('calendar.detail.goMatterTitle', '在事项域打开这件事')}
      jumpIcon={<ArrowUpRight size={13} strokeWidth={2} />}
      onJump={handleJump}
    >
      <MetaRow label={t('calendar.detail.matter', '事项')}>
        {matter ? (
          <span>
            {matter.title}
            <span className="ml-1.5 font-mono text-[11px] text-ink-fg-3">{matter.public_id}</span>
          </span>
        ) : (
          <span className="font-mono text-[12.5px] text-ink-fg-2">{matterId ?? '—'}</span>
        )}
      </MetaRow>

      {entry.itemId && (
        <MetaRow label={t('calendar.detail.item', '行动项')}>
          <span>{item?.title ?? entry.title}</span>
        </MetaRow>
      )}

      {detail.isError ? (
        // 取不到就说清楚取不到 + 给重试，不留一个看着像「这件事什么都没有」的空壳。
        <MetaRow label={t('calendar.detail.loadFailedLabel', '事项详情')}>
          <div className="text-fail">{t('calendar.detail.loadFailed', '没取到这件事的详情')}</div>
          <button
            type="button"
            className="link-row cal-linkbtn mt-1"
            onClick={() => void detail.refetch()}
          >
            {t('calendar.detail.retry', '重试')}
          </button>
        </MetaRow>
      ) : matterId !== null && detail.isPending ? (
        <MetaRow label={t('calendar.detail.nextStep', '下一步')}>
          <span className="skel" style={{ width: '70%' }} />
          <span className="skel" style={{ width: '45%' }} />
        </MetaRow>
      ) : (
        <>
          <MetaRow label={t('calendar.detail.nextStep', '下一步')}>
            {action ? (
              <span>
                {action.title !== null
                  ? t(`matters.nextAction.${action.kind}`, { title: action.title })
                  : t(`matters.nextAction.${action.kind}`)}
              </span>
            ) : (
              <span className="empty-field">—</span>
            )}
          </MetaRow>

          <MetaRow label={t('calendar.detail.owner', '负责人')}>
            {owner ? (
              <span>{owner}</span>
            ) : (
              <span className="empty-field">{t('calendar.detail.ownerUnset', '未指定')}</span>
            )}
          </MetaRow>

          <MetaRow label={t('calendar.detail.blockers', '阻塞点')}>
            {blockers.length > 0 || offTrackReason ? (
              <div>
                {blockers.map((row) => (
                  <div key={row.id}>{row.title}</div>
                ))}
                {offTrackReason && <div className="text-ink-fg-2">{offTrackReason}</div>}
              </div>
            ) : (
              <span className="empty-field">{t('calendar.detail.blockersNone', '没有')}</span>
            )}
          </MetaRow>

          <MetaRow label={t('calendar.detail.recentProgress', '最近进展')}>
            {recent ? (
              <div>
                <div>{recent.title}</div>
                <div className="text-[11.5px] text-ink-fg-2">
                  {formatMatterAgo(recent.happened_at, mountedNow, i18n.language || 'zh-CN')}
                </div>
              </div>
            ) : matter?.current_summary ? (
              <div className="desc-box scrollbar-thin">{matter.current_summary}</div>
            ) : (
              <span className="empty-field">{t('calendar.detail.progressNone', '还没有进展')}</span>
            )}
          </MetaRow>
        </>
      )}
    </ProjectionShell>
  )
}

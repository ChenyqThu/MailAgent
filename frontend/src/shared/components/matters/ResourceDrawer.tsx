import { useMutation } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Pin, RefreshCcw, Shield, Trash2, X } from 'lucide-react'

import { MATTER_ACCESS_POLICIES } from '@shared/api/types/matter'
import type {
  MatterAccessPolicy,
  MatterResourceListItem,
  MatterResourceSubscriptionState
} from '@shared/api/types/matter'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { errorMessage } from '@shared/lib/ipcErrors'
import { useActiveEmail } from '@shared/state/active-email'
import { toastError, toastSuccess } from '@shared/state/toast'

import { isMatterResourceAvailable } from './matterResource'
import { useMattersApi } from './hooks'

interface ResourceDrawerProps {
  open: boolean
  matterId: string
  matterVersion: number
  item: MatterResourceListItem | null
  onClose(): void
  onChanged(): void
}

export function ResourceDrawer({
  open,
  matterId,
  matterVersion,
  item,
  onClose,
  onChanged
}: ResourceDrawerProps): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMattersApi()
  const navigate = useNavigate()
  const setActiveEmail = useActiveEmail((state) => state.setActive)

  const patch = useMutation({
    mutationFn: (input: {
      access_policy?: MatterAccessPolicy
      pinned?: boolean
      sub_state?: MatterResourceSubscriptionState
      scope?: 'resource'
    }) => {
      if (!item) return Promise.reject(new Error('Resource is not loaded'))
      return api.patchResource(matterId, item.resource.id, input, { expectedVersion: matterVersion })
    },
    onSuccess: (_result, input) => {
      onChanged()
      if (input.access_policy) toastSuccess(t('matters.resource.visibilityChanged'))
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const unlink = useMutation({
    mutationFn: () => {
      if (!item) return Promise.reject(new Error('Resource is not loaded'))
      return api.unlinkResource(matterId, item.resource.id, {
        expectedVersion: matterVersion,
        reason: 'user_unlinked_resource'
      })
    },
    onSuccess: () => {
      toastSuccess(t('matters.resource.unlinkedNoDelete'))
      onChanged()
      onClose()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  if (!open || !item) return null

  const resource = item.resource
  const link = item.link
  const available = isMatterResourceAvailable(item)
  const mailId = resource.kind === 'email' && resource.external_key.startsWith('email:')
    ? Number(resource.external_key.slice('email:'.length))
    : null
  const metadata = resource.metadata ?? {}
  const metaLabel = typeof metadata.sender === 'string'
    ? metadata.sender
    : typeof metadata.organizer === 'string'
      ? metadata.organizer
      : resource.provider

  const openSource = (): void => {
    if (mailId !== null && Number.isFinite(mailId)) {
      setActiveEmail(mailId)
      void navigate({ to: '/' })
      onClose()
      return
    }
    if (resource.canonical_url) window.open(resource.canonical_url, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <button type="button" aria-label={t('common.close')} onClick={onClose} className="absolute inset-0 bg-black/35" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="matter-resource-drawer-title"
        className="absolute inset-y-0 right-0 flex w-[440px] max-w-[92vw] flex-col border-l border-ink-border bg-ink-1 shadow-md"
      >
        <header className="flex items-start gap-3 border-b border-ink-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="matter-resource-drawer-title" className="truncate text-title font-semibold text-ink-fg">
              {resource.title || resource.external_key}
            </h2>
            <p className="mt-1 truncate text-meta text-ink-fg-3">
              {t(`matters.context.kind.${resource.kind}`)} · {metaLabel}
            </p>
          </div>
          <button type="button" onClick={openSource} disabled={!resource.canonical_url && mailId === null} className="rounded-[var(--r-ctl)] p-2 hover:bg-ink-3 disabled:opacity-40" title={t('matters.resource.openSource')}>
            <ExternalLink size={15} />
          </button>
          <button type="button" onClick={onClose} className="rounded-[var(--r-ctl)] p-2 hover:bg-ink-3"><X size={16} /></button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 scrollbar-thin">
          {!available ? (
            <div className="rounded-[var(--r-card)] border border-fail/25 bg-fail/5 px-3 py-2 text-aux text-fail">
              {t('matters.context.unavailable')}
            </div>
          ) : null}

          <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-4">
            <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-3 text-aux">
              <Meta label={t('matters.resource.type')} value={t(`matters.context.kind.${resource.kind}`)} />
              <Meta label={t('matters.resource.lastActivity')} value={resource.last_checked_at ? new Date(resource.last_checked_at).toLocaleString() : '—'} />
              {resource.revision ? <Meta label={t('matters.resource.revision')} value={resource.revision} /> : null}
              <Meta label={t('matters.resource.linkMethod')} value={t('matters.resource.manualConfirmed')} />
              <Meta label={t('matters.resource.visibility')} value={t(`matters.resource.access.${resource.access_policy}`)} />
            </dl>
          </section>

          <section>
            <h3 className="mb-2 text-aux font-semibold text-ink-fg">{t('matters.resource.visibility')}</h3>
            <SegmentedControl<MatterAccessPolicy>
              value={resource.access_policy}
              onChange={(accessPolicy) => patch.mutate({ access_policy: accessPolicy, scope: 'resource' })}
              options={MATTER_ACCESS_POLICIES.map((value) => ({ value, label: t(`matters.resource.access.${value}`) }))}
              ariaLabel={t('matters.resource.visibility')}
            />
            <p className="mt-2 text-meta leading-5 text-ink-fg-3">{t('matters.resource.visibilityGlobalHint')}</p>
          </section>

          <section>
            <h3 className="mb-2 text-aux font-semibold text-ink-fg">{t('matters.resource.cachedExcerpt')}</h3>
            <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-4">
              {resource.provider === 'mailagent' && resource.kind === 'email' ? (
                <button type="button" onClick={openSource} className="mb-3 inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1.5 text-aux hover:bg-ink-3">
                  <ExternalLink size={13} />{t('matters.resource.openEmail')}
                </button>
              ) : null}
              <p className="text-aux leading-5 text-ink-fg-2">{t('matters.resource.authoritativeSource')}</p>
              <div className="mt-3 flex items-start gap-2 border-t border-ink-border pt-3 text-meta leading-5 text-ink-fg-2">
                <Shield size={13} className="mt-0.5 shrink-0 text-ok" />
                <span>{t('matters.resource.untrusted')}</span>
              </div>
            </div>
          </section>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-ink-border bg-ink-2 px-5 py-4">
          <button type="button" onClick={() => patch.mutate({ pinned: !link.pinned })} className="inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border px-3 py-2 text-aux hover:bg-ink-3">
            <Pin size={13} />{t(link.pinned ? 'matters.context.unpin' : 'matters.context.pin')}
          </button>
          {resource.kind === 'thread' ? (
            <button
              type="button"
              onClick={() => patch.mutate({ sub_state: link.sub_state === 'active' ? 'paused' : 'active' })}
              className="inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border px-3 py-2 text-aux hover:bg-ink-3"
            >
              <RefreshCcw size={13} />{t(link.sub_state === 'active' ? 'matters.resource.pauseSubscription' : 'matters.resource.resumeSubscription')}
            </button>
          ) : null}
          <button type="button" onClick={() => unlink.mutate()} className="ml-auto inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] px-3 py-2 text-aux text-fail hover:bg-fail/10">
            <Trash2 size={13} />{t('matters.resource.unlink')}
          </button>
        </footer>
      </aside>
    </div>
  )
}

function Meta({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <>
      <dt className="text-ink-fg-3">{label}</dt>
      <dd className="min-w-0 break-words text-ink-fg-1">{value}</dd>
    </>
  )
}

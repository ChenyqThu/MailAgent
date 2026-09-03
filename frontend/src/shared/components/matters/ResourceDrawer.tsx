import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  Info,
  Layers,
  Link2,
  Pin,
  RefreshCcw,
  Shield,
  X
} from 'lucide-react'

import { MATTER_ACCESS_POLICIES } from '@shared/api/types/matter'
import type {
  MatterAccessPolicy,
  MatterResourceListItem,
  MatterResourceSubscriptionState,
  MatterResourceVersion
} from '@shared/api/types/matter'
import { navigateToLibraryFile } from '@shared/components/library/deeplink'
import { SegmentedControl } from '@shared/components/ui/segmented'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { useActiveEmail } from '@shared/state/active-email'
import { toastError, toastSuccess } from '@shared/state/toast'

import {
  DOC_PROVIDER_ICONS,
  LIBRARY_RESOURCE_ICON,
  RESOURCE_KIND_ICONS,
  isLibraryFileResource,
  isMatterResourceAvailable,
  libraryResourceFileId
} from './matterResource'
import { useMattersApi } from './hooks'
import { useMatterMutation } from './matterMutation'
import { useMatterUndoToast } from './useMatterUndoToast'

interface ResourceDrawerProps {
  open: boolean
  matterId: string
  matterVersion: number
  item: MatterResourceListItem | null
  onClose(): void
  onChanged(): void
}

/** 资料摘录取自 metadata，key 顺序与 Python 侧 `context_snapshot` 一致
 *  （`service.py`: cached_excerpt → excerpt → text_excerpt → snippet）。
 *
 *  🔴 这一段此前写的是 `resource.excerpt` —— 而 `resource` 表根本没有这一列，后端也从不
 *  在 list 投影里产出它，所以「概要」一直是空的：那次 dogfood 修复从未真正生效，只是
 *  类型检查没照到（根 tsconfig 是 `files: []` + references，裸跑 tsc 什么都不查）。
 *
 *  🔴 M5 起「缓存摘录」与「资料摘要」是**两个概念**（H3§5.1）：摘要 = `resource.sum` 的
 *  一到三句概括（v56 真列），摘录 = 这里的原始缓存文本。设计原型的面板只画了摘要；摘录
 *  保留成独立小节且只在真有值时渲染 —— 删掉它会把 0811 dogfood「这里看不到内容」的缺口
 *  在 `sum` 为空、摘录非空的资料上还回去。 */
const EXCERPT_KEYS = ['cached_excerpt', 'excerpt', 'text_excerpt', 'snippet'] as const

function resourceExcerpt(metadata: Record<string, unknown> | null | undefined): string | null {
  for (const key of EXCERPT_KEYS) {
    const value = metadata?.[key]
    if (typeof value === 'string' && value.trim()) return value.slice(0, 2000)
  }
  return null
}

/** 来源名的兜底：`notion` → `Notion`。i18n 只收了本仓自己产出的两个 provider
 *  （`mailagent` / `web`，见 `resource_identity.py` 与 `resource_proposal.py`），
 *  外部 provider 直接把落库值首字母大写交出去 —— 不编译不出来的中文名。
 *  批 8（V3-19）定下 canonical 词表后，这一处换成查表即可。 */
function providerFallbackLabel(provider: string): string {
  const value = provider.trim()
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '—'
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
  const router = useRouter()
  const setActiveEmail = useActiveEmail((state) => state.setActive)
  const pushUndoToast = useMatterUndoToast()

  const patch = useMatterMutation({
    matterId,
    mutationFn: (input: {
      access_policy?: MatterAccessPolicy
      pinned?: boolean
      sub_state?: MatterResourceSubscriptionState
      scope?: 'resource'
    }) => {
      if (!item) return Promise.reject(new Error('Resource is not loaded'))
      return api.patchResource(matterId, item.resource.id, input, {
        expectedVersion: matterVersion
      })
    },
    onSuccess: (_result, input) => {
      onChanged()
      if (input.access_policy) toastSuccess(t('matters.resource.visibilityChanged'))
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const unlink = useMatterMutation({
    matterId,
    mutationFn: () => {
      if (!item) return Promise.reject(new Error('Resource is not loaded'))
      return api.unlinkResource(matterId, item.resource.id, {
        expectedVersion: matterVersion,
        reason: 'user_unlinked_resource'
      })
    },
    // G-33 —— 同 MatterContextTab 行级解除：服务端返回 restore descriptor，toast 带撤销。
    onSuccess: (result) => {
      pushUndoToast(t('matters.resource.unlinkedNoDelete'), result, matterId)
      onChanged()
      onClose()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  // G-32 —— 设计 §2.x 抽屉 = `slideIn 220ms`（translateX 24px + 淡入）+ 遮罩 `fadeIn`。
  // `syncBackdrop` 让遮罩与面板同时长进来，否则遮罩 120ms 先"啪"一下、面板再慢慢滑。
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: '[data-anim-card]',
    backdrop: '[data-anim-backdrop]',
    from: { autoAlpha: 0, x: 24 },
    to: { x: 0 },
    syncBackdrop: true
  })
  // 🔴 调用方是 `open={drawerItem !== null}` + `item={drawerItem}` —— 两者同时归 null，
  // 退场期间面板会瞬间空掉。留住最后一份非空 item（同 EventDetailDrawer 的 RSVP 卡对
  // `pendingRsvp` 的处理），只影响这 220ms 的渲染，写操作全部走 props 上的 `item`。
  const lastItemRef = useRef(item)
  if (item) lastItemRef.current = item
  const shown = item ?? lastItemRef.current

  // V3-22 —— 版本轨迹只在抽屉打开时拉。挂在 `listResources` 上会变成每份资料一次扇出
  // （ARCHITECTURE §7.1 列表性能铁律）；而列表行本来也不显示它。
  const trailResourceId = shown?.resource.id ?? null
  const versionTrail = useQuery({
    queryKey: [...qk.matters.detail(matterId), 'resource-versions', trailResourceId] as const,
    queryFn: () => api.listResourceVersions(matterId, trailResourceId as number),
    enabled: open && trailResourceId !== null,
    staleTime: 30_000
  })
  const [expandedVersions, setExpandedVersions] = useState<readonly number[]>([])

  if (!shouldRender || !shown) return null

  const resource = shown.resource
  const link = shown.link
  const available = isMatterResourceAvailable(shown)
  const mailId =
    resource.kind === 'email' && resource.external_key.startsWith('email:')
      ? Number(resource.external_key.slice('email:'.length))
      : null
  // P2-L10（design §9.2「打开」段）—— 第三条打开分支。🔴 判据是 `external_key` 前缀而不是
  // kind：库文件与邮件附件同为 `kind='file'`，按 kind 分会把 `attachment:{id}` 也推去
  // `/library?file=<附件 id>`（另一套 id 空间，落地只会 toast「文件已不在资料库」）。
  // 🔴 `!!` 不是装饰：`isLibraryFile` 下面要进图标派生式，而 react-hooks/static-components
  // 只认语法上可证明是布尔的表达式（比较 / `!`），函数调用的结果先存进局部变量也会顺着数据流
  // 被判红。详见 matterResource.ts 文末。
  const isLibraryFile = !!isLibraryFileResource(resource.kind, resource.external_key)
  const libraryFileId = isLibraryFile ? libraryResourceFileId(resource.external_key) : null
  // 🔴 logo 接缝（V3-19 / 批 8）：整个面板**只有这一个**取图标的派生式，头部方块与
  // 「来源」属性行共用它。批 8 把它换成 appLogos 表的成员索引即可，调用点不用再找。
  // 成员索引而非查表函数：eslint react-hooks/static-components 只认前者（见 matterResource.ts）。
  const SourceIcon =
    (isLibraryFile && LIBRARY_RESOURCE_ICON) ||
    (resource.kind === 'doc' && DOC_PROVIDER_ICONS[resource.provider.toLowerCase()]) ||
    RESOURCE_KIND_ICONS[resource.kind]
  const KindIcon = (isLibraryFile && LIBRARY_RESOURCE_ICON) || RESOURCE_KIND_ICONS[resource.kind]
  const canonicalUrl = resource.canonical_url
  const canOpenSource =
    Boolean(canonicalUrl) || (mailId !== null && Number.isFinite(mailId)) || libraryFileId !== null
  const metadata = resource.metadata ?? {}
  const excerpt = resourceExcerpt(metadata)
  // V3-16 —— 摘要是 v56 真列（批 M4），不是 metadata 里的缓存摘录。三键可能整组缺失
  // （老 fixture / 老后端），一律按 `?? null` 读；空白串也算空态。
  const summary = resource.sum?.trim() ? resource.sum : null
  const summarySource = resource.sum_src ?? null
  const sourceName = t(`matters.resource.providerNames.${resource.provider.toLowerCase()}`, {
    defaultValue: providerFallbackLabel(resource.provider)
  })
  // V3-22 —— 空态分三种，🔴 有意不合成一句「暂无记录」：
  //   · emptyNotTracked   这类资料结构上不跟踪版本（判据来自服务端 `tracks_versions`，
  //                       不在前端按 kind 推 —— 那会是第二处真源）。合成一句会让人以为
  //                       文档 / 邮件只是"还没检出过"，等下去也等不到；
  //   · emptyNeverChecked 会跟踪，但一次都没抓取过（`revision` 为 null）—— 抓一次就有；
  //   · 有当前版本但没有历史行 → 不是空态：照常渲染「当前」行，另附一句说明。
  // 服务端还没答上来时（loading / 出错）整区不渲染，宁可少说也不猜。
  const trail = versionTrail.data ?? null
  const history: MatterResourceVersion[] = trail?.items ?? []
  const trailEmptyReason: 'emptyNotTracked' | 'emptyNeverChecked' | null = !trail?.tracks_versions
    ? 'emptyNotTracked'
    : resource.revision === null
      ? 'emptyNeverChecked'
      : null
  // 库文件的「来源」说的是资料库，不是 provider 词表里的「本地邮件库」（那是邮件那一档）。
  const openInSourceLabel = t('matters.resource.openInSource', {
    name: libraryFileId !== null ? t('library.matter.tabLibrary') : sourceName
  })
  const metaLabel =
    typeof metadata.sender === 'string'
      ? metadata.sender
      : typeof metadata.organizer === 'string'
        ? metadata.organizer
        : resource.provider
  // V3-21 —— 非默认可见性档要说清后果。设计只画了「仅元数据」一档；本仓 access_policy 是
  // 三值契约，第三档不解释后果就是个哑开关，故一并补。
  const visibilityConsequence =
    resource.access_policy === 'metadata_only'
      ? t('matters.resource.metadataOnlyConsequence')
      : resource.access_policy === 'excluded'
        ? t('matters.resource.excludedConsequence')
        : null

  const openSource = (): void => {
    if (libraryFileId !== null) {
      // 深链 `/library?file={id}`：进域 + 展开所在文件夹 + 选中；文件 missing / trashed 由
      // 落地页自己 toast（design §9.5，与通知中心、入库回执三处同一个去处）。
      navigateToLibraryFile(router, libraryFileId)
      onClose()
      return
    }
    if (mailId !== null && Number.isFinite(mailId)) {
      // navTarget：跨域跳转目标可能不在当前列表，豁免 active-reset（08-27 标签工作区）。
      setActiveEmail(mailId, { navTarget: true })
      void navigate({ to: '/' })
      onClose()
      return
    }
    if (canonicalUrl) window.open(canonicalUrl, '_blank', 'noopener,noreferrer')
  }

  const openCanonicalUrl = (): void => {
    if (canonicalUrl) window.open(canonicalUrl, '_blank', 'noopener,noreferrer')
  }

  const copyCanonicalUrl = async (): Promise<void> => {
    if (!canonicalUrl) return
    try {
      await navigator.clipboard.writeText(canonicalUrl)
      toastSuccess(t('matters.resource.linkCopied'))
    } catch (error) {
      toastError(t('matters.resource.copyLinkFailed'), errorMessage(error))
    }
  }

  return (
    <div ref={scopeRef} className="fixed inset-0 z-50" role="presentation">
      <button
        type="button"
        data-anim-backdrop
        aria-label={t('common.close')}
        onClick={onClose}
        className="absolute inset-0 bg-black/35"
      />
      <aside
        data-anim-card
        role="dialog"
        aria-modal="true"
        aria-labelledby="matter-resource-drawer-title"
        className="absolute inset-y-0 right-0 flex w-[440px] max-w-[92vw] flex-col border-l border-ink-border bg-ink-1 shadow-md"
      >
        {/* 头部照设计 §5.2：来源方块 + 标题/副行 + 右上跳转 + 关闭。
            标题此前是整块跳转按钮（0811 dogfood），那次改动的内核是「不要恒 disabled 又
            不解释原因的死控件」—— 这里用**条件渲染**守住同一条：不可跳时右上按钮根本不出现，
            副行照旧写明「未提供来源链接」。 */}
        <header className="flex items-start gap-3 border-b border-ink-border-soft px-5 py-4">
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-[var(--r-ctl)] bg-ink-4 text-ink-fg-2">
            <SourceIcon size={14} />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="matter-resource-drawer-title"
              title={resource.title || resource.external_key}
              className="truncate text-body font-semibold text-ink-fg"
            >
              {resource.title || resource.external_key}
            </h2>
            <p className="mt-1 truncate text-meta text-ink-fg-3">
              {t(`matters.context.kind.${resource.kind}`)} · {metaLabel}
              {canOpenSource ? null : ` · ${t('matters.resource.noSourceLink')}`}
            </p>
          </div>
          {canOpenSource ? (
            <button
              type="button"
              onClick={openSource}
              title={openInSourceLabel}
              aria-label={openInSourceLabel}
              className="rounded-[var(--r-ctl)] p-2 text-ink-fg-2 transition-colors duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg"
            >
              <ExternalLink size={15} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={onClose}
            className="rounded-[var(--r-ctl)] p-2 hover:bg-ink-3"
          >
            <X size={16} />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 scrollbar-thin">
          {!available ? (
            <div className="rounded-[var(--r-card)] border border-fail/25 bg-fail/5 px-3 py-2 text-aux text-fail">
              {t('matters.context.unavailable')}
            </div>
          ) : null}

          {/* V3-18 —— 属性行：类型 / 来源 / 原文地址 / 最近活动 / 关联方式 / 内容可见性，每行带 icon。 */}
          <section className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-4">
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3.5 gap-y-2.5 text-meta">
              <Meta icon={<KindIcon size={12} />} label={t('matters.resource.type')}>
                {t(`matters.context.kind.${resource.kind}`)}
              </Meta>
              <Meta icon={<Layers size={12} />} label={t('matters.resource.source')}>
                <SourceIcon size={13} className="shrink-0 text-ink-fg-2" />
                <span className="truncate">
                  {sourceName}
                  {resource.revision ? ` · ${resource.revision}` : ''}
                </span>
              </Meta>
              {canonicalUrl ? (
                <Meta icon={<Link2 size={12} />} label={t('matters.resource.canonicalUrl')}>
                  {/* 设计是 `<a href="#" onClick={preventDefault}>` —— renderer 里一律用 button
                      开外链（`window.open` + noopener），避免任何形式的窗口内导航。 */}
                  <button
                    type="button"
                    onClick={openCanonicalUrl}
                    title={canonicalUrl}
                    className="min-w-0 flex-1 truncate text-left font-mono text-micro text-ink-fg-1 transition-colors duration-fast ease-standard hover:text-coral"
                  >
                    {canonicalUrl}
                  </button>
                  <button
                    type="button"
                    onClick={openCanonicalUrl}
                    title={openInSourceLabel}
                    aria-label={openInSourceLabel}
                    className="shrink-0 rounded-[var(--r-ctl)] p-1 text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg"
                  >
                    <ExternalLink size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void copyCanonicalUrl()}
                    title={t('matters.resource.copyLink')}
                    aria-label={t('matters.resource.copyLink')}
                    className="shrink-0 rounded-[var(--r-ctl)] p-1 text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg"
                  >
                    <Copy size={12} />
                  </button>
                </Meta>
              ) : null}
              <Meta icon={<Clock size={12} />} label={t('matters.resource.lastActivity')}>
                <span className="font-mono">
                  {resource.last_checked_at
                    ? new Date(resource.last_checked_at).toLocaleString()
                    : '—'}
                </span>
              </Meta>
              {/* 设计稿这一行写死「手动关联 · 已确认」（原型 mock）。建议态资料上那是谎报，
                  判据与 `MatterContextTab::ResourceRow` 同源：`link.confirmed_at`。 */}
              <Meta icon={<Link2 size={12} />} label={t('matters.resource.linkMethod')}>
                {t(
                  link.confirmed_at !== null
                    ? 'matters.resource.manualConfirmed'
                    : 'matters.resource.agentSuggested'
                )}
              </Meta>
              {/* V3-21 —— 可见性从独立 section 收进属性行。三档不是两档：`access_policy` 是
                  后端三值契约，砍成两档会让「排除」态既进不去也退不出。 */}
              <Meta icon={<Eye size={12} />} label={t('matters.resource.visibility')}>
                <SegmentedControl<MatterAccessPolicy>
                  value={resource.access_policy}
                  onChange={(accessPolicy) =>
                    patch.mutate({ access_policy: accessPolicy, scope: 'resource' })
                  }
                  options={MATTER_ACCESS_POLICIES.map((value) => ({
                    value,
                    label: t(`matters.resource.access.${value}`)
                  }))}
                  ariaLabel={t('matters.resource.visibility')}
                />
              </Meta>
            </dl>
            <div className="mt-3 space-y-1.5 border-t border-ink-border-soft pt-3 text-micro leading-[1.65] text-ink-fg-3">
              {visibilityConsequence ? <p>{visibilityConsequence}</p> : null}
              <p>{t('matters.resource.visibilityGlobalHint')}</p>
            </div>
          </section>

          {/* V3-16 —— 资料摘要：这份资料**在说什么**的一到三句概括（`resource.sum`），
              标题右侧标注它的出处。与下面的「缓存摘录」是两个概念。 */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-meta font-semibold uppercase tracking-[0.08em] text-ink-fg-2">
                {t('matters.resource.summary')}
              </h3>
              {summary ? (
                <span className="ml-auto shrink-0 text-micro text-ink-fg-3">
                  {t(
                    summarySource === 'mail'
                      ? 'matters.resource.summaryFromMail'
                      : 'matters.resource.summaryFromAgent'
                  )}
                </span>
              ) : null}
            </div>
            {summary ? (
              // 摘要来自外部内容/模型输出，按不可信数据渲染：纯文本 + 保留换行，不跑
              // markdown/HTML 管线。
              <p className="whitespace-pre-wrap break-words rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2 p-3.5 text-body leading-[1.75] text-ink-fg-1">
                {summary}
              </p>
            ) : (
              <p className="rounded-[var(--r-card)] border border-dashed border-ink-border bg-ink-2 p-3.5 text-meta leading-[1.7] text-ink-fg-3">
                {t('matters.resource.summaryEmpty')}
              </p>
            )}
            {/* V3-17 —— 原来卡内的两段固定说明降级为框外小字。 */}
            <div className="mt-2.5 space-y-1.5 text-micro leading-[1.65] text-ink-fg-3">
              <p className="flex gap-1.5">
                <Info size={12} className="mt-0.5 shrink-0" />
                <span>{t('matters.resource.authoritativeSource')}</span>
              </p>
              <p className="flex gap-1.5">
                <Shield size={12} className="mt-0.5 shrink-0" />
                <span>{t('matters.resource.untrusted')}</span>
              </p>
            </div>
          </section>

          {excerpt ? (
            <section>
              <h3 className="mb-2 text-meta font-semibold uppercase tracking-[0.08em] text-ink-fg-2">
                {t('matters.resource.cachedExcerpt')}
              </h3>
              <p className="whitespace-pre-wrap break-words rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2 p-3.5 text-meta leading-[1.7] text-ink-fg-2">
                {excerpt}
              </p>
            </section>
          ) : null}

          {/* V3-22 —— 版本轨迹。原文不在本地 ⇒ 没有历史正文，能留的只有「当时读到的是哪
              一版 + 当时我们自己写的那份摘要」。
              🔴 当前版本**不来自轨迹表**：它就是 `resource` 行自己（同一事实只有一处真源），
              历史行才来自 v57 的 `resource_version`。 */}
          {trail === null ? null : (
            <section>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-meta font-semibold uppercase tracking-[0.08em] text-ink-fg-2">
                  {t('matters.resource.versionTrail.title')}
                </h3>
                {history.length ? (
                  <span className="ml-auto shrink-0 text-micro text-ink-fg-3">
                    {t('matters.resource.versionTrail.historyCount', { count: history.length })}
                  </span>
                ) : null}
              </div>
              {trailEmptyReason ? (
                <p className="rounded-[var(--r-card)] border border-dashed border-ink-border bg-ink-2 p-3.5 text-meta leading-[1.7] text-ink-fg-3">
                  {t(`matters.resource.versionTrail.${trailEmptyReason}`)}
                </p>
              ) : (
                <>
                  <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border-soft bg-ink-2">
                    <TrailRow
                      revision={resource.revision}
                      timestamp={resource.last_checked_at}
                      timestampLabel={t('matters.resource.versionTrail.checkedAt')}
                      isCurrent
                      currentLabel={t('matters.resource.versionTrail.current')}
                      revisionLabel={t('matters.resource.revision')}
                    />
                    {history.map((version) => (
                      <TrailRow
                        key={version.id}
                        revision={version.revision}
                        timestamp={version.superseded_at}
                        timestampLabel={t('matters.resource.versionTrail.supersededAt')}
                        revisionLabel={t('matters.resource.revision')}
                        diffText={version.diff_text}
                        archivedSummary={version.sum}
                        archivedSummaryLabel={t('matters.resource.versionTrail.archivedSummary')}
                        archivedSummarySourceLabel={
                          version.sum_src
                            ? t(
                                version.sum_src === 'mail'
                                  ? 'matters.resource.summaryFromMail'
                                  : 'matters.resource.summaryFromAgent'
                              )
                            : null
                        }
                        expanded={expandedVersions.includes(version.id)}
                        onToggle={() =>
                          setExpandedVersions((ids) =>
                            ids.includes(version.id)
                              ? ids.filter((id) => id !== version.id)
                              : [...ids, version.id]
                          )
                        }
                      />
                    ))}
                  </div>
                  {history.length ? null : (
                    <p className="mt-2 text-micro leading-[1.65] text-ink-fg-3">
                      {t('matters.resource.versionTrail.emptyNoHistory')}
                    </p>
                  )}
                  <p className="mt-2.5 flex gap-1.5 text-micro leading-[1.65] text-ink-fg-3">
                    <Info size={12} className="mt-0.5 shrink-0" />
                    <span>{t('matters.resource.versionTrail.footnote', { name: sourceName })}</span>
                  </p>
                </>
              )}
            </section>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-ink-border-soft bg-ink-2 px-5 py-4">
          <button
            type="button"
            onClick={() => patch.mutate({ pinned: !link.pinned })}
            className="inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border px-3 py-2 text-aux hover:bg-ink-3"
          >
            <Pin size={13} />
            {t(link.pinned ? 'matters.context.unpin' : 'matters.context.pin')}
          </button>
          {/* 🔴 thread 专属的订阅开关：设计原型里没有这个功能，「设计没画」≠「要删」。 */}
          {resource.kind === 'thread' ? (
            <button
              type="button"
              onClick={() =>
                patch.mutate({ sub_state: link.sub_state === 'active' ? 'paused' : 'active' })
              }
              className="inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] border border-ink-border px-3 py-2 text-aux hover:bg-ink-3"
            >
              <RefreshCcw size={13} />
              {t(
                link.sub_state === 'active'
                  ? 'matters.resource.pauseSubscription'
                  : 'matters.resource.resumeSubscription'
              )}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => unlink.mutate()}
            className="ml-auto inline-flex items-center gap-1.5 rounded-[var(--r-ctl)] px-3 py-2 text-aux text-fail hover:bg-fail/10"
          >
            <X size={13} />
            {t('matters.resource.unlink')}
          </button>
        </footer>
      </aside>
    </div>
  )
}

/** 版本轨迹的一行。当前版本与历史版本共用它 —— 两者的差别只是「有没有可展开的当时摘要」
 *  与时间戳的含义，不值得两套 markup。
 *
 *  `revision` 是内容 sha256（`fetch_url_resource` 把 hash 同时写进 revision 与
 *  content_hash），64 位全写出来只会挤爆行 —— 截前 8 位，`title` 给全量，并借
 *  `matters.resource.revision`（「版本」）说明这串东西是什么。 */
function TrailRow({
  revision,
  timestamp,
  timestampLabel,
  revisionLabel,
  isCurrent = false,
  currentLabel,
  diffText,
  archivedSummary,
  archivedSummaryLabel,
  archivedSummarySourceLabel,
  expanded = false,
  onToggle
}: {
  revision: string | null
  timestamp: number | null
  timestampLabel: string
  revisionLabel: string
  isCurrent?: boolean
  currentLabel?: string
  diffText?: string | null
  archivedSummary?: string | null
  archivedSummaryLabel?: string
  archivedSummarySourceLabel?: string | null
  expanded?: boolean
  onToggle?: () => void
}): React.ReactElement {
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <div className="flex gap-2.5 border-t border-ink-border-soft px-3 py-2.5 first:border-t-0">
      <span
        title={revision ? `${revisionLabel}: ${revision}` : revisionLabel}
        className={`w-[4.5rem] shrink-0 truncate font-mono text-micro ${
          isCurrent ? 'text-coral' : 'text-ink-fg-2'
        }`}
      >
        {revision ? revision.slice(0, 8) : '—'}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-micro text-ink-fg-3">
            {timestampLabel}
            {timestamp ? ` ${new Date(timestamp).toLocaleString()}` : ' —'}
          </span>
          {isCurrent && currentLabel ? (
            <span className="rounded-[var(--r-ctl)] bg-coral/12 px-1.5 py-0.5 text-micro text-coral">
              {currentLabel}
            </span>
          ) : null}
        </div>
        {diffText ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-meta leading-[1.6] text-ink-fg-1">
            {diffText}
          </p>
        ) : null}
        {archivedSummary && onToggle && archivedSummaryLabel ? (
          <>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="mt-1 inline-flex items-center gap-1 text-micro text-ink-fg-3 transition-colors duration-fast ease-standard hover:text-ink-fg"
            >
              <Chevron size={11} />
              {archivedSummaryLabel}
              {archivedSummarySourceLabel ? (
                <span className="text-ink-fg-3">· {archivedSummarySourceLabel}</span>
              ) : null}
            </button>
            {expanded ? (
              // 归档摘要同样是模型/外部内容，按不可信数据渲染：纯文本 + 保留换行。
              <p className="mt-1 whitespace-pre-wrap break-words border-l-2 border-ink-border pl-2 text-micro leading-[1.6] text-ink-fg-2">
                {archivedSummary}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

/** 一条属性行。`icon` 收的是**已经渲染好的节点**而不是组件类型 —— 后者会让调用点写成
 *  `<Meta icon={Clock} …>` 再在内部 `<Icon/>`，踩 eslint react-hooks/static-components。 */
function Meta({
  icon,
  label,
  children
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <>
      <dt className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink-fg-3">
        {icon}
        {label}
      </dt>
      <dd className="flex min-w-0 items-center gap-1.5 break-words text-ink-fg-1">{children}</dd>
    </>
  )
}

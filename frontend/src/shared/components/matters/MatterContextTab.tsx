import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  History,
  Link2,
  ListChecks,
  Pin,
  Plus,
  RefreshCcw,
  Shield,
  Target,
  Users,
  X
} from 'lucide-react'

import type {
  Matter,
  MatterItem,
  MatterResourceListItem,
  MatterStakeholder
} from '@shared/api/types/matter'
import { RecipientAvatar } from '@shared/components/email/compose/recipient-avatar'
import { useContactsEnabled } from '@shared/components/contacts/hooks'
import { useContactNavigation } from '@shared/components/contacts/navigation'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { CollapseChevron } from '@shared/components/ui/collapsible'
import { formatRelativeTime } from '@shared/format'
import { errorMessage } from '@shared/lib/ipcErrors'
import { useActiveEmail } from '@shared/state/active-email'
import { toastError } from '@shared/state/toast'

import {
  DOC_PROVIDER_ICONS,
  RESOURCE_KIND_ICONS,
  groupMatterResources,
  isMatterResourceAvailable
} from './matterResource'
import { useMattersApi } from './hooks'
import { MatterLinkResourceModal } from './MatterLinkResourceModal'
import type { MatterLinkResourceTab } from './MatterLinkResourceModal'
import { MatterRelationsSection } from './MatterRelationsSection'
import { useMatterMutation } from './matterMutation'
import { useMatterUndoToast } from './useMatterUndoToast'
import { MatterStakeholderPicker } from './MatterStakeholderPicker'
import { MatterStakeholderSection } from './MatterStakeholderSection'
import {
  MatterSuggestedResourceActions,
  MatterSuggestedResourceBulkActions
} from './MatterSuggestedResourceActions'
import type { MatterResourceGroupKey } from './matterResource'

/** G-17 ③ —— 资料分组头右侧的「+ 关联」直达对应 tab。分组与 tab 不是一一对应（文档/附件与
 *  链接两组都落在链接与附件两个 tab 上），故只映射有明确归宿的那几组。 */
const GROUP_TAB: Record<MatterResourceGroupKey, MatterLinkResourceTab> = {
  mail: 'mail',
  meetings: 'mail',
  documents: 'link',
  attachments: 'file'
}

interface MatterContextTabProps {
  matter: Matter
  items: MatterItem[]
  resources: MatterResourceListItem[]
  stakeholders: MatterStakeholder[]
  onOpenResource(item: MatterResourceListItem): void
  /** 置顶/取消置顶。0812 起是**唯一**入口 —— 右侧上下文栏（原持有者）已移除。 */
  onTogglePin(item: MatterResourceListItem): void
  onChanged(): void
}

export function MatterContextTab({
  matter,
  items,
  resources,
  stakeholders,
  onOpenResource,
  onTogglePin,
  onChanged
}: MatterContextTabProps): React.ReactElement {
  const { t } = useTranslation()
  const api = useMattersApi()
  // 通讯录 WP4 —— 干系人卡（contact_id 非空时）「头像+姓名+副行」块可点跳人物页。
  // flag off 不可点（现状字节级不变）。跳转 hooks 收在 StakeholderIdentity 里
  // （镜像 StakeholderLastContact：useNavigate 只在渲染干系人卡时才被调用）。
  const { enabled: contactsEnabled } = useContactsEnabled()
  const groups = useMemo(() => groupMatterResources(resources), [resources])
  const pinned = resources.filter((item) => item.link.pinned)
  const [editor, setEditor] = useState<MatterStakeholder | 'new' | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // G-14 —— 关联资料弹窗。null = 关着；值 = 打开并预选那个 tab（G-17 ③ 的分组直达）。
  const [linkTab, setLinkTab] = useState<MatterLinkResourceTab | null>(null)

  // G-17 ① —— 干系人卡「最近联系」要能点进那封邮件。判据取 `source_resource_id`（干系人是从
  // 哪条资料推出来的），在本来就持有的 `resources` 里查，不额外发请求。
  const emailByResourceId = useMemo(() => {
    const index = new Map<number, number>()
    for (const item of resources) {
      if (item.resource.kind !== 'email') continue
      if (!item.resource.external_key.startsWith('email:')) continue
      const internalId = Number(item.resource.external_key.slice('email:'.length))
      if (Number.isInteger(internalId) && internalId > 0) index.set(item.resource.id, internalId)
    }
    return index
  }, [resources])

  const remove = useMatterMutation({
    matterId: matter.public_id,
    mutationFn: (stakeholderId: number) =>
      api.deleteStakeholder(matter.public_id, stakeholderId, {
        expectedVersion: matter.version,
        reason: 'user_removed_stakeholder'
      }),
    onSuccess: onChanged,
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  const openItems = items.filter(
    (item) => item.deleted_at === null && item.status !== 'done' && item.status !== 'canceled'
  ).length
  const pinnedResources = resources.filter((item) => item.link.pinned).length
  const suggestedResources = resources.filter((item) => item.link.confirmed_at === null).length

  return (
    <div className="space-y-6">
      <section>
        <SectionHeader title={t('matters.context.stakeholders')} count={stakeholders.length}>
          <button
            type="button"
            onClick={() => setEditor('new')}
            className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1.5 text-aux hover:bg-ink-3"
          >
            <Plus size={13} />
            {t('matters.context.addStakeholder')}
          </button>
        </SectionHeader>
        {/* S2 —— 核心 / 其他两组 + 组内拖拽重排 + 换组按钮（见 MatterStakeholderSection
            的文件头：为什么从 grid 改单列、为什么换组不是跨组拖）。卡片内容仍由这里提供，
            那几个子组件（StakeholderIdentity / StakeholderLastContact）长在本文件。 */}
        <MatterStakeholderSection
          matter={matter}
          stakeholders={stakeholders}
          resources={resources}
          onEdit={setEditor}
          onRemove={(stakeholderId) => remove.mutate(stakeholderId)}
          onChanged={onChanged}
          renderBody={(stakeholder) => (
            <div
              className={
                stakeholder.is_waiting_on ? 'rounded-[var(--r-ctl)] bg-warn/[0.06] p-1.5' : ''
              }
            >
              <StakeholderIdentity stakeholder={stakeholder} contactsEnabled={contactsEnabled} />
              <div className="mt-2.5 flex items-center gap-1.5 pr-24">
                {stakeholder.role ? <Pip>{stakeholder.role}</Pip> : null}
                <span className="ml-auto">
                  <StakeholderLastContact
                    stakeholder={stakeholder}
                    emailId={
                      stakeholder.source_resource_id === null
                        ? null
                        : (emailByResourceId.get(stakeholder.source_resource_id) ?? null)
                    }
                  />
                </span>
              </div>
              {stakeholder.relationship ? (
                <p className="mt-2 border-t border-ink-border pt-2 text-meta leading-5 text-ink-fg-2">
                  {stakeholder.relationship}
                </p>
              ) : null}
            </div>
          )}
        />
      </section>

      {/* 「置顶资料」独立分区（原只存在于右侧上下文栏）。置顶决定 Agent 每轮带哪几份摘录，
          是个高频判断，不该混在长列表里。 */}
      {pinned.length > 0 ? (
        <section>
          <SectionHeader title={t('matters.context.pinnedResources')} count={pinned.length} />
          <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-2">
            {pinned.map((item) => (
              <ResourceRow
                key={item.link.id}
                matter={matter}
                item={item}
                onOpen={onOpenResource}
                onTogglePin={onTogglePin}
                onChanged={onChanged}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <SectionHeader title={t('matters.context.linkedResources')} count={resources.length}>
          <div className="flex items-center gap-2">
            {suggestedResources > 0 ? (
              <Pip tone="ai">
                {t('matters.resource.suggestedCount', { count: suggestedResources })}
              </Pip>
            ) : null}
            {/* G-14 —— 手动关联资料入口。0812 之前 ContextTab 一个添加口都没有，资料只能靠
                ⌘K 捕获 / 线程订阅 / Agent 建议 / chat 工具进来。 */}
            <button
              type="button"
              onClick={() => setLinkTab('mail')}
              className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1.5 text-aux hover:bg-ink-3"
            >
              <Plus size={13} />
              {t('matters.linkResource.open')}
            </button>
          </div>
        </SectionHeader>
        {/* Agent 一轮能挂十几份建议，逐条点是 0812 dogfood 的第二条 P0。逐条钮保留 —— 用户
            要挑着来；批量口只是省掉「全要 / 全不要」这两种最常见的整批处置。 */}
        <MatterSuggestedResourceBulkActions
          matter={matter}
          resources={resources}
          onChanged={onChanged}
        />
        {resources.length > 0 ? (
          <div className="overflow-hidden rounded-[var(--r-card)] border border-ink-border bg-ink-2">
            {groups.map((group) => {
              if (group.items.length === 0) return null
              const open = collapsed[group.key] !== true
              return (
                <div
                  key={group.key}
                  className="group/head border-b border-ink-border last:border-b-0"
                >
                  <div className="flex items-center bg-ink-3/70 pr-2">
                    <button
                      type="button"
                      aria-expanded={open}
                      onClick={() =>
                        setCollapsed((value) => ({ ...value, [group.key]: !value[group.key] }))
                      }
                      className="flex min-w-0 flex-1 items-center gap-2 px-4 py-2 text-left text-meta font-medium text-ink-fg-2 hover:text-ink-fg"
                    >
                      <CollapseChevron expanded={open} size={12} />
                      <span>{t(`matters.context.groups.${group.key}`)}</span>
                      <span className="font-mono text-ink-fg-3">{group.items.length}</span>
                    </button>
                    {/* G-17 ③ —— 分组头右侧「+ 关联」，开同一个弹窗但预选这一组对应的 tab。 */}
                    <button
                      type="button"
                      onClick={() => setLinkTab(GROUP_TAB[group.key])}
                      title={t('matters.linkResource.openForGroup')}
                      aria-label={t('matters.linkResource.openForGroup')}
                      className="shrink-0 rounded-[var(--r-ctl)] p-1 text-ink-fg-3 opacity-0 transition-opacity duration-fast ease-standard hover:bg-ink-4 hover:text-ink-fg focus-visible:opacity-100 group-hover/head:opacity-100"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  {open
                    ? group.items.map((item) => (
                        <ResourceRow
                          key={item.link.id}
                          matter={matter}
                          item={item}
                          onOpen={onOpenResource}
                          onTogglePin={onTogglePin}
                          onChanged={onChanged}
                        />
                      ))
                    : null}
                </div>
              )
            })}
          </div>
        ) : (
          <EmptyState
            icon={<Link2 size={22} />}
            title={t('matters.context.noResourcesTitle')}
            hint={t('matters.context.noResourcesHint')}
            action={
              <button
                type="button"
                onClick={() => setLinkTab('mail')}
                className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] border border-ink-border px-2.5 py-1.5 text-aux hover:bg-ink-3"
              >
                <Plus size={13} />
                {t('matters.linkResource.open')}
              </button>
            }
          />
        )}
      </section>

      {/* G-15 —— 关联事项。后端 5 个端点与 chat 工具早就齐了，此前前端零渲染面（写得进、
          没人看得见）。 */}
      <MatterRelationsSection matter={matter} onChanged={onChanged} />

      <section>
        <SectionHeader title={t('matters.context.injectionTitle')} />
        <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-4">
          <div className="flex flex-wrap gap-2">
            {/* 五枚 chip 的图标按设计原型逐位对应（target / listcheck / users / pin / history）。
                原先是裸标签, 一个 icon 都没有 —— 设计 §7.6「icon 全部对照原型替换」。 */}
            <Pip>
              <Target size={11} />
              {t('matters.context.injection.acceptedState')}
            </Pip>
            <Pip>
              <ListChecks size={11} />
              {t('matters.context.injection.openItems', { count: openItems })}
            </Pip>
            <Pip>
              <Users size={11} />
              {t('matters.context.injection.stakeholderCount', { count: stakeholders.length })}
            </Pip>
            <Pip>
              <Pin size={11} />
              {t('matters.context.injection.pinnedCount', { count: pinnedResources })}
            </Pip>
            <Pip>
              <History size={11} />
              {t('matters.context.injection.changes')}
            </Pip>
          </div>
          <p className="mt-4 text-aux leading-6 text-ink-fg-2">
            {t('matters.context.injection.description')}
          </p>
          <div className="mt-4 flex items-start gap-2 border-t border-ink-border pt-4 text-meta leading-5 text-ink-fg-2">
            <Shield size={14} className="mt-0.5 shrink-0 text-ok" />
            <span>{t('matters.context.injection.shield')}</span>
          </div>
        </div>
      </section>

      {/* 通讯录 WP3（S3）—— 单页 Picker：通讯录池 + 库外邮箱建入。 */}
      <MatterStakeholderPicker
        matter={matter}
        stakeholders={stakeholders}
        editing={editor === 'new' ? null : editor}
        open={editor !== null}
        onOpenChange={(next) => {
          if (!next) setEditor(null)
        }}
        onChanged={() => {
          setEditor(null)
          onChanged()
        }}
      />

      <MatterLinkResourceModal
        matter={matter}
        resources={resources}
        open={linkTab !== null}
        initialTab={linkTab ?? 'mail'}
        onOpenChange={(next) => {
          if (!next) setLinkTab(null)
        }}
        onChanged={onChanged}
      />
    </div>
  )
}

/** 通讯录 WP4 —— 干系人卡的「头像+姓名+副行」身份块。`contact_id` 非空且通讯录
 *  开启时整块可点（跳人物页：store intent + navigate('/contacts')，title 复用
 *  contacts.chip.open）；否则渲染与改动前逐字相同的静态块（含 className ——
 *  hover accent 类只出现在可点分支）。🔴 不把整卡做成 button：卡内已有
 *  edit/delete 钮与「最近联系」按钮，嵌套 button 非法；设计 mock 的整行按钮在
 *  现有卡片结构上以「点头像/名字区跳转」等价落地。 */
function StakeholderIdentity({
  stakeholder,
  contactsEnabled
}: {
  stakeholder: MatterStakeholder
  contactsEnabled: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const openContact = useContactNavigation((state) => state.open)
  const name =
    stakeholder.display_name ||
    stakeholder.email_normalized ||
    t('matters.context.unnamedStakeholder')
  const interactive = contactsEnabled && stakeholder.contact_id !== null
  const body = (
    <>
      <span
        className={`flex shrink-0 rounded-full ${
          stakeholder.is_waiting_on ? 'ring-2 ring-warn/40 ring-offset-1 ring-offset-ink-1' : ''
        }`}
      >
        <RecipientAvatar
          name={stakeholder.display_name ?? ''}
          email={stakeholder.email_normalized ?? ''}
          size={30}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3
            className={
              interactive
                ? 'truncate text-body font-medium text-ink-fg transition-colors duration-fast group-hover/open:text-coral'
                : 'truncate text-body font-medium text-ink-fg'
            }
          >
            {name}
          </h3>
          {stakeholder.is_waiting_on ? (
            <Pip tone="warn">{t('matters.context.waiting')}</Pip>
          ) : null}
        </div>
        {/* 名字行下 = 库侧信息（组织，退而求其次邮箱）；角色只出现在下面的
            药丸行 —— 设计里「职位·公司」与角色 Pip 是两回事，别重复画角色。 */}
        <p className="mt-0.5 truncate text-meta text-ink-fg-3">
          {stakeholder.organization ||
            stakeholder.email_normalized ||
            t('matters.context.noRole')}
        </p>
      </div>
    </>
  )
  if (interactive) {
    const contactId = stakeholder.contact_id as number
    return (
      <button
        type="button"
        onClick={() => {
          openContact(contactId)
          void navigate({ to: '/contacts' })
        }}
        title={t('contacts.chip.open', { name })}
        className="group/open flex w-full items-start gap-2.5 text-left"
      >
        {body}
      </button>
    )
  }
  return <div className="flex items-start gap-2.5">{body}</div>
}

/** G-17 ① —— 「最近联系」：能定位到那封邮件时是一颗按钮，定位不到就还是一行静态文字。
 *  🔴 不做「永远可点但点了没反应」——干系人可能是手输入的（`source_resource_id=null`），
 *  或者它的来源资料已经被解除关联了。 */
function StakeholderLastContact({
  stakeholder,
  emailId
}: {
  stakeholder: MatterStakeholder
  emailId: number | null
}): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const setActiveEmail = useActiveEmail((state) => state.setActive)
  // 设计用 fmtAgo（相对时间）而非绝对日期；没有记录时诚实地画 '—'。
  const label = `${t('matters.context.lastContact')} ${
    stakeholder.last_contact_at
      ? formatRelativeTime(new Date(stakeholder.last_contact_at).toISOString())
      : '—'
  }`
  if (emailId === null) return <span className="text-meta text-ink-fg-3">{label}</span>
  return (
    <button
      type="button"
      onClick={() => {
        setActiveEmail(emailId)
        void navigate({ to: '/' })
      }}
      title={t('matters.context.openLastContact')}
      className="inline-flex items-center gap-1 rounded-[var(--r-ctl)] text-meta text-ink-fg-2 underline-offset-2 transition-colors duration-fast ease-standard hover:text-ink-fg hover:underline"
    >
      {label}
      <Link2 size={11} />
    </button>
  )
}

/** 一行关联资料。图标按 kind 取（`matterResource.ts` 单源）—— 此前这里一律用 Link2，
 *  邮件/会议/文档长得一模一样；置顶钮此前只在右栏有，右栏删掉后这里是唯一入口。 */
function ResourceRow({
  matter,
  item,
  onOpen,
  onTogglePin,
  onChanged
}: {
  matter: Matter
  item: MatterResourceListItem
  onOpen(item: MatterResourceListItem): void
  onTogglePin(item: MatterResourceListItem): void
  onChanged(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const api = useMattersApi()
  const pushUndoToast = useMatterUndoToast()
  // 成员索引而非查表函数：react-hooks/static-components 只认得前者（见 matterResource.ts）。
  const Icon =
    (item.resource.kind === 'doc' && DOC_PROVIDER_ICONS[item.resource.provider.toLowerCase()]) ||
    RESOURCE_KIND_ICONS[item.resource.kind]
  const suggested = item.link.confirmed_at === null

  // G-17 ② —— 行级「取消关联」。此前只在 ResourceDrawer 里有（要先点开抽屉），复用同一个
  // mutation 形状与 reason，语义与那处一致：解除关联**不删除**原件。
  const unlink = useMatterMutation({
    matterId: matter.public_id,
    mutationFn: () =>
      api.unlinkResource(matter.public_id, item.resource.id, {
        expectedVersion: matter.version,
        reason: 'user_unlinked_resource'
      }),
    // G-33 —— 单条解除关联在服务端有反向操作（`_mutate_resource_link` 返回 restore
    // descriptor），toast 带撤销。
    onSuccess: (result) => {
      pushUndoToast(t('matters.resource.unlinkedNoDelete'), result, matter.public_id)
      onChanged()
    },
    onError: (error) => toastError(t('matters.toast.saveFailed'), errorMessage(error))
  })

  return (
    <div
      className={`group border-t border-ink-border px-4 py-3 first:border-t-0 ${suggested ? 'bg-ai/[0.06]' : ''}`}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => onOpen(item)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left hover:opacity-80"
        >
          <span
            className={`grid size-7 shrink-0 place-items-center rounded ${suggested ? 'bg-ai/15 text-ai' : 'bg-ink-4 text-ink-fg-2'}`}
          >
            <Icon size={13} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-body text-ink-fg">
                {item.resource.title || item.resource.external_key}
              </span>
              {suggested ? <Pip tone="ai">{t('matters.resource.suggested')}</Pip> : null}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-ink-fg-3">
              {/* kind 由左侧图标承载 —— 再写一遍文字会和上面的分组标题重复。 */}
              <span>
                {t(suggested ? 'matters.resource.agentSuggested' : 'matters.resource.manualLink')}
              </span>
              {item.link.sub_state !== 'none' ? (
                <Pip tone={item.link.sub_state === 'paused' ? 'warn' : 'ok'}>
                  <RefreshCcw size={10} />
                  {t(
                    item.link.sub_state === 'paused'
                      ? 'matters.resource.subscriptionPaused'
                      : 'matters.resource.subscriptionActive'
                  )}
                </Pip>
              ) : null}
              {!isMatterResourceAvailable(item) ? (
                <Pip tone="fail">{t('matters.context.unavailable')}</Pip>
              ) : null}
            </span>
          </span>
        </button>
        <button
          type="button"
          title={t(item.link.pinned ? 'matters.context.unpin' : 'matters.context.pin')}
          aria-label={t(item.link.pinned ? 'matters.context.unpin' : 'matters.context.pin')}
          aria-pressed={item.link.pinned}
          onClick={() => onTogglePin(item)}
          className={`shrink-0 rounded-[var(--r-ctl)] p-1.5 text-ink-fg-3 opacity-0 transition-opacity duration-fast ease-standard hover:bg-ink-3 hover:text-ink-fg focus-visible:opacity-100 group-hover:opacity-100 ${
            item.link.pinned ? 'text-coral opacity-100' : ''
          }`}
        >
          <Pin size={13} />
        </button>
        <button
          type="button"
          disabled={unlink.isPending}
          title={t('matters.resource.unlink')}
          aria-label={t('matters.resource.unlink')}
          onClick={() => unlink.mutate()}
          className="shrink-0 rounded-[var(--r-ctl)] p-1.5 text-ink-fg-3 opacity-0 transition-opacity duration-fast ease-standard hover:bg-ink-3 hover:text-fail focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X size={13} />
        </button>
      </div>
      <MatterSuggestedResourceActions matter={matter} item={item} onChanged={onChanged} />
    </div>
  )
}

function SectionHeader({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children?: React.ReactNode
}): React.ReactElement {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-body font-semibold text-ink-fg">
        {title}
        {count === undefined ? null : (
          <span className="ml-1 font-mono text-meta text-ink-fg-3">· {count}</span>
        )}
      </h2>
      <div className="ml-auto">{children}</div>
    </div>
  )
}

function Pip({
  children,
  tone = 'neutral'
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'warn' | 'ok' | 'fail' | 'ai'
}): React.ReactElement {
  const tones = {
    neutral: 'bg-ink-4 text-ink-fg-2',
    warn: 'bg-warn/10 text-warn',
    ok: 'bg-ok/10 text-ok',
    fail: 'bg-fail/10 text-fail',
    ai: 'bg-ai/10 text-ai'
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-meta ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

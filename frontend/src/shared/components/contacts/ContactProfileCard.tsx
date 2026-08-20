// AI 画像卡（task 08-13 WP6，设计 §2.3 / D4 / D5 / D7，原型 `cdetail.jsx:80-228` +
// `cui.jsx::Provenance/Evolution/SuggestRow`）。
//
// 有画像（D4 叙事优先）：summary 整段 → 常聊议题 chips（ai 紫）→ 共同项目 chips（中性）
// → 沟通风格灰底块 → 人物轨迹（D5 月份粒度竖线）→ 待澄清 → 建议值区（D7）→ provenance。
// 无画像四态（§2.3 文案语义严格区分）：未开启 / 未达阈值 / 已达阈值等批处理 / 证据不足。
//
// 🔒 **画像文本一律纯文本渲染**（§7 + §8-WP6 验收）：summary / topics / projects /
// evolution / contradictions 全部走 `{value}` 插值 —— React 自动转义，不解析 markdown/HTML。
// 本文件里没有、也不许出现 `dangerouslySetInnerHTML` 或任何 markdown 渲染器。
// 闸：`tests/components/contacts/ContactProfileCard.test.tsx` 的注入用例。
//
// 🔒 阈值文案零硬编码（§4.4）：`profile_min` / `needed_mail_count` 全读后端投影，
// 前端不复制那个 50。

import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  HelpCircle,
  Hourglass,
  Loader2,
  MessageSquare,
  Milestone,
  Quote,
  RefreshCw,
  Sparkles
} from 'lucide-react'

import type {
  ContactProfileDocument,
  ContactProfileDto,
  ContactProfileEvolutionItem,
  ContactProfileSuggestionField
} from '@shared/api/types/contact'
import { SuggestRow } from '@shared/components/ui/suggest-row'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { formatMatterAgo } from '@shared/lib/matterDerive'
import { useActiveEmail } from '@shared/state/active-email'
import { toastError, toastSuccess } from '@shared/state/toast'

import { ContactPip, SecHead } from './parts'
import {
  useAdoptProfileSuggestion,
  useIgnoreProfileSuggestion,
  useRefreshContactProfile
} from './hooks'

/** 画像正文里的内联证据引用。prompt 约定见 `src/contacts/profile_prompts.py`
 *  （HARD RULES 3「cite supporting email internal_id values inline, for example [id:123]」），
 *  在此之前前端把它当纯文本渲染 → 用户看到一屏 `[id:1000012991]` 字面量且点不动。
 *
 *  🔒 这是本文件里**唯一**认识的 token，且它不构成 markdown/HTML 渲染：切段之后每一段仍走
 *  `{value}` 插值（React 转义）。`[id:abc]` / `[id:]` / 超出安全整数的超长数字都**不匹配或
 *  不成钮**，原样留在纯文本里。 */
const EVIDENCE_REF_PATTERN = /\[id:(\d+)\]/g

type InlineSegment = { kind: 'text'; value: string } | { kind: 'ref'; value: number }

/** 把一段画像文本切成「纯文本段 / 证据引用段」。非法引用不产生 ref 段，其字面量随周围
 *  文本一起留在 text 段里。 */
function parseEvidenceRefs(text: string): InlineSegment[] {
  const segments: InlineSegment[] = []
  let cursor = 0
  for (const match of text.matchAll(EVIDENCE_REF_PATTERN)) {
    const id = Number.parseInt(match[1] as string, 10)
    // 🔴 超长数字（`[id:99999999999999999999]`）落在安全整数外 —— 不可能是真的 internal_id，
    // 做成钮只会跳去一封不存在的邮件。跳过（不推进 cursor）＝ 它随后并入下一段纯文本。
    if (!Number.isSafeInteger(id)) continue
    const at = match.index
    if (at > cursor) segments.push({ kind: 'text', value: text.slice(cursor, at) })
    segments.push({ kind: 'ref', value: id })
    cursor = at + match[0].length
  }
  if (cursor < text.length) segments.push({ kind: 'text', value: text.slice(cursor) })
  return segments
}

/** chips 是不换行的短标签，塞不下引用钮（原型 `cdetail.jsx::ChipList` 就是纯展示 span，
 *  无点击无图标）→ 剥掉标记而不是留字面量。剥完把多出来的空隙收拢。 */
function stripEvidenceRefs(text: string): string {
  return text
    .replace(EVIDENCE_REF_PATTERN, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 纯文本 + 内联证据钮。视觉与 evolution 的「证据 N」同族（Quote / italic / micro 灰），
 *  只去掉那边的块级上边距。 */
function InlineRefs({
  text,
  onEvidence
}: {
  text: string
  onEvidence(internalId: number): void
}): React.ReactElement {
  const { t } = useTranslation()
  const segments = parseEvidenceRefs(text)
  // 没有引用（绝大多数段落）→ 原样一个文本节点，DOM 与改造前完全一致。
  if (!segments.some((segment) => segment.kind === 'ref')) return <>{text}</>
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          segment.value
        ) : (
          <button
            key={index}
            type="button"
            onClick={() => onEvidence(segment.value)}
            className="inline-flex items-center gap-1 whitespace-nowrap align-baseline text-meta italic text-ink-fg-3 transition-opacity duration-fast ease-standard hover:opacity-80"
          >
            <Quote size={10} aria-hidden />
            {t('contacts.profile.evidence', { ref: segment.value })}
          </button>
        )
      )}
    </>
  )
}

/** 建议字段 → 身份信息区共用的标签键（同一个字段在两处必须叫同一个名字）。 */
const SUGGESTION_LABEL_KEY: Record<ContactProfileSuggestionField, string> = {
  formal_name: 'contacts.field.formalName',
  department: 'contacts.field.dept',
  phone: 'contacts.field.phone'
}

/** 空态壳（原型 `Card pad={16}` + dashed + `--ink-fg 0.02`）—— 虚线 = 「还没有这回事」，
 *  与有画像时的实底 ink-2 卡形成 D7 的虚/实对比。 */
function EmptyShell({
  children,
  align = 'center'
}: {
  children: React.ReactNode
  align?: 'center' | 'start'
}): React.ReactElement {
  return (
    <div
      className={cn(
        'flex gap-[11px] rounded-[var(--r-card)] border border-dashed border-ink-border bg-ink-fg/[0.02] px-3.5 py-3.5',
        align === 'center' ? 'items-center' : 'items-start'
      )}
    >
      {children}
    </div>
  )
}

/** 空态里的 ghost 动作钮（原型 `Btn size="sm" kind="ghost" icon`）。 */
function GhostAction({
  icon,
  label,
  busy,
  onClick
}: {
  icon: React.ReactNode
  label: string
  busy: boolean
  onClick(): void
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.06] disabled:pointer-events-none disabled:opacity-50"
    >
      {icon}
      {label}
    </button>
  )
}

function ChipList({ items, tone }: { items: string[]; tone: 'ai' | 'neutral' }): React.ReactElement {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className={cn(
            'whitespace-nowrap rounded-full border px-[9px] py-[3px] text-meta text-ink-fg-1',
            tone === 'ai' ? 'border-ai/[0.22] bg-ai/[0.08]' : 'border-ink-border bg-ink-fg/[0.04]'
          )}
        >
          {stripEvidenceRefs(item)}
        </span>
      ))}
    </div>
  )
}

/** D5 · 人物轨迹：单根 1px 竖线（最后一节透明保住等宽）+ 7px 空心紫环 + 等宽月份标签。
 *  与事项时间线的区分在节点填充（空心 vs 实心）、时间粒度（月 vs 时刻）、有无 actor。 */
function Evolution({
  items,
  onEvidence
}: {
  items: ContactProfileEvolutionItem[]
  onEvidence(internalId: number): void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col">
      {items.map((item, index) => {
        const last = index === items.length - 1
        return (
          <div key={`${item.at}-${index}`} className="flex gap-[11px]">
            <div className="relative flex w-[9px] shrink-0 justify-center">
              <span
                aria-hidden
                className={cn(
                  'absolute bottom-0 top-3 w-px',
                  last ? 'bg-transparent' : 'bg-ink-border'
                )}
              />
              <span
                aria-hidden
                className="relative mt-[5px] size-[7px] shrink-0 rounded-full border-[1.5px] border-ai/60 bg-ink-2"
              />
            </div>
            <div className={cn('min-w-0', last ? undefined : 'pb-3.5')}>
              <span className="font-mono text-micro tracking-[0.02em] text-ink-fg-3">{item.at}</span>
              <div className="text-body leading-[1.6] text-ink-fg-1 [text-wrap:pretty]">
                {/* prompt 要求 evolution 用 `ev` 而不是内联引用，但模型可能违规 —— 解析器兜底。 */}
                <InlineRefs text={item.text} onEvidence={onEvidence} />
              </div>
              {/* `ev` 是证据邮件的 internal_id。用 `!= null` 而非真值判断 —— 0 是合法 id。 */}
              {item.ev != null ? (
                <button
                  type="button"
                  onClick={() => onEvidence(item.ev as number)}
                  className="mt-[3px] inline-flex items-center gap-1 text-meta italic text-ink-fg-3 transition-opacity duration-fast ease-standard hover:opacity-80"
                >
                  <Quote size={10} aria-hidden />
                  {t('contacts.profile.evidence', { ref: item.ev })}
                </button>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** provenance 行：证据窗 / 模型 / 更新时间 +（失败时）红 pip +「立即更新画像」。 */
function Provenance({
  document,
  profile,
  busy,
  now,
  locale,
  onRefresh
}: {
  document: ContactProfileDocument
  profile: ContactProfileDto
  busy: boolean
  now: number
  locale: string
  onRefresh(): void
}): React.ReactElement {
  const { t } = useTranslation()
  const window = document.evidence_window
  const model = profile.profile_model || '—'
  const ago =
    profile.profile_updated_at != null
      ? formatMatterAgo(profile.profile_updated_at, now, locale)
      : '—'
  const mailCount = window?.mail_count ?? profile.profile_mail_count ?? 0
  // 🔴 `from`/`to` 是 internal_id 整数（与 evolution 的 `证据 {ev}` 同坐标系），不是月份。
  // 增量轮可能 0 新证据 → 两端 null，此时退到不带窗口的那句（否则渲染出「基于 null~null」）。
  const hasWindow = window != null && window.from != null && window.to != null
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-t border-ink-border-soft pt-2.5">
      <span className="font-mono text-micro leading-[1.5] text-ink-fg-3">
        {hasWindow
          ? t('contacts.profile.provenance', {
              from: window.from,
              to: window.to,
              n: mailCount,
              model,
              ago
            })
          : t('contacts.profile.provenanceNoWindow', { n: mailCount, model, ago })}
        {window
          ? ` ${t(
              window.mode === 'incremental'
                ? 'contacts.profile.modeIncremental'
                : 'contacts.profile.modeFirst'
            )}`
          : ''}
      </span>
      <span aria-hidden className="flex-1" />
      {profile.status === 'failed' ? (
        <ContactPip tone="critical" icon={<AlertCircle size={9.5} aria-hidden />}>
          {t('contacts.profile.failed')}
        </ContactPip>
      ) : null}
      <button
        type="button"
        disabled={busy}
        onClick={onRefresh}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-[var(--r-ctl)] px-2 py-1 text-meta transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.06] disabled:pointer-events-none disabled:opacity-70',
          busy ? 'text-ai' : 'text-ink-fg-1'
        )}
      >
        {/* 两个图标共一槽 → DESIGN §8 `.icon-swap` 交叉淡入（opacity+scale 120ms）。 */}
        <span className="icon-swap">
          <span className="icon-swap-item" data-active={!busy}>
            <RefreshCw size={12} aria-hidden />
          </span>
          <span className="icon-swap-item" data-active={busy}>
            <Loader2 size={12} aria-hidden className="animate-spin" />
          </span>
        </span>
        {busy ? t('contacts.profile.refreshing') : t('contacts.profile.refresh')}
      </button>
    </div>
  )
}

export interface ContactProfileCardProps {
  contactId: number
  profile: ContactProfileDto
  /** 阈值文案里的「当前 N 封」= 该联系人的往来总数。 */
  mailCount: number
}

export function ContactProfileCard({
  contactId,
  profile,
  mailCount
}: ContactProfileCardProps): React.ReactElement {
  const { t, i18n } = useTranslation()
  const locale = i18n.language || 'zh-CN'
  const navigate = useNavigate()
  const setActiveEmail = useActiveEmail((state) => state.setActive)
  // render 期不许调 Date.now()（react-hooks/purity）—— 同 ContactDetail 的快照模式。
  const [now] = useState(() => Date.now())
  // 「全部采纳」串行执行期间的整区禁用（后端无批量端点，见下）。
  const [adoptingAll, setAdoptingAll] = useState(false)

  const refresh = useRefreshContactProfile(contactId)
  const adopt = useAdoptProfileSuggestion(contactId)
  const ignore = useIgnoreProfileSuggestion(contactId)

  const document = profile.document
  // busy = 后端已在跑 OR 本地请求在途（202 返回到下一次轮询之间的空窗也要显示生成中）。
  const generating = profile.status === 'running' || refresh.isPending
  const suggestBusy = adopt.isPending || ignore.isPending || adoptingAll

  const runRefresh = (): void => {
    if (generating) return
    refresh.mutate(undefined, {
      onSuccess: () => toastSuccess(t('contacts.toast.profileRunning')),
      onError: (error) => toastError(t('contacts.toast.profileFailed'), errorMessage(error))
    })
  }

  // 🔴 `{ navTarget: true }` 不是可选装饰：证据邮件常常不在收件箱列表当前加载窗口里
  //（也可能被 view / Focused tab / 二值筛选挡在 orderedIds 之外）。少了它，
  // useEmailListRows 的 active-reset 会在下一个微任务里把 active 抢回列表第一封 ——
  // 正文闪一下目标邮件就跳走，表现正是 dogfood 报的「点击也无法跳转」。
  // EmailDetail 本身按 id 独立取详情，豁免之后窗口外的邮件照样打得开。
  // 先例：`agents/EmailSourcePanel.tsx` 的 openInbox（同样只有 internal_id、没有 mailbox）。
  const openEvidence = (internalId: number): void => {
    setActiveEmail(internalId, { navTarget: true })
    void navigate({ to: '/' })
  }

  const adoptOne = (field: ContactProfileSuggestionField, value: string): void => {
    adopt.mutate(
      { field, value },
      {
        onSuccess: () =>
          toastSuccess(
            t('contacts.toast.adopted', { field: t(SUGGESTION_LABEL_KEY[field]), value })
          ),
        onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
      }
    )
  }

  const ignoreOne = (field: ContactProfileSuggestionField): void => {
    ignore.mutate(field, {
      onSuccess: () =>
        toastSuccess(t('contacts.toast.ignored', { field: t(SUGGESTION_LABEL_KEY[field]) })),
      onError: (error) => toastError(t('contacts.toast.saveFailed'), errorMessage(error))
    })
  }

  // 「全部采纳」：后端没有批量端点 → 串行 for-await。串行（而非 Promise.all）是必需的：
  // 每条 adopt 都读改写同一行的 `identity_locks_json`，并发会互相覆盖掉锁。
  // 任一失败即停并报错，已成功的那几条保留（🔒 §4.2「失败不乐观出队」）。
  const adoptAll = async (): Promise<void> => {
    if (suggestBusy) return
    const pending = profile.suggestions
    setAdoptingAll(true)
    let done = 0
    try {
      for (const item of pending) {
        await adopt.mutateAsync({ field: item.field, value: item.value })
        done += 1
      }
      toastSuccess(t('contacts.toast.adoptedAll', { n: done }))
    } catch (error) {
      toastError(t('contacts.toast.saveFailed'), errorMessage(error))
    } finally {
      setAdoptingAll(false)
    }
  }

  // ── 四种「没有画像」（§2.3 文案语义严格区分）────────────────────────────────
  if (!document) {
    // ① 未开启：灰度 flag 关，或画像 agent 行没启用。只给「去开」的指路，不给「立即生成」。
    if (profile.status === 'unconfigured') {
      return (
        <EmptyShell align="start">
          <Sparkles size={15} aria-hidden className="mt-0.5 shrink-0 text-ai" />
          <div className="min-w-0">
            <div className="text-body font-medium text-ink-fg-1">{t('contacts.profile.off')}</div>
            <p className="mt-1 text-meta leading-[1.65] text-ink-fg-3 [text-wrap:pretty]">
              {t('contacts.profile.offHint')}
            </p>
            <button
              type="button"
              onClick={() => void navigate({ to: '/agents', search: { tab: 'agents' } })}
              className="mt-2.5 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-2.5 py-1 text-meta text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-3"
            >
              {t('contacts.profile.offCta')}
            </button>
          </div>
        </EmptyShell>
      )
    }
    // ② 证据不足：模型看过邮件但判据不足拒写（不算失败，下轮会再试）。
    if (profile.status === 'skipped') {
      return (
        <EmptyShell>
          <HelpCircle size={15} aria-hidden className="shrink-0 text-ink-fg-3" />
          <div className="min-w-0 flex-1">
            <div className="text-body text-ink-fg-1">{t('contacts.profile.insufficient')}</div>
            <div className="mt-[3px] text-meta text-ink-fg-3 [text-wrap:pretty]">
              {t('contacts.profile.insufficientHint', {
                n: profile.attempted_mail_count ?? mailCount
              })}
            </div>
          </div>
          <GhostAction
            icon={<RefreshCw size={12} aria-hidden />}
            label={t('contacts.profile.retry')}
            busy={generating}
            onClick={runRefresh}
          />
        </EmptyShell>
      )
    }
    // ③ 未达阈值 / ④ 已达阈值等下一轮批处理 —— 同一个壳，标题与说明按是否够格分。
    // `running` 与「首轮 failed 尚无旧画像」也落这里：说「下一轮会写入」对两者都是真话
    //（failed 的下轮确实会再试），比误报「证据不足」诚实。running 时额外挂一个生成中 pip。
    const queued = profile.status === 'pending_batch' || profile.eligible
    return (
      <EmptyShell>
        <Hourglass size={15} aria-hidden className="shrink-0 text-ink-fg-3" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body text-ink-fg-1">
              {t(queued ? 'contacts.profile.queued' : 'contacts.profile.threshold')}
            </span>
            {generating ? (
              <ContactPip tone="info" icon={<Loader2 size={9.5} aria-hidden className="animate-spin" />}>
                {t('contacts.profile.refreshing')}
              </ContactPip>
            ) : null}
            {profile.status === 'failed' ? (
              <ContactPip tone="critical" icon={<AlertCircle size={9.5} aria-hidden />}>
                {t('contacts.profile.failed')}
              </ContactPip>
            ) : null}
          </div>
          <div className="mt-[3px] text-meta text-ink-fg-3">
            {queued
              ? t('contacts.profile.queuedHint', { n: mailCount, min: profile.profile_min })
              : t('contacts.profile.thresholdHint', {
                  min: profile.profile_min,
                  n: mailCount,
                  need: profile.needed_mail_count
                })}
          </div>
        </div>
        <GhostAction
          icon={<Sparkles size={12} aria-hidden />}
          label={t('contacts.profile.thresholdCta')}
          busy={generating}
          onClick={runRefresh}
        />
      </EmptyShell>
    )
  }

  // ── 有画像（D4 叙事优先）────────────────────────────────────────────────────
  const suggestions = profile.suggestions
  return (
    <div className="rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-[18px]">
      <div className="mb-[11px] flex items-center gap-2">
        <Sparkles size={14} aria-hidden className="shrink-0 text-ai" />
        <span className="text-meta font-semibold text-ink-fg">{t('contacts.profile.title')}</span>
        {generating ? (
          <ContactPip tone="info" icon={<Loader2 size={9.5} aria-hidden className="animate-spin" />}>
            {t('contacts.profile.refreshing')}
          </ContactPip>
        ) : null}
      </div>

      {/* 🔒 纯文本：`{}` 插值即转义，`whitespace-pre-wrap` 保住模型给的换行。唯一的例外是
          `[id:N]` 内联引用被切成证据钮（见 InlineRefs），其余一律不解析。 */}
      <p className="m-0 whitespace-pre-wrap text-body leading-[1.78] text-ink-fg/90 [text-wrap:pretty]">
        <InlineRefs text={document.summary} onEvidence={openEvidence} />
      </p>

      {document.topics.length > 0 ? (
        <div className="mt-3.5">
          <div className="mb-1.5 text-micro text-ink-fg-2">{t('contacts.profile.topics')}</div>
          <ChipList items={document.topics} tone="ai" />
        </div>
      ) : null}

      {document.projects.length > 0 ? (
        <div className="mt-[11px]">
          <div className="mb-1.5 text-micro text-ink-fg-2">{t('contacts.profile.projects')}</div>
          <ChipList items={document.projects} tone="neutral" />
        </div>
      ) : null}

      {document.communication_style ? (
        <div className="mt-3.5 flex gap-[9px] rounded-[var(--r-ctl)] bg-ink-fg/[0.025] px-3 py-2.5">
          <MessageSquare size={13} aria-hidden className="mt-0.5 shrink-0 text-ink-fg-2" />
          <span className="text-body leading-[1.65] text-ink-fg-1 [text-wrap:pretty]">
            <InlineRefs text={document.communication_style} onEvidence={openEvidence} />
          </span>
        </div>
      ) : null}

      {document.evolution.length > 0 ? (
        <div className="mt-4">
          <SecHead
            icon={<Milestone size={13} aria-hidden className="shrink-0 text-ink-fg-2" />}
            title={t('contacts.profile.evolution')}
          />
          <Evolution items={document.evolution} onEvidence={openEvidence} />
        </div>
      ) : null}

      {document.contradictions.length > 0 ? (
        <div className="mt-3.5 border-t border-ink-border-soft pt-[11px]">
          {document.contradictions.map((text, index) => (
            <div key={`${index}-${text}`} className="flex items-start gap-[7px]">
              <HelpCircle size={12} aria-hidden className="mt-[3px] shrink-0 text-ink-fg-3" />
              <span className="text-meta leading-[1.6] text-ink-fg-3 [text-wrap:pretty]">
                {/* 前缀「待澄清 · 」是本地化死文案，不含 `[id:N]`，所以整句一起过解析器
                    即可，不必为此把这个 i18n key 拆成两半。 */}
                <InlineRefs
                  text={t('contacts.profile.contradiction', { text })}
                  onEvidence={openEvidence}
                />
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {suggestions.length > 0 ? (
        <div className="mt-4">
          <SecHead
            icon={<Sparkles size={13} aria-hidden className="shrink-0 text-ai" />}
            title={t('contacts.profile.suggest')}
            count={suggestions.length}
            right={
              <button
                type="button"
                disabled={suggestBusy}
                onClick={() => void adoptAll()}
                className="shrink-0 text-micro text-coral transition-opacity duration-fast ease-standard hover:opacity-80 disabled:pointer-events-none disabled:opacity-50"
              >
                {t('contacts.profile.adoptAll')}
              </button>
            }
          />
          {/* 采纳/忽略后该行从后端投影里消失 → 只做透明度过渡（红线：不许位移动画）。 */}
          <div className="flex flex-col gap-[7px] transition-opacity duration-base ease-standard">
            {suggestions.map((item) => (
              <SuggestRow
                key={item.field}
                label={t(SUGGESTION_LABEL_KEY[item.field])}
                value={item.value}
                adoptLabel={t('contacts.profile.adopt')}
                ignoreLabel={t('contacts.profile.ignore')}
                busy={suggestBusy}
                onAdopt={() => adoptOne(item.field, item.value)}
                onIgnore={() => ignoreOne(item.field)}
              />
            ))}
          </div>
          <div className="mt-[7px] text-micro leading-[1.6] text-ink-fg-3">
            {t('contacts.profile.suggestHint')}
          </div>
        </div>
      ) : null}

      <div className="mt-4">
        <Provenance
          document={document}
          profile={profile}
          busy={generating}
          now={now}
          locale={locale}
          onRefresh={runRefresh}
        />
      </div>
    </div>
  )
}

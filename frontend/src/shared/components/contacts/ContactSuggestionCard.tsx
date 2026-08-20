// 一条治理建议卡（WP7；原型 `cagent.jsx::SugCard` :15-47 逐属性，工程形态照
// `MatterUpdateReview::ChangeRow`）。
//
// 头行：类型 Pip（label 走 i18n —— MatterUpdateReview 硬编码中文的教训）+ 置信度 +
// 相关人 Monogram 组（可点跳人物页）→ 主文案 → 理由 → 脚行（证据引文 + 忽略 + 采纳）。
//
// 🔴 **结论句是前端拼的，不是模型写的**：propose 三工具的 payload 只有结构化字段
// （identity `{field,value}` / former_email `{email}` / relation `{manager_id}` /
// kind `{kind}` / merge `{winner_contact_id,loser_contact_id}`）+ 一句可选 `reason`。
// 所以「这条建议要干什么」由 type + payload 用 i18n 模板确定性拼出，模型只负责
// `reason` 与证据引文那两处散文。
//
// 🔴 模型产物一律**纯文本渲染**（`reason` / `evidence[].quote` / `payload.value` /
// `payload.email` / `block_reason`）：无 dangerouslySetInnerHTML、不解析 markdown。
// 闸 `ContactSuggestionCard.test.tsx` 塞 `<script>` 与 `**bold**` 断言原样出现。
//
// 🔴 blocked 行**不给采纳/忽略按钮**：后端只允许 pending 被 adopt/ignore
// （`E_INVALID_STATE`），画出来就是一个必然 400 的假入口。

import { useTranslation } from 'react-i18next'
import { Bot, Check, History, Merge, Quote, User, Users } from 'lucide-react'

import type { ContactGovernanceSuggestion, ContactRowDto } from '@shared/api/types/contact'
import { cn } from '@shared/lib/cn'

import { FIELD_LABEL_KEY } from './contactFields'
import { stripEvidenceRefs } from './evidenceRefs'
import { Monogram } from './Monogram'
import { ContactPip } from './parts'

/** 原型 `SUG_META` :7-13（icon + tone），键名换成 taxonomy 的 5 个值：原型的
 *  `field` / `former` 是展示层遗留，DB 的 CHECK 值域是 identity / former_email。 */
const SUGGESTION_META = {
  merge: { icon: Merge, tone: 'warn' },
  identity: { icon: User, tone: 'info' },
  former_email: { icon: History, tone: 'neutral' },
  relation: { icon: Users, tone: 'info' },
  kind: { icon: Bot, tone: 'neutral' }
} as const

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function contactId(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export interface ContactSuggestionCardProps {
  suggestion: ContactGovernanceSuggestion
  /** 相关人查表（列表行投影）。查不到（墓碑 / 不在当前库视图）→ 头像位留空、
   *  名字降级成 `#id`，不编一个假身份出来。 */
  personOf(contactId: number): ContactRowDto | undefined
  /** 写入在途：两钮一起禁（🔒 失败要能留在原位，所以禁的是入口不是行）。 */
  busy: boolean
  onAdopt(suggestion: ContactGovernanceSuggestion): void
  onIgnore(suggestion: ContactGovernanceSuggestion): void
  onOpenPerson(contactId: number): void
}

export function ContactSuggestionCard({
  suggestion,
  personOf,
  busy,
  onAdopt,
  onIgnore,
  onOpenPerson
}: ContactSuggestionCardProps): React.ReactElement {
  const { t } = useTranslation()
  const meta = SUGGESTION_META[suggestion.type]
  const blocked = suggestion.status === 'blocked'
  const payload = suggestion.payload

  const nameOf = (id: number): string => {
    const person = personOf(id)
    return person?.display_name ?? person?.primary_email ?? `#${id}`
  }

  // 相关人 = payload 点名的人（merge 两位、relation 的上级）+ contact_ids。去重保序，
  // 查不到的按原型 `.filter(Boolean)` 丢掉。
  const relatedIds = [
    ...suggestion.contact_ids,
    ...(suggestion.type === 'relation' ? [contactId(payload.manager_id)].filter(isId) : [])
  ]
  const people = [...new Set(relatedIds)]
    .map((id) => personOf(id))
    .filter((person): person is ContactRowDto => person !== undefined)

  const headline = ((): string => {
    switch (suggestion.type) {
      case 'merge': {
        const winner = contactId(payload.winner_contact_id) ?? suggestion.contact_ids[0]
        const loser = contactId(payload.loser_contact_id) ?? suggestion.contact_ids[1]
        return t('contacts.suggestion.text.merge', {
          a: loser === undefined ? '' : nameOf(loser),
          b: winner === undefined ? '' : nameOf(winner)
        })
      }
      case 'identity': {
        const field = text(payload.field)
        // 值域由服务端 `_guard_locked_fields` 把关（不在 CONTACT_LOCKABLE_FIELDS 里的
        // 直接 E_INVALID_FIELD），所以未知字段名只可能来自更旧/更新的后端 —— 原样显示，
        // 不 crash 也不假装认识它。
        const labelKey = (FIELD_LABEL_KEY as Record<string, string | undefined>)[field]
        const label = labelKey === undefined ? field : t(labelKey)
        return t('contacts.suggestion.text.identity', {
          name: nameOf(suggestion.contact_ids[0] ?? 0),
          field: label,
          value: text(payload.value)
        })
      }
      case 'former_email':
        return t('contacts.suggestion.text.former_email', { email: text(payload.email) })
      case 'relation': {
        const manager = contactId(payload.manager_id)
        const name = nameOf(suggestion.contact_ids[0] ?? 0)
        return manager === null
          ? t('contacts.suggestion.text.relationClear', { name })
          : t('contacts.suggestion.text.relation', { name, manager: nameOf(manager) })
      }
      case 'kind': {
        const kind = text(payload.kind)
        return t('contacts.suggestion.text.kind', {
          name: nameOf(suggestion.contact_ids[0] ?? 0),
          kind: kind === '' ? '' : t(`contacts.kind.${kind}`)
        })
      }
    }
  })()

  // `reason` 是模型散文，比结构化字段更容易带内联引证 → 同样剥掉（stripEvidenceRefs 自带
  // trim）。`evidence[].quote` **不剥**：那是邮件原文引文，不带标记，且是有用的溯源展示。
  const reason = stripEvidenceRefs(text(payload.reason))

  return (
    <article
      data-suggestion-status={suggestion.status}
      className={cn(
        'rounded-[var(--r-card)] border border-ink-border bg-ink-2 p-[13px]',
        blocked && 'opacity-60'
      )}
    >
      <div className="mb-2 flex items-center gap-[7px]">
        <ContactPip tone={meta.tone} icon={<meta.icon size={9.5} aria-hidden />}>
          {t(`contacts.suggestion.type.${suggestion.type}`)}
        </ContactPip>
        {blocked ? (
          <ContactPip tone="critical">{t('contacts.suggestion.blocked')}</ContactPip>
        ) : null}
        {suggestion.confidence != null ? (
          <span className="shrink-0 text-micro tabular-nums text-ink-fg-3">
            {t('contacts.suggestion.confidence', {
              percent: Math.round(suggestion.confidence * 100)
            })}
          </span>
        ) : null}
        <span aria-hidden className="flex-1" />
        {people.map((person) => (
          <button
            key={person.id}
            type="button"
            onClick={() => onOpenPerson(person.id)}
            title={t('contacts.suggestion.openPerson', { name: nameOf(person.id) })}
            className="flex shrink-0 rounded-full transition-opacity duration-fast ease-standard hover:opacity-80"
          >
            <Monogram
              displayName={person.display_name}
              primaryEmail={person.primary_email}
              kind={person.kind}
              size={20}
            />
          </button>
        ))}
      </div>

      {/* 老数据的 payload 值带 `[id: 54216]` 尾巴（模型把内联引证写进了结构化字段）——
          结论句是拿这些值拼的，显示侧剥掉；产生 / 采纳侧由后端修。 */}
      <div className="text-body leading-[1.55] text-ink-fg [text-wrap:pretty]">
        {stripEvidenceRefs(headline)}
      </div>

      {reason !== '' ? (
        <div className="mt-[5px] text-meta leading-[1.6] text-ink-fg-2 [text-wrap:pretty]">
          {reason}
        </div>
      ) : null}

      {blocked && suggestion.block_reason ? (
        <div className="mt-[5px] text-meta leading-[1.6] text-fail">
          {t('contacts.suggestion.blockReason', { reason: suggestion.block_reason })}
        </div>
      ) : null}

      <div className="mt-2.5 flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {suggestion.evidence.map((item, index) => (
            <span
              key={`${item.message_id}-${index}`}
              title={t('contacts.suggestion.evidenceTitle', { messageId: item.message_id })}
              className="inline-flex items-start gap-1 text-micro italic leading-[1.5] text-ink-fg-3"
            >
              <Quote size={10} aria-hidden className="mt-[3px] shrink-0" />
              <span className="min-w-0">{item.quote}</span>
            </span>
          ))}
        </div>
        {blocked ? null : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => onIgnore(suggestion)}
              className="shrink-0 rounded-[var(--r-ctl)] px-2 py-1 text-meta text-ink-fg-1 transition-colors duration-fast ease-standard hover:bg-ink-fg/[0.06] disabled:pointer-events-none disabled:opacity-50"
            >
              {t('contacts.suggestion.ignore')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAdopt(suggestion)}
              className="inline-flex shrink-0 items-center gap-1 rounded-[var(--r-ctl)] border border-coral/30 bg-coral/10 px-2.5 py-1 text-meta font-medium text-coral transition-colors duration-fast ease-standard hover:bg-coral/[0.17] disabled:pointer-events-none disabled:opacity-50"
            >
              {suggestion.type === 'merge' ? (
                <Merge size={12} aria-hidden />
              ) : (
                <Check size={12} aria-hidden />
              )}
              {t(
                suggestion.type === 'merge'
                  ? 'contacts.suggestion.openMerge'
                  : 'contacts.suggestion.adopt'
              )}
            </button>
          </>
        )}
      </div>
    </article>
  )
}

function isId(value: number | null): value is number {
  return value !== null
}

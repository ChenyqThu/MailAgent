/**
 * InboxMock — the hero 3-pane mail client (sidebar rail + mail list + reading
 * pane with AI Fields). Faithful recreation of the reference product UI
 * (frontend/docs/landing/MailAgent.html .app + mockups.css). Drives off
 * fixtures (emails[] + aiFields). Tier-2 mock, highest fidelity.
 *
 * Presentational only — pure props → JSX, no product imports, no window.electron.
 */
import type { MockEmail, MockAIFields, Priority } from './fixtures/fixtures'
import { emails as defaultEmails, aiFields as defaultAiFields } from './fixtures/fixtures'

export interface InboxMockProps {
  /** Mail list rows. Defaults to fixtures.emails when omitted. */
  emails?: MockEmail[]
  /** id of the selected row (reading pane shows its AI Fields). */
  selectedId?: string
  /** Selected email's AI Fields panel data. */
  aiFields?: MockAIFields
  /** Locale for the few UI chrome strings the mock renders (tabs etc.). */
  locale?: 'zh-CN' | 'en'
  /** Show only the list pane (used by responsive / compact embeds). */
  compact?: boolean
}

/** Coral sparkle star — the product brand mark. */
function Star({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
    </svg>
  )
}

/** Map fixture priority → the .ppip modifier class (low → norm styling). */
function ppipClass(p: Priority): string {
  return p === 'low' ? 'norm' : p
}

interface Chrome {
  focused: string
  other: string
  reply: string
  reviewed: string
  summary: string
  replySuggestion: string
  priority: string
  action: string
  category: string
}

const CHROME: Record<'zh-CN' | 'en', Chrome> = {
  'zh-CN': {
    focused: '重点',
    other: '其他',
    reply: '回复',
    reviewed: 'reviewed',
    summary: 'Summary',
    replySuggestion: 'Reply Suggestion',
    priority: 'Priority',
    action: 'Action',
    category: 'Category',
  },
  en: {
    focused: 'Focused',
    other: 'Other',
    reply: 'Reply',
    reviewed: 'reviewed',
    summary: 'Summary',
    replySuggestion: 'Reply Suggestion',
    priority: 'Priority',
    action: 'Action',
    category: 'Category',
  },
}

function MailRow({ email, selected }: { email: MockEmail; selected: boolean }) {
  const cls = ['mrow', selected ? 'sel' : '', email.unread ? 'unread' : 'read'].filter(Boolean).join(' ')
  return (
    <div className={cls}>
      <span className="dot" />
      <div className="mbody">
        <div className="mline1">
          <span className="sender">
            {email.sender} · {email.domain}
          </span>
          {email.langPip ? <span className="lpip">{email.langPip}</span> : null}
          <span className="time">{email.time}</span>
        </div>
        <div className="subj">{email.subject}</div>
        <div className="snip">{email.snippet}</div>
        <div className="mtags">
          <span className={`ppip ${ppipClass(email.priority)}`}>{email.priorityLabel}</span>
          {email.action ? <span className="apip">{email.action}</span> : null}
        </div>
      </div>
    </div>
  )
}

export default function InboxMock({
  emails = defaultEmails,
  selectedId,
  aiFields = defaultAiFields,
  locale = 'zh-CN',
  compact = false,
}: InboxMockProps) {
  const t = CHROME[locale]
  const selId = selectedId ?? emails[0]?.id
  const unreadCount = emails.filter((e) => e.unread).length

  return (
    <div className="app" data-mock="InboxMock">
      {/* ── sidebar rail ───────────────────────────────────────────── */}
      {!compact && (
        <aside className="app-rail">
          <div className="rail-acct">
            <span className="logo" style={{ width: 20, height: 20, borderRadius: 6 }}>
              <Star size={11} />
            </span>
            <span>me</span>
            <span className="chev">▾</span>
          </div>
          <div className="rail-grp">Mailboxes</div>
          <div className="rail-item on">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
              <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
            </svg>
            <span className="lbl">{locale === 'en' ? 'Inbox' : '收件箱'}</span>
            <span className="badge">{unreadCount}</span>
          </div>
          <div className="rail-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
            <span className="lbl">{locale === 'en' ? 'Sent' : '发件箱'}</span>
          </div>
          <div className="rail-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <polyline points="21 8 21 21 3 21 3 8" />
              <rect x="1" y="3" width="22" height="5" />
              <line x1="10" y1="12" x2="14" y2="12" />
            </svg>
            <span className="lbl">{locale === 'en' ? 'Archive' : '存档'}</span>
          </div>
          <div className="rail-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
              <line x1="4" y1="22" x2="4" y2="15" />
            </svg>
            <span className="lbl">{locale === 'en' ? 'Flagged' : '已标旗'}</span>
            <span className="ct">27</span>
          </div>
          <div className="rail-grp">AI Agents</div>
          <div className="rail-item">
            <Star size={15} />
            <span className="lbl">Notion Agent</span>
            <span
              className="dot"
              style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgb(var(--c-ok))' }}
            />
          </div>
          <div className="rail-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
            <span className="lbl">Custom AI</span>
          </div>
          <div className="rail-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-7 3.3M3 4v4h4" />
              <path d="M12 8v4l3 2" />
            </svg>
            <span className="lbl">{locale === 'en' ? 'AI history' : 'AI 会话历史'}</span>
          </div>
          <div className="rail-spacer" />
          <div className="rail-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.4.92 1.65 1.65 0 0 0-1.5 1H10a2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 7 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 2.6 14H2.5a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4 9.4" />
            </svg>
            <span className="lbl">{locale === 'en' ? 'Settings' : '设置'}</span>
          </div>
        </aside>
      )}

      {/* ── mail list ──────────────────────────────────────────────── */}
      <div className="app-list">
        <div className="list-top">
          <div className="list-tabs">
            <button className="on">{t.focused}</button>
            <button>{t.other}</button>
          </div>
        </div>
        <div className="list-meta">
          {locale === 'en'
            ? `${unreadCount} unread · ${674} total`
            : `${unreadCount} 未读 · 总计 ${674}`}
        </div>
        <div className="mlist">
          {emails.map((e) => (
            <MailRow key={e.id} email={e} selected={e.id === selId} />
          ))}
        </div>
      </div>

      {/* ── reading pane ───────────────────────────────────────────── */}
      {!compact && (
        <div className="app-read">
          <div className="read-bar">
            <span className="read-reply">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="9 17 4 12 9 7" />
                <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
              </svg>
              {t.reply}
            </span>
            <span className="read-ic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <span className="read-ic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                <line x1="4" y1="22" x2="4" y2="15" />
              </svg>
            </span>
            <span className="read-ic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <polyline points="21 8 21 21 3 21 3 8" />
                <rect x="1" y="3" width="22" height="5" />
              </svg>
            </span>
            <span className="read-ic" style={{ marginLeft: 'auto' }}>
              <Star size={15} />
            </span>
          </div>
          <div className="read-body">
            <div className="read-subj">{aiFields.subject}</div>
            <div className="read-meta">
              <span className="mk">From</span>
              <span className="mv">
                <b>{aiFields.fromName}</b> · {aiFields.fromDomain}
              </span>
              <span className="mk">Date</span>
              <span className="mv">{aiFields.date}</span>
            </div>

            <div className="aif">
              <div className="aif-top">
                <span className="star">
                  <Star size={13} />
                </span>{' '}
                AI Fields · 5{' '}
                <span className="rev">
                  <svg
                    viewBox="0 0 24 24"
                    width="12"
                    height="12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  {t.reviewed}
                </span>
                <span className="model">{aiFields.model}</span>
              </div>
              <div className="aif-sec">
                <div className="aif-lab">
                  <span className="n">✶</span> {t.summary}
                </div>
                <div className="aif-sum">{aiFields.summary}</div>
              </div>
              <div className="aif-sec">
                <div className="aif-lab">
                  <span className="n">✶</span> {t.replySuggestion}
                </div>
                <div className="aif-reply">
                  <span className="chev">›</span>
                  {locale === 'en' ? 'A draft reply is ready · expand' : '已起草一版回复 · 点击展开'}
                </div>
              </div>
              <div className="aif-foot">
                <span className="ff">
                  <span className="fk">{t.priority}</span>
                  <span className={`ppip ${ppipClass(aiFields.priority)}`}>{aiFields.priorityLabel}</span>
                </span>
                <span className="ff">
                  <span className="fk">{t.action}</span>
                  {aiFields.action}
                </span>
                <span className="ff">
                  <span className="fk">{t.category}</span>
                  {aiFields.category}
                </span>
              </div>
            </div>

            <div className="read-prose">
              <p>{locale === 'en' ? 'Hi all,' : 'Hi 各位，'}</p>
              <p>
                {locale === 'en'
                  ? 'I think the discussion is already thorough — here are a few notes from the field for reference: rollout pacing differs by market and adoption isn’t uniform…'
                  : '我看大家已经有比较全面的讨论了，这里补充几点我在一线的观察供参考：多区域的部署节奏不同市场接受度不完全一样……'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

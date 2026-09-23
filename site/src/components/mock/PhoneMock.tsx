/**
 * PhoneMock — the remote web app on a phone: status bar, a pending-approvals
 * notification banner, app header, Focused/Other tabs, compact mail list and
 * home indicator (global.css .phone-*). Tier-2 mock. Drives off
 * fixtures.phoneEmails.
 *
 * Presentational only — pure props → JSX, no product imports, no window.electron.
 */
import type { MockEmail, Priority } from './fixtures/fixtures'
import { phoneEmails as defaultEmails } from './fixtures/fixtures'

export interface PhoneMockProps {
  /** Compact mail rows. Defaults to fixtures.phoneEmails. */
  emails?: MockEmail[]
  /** Status-bar clock text (e.g. "9:41"). */
  clock?: string
  locale?: 'zh-CN' | 'en'
}

interface Chrome {
  focused: string
  other: string
  pending: string
  count: string
}

const CHROME: Record<'zh-CN' | 'en', Chrome> = {
  'zh-CN': { focused: '重点', other: '其他', pending: '等你拍板 · 发送会议材料给 Maya', count: '2 项' },
  en: { focused: 'Focused', other: 'Other', pending: 'Needs you · send the meeting pack to Maya', count: '2' },
}

/** Map fixture priority → the .ppip modifier class (low → norm styling). */
function ppipClass(p: Priority): string {
  return p === 'low' ? 'norm' : p
}

/** Coral sparkle star — the product brand mark. */
function Star({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
    </svg>
  )
}

function PhoneRow({ email }: { email: MockEmail }) {
  return (
    <div className={`mrow ${email.unread ? 'unread' : 'read'}`}>
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
        <div className="mtags">
          <span className={`ppip ${ppipClass(email.priority)}`}>{email.priorityLabel}</span>
          {email.action ? <span className="apip">{email.action}</span> : null}
        </div>
      </div>
    </div>
  )
}

export default function PhoneMock({
  emails = defaultEmails,
  clock = '9:41',
  locale = 'zh-CN',
}: PhoneMockProps) {
  const t = CHROME[locale]

  return (
    <div className="phone" data-mock="PhoneMock">
      <div className="phone-status">
        <span>{clock}</span>
        <span className="r">5G ▪ ▪▪</span>
      </div>
      {/* Notification banner — approvals waiting on the owner. */}
      <div className="phone-island">
        <div className="pa">
          <Star size={14} />
        </div>
        <div className="pb">
          <div className="pe">MailAgent</div>
          <div className="pt">{t.pending}</div>
        </div>
        <span className="live">
          <span className="d" />
          {t.count}
        </span>
      </div>
      <div className="phone-head">
        <span className="logo">
          <Star size={12} />
        </span>
        <span className="t">MailAgent</span>
        <span className="s">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4-4" />
          </svg>
        </span>
      </div>
      <div className="phone-tabs">
        <button className="on">{t.focused}</button>
        <button>{t.other}</button>
      </div>
      <div className="phone-list">
        {emails.map((e) => (
          <PhoneRow key={e.id} email={e} />
        ))}
      </div>
      <div className="phone-home" />
    </div>
  )
}

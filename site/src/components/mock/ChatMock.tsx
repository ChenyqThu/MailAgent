/**
 * ChatMock — the Custom AI / KOS chat transcript (user bubble + AI tool-call
 * line + cited answer). Faithful recreation of the reference .chat block
 * (MailAgent.html + global.css .chat-*). Tier-2 mock. Drives off fixtures.chat.
 *
 * Presentational only — pure props → JSX, no product imports, no window.electron.
 */
import type { MockChatTurn } from './fixtures/fixtures'
import { chat as defaultChat } from './fixtures/fixtures'

export interface ChatMockProps {
  /** Conversation turns. Defaults to fixtures.chat. */
  turns?: MockChatTurn[]
  /** Caption shown in the chat header strip. */
  title?: string
  locale?: 'zh-CN' | 'en'
}

/** Coral sparkle star — the product brand mark. */
function Star({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 2 14.4 9.6 22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
    </svg>
  )
}

export default function ChatMock({ turns = defaultChat, title, locale = 'zh-CN' }: ChatMockProps) {
  const heading = title ?? (locale === 'en' ? 'Custom AI · chat with an email' : 'Custom AI · 对话一封邮件')

  return (
    <div className="chat" data-mock="ChatMock">
      <div className="chat-top">
        <span className="star">
          <Star size={13} />
        </span>
        {heading}
      </div>
      {turns.map((turn, i) =>
        turn.role === 'you' ? (
          <div className="chat-row" key={i}>
            <div className="chat-av you">{locale === 'en' ? 'U' : '你'}</div>
            <div className="chat-bub">{turn.text}</div>
          </div>
        ) : (
          <div className="chat-row" key={i}>
            <div className="chat-av ai">✦</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {turn.tool ? (
                <div className="chat-tool">
                  <span className="d" />
                  {turn.tool}
                </div>
              ) : null}
              {turn.answer || turn.source ? (
                <div className="chat-ans">
                  {turn.answer}
                  {turn.source ? <span className="src"> {turn.source}</span> : null}
                </div>
              ) : turn.text ? (
                <div className="chat-ans">{turn.text}</div>
              ) : null}
            </div>
          </div>
        ),
      )}
    </div>
  )
}

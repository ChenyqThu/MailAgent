/**
 * MacWindow: the traffic-light window chrome wrapper used around every mock
 * (hero inbox, AI fields, report, dashboard, chat). Renders a .window with a
 * .window-bar (3 dots + address pill) and the children as the window body.
 *
 * Presentational only — pure props → JSX, no product imports, no window.electron.
 */
import type { ReactNode } from 'react'

export interface MacWindowProps {
  /** Address-bar caption (e.g. "MailAgent — 收件箱 · Inbox"). */
  address: string
  /** Window body content. */
  children?: ReactNode
  /** Optional extra class on the .window element. */
  className?: string
}

export default function MacWindow({ address, children, className }: MacWindowProps) {
  return (
    <div className={`window${className ? ' ' + className : ''}`} data-mock="MacWindow">
      <div className="window-bar">
        <div className="dots">
          <i />
          <i />
          <i />
        </div>
        <div className="addr">{address}</div>
      </div>
      {children}
    </div>
  )
}

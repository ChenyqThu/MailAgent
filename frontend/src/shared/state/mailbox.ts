// Active mailbox state. Sprint 1 only persists the *user choice* — the real
// mailbox list (`mailagent debug mail-structure -o json`) lands in Sprint 2
// alongside `<EmailList>`, where we'll fan out a query to populate
// `<Sidebar>` with live unread counts.
//
// Why a separate store from appearance: the active mailbox drives the email
// list query key (TanStack Query cache scope). Coupling it with theme would
// force a query-cache invalidation on every theme toggle. They stay split.

import { create } from 'zustand'

const STORAGE_KEY = 'mailagent.activeMailbox'
const DEFAULT_MAILBOX = '收件箱'

interface MailboxStore {
  active: string
  setActive(next: string): void
}

function read(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (typeof v === 'string' && v.length > 0) return v
    return DEFAULT_MAILBOX
  } catch {
    // localStorage throws under privacy mode; treat as first run.
    return DEFAULT_MAILBOX
  }
}

export const useMailbox = create<MailboxStore>((set) => ({
  active: read(),
  setActive(next) {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* ignore: read() will fall back to default next session */
    }
    set({ active: next })
  }
}))

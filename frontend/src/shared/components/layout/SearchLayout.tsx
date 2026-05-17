// Sprint 3 §2.1 — Search route shell. Mirrors InboxLayout but swaps the
// EmailList + EmailDetail pair for a single full-width SearchPage. Sidebar
// stays so the user can pivot back to a mailbox without going through
// the back arrow.
//
// TitleBar stays mounted across both routes (it owns the theme + accent
// toggles) so we don't lose user-set state across navigation.

import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { SearchPage } from '../search/SearchPage'

export function SearchLayout(): React.ReactElement {
  return (
    <div className="flex flex-col h-full bg-ink-0 text-ink-fg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <SearchPage />
      </div>
      <StatusBar />
    </div>
  )
}

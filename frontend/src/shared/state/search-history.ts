// G-B3 — ⌘K command palette: search history + saved searches.
//
// Pure-frontend, localStorage-backed (no backend / no schema / no IPC). Mirrors
// the persistence + cross-window-sync pattern of src/shared/state/email-filter.ts.
//
// Two persisted slices:
//   - history: most-recent-first, de-duped, capped at HISTORY_LIMIT — the raw
//     normalised query strings the user actually ran.
//   - saved: user-pinned { id, name, query } searches (add / remove).

import { create } from 'zustand'

const KEY_HISTORY = 'mailagent.palette.history'
const KEY_SAVED = 'mailagent.palette.saved'

const HISTORY_LIMIT = 8

export interface SavedSearch {
  id: string
  name: string
  query: string
}

function readHistory(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(KEY_HISTORY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter((v): v is string => typeof v === 'string').slice(0, HISTORY_LIMIT)
  } catch {
    return []
  }
}

function writeHistory(history: ReadonlyArray<string>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY_HISTORY, JSON.stringify(history))
  } catch {
    /* ignore */
  }
}

function readSaved(): SavedSearch[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(KEY_SAVED)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (v): v is SavedSearch =>
        !!v &&
        typeof v === 'object' &&
        typeof (v as SavedSearch).id === 'string' &&
        typeof (v as SavedSearch).name === 'string' &&
        typeof (v as SavedSearch).query === 'string'
    )
  } catch {
    return []
  }
}

function writeSaved(saved: ReadonlyArray<SavedSearch>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(KEY_SAVED, JSON.stringify(saved))
  } catch {
    /* ignore */
  }
}

// Stable id for a saved search. Runtime UI event handler (not a pure-function
// workflow seam), so a randomUUID / timestamp source is acceptable; falls back
// to a timestamp+counter when crypto.randomUUID is unavailable (older runtimes
// / non-secure contexts).
let savedCounter = 0
function newSavedId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  savedCounter += 1
  return `saved-${Date.now()}-${savedCounter}`
}

interface SearchHistoryStore {
  history: string[]
  saved: SavedSearch[]
  /** Record a run query: trim, skip empty, de-dupe (move to front), cap at 8. */
  pushHistory(query: string): void
  removeHistory(query: string): void
  clearHistory(): void
  /** Pin the current query as a saved search. */
  addSaved(name: string, query: string): void
  removeSaved(id: string): void
}

export const useSearchHistory = create<SearchHistoryStore>((set, get) => ({
  history: readHistory(),
  saved: readSaved(),

  pushHistory(query) {
    const q = query.trim()
    if (q.length === 0) return
    const prev = get().history
    const next = [q, ...prev.filter((h) => h !== q)].slice(0, HISTORY_LIMIT)
    writeHistory(next)
    set({ history: next })
  },
  removeHistory(query) {
    const next = get().history.filter((h) => h !== query)
    writeHistory(next)
    set({ history: next })
  },
  clearHistory() {
    writeHistory([])
    set({ history: [] })
  },
  addSaved(name, query) {
    const q = query.trim()
    if (q.length === 0) return
    const trimmedName = name.trim() || q
    const next = [...get().saved, { id: newSavedId(), name: trimmedName, query: q }]
    writeSaved(next)
    set({ saved: next })
  },
  removeSaved(id) {
    const next = get().saved.filter((s) => s.id !== id)
    writeSaved(next)
    set({ saved: next })
  }
}))

// Cross-window sync for the persisted slices.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY_HISTORY) {
      useSearchHistory.setState({ history: readHistory() })
    } else if (e.key === KEY_SAVED) {
      useSearchHistory.setState({ saved: readSaved() })
    }
  })
}

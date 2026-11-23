// Wave 4C gate: Electron main must NEVER open sync_store.db in read-write mode.
// All SQLite writes outside ai_chat.db (chat_db/) belong strictly to Python serve-api.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = resolve(fileURLToPath(new URL('../../src', import.meta.url)))

function walkTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...walkTsFiles(full))
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

describe('sync_store.db read-only gate (Wave 4C)', () => {
  it('never opens writable better-sqlite3 Database handles outside electron/main/chat_db', () => {
    const offenders: string[] = []
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).replace(/\\/g, '/')
      if (rel.startsWith('electron/main/chat_db/')) continue

      const content = readFileSync(file, 'utf8')
      const matches = [...content.matchAll(/\bnew\s+Database\s*\(/g)]
      for (const m of matches) {
        const idx = m.index ?? 0
        const snippet = content.slice(idx, idx + 220)
        if (!snippet.includes('readonly: true')) {
          offenders.push(`${rel}: ${snippet.split('\n')[0]}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

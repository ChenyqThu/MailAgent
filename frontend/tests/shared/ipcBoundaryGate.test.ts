// Wave 4C gate: enforce that renderer/shared code only touches window.electron / ipcRenderer
// through the three approved boundary modules:
//   - shared/ipc/client.ts
//   - shared/api/ElectronApi.ts
//   - shared/api/factory.ts

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SHARED_ROOT = resolve(fileURLToPath(new URL('../../src/shared', import.meta.url)))
const ALLOWED_FILES = new Set([
  'ipc/client.ts',
  'api/ElectronApi.ts',
  'api/factory.ts'
])

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

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

describe('IPC boundary gate (Wave 4C)', () => {
  it('bans direct window.electron / ipcRenderer access in shared/ outside boundary modules', () => {
    const offenders: string[] = []
    for (const file of walkTsFiles(SHARED_ROOT)) {
      const rel = relative(SHARED_ROOT, file).replace(/\\/g, '/')
      if (ALLOWED_FILES.has(rel)) continue

      const stripped = stripComments(readFileSync(file, 'utf8'))
      if (/\bwindow\.electron\b|\bipcRenderer\b|\.electron\?\./.test(stripped)) {
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})

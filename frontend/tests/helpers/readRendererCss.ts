import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_ENTRY = 'src/electron/renderer/index.css'
const IMPORT_RE = /^@import\s+['"]([^'"]+)['"]\s*;\s*$/gm

function expandCss(absPath: string, seen: Set<string>): string {
  if (seen.has(absPath)) return ''
  seen.add(absPath)
  const raw = readFileSync(absPath, 'utf8')
  const baseDir = dirname(absPath)
  return raw.replace(IMPORT_RE, (line, spec: string) => {
    if (!spec.startsWith('.')) return line
    return expandCss(resolve(baseDir, spec), seen)
  })
}

export function readRendererCss(entryRelPath = DEFAULT_ENTRY): string {
  return expandCss(resolve(process.cwd(), entryRelPath), new Set())
}

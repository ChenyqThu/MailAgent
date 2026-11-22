import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type SupportedLocale = 'zh-CN' | 'en-US'

export interface LocaleFileEntry {
  file: string
  raw: string
  data: Record<string, unknown>
}

export const LOCALES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/shared/i18n/locales'
)

/** Read all domain JSON files under a locale directory in deterministic order. */
export function loadLocaleFiles(locale: SupportedLocale): LocaleFileEntry[] {
  const dir = resolve(LOCALES_DIR, locale)
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
  if (files.length === 0) {
    throw new Error(`${locale}: no domain *.json files found under ${dir}`)
  }
  return files.map((file) => {
    const raw = readFileSync(resolve(dir, file), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${locale}/${file}: root JSON value must be an object`)
    }
    return { file, raw, data: parsed as Record<string, unknown> }
  })
}

/** Merge all domain JSON files for a locale, failing loudly on duplicate top-level keys. */
export function loadLocaleDict(locale: SupportedLocale): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  const owners = new Map<string, string>()

  for (const { file, data } of loadLocaleFiles(locale)) {
    for (const [key, value] of Object.entries(data)) {
      const prev = owners.get(key)
      if (prev !== undefined) {
        throw new Error(`${locale}: duplicate top-level key "${key}" in ${prev} and ${file}`)
      }
      owners.set(key, file)
      merged[key] = value
    }
  }
  return merged
}

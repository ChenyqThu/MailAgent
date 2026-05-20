// Shared Electron launcher for the smoke specs. Points at the packaged
// arm64 .app so the suite exercises the same code path users get from the
// .dmg (file:// loader, ASAR.unpacked native deps, hardened runtime).

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'

// ESM-safe __dirname equivalent. The harness picks up playwright.config.ts
// via type:"module", so CommonJS globals aren't available.
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_FRONTEND_ROOT = path.resolve(__dirname, '..', '..')
const APP_EXECUTABLE = path.join(
  REPO_FRONTEND_ROOT,
  'dist',
  'mac-arm64',
  'MailAgent.app',
  'Contents',
  'MacOS',
  'MailAgent'
)

export interface LaunchedApp {
  app: ElectronApplication
  win: Page
}

export async function launchApp(): Promise<LaunchedApp> {
  const app = await electron.launch({
    executablePath: APP_EXECUTABLE,
    // Hardened runtime + ad-hoc signing still fine for local launch.
    args: [],
    timeout: 30_000
  })
  const win = await app.firstWindow({ timeout: 30_000 })
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

export async function setLocale(win: Page, lng: 'zh-CN' | 'en-US'): Promise<void> {
  // src/shared/i18n/index.ts wires LanguageDetector with detection order
  // ['localStorage', 'navigator'] and `lookupLocalStorage: 'mailagent.language'`.
  // Set THAT key (not the default 'i18nextLng') so the detector picks it up
  // on next init; reload to re-init.
  await win.evaluate((next) => {
    localStorage.setItem('mailagent.language', next)
  }, lng)
  await win.reload()
  await win.waitForLoadState('domcontentloaded')
}

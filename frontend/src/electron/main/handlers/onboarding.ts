// Onboarding IPC (打包 P2/P3 MVP):
//   - onboarding:status  → 当前用户状态 (renderer 也可经 ?onboarding=1 query 直接进向导)
//   - onboarding:complete→ 写 DATA_ROOT/.env (必填项) + 起后端 + 等就绪 + reload 主界面
//
// MVP 范围: 单页配置 (Notion token + DB id + 邮箱/账户名), 默认 AppleScript backend
// (零依赖)。完整多步向导 (FDA 引导 / backend 选择 / 插件勾选 / init 进度) 见
// docs/packaging/03-onboarding-prd.md, 后续迭代。

import { BrowserWindow, app, ipcMain } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'

import { getBackendLifecycle, registerBackendQuitHook } from '../backend_lifecycle'
import { resolveDataRoot } from '../db'
import { detectUserState, ONBOARDING_REQUIRED_KEYS } from '../onboarding/detect'
import { writePatch } from './env'

// 向导可写入 .env 的 key (都在 MANAGED_ENV_KEYS 白名单内; writePatch 会再校验一次)。
const ONBOARDING_WRITABLE_KEYS = [
  'NOTION_TOKEN',
  'EMAIL_DATABASE_ID',
  'CALENDAR_DATABASE_ID',
  'USER_EMAIL',
  'MAIL_ACCOUNT_NAME'
] as const

interface OnboardingResult {
  ok: boolean
  ready?: boolean
  error?: { code: string; message: string }
}

async function handleComplete(
  evt: Electron.IpcMainInvokeEvent,
  raw: unknown
): Promise<OnboardingResult> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: { code: 'E_INVALID', message: 'onboarding:complete 需要配置对象' } }
  }
  const cfg = raw as Record<string, unknown>

  // 收集 + trim 向导可写键。
  const patch: Record<string, string> = {}
  for (const key of ONBOARDING_WRITABLE_KEYS) {
    const v = cfg[key]
    if (typeof v === 'string' && v.trim() !== '') patch[key] = v.trim()
  }

  const missing = ONBOARDING_REQUIRED_KEYS.filter((k) => !patch[k])
  if (missing.length > 0) {
    return { ok: false, error: { code: 'E_MISSING', message: `缺必填项: ${missing.join(', ')}` } }
  }

  // 确保 DATA_ROOT + data/ 存在 (writePatch 不建父目录; 大库附件也落 data/)。
  const dataRoot = resolveDataRoot()
  try {
    mkdirSync(join(dataRoot, 'data'), { recursive: true })
  } catch (err) {
    return {
      ok: false,
      error: { code: 'E_MKDIR', message: `无法创建数据目录 ${dataRoot}: ${(err as Error).message}` }
    }
  }

  // 写 .env (writePatch 处理缺文件→创建 + mode 0600 + MANAGED_ENV_KEYS 校验)。
  const res = writePatch(patch)
  if (!res.ok) {
    return { ok: false, error: res.error ?? { code: 'E_WRITE', message: '.env 写入失败' } }
  }

  // 起后端 + 等就绪 (打包模式; dev 走 pm2 不接管, 视为就绪)。
  registerBackendQuitHook()
  const mgr = getBackendLifecycle()
  mgr.start()
  const ready = app.isPackaged ? await mgr.waitReady() : true

  // 切回主界面: reload 窗口去掉 ?onboarding=1 (loadFile 无 search)。
  const win = BrowserWindow.fromWebContents(evt.sender)
  if (win) {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return { ok: true, ready }
}

export function registerOnboardingHandlers(): void {
  ipcMain.handle('onboarding:status', () => ({ state: detectUserState() }))
  ipcMain.handle('onboarding:complete', handleComplete)
}

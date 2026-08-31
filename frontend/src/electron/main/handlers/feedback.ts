// 快捷反馈的主进程面（task 08-27-l4-tab-workspace P4a）。
//
// 为什么在主进程：renderer 发跨域请求要过 CSP，主进程没这个限制；而且 UA 只有在这里
// 才拼得出 `app.getVersion()`，统一设一处比每个调用方各设一次可靠（🔴 UA 不对
// Cloudflare 会 403 error 1010，见 shared/feedback/contract.ts 顶部）。
//
// 六个 IPC：
//   feedback:context      — 「自动带上」那一行（版本 · 平台 · 当前页面），显示与实发同一份
//   feedback:capture      — 截当前窗口一张 PNG（renderer 截不到自己所在的原生窗口）
//   feedback:diagnostics  — 组装诊断包（复用 admin export-diagnostics，**不弹保存框**）
//   feedback:submit       — 真提交，成功返回 submissionBlockId
//   feedback:recent       — 本地对账台账（最近 N 条）
//   feedback:openForm     — 失败降级：浏览器打开表单页手动提交
//
// 🔴 失败可见是本模块的第一职责：submit 失败一律**抛**（renderer 弹「没发出去」+ 降级
//    入口），并且失败那条也进台账 —— 「界面说成功、其实没发出去」是这批最不能出的错。

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { readFileSync, statSync } from 'fs'
import { basename } from 'path'

import {
  appendFeedbackLog,
  FEEDBACK_FORM_URL,
  FeedbackSubmitError,
  submitFeedbackToNotion,
  type FeedbackAttachment,
  type FeedbackKind,
  type FeedbackLogEntry,
  type FeedbackSubmitInput
} from '@shared/feedback/contract'
import { buildDiagnosticsZip, cleanupDiagnosticsTmp } from './admin'

/** 截图上限（PNG，1600px 宽足够看清界面且不至于让上传慢到用户以为卡了）。 */
const SCREENSHOT_MAX_WIDTH = 1600

/** 主进程侧的台账（进程内，重启即清 —— 它只用于「刚才那条发出去没有」的当场对账，
 *  不是长期归档；长期归档在 Notion 库里）。 */
let feedbackLog: FeedbackLogEntry[] = []

/** 🔴 正常浏览器 UA。`Python-urllib` / 空 UA 会被 Cloudflare 拦成 403 error 1010，
 *  且错误正文里**没有任何关于 UA 的线索** —— 别把它「简化」掉。 */
function feedbackUserAgent(): string {
  return (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) MailAgent/${app.getVersion()} Chrome/130.0.0.0 Safari/537.36`
  )
}

/** 自动带上的运行环境串：版本 · 平台 · 当前页面。界面上只显示这一行确认。 */
export function feedbackContextLine(route?: string): string {
  const parts = [app.getVersion(), process.platform]
  if (route && route.trim().length > 0) parts.push(route.trim())
  return parts.join(' · ')
}

export interface CaptureResult {
  name: string
  type: string
  /** base64 PNG —— renderer 拿它做缩略图，提交时原样回传。 */
  dataBase64: string
  bytes: number
}

/** 截当前窗口。失败返回 null（截不到不是错误 —— 用户可以不带截图继续提交）。 */
export async function runCaptureScreenshot(): Promise<CaptureResult | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return null
  try {
    const image = await win.webContents.capturePage()
    const sized =
      image.getSize().width > SCREENSHOT_MAX_WIDTH
        ? image.resize({ width: SCREENSHOT_MAX_WIDTH })
        : image
    const buf = sized.toPNG()
    return {
      name: `screenshot-${Date.now()}.png`,
      type: 'image/png',
      dataBase64: buf.toString('base64'),
      bytes: buf.byteLength
    }
  } catch {
    // 截图失败不阻断反馈流程（无头 / 窗口刚销毁）。
    return null
  }
}

export interface DiagnosticsResult {
  path: string
  name: string
  bytes: number
}

/** 组装诊断包（约 1 分钟）。renderer 只拿到路径与体积；内容在提交时才读盘。 */
export async function runBuildDiagnostics(): Promise<DiagnosticsResult> {
  const zipPath = await buildDiagnosticsZip()
  let bytes = 0
  try {
    bytes = statSync(zipPath).size
  } catch {
    /* 体积拿不到不致命，界面显示 0 即可 */
  }
  return { path: zipPath, name: basename(zipPath), bytes }
}

/** renderer → 主进程的提交请求（附件用「引用」而不是内容：截图是 base64、诊断包是路径）。 */
export interface FeedbackSubmitRequest {
  kind: FeedbackKind
  title: string
  detail?: string
  freq?: string
  email?: string
  /** 当前路由，进「自动带上的上下文」那一行。 */
  route?: string
  /** 撤掉截图 = **不传这个字段**（而不是传空串）—— payload 必须真的变。 */
  screenshotBase64?: string
  /** 撤掉诊断包 = **不传这个字段**。 */
  diagnosticsPath?: string
  viaAgent?: boolean
}

function attachmentFromBase64(b64: string): FeedbackAttachment {
  const body = Buffer.from(b64, 'base64')
  return { name: `screenshot-${Date.now()}.png`, type: 'image/png', body: new Uint8Array(body) }
}

function attachmentFromPath(path: string): FeedbackAttachment {
  const body = readFileSync(path)
  return { name: basename(path), type: 'application/zip', body: new Uint8Array(body) }
}

/**
 * 真提交。成功返回 submissionBlockId；失败抛 FeedbackSubmitError（调用方给降级）。
 * 无论成败都往台账写一条。
 */
export async function runSubmitFeedback(req: FeedbackSubmitRequest): Promise<{
  submissionBlockId: string
}> {
  const input: FeedbackSubmitInput = {
    kind: req.kind,
    title: req.title,
    detail: req.detail,
    // 类型不是「问题」时 contract 会自己丢掉 freq —— 这里照传，判据只留一处。
    freq: req.freq as FeedbackSubmitInput['freq'],
    version: feedbackContextLine(req.route),
    email: req.email,
    viaAgent: req.viaAgent,
    ...(req.screenshotBase64 ? { screenshot: attachmentFromBase64(req.screenshotBase64) } : {}),
    ...(req.diagnosticsPath ? { diagnostics: attachmentFromPath(req.diagnosticsPath) } : {})
  }
  try {
    const id = await submitFeedbackToNotion(input, { userAgent: feedbackUserAgent() })
    feedbackLog = appendFeedbackLog(feedbackLog, {
      at: Date.now(),
      kind: req.kind,
      title: req.title,
      ok: true,
      submissionBlockId: id,
      viaAgent: req.viaAgent
    })
    return { submissionBlockId: id }
  } catch (e) {
    const detail =
      e instanceof FeedbackSubmitError
        ? `${e.stage}:${e.status}`
        : e instanceof Error
          ? e.message
          : String(e)
    feedbackLog = appendFeedbackLog(feedbackLog, {
      at: Date.now(),
      kind: req.kind,
      title: req.title,
      ok: false,
      error: detail,
      viaAgent: req.viaAgent
    })
    throw e
  } finally {
    // 诊断包是 tmp 产物，提交完（无论成败）就清掉它所在的临时目录。
    if (req.diagnosticsPath) cleanupDiagnosticsTmp(req.diagnosticsPath)
  }
}

export function getFeedbackLog(): FeedbackLogEntry[] {
  return feedbackLog
}

export function registerFeedbackHandlers(): void {
  // 🔴 界面上那一行「自动带上」必须与真正发出去的那一行**由同一个函数算出来**，否则就成了
  // 「显示的和发的不一致」—— renderer 自己拼 version/platform 迟早对不上。
  ipcMain.handle(
    'feedback:context',
    async (_evt, route?: string): Promise<string> => feedbackContextLine(route)
  )
  ipcMain.handle(
    'feedback:capture',
    async (): Promise<CaptureResult | null> => runCaptureScreenshot()
  )
  ipcMain.handle(
    'feedback:diagnostics',
    async (): Promise<DiagnosticsResult> => runBuildDiagnostics()
  )
  ipcMain.handle(
    'feedback:submit',
    async (_evt, req: FeedbackSubmitRequest): Promise<{ submissionBlockId: string }> =>
      runSubmitFeedback(req)
  )
  ipcMain.handle('feedback:recent', async (): Promise<FeedbackLogEntry[]> => getFeedbackLog())
  ipcMain.handle('feedback:openForm', async (): Promise<void> => {
    await shell.openExternal(FEEDBACK_FORM_URL)
  })
}

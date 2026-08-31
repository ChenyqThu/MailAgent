// 快捷反馈的 renderer API 面（task 08-27-l4-tab-workspace P4a）。
//
// 🔴 整个 API 是 **Electron-only 可选面**（`MailApi.feedback?`）：诊断包要 fork CLI、
// 提交要绕开 renderer 的 CSP。远程 web（HttpApi）不实现它 —— 消费方按
// `mailApi.feedback == null` 决定入口显不显示（先例：`admin.exportDiagnostics?`）。

import type { FeedbackKind, FeedbackLogEntry } from '../../feedback/contract'

/** 用户拖进来 / 粘贴的一张图。缩略图与提交 payload 用的是同一份 base64。 */
export interface FeedbackImage {
  name: string
  type: string
  dataBase64: string
  bytes: number
}

export interface FeedbackDiagnostics {
  /** tmp zip 路径。提交后由主进程清理。 */
  path: string
  name: string
  bytes: number
}

export interface FeedbackSubmitOpts {
  kind: FeedbackKind
  title: string
  detail?: string
  /** 🔴 只在 kind==='问题' 时有意义；别的类不传（payload 里整段不出现）。 */
  freq?: string
  email?: string
  /** 当前路由 —— 进「自动带上的上下文」那一行。 */
  route?: string
  /** 撤掉某张图 = **它不在这个数组里**。传空壳不算撤掉。 */
  images?: { name: string; type: string; dataBase64: string }[]
  /** 撤掉诊断包 = **不传这个字段**。 */
  diagnosticsPath?: string
}

export interface FeedbackApi {
  /** 「自动带上」的那一行（版本 · 平台 · 当前页面）。
   *  🔴 与提交时真正写进 payload 的是**同一个函数**算的 —— 别在 renderer 另拼一份。 */
  context(route?: string): Promise<string>
  /** 组装诊断包（约 1 分钟）。 */
  diagnostics(): Promise<FeedbackDiagnostics>
  /** 提交。成功返回回执编号；失败 reject（调用方必须显示「没发出去」+ 降级）。 */
  submit(opts: FeedbackSubmitOpts): Promise<{ submissionBlockId: string }>
  /** 本地对账台账（最近 N 条，进程内）。 */
  recent(): Promise<FeedbackLogEntry[]>
  /** 降级：浏览器打开表单页手动提交。 */
  openForm(): Promise<void>
}

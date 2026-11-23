// Native-only admin IPC handlers: local SQLite path resolution and OS diagnostics zip export.
// Health/stats/dead-letter/davmail-health/system-alerts route directly to loopback serve-api via HttpApi.admin.

import { app, dialog } from 'electron'
import { copyFileSync, rmSync } from 'fs'
import { basename, dirname } from 'path'

import { callCli } from '../cli_runner'
import { resolveDbPath } from '../db'
import { typedIpcHandle } from '../ipc/typedHandle'

const DIAGNOSTICS_TIMEOUT_MS = 180_000

export interface ExportDiagnosticsResult {
  /** True when the user picked a save location and the zip was copied there. */
  saved: boolean
  /** Absolute path the zip was saved to (only when saved=true). */
  path?: string
}

interface DiagnosticsCliData {
  zip_path?: string
  size_bytes?: number
  entry_count?: number
  skipped?: string[]
}

/** tmp zip sits inside its own Python tempfile.mkdtemp() directory; removing the parent cleans everything. */
export function cleanupDiagnosticsTmp(zipPath: string): void {
  try {
    rmSync(dirname(zipPath), { recursive: true, force: true })
  } catch {
    /* best-effort cleanup */
  }
}

export interface DiagnosticsOpts {
  /** `false` passes `--no-quick-check` to skip `PRAGMA quick_check`. */
  quickCheck?: boolean
}

/** Pure CLI argv builder for diagnostics export (unit-tested without forking). */
export function diagnosticsCliArgs(appVersion: string, opts?: DiagnosticsOpts): string[] {
  const args = ['admin', 'export-diagnostics', '--app-version', appVersion]
  if (opts?.quickCheck === false) args.push('--no-quick-check')
  return args
}

/** Assemble diagnostics zip via CLI into a temp dir without showing a save dialog (used by feedback + export). */
export async function buildDiagnosticsZip(opts?: DiagnosticsOpts): Promise<string> {
  const data = (await callCli(diagnosticsCliArgs(app.getVersion(), opts), {
    timeoutMs: DIAGNOSTICS_TIMEOUT_MS
  })) as DiagnosticsCliData
  const zipPath = data?.zip_path
  if (typeof zipPath !== 'string' || zipPath.length === 0) {
    throw new Error('export-diagnostics 未返回 zip_path')
  }
  return zipPath
}

export async function runExportDiagnostics(): Promise<ExportDiagnosticsResult> {
  const zipPath = await buildDiagnosticsZip()
  const result = await dialog.showSaveDialog({
    title: '保存诊断包',
    defaultPath: basename(zipPath),
    filters: [{ name: 'Zip Archive', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePath) {
    cleanupDiagnosticsTmp(zipPath)
    return { saved: false }
  }
  try {
    copyFileSync(zipPath, result.filePath)
  } finally {
    cleanupDiagnosticsTmp(zipPath)
  }
  return { saved: true, path: result.filePath }
}

export function registerAdminHandlers(): void {
  typedIpcHandle('admin:dbPath', (): string => resolveDbPath())
  typedIpcHandle(
    'admin:exportDiagnostics',
    async (): Promise<ExportDiagnosticsResult> => runExportDiagnostics()
  )
}

export const __testing = {
  runExportDiagnostics,
  resolveDbPath
}

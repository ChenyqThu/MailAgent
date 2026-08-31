// task 08-27 P4c — 今日聚合读 IPC（`today:get`）。
//
// 🔴 **不在 TS 重写任何判据**：待回邮件的「已回」判定要跨线程全历史比真实时刻
// （`date_received` 混合时区），且与报告的 attention 分组共用同一份 Python 判据
// （`src/reports/data.is_replied_in_thread`）。这里只经 daemon_api 转发本机 serve-api，
// path/query 严格 mirror `HttpApi.today.get`。
//
// serve-api 不可达（dev 未起）时 `daemonRead` 重试一次后原样 reject —— 由
// `HttpApi`/hook 那侧决定降级；本层不吞错。

import { ipcMain } from 'electron'

import { daemonRead } from '../daemon_api'
import type { TodayData } from '../../../shared/api/types'

interface TodayGetOpts {
  tz?: string
  replyLimit?: number
}

export function registerTodayHandlers(): void {
  ipcMain.handle('today:get', async (_evt, ...args): Promise<TodayData> => {
    const opts = (args[0] ?? {}) as TodayGetOpts
    return daemonRead<TodayData>('/today', {
      query: { tz: opts.tz, replyLimit: opts.replyLimit }
    })
  })
}

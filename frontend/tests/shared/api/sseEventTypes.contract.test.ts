// SSE 事件名跨语言一致性闸（perf-sse-realtime R2）。
//
// 背景: `types/events.ts` 的枚举漂移了半年 —— 漏 `matter.*`/`job.*` 五类、保留已死的
// `folder.synced`，运行时靠 `| string` 兜住, 枚举早已不是契约。本闸把它钉回契约:
// 从后端 Python 源码抽取 `safe_publish("<literal>", …)` 的事件名集合, 与
// `SSE_EVENT_TYPES` 做**双向**对拍 —— 后端新增事件漏 TS 必红, TS 留死名字也必红。
//
// 抽取器纪律（CLAUDE.md「跨边界手抄常量必建一致性闸」/「抽取失败必须红」）:
//   1. 每个已知发布文件必须抽到 ≥1 个事件（PINNED_PUBLISHER_FILES）—— 防「部分抽取
//      比抽不到更毒」: 正则整体失效会命中集合对拍, 单文件悄悄漏抽靠这条兜。
//   2. 禁止 f-string 事件名 `safe_publish(f"…")` —— 拼接名对抽取器不可见
//      (outbox.py 曾是 f"outbox.{new_status}", 本批改成字面量三元)。
//   3. 变量三元形态 `event = "a.b" if … else "c.d"` 单独一条 pattern
//      (job_worker.py / outbox.py 仅有的两处)。
import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative, resolve } from 'path'

import { SSE_EVENT_TYPES } from '../../../src/shared/api/types/events'

const HERE = dirname(fileURLToPath(import.meta.url))
// frontend/tests/shared/api → 上溯四级到仓库根。
const REPO_ROOT = resolve(HERE, '../../../..')
const BACKEND_SRC = join(REPO_ROOT, 'src')

// 事件系统的基础设施（转投/透传, 不是事件**源头**; docstring 里的示例字面量会污染抽取）。
const INFRA_EXCLUDES = new Set([
  'events/publisher.py',
  'events/inprocess_bus.py',
  'events/loopback.py',
  'sse_server.py'
])

// 已知发布文件 → 抽取数下限。抽取器坏掉时这里先红、且报得出是哪个文件。
const PINNED_PUBLISHER_FILES: Record<string, number> = {
  'mail/sync_store.py': 3, // email.synced/failed/dead_letter + folder.changed
  'mail/new_watcher.py': 2, // email.new + email.flag_changed + email.synced
  'services/mail_write.py': 3, // flag/pin/synced + folder.changed
  'sync/outbox.py': 3, // enqueued/done + failed/dead_letter (变量三元)
  'sync/job_worker.py': 3, // running/progress + done/failed (变量三元)
  'api/routers/jobs.py': 1, // job.enqueued
  'llm_agent/store.py': 2, // llm.success + llm.failed/gave_up
  'calendar_sync/worker.py': 1, // calendar.synced
  'api/routers/calendar.py': 1, // calendar.synced (REST 写面)
  'contacts/scanner.py': 1, // contact.changed
  'contacts/profile.py': 1, // contact.changed
  'api/routers/contacts.py': 1, // contact.changed
  'agents/run_queue.py': 1, // agent.run.changed
  'agents/run_worker.py': 1, // agent.run.changed
  'api/routers/agent_runs.py': 1, // agent.run.changed
  'matters/service.py': 1, // matter.changed
  'matters/worker.py': 2, // matter.attention + matter.notify
  'matters/run_service.py': 1, // matter.run.changed
  'sync/mailapp_fanout.py': 1, // email.flag_changed
  'sync/notion_fanout.py': 1 // email.flag_changed
}

function walkPy(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__pycache__') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walkPy(full, out)
    else if (name.endsWith('.py')) out.push(full)
  }
  return out
}

/** 单文件抽取: safe_publish 字面量 + 变量三元两种形态。返回事件名列表（可重复）。 */
function extractEvents(source: string): string[] {
  const events: string[] = []
  // 形态 A: safe_publish( 后第一个实参是字符串字面量（允许换行缩进）。
  for (const m of source.matchAll(/safe_publish\(\s*(['"])([a-z][a-z_.]*)\1/g)) {
    events.push(m[2])
  }
  // 形态 B: event(_type)? = "a.b" if … else "c.d"（job_worker / outbox 的分支名）。
  for (const m of source.matchAll(
    /\bevent(?:_type)?\s*=\s*(['"])([a-z][a-z_.]*)\1\s+if\s.+?\selse\s+(['"])([a-z][a-z_.]*)\3/g
  )) {
    events.push(m[2], m[4])
  }
  // 形态 C: 首实参就是内联三元 safe_publish("a.b" if … else "c.d", …)
  // （llm_agent/store.py 的 llm.failed/llm.gave_up）。形态 A 只见得到 if 前那半。
  for (const m of source.matchAll(
    /safe_publish\(\s*(['"])([a-z][a-z_.]*)\1\s+if\s.+?\selse\s+(['"])([a-z][a-z_.]*)\3/g
  )) {
    events.push(m[2], m[4])
  }
  return events
}

function backendEventMap(): Map<string, Set<string>> {
  const byFile = new Map<string, Set<string>>()
  for (const file of walkPy(BACKEND_SRC)) {
    const rel = relative(BACKEND_SRC, file)
    if (INFRA_EXCLUDES.has(rel)) continue
    const events = extractEvents(readFileSync(file, 'utf8'))
    if (events.length > 0) byFile.set(rel, new Set(events))
  }
  return byFile
}

describe('SSE 事件名 Python↔TS 一致性', () => {
  const byFile = backendEventMap()
  const backendEvents = new Set([...byFile.values()].flatMap((s) => [...s]))

  test('抽取器活着: 每个已知发布文件都抽得到事件（抽取失败必须红）', () => {
    for (const [rel, min] of Object.entries(PINNED_PUBLISHER_FILES)) {
      const got = byFile.get(rel)?.size ?? 0
      expect(
        got,
        `${rel} 只抽到 ${got} 个事件 (< ${min}) —— 要么发布点被移走了 (同步更新本表), ` +
          `要么抽取正则跟不上代码形态 (修抽取器, 别放宽下限)`
      ).toBeGreaterThanOrEqual(min)
    }
  })

  test('禁止 f-string 事件名 (拼接名对抽取器不可见)', () => {
    for (const file of walkPy(BACKEND_SRC)) {
      const rel = relative(BACKEND_SRC, file)
      if (INFRA_EXCLUDES.has(rel)) continue
      const source = readFileSync(file, 'utf8')
      expect(
        /safe_publish\(\s*f['"]/.test(source),
        `${rel} 用了 safe_publish(f"…") 动态事件名 —— 改成字面量分支 ` +
          `(outbox.py 的三元先例), 否则本闸看不见它`
      ).toBe(false)
    }
  })

  test('后端发布集合 ⊆ TS 枚举 (后端新增事件必须同步 SSE_EVENT_TYPES + sse-events.md)', () => {
    const tsSet = new Set<string>(SSE_EVENT_TYPES)
    const missing = [...backendEvents].filter((e) => !tsSet.has(e)).sort()
    expect(
      missing,
      `后端在发但 TS 枚举没有: ${missing.join(', ')} —— 补进 types/events.ts 的 SSE_EVENT_TYPES`
    ).toEqual([])
  })

  test('TS 枚举 ⊆ 后端发布集合 (枚举里不许留后端已死的名字, folder.synced 前车之鉴)', () => {
    const dead = SSE_EVENT_TYPES.filter((e) => !backendEvents.has(e)).sort()
    expect(
      dead,
      `TS 枚举里这些事件后端零发布点: ${dead.join(', ')} —— 要么后端补发布, 要么从枚举删除`
    ).toEqual([])
  })
})

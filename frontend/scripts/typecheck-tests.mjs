#!/usr/bin/env node
// `frontend/tests/` 的类型闸（棘轮式：只许债变少，不许变多）。
//   用法: pnpm typecheck:tests            # 校验，回归则退出码 1
//         pnpm typecheck:tests --update   # 债还掉之后重录基线
//
// ── 为什么需要这个闸 ────────────────────────────────────────────────────────
// `tsconfig.web.json` 只 include `src/**`，vitest 又用 esbuild 抹掉类型照跑 ⇒ 测试里的
// DTO fixture 缺字段、公共函数签名改了调用点没跟上，**都不会红**，而且测试会绿着装作没事：
//   · 2026-08-18 排序批：第二参 `ReadonlySet`→`readonly string[]` 后测试仍传 `new Set()`，
//     comparator 出 NaN ⇒ 排序完全没生效，两道闸全绿；
//   · 2026-08-20 gender 批：`ContactRowDto` 加字段，7 个 fixture 缺，零告警。
//
// ── 为什么是棘轮而不是「全绿闸」────────────────────────────────────────────
// 首次把 tests/ 纳入 tsc 时有 275 个**预存**错（vitest 泛型签名升级、AI-SDK mock 形状、
// matters API 等），跟本轮的 DTO 漂移不是一类，也不该由一次改动全部吞掉。棘轮让闸**今天**
// 就能上：新增错误立刻红，存量按文件记在基线里慢慢还。基线只减不增。
//
// 🔴 基线记的是**每文件错误条数**，不是具体消息 —— 行号会随无关编辑漂移，记消息等于天天改基线。
// 🔴 严禁改成 `tsc -b`（build 模式会 emit，曾往 src 写进 1518 个文件并覆盖 tracked 文件）。

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(root, 'tests', 'typecheck-baseline.json')
const update = process.argv.includes('--update')

/** 跑 tsc 拿原始输出。tsc 有错时退出码非 0 —— 那是预期，不是失败。 */
function runTsc() {
  try {
    execFileSync('node_modules/.bin/tsc', ['--noEmit', '-p', 'tsconfig.tests.json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return ''
  } catch (error) {
    if (typeof error.stdout !== 'string') throw error
    return error.stdout + (error.stderr ?? '')
  }
}

const output = runTsc()
const lines = output.split('\n')
// 形如 `tests/foo.test.ts(12,3): error TS2345: ...`；只取诊断首行（续行以空格缩进）。
const DIAG = /^(\S.*?)\((\d+),(\d+)\): error (TS\d+):/
const counts = {}
let parsed = 0
for (const line of lines) {
  const match = DIAG.exec(line)
  if (!match) continue
  parsed += 1
  const file = match[1].split('\\').join('/')
  counts[file] = (counts[file] ?? 0) + 1
}

// tsc 崩了（配置错 / 依赖缺 / 别人正改到一半）：有输出但一条诊断都解析不出来 ⇒ 别当成「全绿」。
if (output.trim() !== '' && parsed === 0) {
  console.error('[typecheck:tests] tsc 没有产出可解析的诊断，原样转述：\n')
  console.error(output.trim())
  process.exit(1)
}

if (update) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`)
  console.log(
    `[typecheck:tests] 基线已重录：${Object.keys(sorted).length} 个文件 / ${parsed} 条错误。`
  )
  process.exit(0)
}

let baseline
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8'))
} catch {
  console.error(`[typecheck:tests] 读不到基线 ${BASELINE}，先跑一次 --update。`)
  process.exit(1)
}

const regressions = []
for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline[file] ?? 0
  if (count > allowed) regressions.push({ file, count, allowed })
}
const improvements = []
for (const [file, allowed] of Object.entries(baseline)) {
  const count = counts[file] ?? 0
  if (count < allowed) improvements.push({ file, count, allowed })
}

if (regressions.length > 0) {
  console.error('[typecheck:tests] ✗ 测试目录出现新的类型错误：\n')
  for (const { file, count, allowed } of regressions) {
    console.error(`  ${file}: ${allowed} → ${count}`)
    for (const line of lines) {
      if (line.startsWith(`${file}(`)) console.error(`      ${line.trim().slice(0, 200)}`)
    }
  }
  console.error(
    '\n  这些是**新增**的（基线里的存量债不会报）。修掉它们，别去改基线 —— ' +
      '基线只在债变少时用 `pnpm typecheck:tests --update` 重录。'
  )
  process.exit(1)
}

const total = Object.values(baseline).reduce((sum, n) => sum + n, 0)
if (improvements.length > 0) {
  const paid = improvements.reduce((sum, i) => sum + (i.allowed - i.count), 0)
  console.log(`[typecheck:tests] ✓ 无回归，另有 ${paid} 条存量债已还：`)
  for (const { file, count, allowed } of improvements) console.log(`  ${file}: ${allowed} → ${count}`)
  console.log('  跑 `pnpm typecheck:tests --update` 把基线收紧，省得日后又漏回去。')
} else {
  console.log(`[typecheck:tests] ✓ 无回归（基线存量 ${total} 条，见 tests/typecheck-baseline.json）`)
}

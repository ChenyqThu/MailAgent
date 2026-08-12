import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * 「renderer 里禁裸相对 `/api` fetch」结构闸（0812 dogfood Lane A）。
 *
 * 背景：`resolveApiBaseUrl()`（`src/shared/lib/apiBaseUrl.ts`）在**桌面 renderer** 下返回的是
 * 绝对 loopback `http://127.0.0.1:<apiPort>/api`（token/CORS 由主进程 webRequest 桥透明注入）；
 * 只有 web 构建目标才是同源 `/api`。裸相对路径 `fetch('/api/...')` 在桌面端会打向
 * `file://` 或 renderer 自身 origin，读不到也存不了——这正是 `MatterGlobalAgentModal` /
 * `useMatterGlobalAgentDoc` 这两处 0812 新写的真 bug（配置弹窗整个是死的）。
 *
 * 判据只认三种裸相对写法：`fetch('/api`、`fetch("/api`、`` fetch(`/api ``。带 `resolveApiBaseUrl()`
 * 或其他变量拼出来的 `/api` 前缀不算——那是本仓的正确形态。
 *
 * 扫描范围 = `src/shared` + `src/electron/renderer`（renderer 侧代码的两个落点；
 * `src/shared` 是绝大多数 UI 组件所在，被 electron renderer 与 web 双端共用，
 * `src/electron/renderer` 是桌面壳自己的少量代码，如 onboarding）。
 *
 * 🔴 抽取失败必须红：扫到 0 个文件（目录改名/glob 写错）不能被误读成"零违规"，
 * 所以断言里显式钉了「扫到的文件数」下限。
 */

const ROOTS = ['src/shared', 'src/electron/renderer']
const REPO_ROOT = resolve(__dirname, '../..')

/** 裸相对 `/api` fetch 的三种字面量写法。带变量拼接（如 `` `${resolveApiBaseUrl()}/api...` ``）不命中。 */
const OFFENDER_PATTERN = /fetch\(\s*(['"`])\/api/g

/** 递归收集 .ts/.tsx（新增子目录自动入闸）。目录不存在会抛错——这本身就是"必须红"的一种。 */
function walkTsFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...walkTsFiles(full))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

interface GateResult {
  offenders: string[]
  scannedCount: number
}

function runGate(): GateResult {
  const offenders: string[] = []
  let scannedCount = 0
  for (const rootRel of ROOTS) {
    const root = resolve(REPO_ROOT, rootRel)
    for (const file of walkTsFiles(root)) {
      scannedCount += 1
      const source = readFileSync(file, 'utf-8')
      const rel = relative(REPO_ROOT, file)
      let match: RegExpExecArray | null
      OFFENDER_PATTERN.lastIndex = 0
      while ((match = OFFENDER_PATTERN.exec(source)) !== null) {
        const lineNumber = source.slice(0, match.index).split('\n').length
        offenders.push(`${rel}:${lineNumber}`)
      }
    }
  }
  return { offenders, scannedCount }
}

describe('renderer 侧禁裸相对 /api fetch（须走 resolveApiBaseUrl）', () => {
  it('src/shared + src/electron/renderer 下没有 fetch(\'/api / fetch("/api / fetch(`/api', () => {
    const { offenders, scannedCount } = runGate()
    // 抽不到就是闸失效（目录改名 / glob 写错），必须红，不能被读成"零违规"。
    expect(scannedCount, '一个 .ts/.tsx 文件都没扫到 —— 闸失效了').toBeGreaterThan(0)
    expect(
      offenders,
      `这些位置用了裸相对 /api fetch，桌面 renderer 下会打不到后端——改用 ` +
        `\`${'`'}${'${resolveApiBaseUrl()}'}/...${'`'}\`（import { resolveApiBaseUrl } from '@shared/lib/apiBaseUrl'）`
    ).toEqual([])
  })
})

describe('抽取器失效时必须红', () => {
  it('目录不存在 → 抛错而不是静默当作零文件', () => {
    expect(() => walkTsFiles(resolve(REPO_ROOT, 'src/__does_not_exist__'))).toThrow()
  })

  it('命中三种裸相对写法都能抓到；resolveApiBaseUrl 拼接不误伤', () => {
    const source = [
      "fetch('/api/a')",
      'fetch("/api/b")',
      'fetch(`/api/c`)',
      'fetch(`${resolveApiBaseUrl()}/api/d`)',
      "fetch('https://example.com/api/e')"
    ].join('\n')
    const hits: number[] = []
    let match: RegExpExecArray | null
    OFFENDER_PATTERN.lastIndex = 0
    while ((match = OFFENDER_PATTERN.exec(source)) !== null) {
      hits.push(source.slice(0, match.index).split('\n').length)
    }
    expect(hits).toEqual([1, 2, 3])
  })
})

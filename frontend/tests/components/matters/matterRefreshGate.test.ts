import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * 「事项写入后刷新」的**结构闸**（S1，0818 dogfood）。
 *
 * 病根与 `matterMutationGate` 同源、只是换了一条路径：失效清单被**手抄在各个调用点**。
 * `MatterDetail.refresh()` 那份抄了七行，却漏了焦点页跨事项的 `['matters','pending-updates']`
 * —— 它结构上**不可能**被 `['matters','detail',id]` 前缀覆盖，于是在详情里接受一条提案后，
 * 焦点页「待审阅 · Agent 更新提案」里那条继续挂着（staleTime 15s + 组件不重挂 ⇒ 不 refetch）。
 *
 * 修复形态是单一出口 `refreshMatter(client, matterId)`；这条闸负责让**再抄一份**被挡下来。
 *
 * 判据取「失效了 `qk.matters.*` 」而不是「所有 invalidateQueries」：
 * 事项目录下有几处合法的**专属键**失效（attention / runs / 标签定义 / contacts 域），
 * 它们各有语义、不该被这条闸波及。
 */

const MATTERS_DIR = resolve(__dirname, '../../../src/shared/components/matters')
const SHARED_EXIT = 'matterMutation.ts'

/** 允许自己失效 `qk.matters.*` 的文件 —— 加进这里前先问：为什么不能走 refreshMatter？ */
const ALLOWED = new Set<string>([
  SHARED_EXIT,
  // 标签管理器：改的是**标签定义表**（跨全部事项），语义上就是 `qk.matters.all()` 全量，
  // 比 refreshMatter 覆盖面更大，不是它的子集。
  'MatterTagManagerModal.tsx'
])

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 一行里同时出现 invalidateQueries 与 qk.matters. —— 手抄清单的形态。 */
const HANDROLLED = /invalidateQueries\([^)]*qk\.matters\./

describe('事项刷新清单只有一个出口', () => {
  it('事项目录下不许再手抄 qk.matters.* 的失效清单', () => {
    const offenders: string[] = []
    for (const file of sources(MATTERS_DIR)) {
      const name = relative(MATTERS_DIR, file)
      if (ALLOWED.has(name)) continue
      const text = readFileSync(file, 'utf8')
      // 逐行判：多行 Promise.all 里每个 invalidateQueries 各占一行，行内判即可命中。
      text.split('\n').forEach((line, index) => {
        if (HANDROLLED.test(line)) offenders.push(`${name}:${index + 1}  ${line.trim()}`)
      })
    }
    expect(
      offenders,
      `这些地方手抄了事项失效清单 —— 改调 refreshMatter（见 ${SHARED_EXIT}）：\n${offenders.join('\n')}`
    ).toEqual([])
  })

  it('refreshMatter 必须失效跨事项的 pending-updates 聚合键', () => {
    // 🔴 这就是 0818「接受的提案还留在待审阅里」的那一条。它跨事项、没有 id 可挂，
    //    任何前缀都覆盖不到它 —— 只能显式列在清单里。
    const source = readFileSync(join(MATTERS_DIR, SHARED_EXIT), 'utf8')
    const body = /export async function refreshMatter\([\s\S]*?\n}/.exec(source)
    expect(body, `${SHARED_EXIT} 里找不到 refreshMatter —— 闸失效了`).not.toBeNull()
    expect(body![0]).toContain('qk.matters.pendingUpdates()')
    expect(body![0]).toContain('qk.matters.list()')
    expect(body![0]).toContain('qk.matters.detail(matterId)')
  })

  it('pending-updates 的键只能来自工厂，不许内联拼', () => {
    // 内联拼键 = 工厂改了它不跟着改 = 又一个没人失效得到的缓存。
    // 🔴 跳过注释行：解释这个键为什么存在的文档注释里必然写到键名本身，
    //    按裸文本判会把「说明」当成「违规」（首次跑这条闸就误伤了 matterMutation.ts 的注释）。
    const offenders: string[] = []
    for (const file of sources(MATTERS_DIR)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const code = line.trim()
          if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
          if (code.includes("'pending-updates'")) {
            offenders.push(`${relative(MATTERS_DIR, file)}:${index + 1}`)
          }
        })
    }
    expect(
      offenders,
      `这些地方内联拼了 pending-updates 键 —— 改用 qk.matters.pendingUpdates()：${offenders}`
    ).toEqual([])
  })

  it('SSE 的 matter.changed 分支复用同一个出口', () => {
    // 两条路径（用户点击 / SSE 到达）失效同一张清单，才不会一边刷到一边刷不到。
    const bridge = readFileSync(
      resolve(__dirname, '../../../src/shared/hooks/useEventBridge.ts'),
      'utf8'
    )
    expect(bridge).toContain("ev.event_type === 'matter.changed'")
    expect(bridge).toContain('refreshMatter(queryClient, publicId)')
  })
})

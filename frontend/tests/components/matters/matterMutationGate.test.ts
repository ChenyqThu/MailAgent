import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

/**
 * 「冲突后自愈」的**结构闸**（0812 dogfood P0 → 0812 codex修复批加固为 AST）。
 *
 * 病根不是某一处写错，而是**四处各写一遍 onError、其中四处忘了刷新**：带 `expectedVersion`
 * 的写一旦撞上乐观锁，UI 手里那份 version 就永远停在旧值，之后每次点击都必定失败。修复的
 * 形态是一个共享出口 `useMatterMutation`（把「冲突 ⇒ 重新拉事项」焊在包装里），而这条闸负责
 * 让**绕过它**这件事被测试挡下来 —— 否则下一个新增的 mutation 又会漏。
 *
 * 判据取「文件里**构造**了 expectedVersion」而不是「所有 mutation」：能撞版本冲突的恰好就是
 * 带乐观锁的那些写；标签改名 / 通知档位这类全局写没有版本，不该被这条闸波及（hooks.ts 里的
 * attention/notify mutation 就是合法的裸 useMutation）。
 *
 * 🔴 codex 实证过的绕过（旧闸 = 顶层 readdirSync + 字面量正则，全部漏抓），现在逐个堵死：
 *   · 新增子目录 —— 递归扫描；
 *   · 对象 shorthand `{ expectedVersion }` —— AST 的 ShorthandPropertyAssignment；
 *   · 别名导入 `useMutation as mutateHook` —— ImportSpecifier 按**原名**判；
 *   · namespace 调用 `RQ.useMutation` / `RQ['useMutation']` / 解构 —— 属性访问按名判；
 *   · 从本地模块重导出（洗名再供别人 import）—— ExportSpecifier 按原名判，**不限来源模块**、
 *     不要求文件自己带 expectedVersion。
 * 注释里的 useMutation / expectedVersion 天然不再误伤（AST 不看注释）。
 */

const MATTERS_DIR = resolve(__dirname, '../../../src/shared/components/matters')
const SHARED_EXIT = 'matterMutation.ts'

interface MatterMutationScan {
  /** 构造了 expectedVersion（对象字面量属性，含 shorthand）——「带乐观锁的写」的判据。 */
  constructsExpectedVersion: boolean
  /** 触到 raw useMutation 的具体方式（import / 属性访问 / 解构），空 = 干净。 */
  rawUseMutationHits: string[]
  /** 重导出 useMutation（export 子句原名命中，或对 react-query 整包 export *）。 */
  reExportHits: string[]
}

function scanSource(fileName: string, source: string): MatterMutationScan {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const scan: MatterMutationScan = {
    constructsExpectedVersion: false,
    rawUseMutationHits: [],
    reExportHits: []
  }
  const visit = (node: ts.Node): void => {
    // ── expectedVersion 构造点（`expectedVersion: x` 与 shorthand `{ expectedVersion }`）──
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'expectedVersion'
    ) {
      scan.constructsExpectedVersion = true
    }
    // ── import { useMutation [as X] } from '<任意模块>'（本地模块洗名后再导入也算）──
    if (
      node.kind === ts.SyntaxKind.ImportSpecifier ||
      node.kind === ts.SyntaxKind.ExportSpecifier
    ) {
      const spec = node as ts.ImportSpecifier | ts.ExportSpecifier
      const originalName = (spec.propertyName ?? spec.name).text
      if (originalName === 'useMutation') {
        if (node.kind === ts.SyntaxKind.ImportSpecifier) {
          scan.rawUseMutationHits.push(`import of useMutation (as ${spec.name.text})`)
        } else {
          scan.reExportHits.push(`re-export of useMutation (as ${spec.name.text})`)
        }
      }
    }
    // ── export * from '@tanstack/react-query'（整包转发同样把 useMutation 洗出去）──
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause == null &&
      node.moduleSpecifier != null &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@tanstack/react-query'
    ) {
      scan.reExportHits.push("export * from '@tanstack/react-query'")
    }
    // ── namespace / 动态形态：NS.useMutation、NS['useMutation']、const { useMutation } = NS ──
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'useMutation') {
      scan.rawUseMutationHits.push('property access .useMutation')
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'useMutation'
    ) {
      scan.rawUseMutationHits.push("element access ['useMutation']")
    }
    if (ts.isBindingElement(node)) {
      const original =
        node.propertyName != null
          ? ts.isIdentifier(node.propertyName)
            ? node.propertyName.text
            : ts.isStringLiteralLike(node.propertyName)
              ? node.propertyName.text
              : undefined
          : ts.isIdentifier(node.name)
            ? node.name.text
            : undefined
      if (original === 'useMutation') scan.rawUseMutationHits.push('destructured useMutation')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return scan
}

/** 递归收集 .ts/.tsx（新增子目录自动入闸）。 */
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
  versionedCount: number
}

function runGate(root: string): GateResult {
  const offenders: string[] = []
  let versionedCount = 0
  for (const file of walkTsFiles(root)) {
    const rel = relative(root, file)
    // 共享出口按**精确相对路径**豁免 —— 子目录里同名文件蹭不到豁免。
    if (rel === SHARED_EXIT) continue
    const scan = scanSource(file, readFileSync(file, 'utf-8'))
    if (scan.constructsExpectedVersion) versionedCount += 1
    // 重导出无论带不带 expectedVersion 都是洗名通道，一律拦。
    for (const hit of scan.reExportHits) offenders.push(`${rel}: ${hit}`)
    if (scan.constructsExpectedVersion && scan.rawUseMutationHits.length > 0) {
      offenders.push(`${rel}: ${[...new Set(scan.rawUseMutationHits)].join(' + ')}`)
    }
  }
  return { offenders, versionedCount }
}

function read(name: string): string {
  return readFileSync(resolve(MATTERS_DIR, name), 'utf-8')
}

describe('带乐观锁的事项写操作只能走共享出口', () => {
  it('凡是构造 expectedVersion 的文件（递归、AST 判定），都不许触到 raw useMutation', () => {
    const { offenders, versionedCount } = runGate(MATTERS_DIR)
    // 抽不到就是闸失效（目录改名 / 选项改名），必须红。
    expect(versionedCount, '一个构造 expectedVersion 的文件都没找到 —— 闸失效了').toBeGreaterThan(3)
    expect(
      offenders,
      `这些文件带乐观锁却触到了 raw useMutation（或在重导出洗名）—— 改用 useMatterMutation（见 ${SHARED_EXIT}）`
    ).toEqual([])
  })

  it('useStartMatterRun 的版本号藏在转发的 options 里，单列一条', () => {
    const source = read('hooks.ts')
    const body = /export function useStartMatterRun\([\s\S]*?\n}/.exec(source)
    expect(body, 'hooks.ts 里找不到 useStartMatterRun —— 闸失效了').not.toBeNull()
    expect(body![0]).toContain('useMatterMutation({')
  })

  it('共享出口自己恒在冲突时重新拉取，调用方的 onError 关不掉它', () => {
    const source = read(SHARED_EXIT)
    const handler =
      /onError: \(error, variables, onMutateResult, context\) => \{[\s\S]*?\n {4}\}/.exec(source)
    expect(handler, `${SHARED_EXIT} 的 onError 包装被改形了 —— 闸失效了`).not.toBeNull()
    // 先刷新、再把错误交给调用方：顺序反了的话调用方 throw 就会吃掉刷新。
    const refresh = handler![0].indexOf('refetchMatterAfterStale')
    const delegate = handler![0].indexOf('onError?.(')
    expect(refresh).toBeGreaterThan(-1)
    expect(delegate).toBeGreaterThan(refresh)
  })
})

// ── 0812 codex修复批 — 绕过语料库：每种绕过写法都必须被抓到（含新增子目录）────────────────────
describe('结构闸的绕过语料库（synthetic fixtures in a temp tree）', () => {
  const BYPASSES: Array<{ label: string; file: string; source: string }> = [
    {
      label: '子目录 + 别名导入 + shorthand expectedVersion（codex 演示的原始绕过）',
      file: 'sub/probe.ts',
      source: [
        "import { useMutation as mutateHook } from '@tanstack/react-query'",
        'export function probe(expectedVersion: number) {',
        '  return mutateHook({ mutationFn: async () => ({ expectedVersion }) })',
        '}'
      ].join('\n')
    },
    {
      label: 'namespace 调用 ReactQuery.useMutation',
      file: 'deep/nested/ns.ts',
      source: [
        "import * as ReactQuery from '@tanstack/react-query'",
        'export const m = ReactQuery.useMutation({ mutationFn: async () => ({}) })',
        'export const payload = { expectedVersion: 1 }'
      ].join('\n')
    },
    {
      label: "element access RQ['useMutation']",
      file: 'sub/elem.ts',
      source: [
        "import * as RQ from '@tanstack/react-query'",
        "export const m = RQ['useMutation']({ mutationFn: async () => ({}) })",
        'export const payload = { expectedVersion: 1 }'
      ].join('\n')
    },
    {
      label: '解构 const { useMutation } = NS',
      file: 'sub/destructure.ts',
      source: [
        "import * as NS from '@tanstack/react-query'",
        'const { useMutation: um } = NS',
        'export const m = um({ mutationFn: async () => ({}) })',
        'export const payload = { expectedVersion: 1 }'
      ].join('\n')
    },
    {
      label: '本地重导出洗名（不带 expectedVersion 也要拦）',
      file: 'sub/launder.ts',
      source: "export { useMutation as mutate } from '@tanstack/react-query'"
    },
    {
      label: "export * from '@tanstack/react-query' 整包转发",
      file: 'sub/star.ts',
      source: "export * from '@tanstack/react-query'"
    },
    {
      label: '子目录里蹭共享出口的文件名（matterMutation.ts 豁免只认精确相对路径）',
      file: 'sub/matterMutation.ts',
      source: [
        "import { useMutation } from '@tanstack/react-query'",
        'export const m = useMutation({ mutationFn: async () => ({ expectedVersion: 1 }) })'
      ].join('\n')
    }
  ]

  const CLEAN: Array<{ label: string; file: string; source: string }> = [
    {
      label: '无版本的全局写可以用裸 useMutation（hooks.ts 的合法形态）',
      file: 'clean/notify.ts',
      source: [
        "import { useMutation } from '@tanstack/react-query'",
        'export const m = useMutation({ mutationFn: async () => ({}) })'
      ].join('\n')
    },
    {
      label: '注释里的 expectedVersion / useMutation 不误伤',
      file: 'clean/comments.ts',
      source: [
        '// expectedVersion: useMutation 这些词出现在注释里不算数',
        'export const x = 1'
      ].join('\n')
    }
  ]

  it('每种绕过写法在新增子目录里都会被抓到；干净形态不误伤', () => {
    const root = mkdtempSync(join(tmpdir(), 'matter-gate-'))
    try {
      for (const { file, source } of [...BYPASSES, ...CLEAN]) {
        mkdirSync(join(root, file, '..'), { recursive: true })
        writeFileSync(join(root, file), source)
      }
      const { offenders } = runGate(root)
      for (const { label, file } of BYPASSES) {
        expect(
          offenders.some((line) => line.startsWith(file.split('/').join('/'))),
          `绕过「${label}」（${file}）没有被抓到；offenders=${JSON.stringify(offenders)}`
        ).toBe(true)
      }
      for (const { label, file } of CLEAN) {
        expect(
          offenders.some((line) => line.startsWith(file)),
          `干净形态「${label}」（${file}）被误伤`
        ).toBe(false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

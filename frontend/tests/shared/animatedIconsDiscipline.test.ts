// 动画图标目录的三道红线闸（`src/shared/components/icons/animated/`）。
//
// 为什么需要闸：这批图标是从 pqoqubbw/icons vendor 进来的（460+ 个，`pnpm icon:vendor`
// 生成），上游的动画参数与本仓 docs/motion-gsap.md §10 / DESIGN.md §8 直接冲突 ——
// 97 个 spring、45 个 `repeat: Infinity`、77 个 duration > 0.8s、91 个干脆不写 duration
// （吃 motion 默认值 = spring）。转换脚本会把它们改掉，但**没有闸的话，下一次手动加图标
// 或重跑脚本时回潮是完全静默的**：图标照常渲染，只是曲线不对、或者挂上一个常驻 rAF。
//
// 判据单源 = 转换脚本导出的 `redLineHits` / `stripComments`（写侧与验侧同一份定义，
// 不手抄镜像）。三条：
//   ① spring / stiffness / damping / 'use client' / forwardRef / useAnimation 在**代码行**
//      里一次都不许出现（注释里说明「已从 spring 改成 tween」是允许的，故先剥注释）；
//      同一条还管 `ease` —— 必须是 ICON_EASE，上游的 'easeInOut' / 'linear' / 裸
//      cubic-bezier 数组一律判红（曲线不对是「半转半留」里唯一既不报错又看不出来的形态，
//      实际漏过一次：rabbit 的 `transition: TRANSITION` 常量引用绕开了 codemod）；
//   ② `repeat: Infinity`（含 Number.POSITIVE_INFINITY）零命中 —— 常驻动画违 §8 克制哲学，
//      挂在常驻导航上就是永不停的 rAF；
//   ③ 每个 `duration:` 都是数字字面量且 ≤ 0.8s。要求字面量是因为 `duration: X * 2`
//      这类表达式让上界没法验（上游真有：`DURATION * 2` = 1.4s）。

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, test } from 'vitest'

import { redLineHits, stripComments } from '../../scripts/vendor-animated-icons.mjs'

const ICONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/shared/components/icons/animated'
)

const files = readdirSync(ICONS_DIR).filter((f) => f.endsWith('.tsx'))
const sources = files.map((f) => [f, readFileSync(resolve(ICONS_DIR, f), 'utf-8')] as const)

function codeOf(file: string): string {
  const entry = sources.find(([name]) => name === file)
  if (!entry) throw new Error(`${file} 不在图标目录里`)
  return stripComments(entry[1])
}

describe('animated icons — 目录本身', () => {
  // canary：路径写错 / 目录被挪走时，下面三道闸会因为空集合而恒绿 —— 先拦下。
  test('图标目录扫得到（400+ 个），否则三道闸是空转', () => {
    expect(files.length).toBeGreaterThan(400)
  })

  test('每个图标都从 barrel 具名导出，且 barrel 里没有 key → 组件的查表', () => {
    const barrel = readFileSync(resolve(ICONS_DIR, 'index.ts'), 'utf-8')
    const exported = new Set(
      [...barrel.matchAll(/export \{ \w+ \} from '\.\/([\w-]+)'/g)].map((m) => `${m[1]}.tsx`)
    )
    expect([...files].filter((f) => !exported.has(f))).toEqual([])
    // 🔴 461 个图标的 eager 查表 = 一个消费点把全部图标拖进 bundle（folderIcons.ts 那种
    // 查表只对 24 个落库 key 成立）。barrel 里只许有 re-export 行。
    expect(
      stripComments(barrel)
        .replace(/export \{ \w+ \} from '[^']+'\n?/g, '')
        .trim()
    ).toBe('')
  })
})

describe('animated icons — 三道红线闸', () => {
  test.each(sources.map(([f]) => f))('%s 无红线命中', (file) => {
    expect(redLineHits(codeOf(file))).toEqual([])
  })

  // ⚠️ 下面三条聚合闸是**展示副本**（红时按维度列 offenders 好定位），判据以上方
  // per-file 闸的 redLineHits（与 vendor 脚本单源共享）为准——往 redLineHits 加新
  // 维度时聚合闸不会自动跟上，别只看这三条绿就当全过。
  test('闸①：spring / 上游外壳残留在整个目录里零命中', () => {
    const offenders = sources
      .map(([f, src]) => [f, stripComments(src)] as const)
      .filter(([, code]) =>
        /\bspring\b|\bstiffness\b|\bdamping\b|use client|\bforwardRef\b|\buseAnimation\b/.test(code)
      )
      .map(([f]) => f)
    expect(offenders).toEqual([])
  })

  test('闸②：repeat 循环零命中', () => {
    const offenders = sources
      .filter(([, src]) =>
        /repeat:\s*(Infinity|Number\.POSITIVE_INFINITY)/.test(stripComments(src))
      )
      .map(([f]) => f)
    expect(offenders).toEqual([])
  })

  test('闸③：每个 duration 都是 ≤ 0.8 的数字字面量', () => {
    const offenders: string[] = []
    for (const [file, src] of sources) {
      for (const m of stripComments(src).matchAll(/duration:\s*([^,}\n]+)/g)) {
        const value = Number(m[1].trim())
        if (!Number.isFinite(value) || value > 0.8)
          offenders.push(`${file}: duration ${m[1].trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

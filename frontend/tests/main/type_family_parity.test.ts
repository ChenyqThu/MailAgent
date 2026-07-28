// 两个大型 TS 类型族的**结构性字段集比对闸**（issue #68 —— 体量最大的零闸项）。
//
// 覆盖两对镜像（都是同语言、跨进程/跨层的手抄，没有共享定义）：
//
//   A. 日历 IPC —— `electron/main/handlers/calendar-{read,sync,write}.ts`（生产者，
//      IPC 返回/入参的真实形状）↔ `shared/api/types/calendar.ts`（消费者读的声明，
//      renderer 与 web 两端共用）。17 个同名 interface。
//   B. onboarding IPC —— `electron/main/handlers/onboarding.ts` ↔
//      `electron/renderer/onboarding/ipc.ts`。
//      ⚠️ 台账把这一对写成「main ↔ shared/api/types」，实际**没有** `types/onboarding.ts`：
//      onboarding 的消费侧声明在 renderer 自己的 `ipc.ts` 里。镜像关系成立，位置不同。
//
// **为什么是字段集比对而不是逐字段钉值**：这两族加起来 30+ 个 interface、几百个字段，
// 逐个钉 = 一份手抄变两份，且任何合法演进都要改闸（噪音大到没人会维护）。字段**键集**
// 才是漂移真正伤人的地方：生产者多发一个键 = 消费者读不到（TS 说它不存在）；消费者
// 多声明一个键 = 读出来恒 undefined 且**编译期完全不报**（本仓 #67 一整批就是这个形态）。
//
// 🔴 TS 类型运行期被擦除，只能**读源码文本**。本仓已有先例：`db_version_consistency.test.ts`
// 读 Python 源码抽常量。这里同理，但需要带花括号深度的小解析器（interface 里有嵌套对象
// 字面量，纯正则会把嵌套键当成顶层键）。抽取失败一律红。
//
// **只比"两侧都存在"的同名 interface**：各自独有的（main 的 `DbCalendarRow` / `CliSeries`
// 是 SQLite 行内部形状，shared 的 `CalendarApi` / `CalendarEventDetail` 是纯消费侧聚合）
// 不是镜像，不该被强行拉平。
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}

/**
 * 源码文本 → `{ interface 名: 顶层字段键集 }`。
 *
 * 用花括号深度跟踪把嵌套对象字面量的键排除在外（`cost: { input_tokens: number }` 只算
 * `cost` 一个顶层键）。行注释先剥掉，避免注释里的 `foo:` 被当成字段。
 */
export function extractInterfaces(src: string, origin: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const header = /(?:export )?interface (\w+)(?:\s+extends\s+[\w<>, ]+)?\s*\{/g
  let m: RegExpExecArray | null
  while ((m = header.exec(src)) !== null) {
    const name = m[1]
    let depth = 1
    let i = header.lastIndex
    const start = i
    while (i < src.length && depth > 0) {
      const ch = src[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      i++
    }
    if (depth !== 0) {
      throw new Error(`${origin}: interface ${name} 的花括号没配平 —— 源码坏了或解析器需要更新`)
    }
    const body = src
      .slice(start, i - 1)
      // 剥块注释与行注释（注释里的 `foo:` 会被误当字段）。
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    const keys = new Set<string>()
    let d = 0
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim()
      if (d === 0) {
        const km = line.match(/^(?:readonly\s+)?(\w+)\??\s*:/)
        if (km) keys.add(km[1])
      }
      d += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    }
    out.set(name, keys)
  }
  if (out.size === 0) {
    throw new Error(
      `${origin}: 一个 interface 都没抽到 —— 文件搬家了 / 改成 type alias 了？更新本闸的抽取器`
    )
  }
  return out
}

/** 合并多个生产者文件（日历侧 main 分了 read/sync/write 三份）。 */
function extractMany(rels: string[]): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>()
  for (const rel of rels) {
    for (const [name, keys] of extractInterfaces(read(rel), rel)) {
      if (!merged.has(name)) merged.set(name, keys)
    }
  }
  return merged
}

/**
 * 报告两侧对应 interface 的键集差异；返回可读的差异清单（空 = 一致）。
 *
 * `aliases` 给**改了名的**镜像对（生产者名 → 消费者名）。纯按同名匹配会把它们漏掉，
 * 而改名恰恰是漂移最容易藏身的地方（改名时顺手改字段，另一侧没跟）。
 */
function diffShared(
  producer: Map<string, Set<string>>,
  consumer: Map<string, Set<string>>,
  minShared: number,
  aliases: Record<string, string> = {}
): string[] {
  for (const [from, to] of Object.entries(aliases)) {
    const keys = producer.get(from)
    expect(
      keys,
      `别名表里的生产者类型 ${from} 不存在了 —— 改名/删除了？更新本闸的别名表`
    ).toBeDefined()
    expect(
      consumer.get(to),
      `别名表里的消费者类型 ${to} 不存在了 —— 改名/删除了？更新本闸的别名表`
    ).toBeDefined()
    producer.delete(from)
    producer.set(to, keys!)
  }
  const shared = [...producer.keys()].filter((n) => consumer.has(n)).sort()
  expect(
    shared.length,
    `两侧同名 interface 只剩 ${shared.length} 个（预期 ≥${minShared}）—— 大批改名/搬家了？` +
      ' 确认镜像关系是否还成立，再调整本闸的下限，别直接把它调到 0'
  ).toBeGreaterThanOrEqual(minShared)

  const problems: string[] = []
  for (const name of shared) {
    const p = producer.get(name)!
    const c = consumer.get(name)!
    const onlyProducer = [...p].filter((k) => !c.has(k)).sort()
    const onlyConsumer = [...c].filter((k) => !p.has(k)).sort()
    if (onlyProducer.length || onlyConsumer.length) {
      problems.push(
        `${name}: 只在生产者[${onlyProducer.join(', ')}] / 只在消费者[${onlyConsumer.join(', ')}]`
      )
    }
  }
  return problems
}

const CALENDAR_MAIN = [
  'frontend/src/electron/main/handlers/calendar-read.ts',
  'frontend/src/electron/main/handlers/calendar-sync.ts',
  'frontend/src/electron/main/handlers/calendar-write.ts'
]
const CALENDAR_SHARED = 'frontend/src/shared/api/types/calendar.ts'
const ONBOARDING_MAIN = 'frontend/src/electron/main/handlers/onboarding.ts'
const ONBOARDING_RENDERER = 'frontend/src/electron/renderer/onboarding/ipc.ts'

/** 日历侧**改了名**的镜像对（main 名 → shared 名）。
 *
 *  🔴 `CalendarEventRow` ↔ `CalendarEventDetail` 正是靠这条才进闸的：纯按同名匹配会整对漏掉，
 *  而它当时**真的漂着** —— 生产者发 `tzid`（v35 加的），消费侧类型没声明，前端读不到且
 *  编译期不报（issue #68 修复时补上，声明为 optional，因为 web 那条腿至今不发）。
 *  改名是漂移最好的藏身处：改名时顺手改字段，另一侧没跟，谁都不会红。 */
const CALENDAR_ALIASES: Record<string, string> = {
  CalendarEventRow: 'CalendarEventDetail'
}

describe('日历 IPC 类型族 main ↔ shared/api/types', () => {
  test('对应 interface 的字段键集一致（含 1 对改名镜像）', () => {
    const problems = diffShared(
      extractMany(CALENDAR_MAIN),
      extractInterfaces(read(CALENDAR_SHARED), CALENDAR_SHARED),
      // 当前 17 对同名 + 1 对改名；留一档余量，掉到 15 以下说明镜像关系变了（该确认而非放宽）。
      15,
      CALENDAR_ALIASES
    )
    expect(
      problems,
      '日历 IPC 生产者与类型声明的字段集漂移：\n  ' +
        problems.join('\n  ') +
        '\n生产者多的键 = 前端读不到（TS 说它不存在）；声明多的键 = 恒 undefined 且编译期不报。'
    ).toEqual([])
  })
})

/** onboarding 两侧**改了名**的镜像对（main 名 → renderer 名）。各自键集当前一致。 */
const ONBOARDING_ALIASES: Record<string, string> = {
  OnboardingResult: 'CompleteResult',
  PrivacyPaneResult: 'OpenPrivacyPaneResult',
  LegacyVerifyCheck: 'VerifyCheck',
  OnboardingCompleteCfg: 'CompleteConfig'
}

describe('onboarding IPC 类型族 main ↔ renderer/onboarding/ipc', () => {
  test('对应 interface 的字段键集一致（含 4 对改名镜像）', () => {
    const problems = diffShared(
      extractInterfaces(read(ONBOARDING_MAIN), ONBOARDING_MAIN),
      extractInterfaces(read(ONBOARDING_RENDERER), ONBOARDING_RENDERER),
      // 当前 12 对同名 + 4 对改名 = 16；留一档余量，掉到 14 以下说明镜像关系变了。
      14,
      ONBOARDING_ALIASES
    )
    expect(
      problems,
      'onboarding IPC 生产者与 renderer 声明的字段集漂移：\n  ' +
        problems.join('\n  ') +
        '\nonboarding 是首启唯一路径，字段读不到 = 用户卡在某一步且没有报错。'
    ).toEqual([])
  })
})

// ── 反向用例：合成源码证明闸真会红 ────────────────────────────────────────────

describe('闸自身有效性（合成源码）', () => {
  test('嵌套对象的键不被当成顶层键', () => {
    const got = extractInterfaces(
      'export interface X {\n  a: number\n  cost: {\n    nested: number\n  }\n  b?: string\n}\n',
      '<s>'
    )
    expect([...got.get('X')!].sort()).toEqual(['a', 'b', 'cost'])
  })

  test('注释里的 `key:` 不被当成字段', () => {
    const got = extractInterfaces(
      'export interface X {\n  /** see foo: bar */\n  a: number\n  // baz: qux\n}\n',
      '<s>'
    )
    expect([...got.get('X')!]).toEqual(['a'])
  })

  test('抽不到 interface 必须抛，而不是返回空 Map 让比对恒真', () => {
    expect(() => extractInterfaces('export type X = { a: number }\n', '<s>')).toThrow()
  })

  test('漂移必须被报出来', () => {
    const producer = extractInterfaces('interface X {\n  a: number\n  extra: string\n}\n', '<s>')
    const consumer = extractInterfaces('interface X {\n  a: number\n  ghost: string\n}\n', '<s>')
    const problems = diffShared(producer, consumer, 1)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('extra')
    expect(problems[0]).toContain('ghost')
  })
})

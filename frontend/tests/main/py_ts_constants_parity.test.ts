// Python ↔ TS 手抄常量的**对撞闸**（issue #68 —— 矫正三处"假闸"）。
//
// 姊妹闸 `db_version_consistency.test.ts` 是本仓最早的这类闸，也是本文件的模板：
// **纯静态读两个源文件 + 正则抽常量**，不 import 运行时模块（避开 electron mock）、不碰 SQLite。
//
// 本文件覆盖的三对镜像，此前的"闸"各自失效于一种形态（三种形态见 CLAUDE.md /
// architecture-internals.md「跨语言手抄常量的一致性闸」）：
//
// 1. `FIXED_EXEC_PATH` —— **无闸**。Python 是冒号串、TS 是数组，两处独立手写；
//    `exec_policy_matcher.test.ts` 只断言"bare 命令能在固定 PATH 上解析出来"（行为），
//    对两侧列表是否一致完全无感。漂了 = owner 派生出的免卡 exec 规则钉的是一个
//    **子进程实际不会去查的目录** → 规则永不命中、次次弹审批（或反过来：TS 多一个目录，
//    UI 显示的"将免卡"与真实执行不符）。
// 2. `INTEGRITY_MARKER_FILENAME` —— **自指闸**：`backend_lifecycle.test.ts:1345` 写的是
//    `expect(DB_INTEGRITY_MARKER_FILENAME).toBe('db_integrity_failure.json')`，
//    即"TS 常量 == 测试里再抄一遍的同一个字面量"。Python 侧改名时它照样绿。
//    （那条断言保留无妨——它挡的是"TS 侧被误改"；真正缺的是下面这条读 Python 的。）
//    漂了 = Python fail-fast 时写的 marker 前端永远读不到 → 用户只看到"后端起不来"，
//    拿不到 quick_check 的具体损坏详情。
// 3. `REQUIRED_TABLES` —— **单侧**：TS 那份是 Python 那份的**有意子集**（开窗门控只要
//    "邮件读写主路径"已建，admin health 要全量）。此前无任何机制保证它真的是子集；
//    TS 里写错一个表名 = 门控永远等不到就绪 → 开窗卡满 120s 超时降级（v0.2.2 同款事故）。
//
// 三条都**两侧抽真源**，本文件不持任何一侧的期望值副本；抽取失败一律红（正则只认当前习语，
// 重构写法的人必须回来更新抽取器，顺手核对镜像仍一致）。文末合成源码反向用例证明闸真会红。
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}

// ── 抽取器（抽不到 → 抛，调用点断言必红）──────────────────────────────────────

/** Python `NAME = "值"`（模块级，行首无缩进）。 */
function pyStr(src: string, name: string, origin: string): string {
  const m = src.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'))
  if (!m) {
    throw new Error(
      `${origin}: 没抽到 \`${name} = "..."\` —— 常量被改名 / 改成 f-string / 拆成拼接了？` +
        ' 更新本闸的抽取器，并核对镜像仍一致'
    )
  }
  return m[1]
}

/** TS `const NAME = ['a', 'b'] as const` / `export const NAME = [...]`。 */
function tsStrArray(src: string, name: string, origin: string): string[] {
  const m = src.match(new RegExp(`(?:export )?const ${name}\\s*=\\s*\\[([^\\]]*)\\]`))
  if (!m) {
    throw new Error(
      `${origin}: 没抽到 \`const ${name} = [...]\` —— 换成 Set / 从别处 import 了？更新本闸的抽取器`
    )
  }
  const items = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  if (items.length === 0) {
    throw new Error(`${origin}: ${name} 数组里一个字符串字面量都没抽到 —— 习语变了，更新本闸`)
  }
  return items
}

/** TS `export const NAME = 'value'`。 */
function tsStr(src: string, name: string, origin: string): string {
  const m = src.match(new RegExp(`(?:export )?const ${name}\\s*=\\s*'([^']+)'`))
  if (!m) {
    throw new Error(`${origin}: 没抽到 \`const ${name} = '...'\` —— 写法变了，更新本闸的抽取器`)
  }
  return m[1]
}

/** Python 多行元组 `NAME: tuple[str, ...] = (\n  "a",  # 注释\n)`。
 *
 *  🔴 结束符必须锚定**行首的** `)`：条目行的行尾注释里就有右括号
 *  （`"email_outbox",  # v10: SQLite SSoT inversion (Sprint 15)`），用 `[^)]*` 会在那儿
 *  截断，**静默少抽后面的条目** —— 部分抽取比抽不到更毒（闸会红在一个不存在的漂移上，
 *  或反过来放过真漂移）。本闸开发时就踩了这一脚。 */
function pyStrTuple(src: string, name: string, origin: string): string[] {
  const m = src.match(new RegExp(`^${name}[^=\\n]*=\\s*\\(\\n([\\s\\S]*?)\\n\\)`, 'm'))
  if (!m) {
    throw new Error(
      `${origin}: 没抽到多行 \`${name} = (\\n...\\n)\` —— 换成 list / frozenset / 单行写法 /` +
        ' 从别处 import 了？更新本闸的抽取器'
    )
  }
  // 只认「行首缩进 + 字符串字面量」的条目行，避开行尾注释里的引号。
  const items = [...m[1].matchAll(/^\s*"([^"]+)"\s*,/gm)].map((x) => x[1])
  if (items.length === 0) {
    throw new Error(`${origin}: ${name} 里一个条目都没抽到 —— 习语变了，更新本闸的抽取器`)
  }
  return items
}

// ── 1. FIXED_EXEC_PATH（Python 冒号串 ↔ TS 数组）───────────────────────────────

describe('FIXED_EXEC_PATH — exec 子进程固定 PATH', () => {
  test('TS 的目录数组 === Python 冒号串按序拆分', () => {
    const py = pyStr(read('src/skills/secret_names.py'), 'FIXED_EXEC_PATH', 'secret_names.py')
    const ts = tsStrArray(
      read('frontend/src/electron/main/exec_policy_matcher.ts'),
      'FIXED_EXEC_PATH',
      'exec_policy_matcher.ts'
    )
    expect(
      ts,
      `TS 侧 [${ts.join(', ')}] 与 Python 侧 "${py}" 漂移 —— 前端派生 exec 免卡规则时，` +
        ' argv[0] 解析出的 realpath 会与子进程实际查找的目录不一致：规则永不命中（次次弹审批），' +
        ' 或 UI 承诺免卡而真实执行仍拦。**顺序也是语义**（先到先得）。'
    ).toEqual(py.split(':'))
  })
})

// ── 1b. DavMail 登录到期提醒线（本 issue 的原始病根：门槛手抄后漂移）──────────────

describe('AUTH_REMIND_DAYS — davmail 登录到期分档', () => {
  test('TS AUTH_REMIND_DAYS === Python davmail_watchdog 的同名常量', () => {
    const name = 'AUTH_REMIND_DAYS'
    const pySrc = read('src/mail/davmail_watchdog.py')
    const pm = pySrc.match(new RegExp(`^${name}\\s*=\\s*([\\d.]+)`, 'm'))
    expect(
      pm,
      `davmail_watchdog.py 里没抽到 \`${name} = <number>\` —— 改名了？更新本闸`
    ).not.toBeNull()

    const tsSrc = read('frontend/src/shared/lib/davmailThresholds.ts')
    const tm = tsSrc.match(new RegExp(`export const ${name}\\s*=\\s*([\\d.]+)`))
    expect(
      tm,
      `davmailThresholds.ts 里没抽到 \`export const ${name}\` —— 改名了？更新本闸`
    ).not.toBeNull()

    expect(
      Number.parseFloat(tm![1]),
      `TS ${name}=${tm![1]} 与 Python ${pm![1]} 漂移 —— level 由 watchdog live 计算不落盘，` +
        ' 每个读面都自己重算：漂了就是同一次到期在桌面/web/CLI 报不同严重度。'
    ).toBe(Number.parseFloat(pm![1]))
  })

  test('Python auth_expiry_level 的分档比较仍是 `<= 0` / `<= AUTH_REMIND_DAYS`', () => {
    // TS authExpiryLevel 按这两条比较手抄；Python 侧若改成 `<` 或换了判据，这里必须红，
    // 逼改的人回来同步 TS（只比常量抓不到「同一个数、不同的比较符」）。
    const pySrc = read('src/mail/davmail_watchdog.py')
    const fn = pySrc.match(/^def auth_expiry_level\([\s\S]*?(?=^def |^class |^\S)/m)
    expect(
      fn,
      'davmail_watchdog.py 里没抽到 `def auth_expiry_level` —— 改名了？更新本闸'
    ).not.toBeNull()
    expect(fn![0]).toMatch(/if days_left <= 0:\s*\n\s*return "critical"/)
    expect(fn![0]).toMatch(/if days_left <= AUTH_REMIND_DAYS:\s*\n\s*return "warning"/)

    const tsSrc = read('frontend/src/shared/lib/davmailThresholds.ts')
    expect(tsSrc).toMatch(/if \(daysLeft <= 0\) return 'critical'/)
    expect(tsSrc).toMatch(/if \(daysLeft <= AUTH_REMIND_DAYS\) return 'warning'/)
  })

  test('handlers/admin.ts 不再出现裸阈值魔数', () => {
    // issue #68 修复前这里是 `tokenAge >= 87` / `>= 80` 两处裸数字（连常量名都没有，grep
    // 都难找）。分档一律走 @shared/lib/davmailThresholds 的 authExpiryLevel。只抓非零的比较数：
    // 同文件里 `tokenAge >= 0` 是 watchdog 的 "-1 表示 token 文件不可读" 哨兵判定，不是阈值。
    const src = read('frontend/src/electron/main/handlers/admin.ts')
    const body = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n')
    expect(
      body.match(/(token_?[Aa]ge|[Dd]ays_?[Ll]eft)\w*\s*(>=|<=|<|>)\s*[1-9]/g),
      'handlers/admin.ts 又把到期阈值写成裸数字了 —— 必须用 @shared/lib/davmailThresholds'
    ).toBeNull()
  })
})

// ── 2. INTEGRITY_MARKER_FILENAME（自指闸的补侧）───────────────────────────────

describe('INTEGRITY_MARKER_FILENAME — DB 完整性失败 marker', () => {
  test('TS 常量 === Python db_safety 的文件名', () => {
    const py = pyStr(read('src/mail/db_safety.py'), 'INTEGRITY_MARKER_FILENAME', 'db_safety.py')
    const ts = tsStr(
      read('frontend/src/electron/main/backend_lifecycle.ts'),
      'DB_INTEGRITY_MARKER_FILENAME',
      'backend_lifecycle.ts'
    )
    expect(
      ts,
      `TS '${ts}' 与 Python '${py}' 漂移 —— Python 在 quick_check 失败时写这个文件后 fail-fast，` +
        ' 前端读不到就只能显示「后端起不来」，损坏详情丢失。'
    ).toBe(py)
  })
})

// ── 3. REQUIRED_TABLES（有意的子集关系，不是相等）──────────────────────────────

describe('REQUIRED_TABLES — 开窗门控关键表 ⊆ admin health 必备表', () => {
  test('TS 门控子集的每一张表都在 Python 全量清单里', () => {
    // Python 侧真源 = issue #68 起单源的 src/services/admin_health.py
    // （此前 CLI 与 serve-api 各一份逐字副本）。
    const py = pyStrTuple(
      read('src/services/admin_health.py'),
      'REQUIRED_TABLES',
      'admin_health.py'
    )
    const ts = tsStrArray(
      read('frontend/src/electron/main/backend_lifecycle.ts'),
      'REQUIRED_TABLES',
      'backend_lifecycle.ts'
    )
    const extra = ts.filter((t) => !py.includes(t))
    expect(
      extra,
      `前端门控要求的表 [${extra.join(', ')}] 不在后端必备表清单里 —— 拼错一个表名 = probeDbReady` +
        ' 永远等不到就绪，开窗卡满 120s 超时才降级（v0.2.2 同款事故形态）。' +
        ' 子集关系是**有意的**（门控只要邮件读写主路径已建），但成员必须是真表名。'
    ).toEqual([])
    expect(ts.length, '前端门控清单被清空了？那门控形同虚设').toBeGreaterThan(0)
  })
})

// ── 反向用例：合成源码证明闸真会红 ────────────────────────────────────────────

describe('闸自身有效性（合成源码）', () => {
  test('抽取失败必须抛，而不是静默返回空值恒真', () => {
    expect(() =>
      pyStr('FIXED_EXEC_PATH = os.environ["PATH"]\n', 'FIXED_EXEC_PATH', '<s>')
    ).toThrow()
    expect(() =>
      tsStrArray('const FIXED_EXEC_PATH = new Set([])\n', 'FIXED_EXEC_PATH', '<s>')
    ).toThrow()
    expect(() => tsStrArray('const FIXED_EXEC_PATH = []\n', 'FIXED_EXEC_PATH', '<s>')).toThrow()
    expect(() => tsStr('const X = `db_integrity_failure.json`\n', 'X', '<s>')).toThrow()
    expect(() =>
      pyStrTuple('REQUIRED_TABLES = frozenset({"a"})\n', 'REQUIRED_TABLES', '<s>')
    ).toThrow()
  })

  test('多行元组抽取不被行尾注释里的右括号截断', () => {
    // 本闸开发时的真实 bug：`[^)]*` 在 `(Sprint 15)` 处停下，静默漏掉其后所有条目 ——
    // 部分抽取比抽不到更毒（会红在一个不存在的漂移上，也可能反过来放过真漂移）。
    const synthetic =
      'REQUIRED_TABLES: tuple[str, ...] = (\n' +
      '    "a",\n' +
      '    "b",     # v10: SSoT inversion (Sprint 15)\n' +
      '    "c",     # 说明里还有 "带引号的词"\n' +
      ')\n'
    expect(pyStrTuple(synthetic, 'REQUIRED_TABLES', '<s>')).toEqual(['a', 'b', 'c'])
  })

  test('漂移必须比对不上', () => {
    const drifted = tsStrArray(
      "const FIXED_EXEC_PATH = ['/usr/bin', '/bin'] as const\n",
      'FIXED_EXEC_PATH',
      '<s>'
    )
    const py = pyStr(read('src/skills/secret_names.py'), 'FIXED_EXEC_PATH', 'secret_names.py')
    expect(drifted).not.toEqual(py.split(':'))

    const bogus = tsStrArray(
      "const REQUIRED_TABLES = ['email_metadata', 'typo_table'] as const\n",
      'REQUIRED_TABLES',
      '<s>'
    )
    const pyTables = pyStrTuple(
      read('src/services/admin_health.py'),
      'REQUIRED_TABLES',
      'admin_health.py'
    )
    expect(bogus.filter((t) => !pyTables.includes(t))).toEqual(['typo_table'])
  })
})

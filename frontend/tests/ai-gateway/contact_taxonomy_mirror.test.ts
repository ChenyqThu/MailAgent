// 通讯录 CONTACT_KINDS / CONTACT_IDENTITY_FIELDS 词表跨语言一致性闸（task 08-24 收尾批）。
//
// 背景: `frontend/src/ai-gateway/tools/contacts.ts` 里手抄了 Python
// `src/contacts/taxonomy.py` 的两个 CHECK 值域 —— 本地未导出常量 `CONTACT_KINDS`
// (镜 `CONTACT_KIND_VALUES`) / `CONTACT_IDENTITY_FIELDS` (镜 `CONTACT_LOCKABLE_FIELDS`)。
// 同文件里已导入的 `CONTACT_FUNCTION_VALUES` / `CONTACT_SENIORITY_VALUES` 走
// `shared/api/types/contact.ts`, 那份已有 Python 侧闸 `tests/config/test_contact_enum_parity.py`
// 盯着 —— 但 `CONTACT_KINDS` / `CONTACT_IDENTITY_FIELDS` 是第三次手抄 (未走那份共享类型
// 文件, 直接在 gateway 工具文件里重抄一遍), 从未建闸。
//
// 两侧都用文本抽取: Python 源码不能被 vitest import; TS 侧这两个 const 也**未导出**,
// 同样只能文本抽取 (若要 `import` 需先在 src 里加 `export`, 但本闸的任务边界是「只新增
// frontend/tests/ 下的测试文件, 不改 src」, 文本抽取正好不需要改 src)。
//
// 顺序判据: 两个词表在 TS 侧只喂给 `z.enum(...)`, zod 枚举校验只认成员集合、不认声明
// 顺序, 消费点 (`governance._guard_locked_fields` / `set_kind`) 也是集合校验 —— 故本闸
// 按**集合**比较, 不比较声明序 (与 mailboxSemantics 闸的「有序」策略不同, 那里 UI 展示
// 顺序有语义)。
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const HERE = dirname(fileURLToPath(import.meta.url))
// frontend/tests/ai-gateway → 上溯三级到仓库根。
const REPO_ROOT = resolve(HERE, '../../..')

const TAXONOMY_PY = resolve(REPO_ROOT, 'src/contacts/taxonomy.py')
const CONTACTS_TS = resolve(REPO_ROOT, 'frontend/src/ai-gateway/tools/contacts.ts')

/** 从 Python 单源抽 `NAME: Tuple[str, ...] = (...)` 里的字符串成员（跨行安全）。 */
function pythonTuple(pySrc: string, name: string): string[] {
  const block = pySrc.match(
    new RegExp(`${name}:\\s*Tuple\\[str, \\.\\.\\.\\]\\s*=\\s*\\(([^)]*)\\)`)
  )
  expect(
    block,
    `taxonomy.py 里没找到 ${name} 的 tuple 定义 —— 改名/搬家了，本闸抽取器需同步更新`
  ).not.toBeNull()
  const literals = [...block![1].matchAll(/"([^"]*)"/g)].map((m) => m[1])
  expect(literals.length, `${name}: 抽到空集 —— 抽取器需更新`).toBeGreaterThan(0)
  return literals
}

/** 从 TS 本地手抄 `const NAME = [...] as const` 里抽字符串成员（跨行安全；未导出也能
 *  抽，因为是纯文本匹配，不走 import）。 */
function tsArray(tsSrc: string, name: string): string[] {
  const block = tsSrc.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const`))
  expect(
    block,
    `contacts.ts 里没找到 \`const ${name} = [...] as const\` —— 声明改形了，本闸抽取器需同步更新`
  ).not.toBeNull()
  const literals = [...block![1].matchAll(/'([^']*)'/g)].map((m) => m[1])
  expect(literals.length, `${name}: 抽到空集 —— 抽取器需更新`).toBeGreaterThan(0)
  return literals
}

describe('gateway contact 工具本地手抄词表 ↔ Python taxonomy.py 单源', () => {
  const pySrc = readFileSync(TAXONOMY_PY, 'utf8')
  const tsSrc = readFileSync(CONTACTS_TS, 'utf8')

  test.each([
    ['CONTACT_KIND_VALUES', 'CONTACT_KINDS'],
    ['CONTACT_LOCKABLE_FIELDS', 'CONTACT_IDENTITY_FIELDS']
  ])('%s (Python 单源) 与本地手抄 %s (TS) 成员集合相等', (pyName, tsName) => {
    const pyMembers = pythonTuple(pySrc, pyName)
    const tsMembers = tsArray(tsSrc, tsName)
    expect(
      new Set(tsMembers),
      `contacts.ts 的 ${tsName} 与 taxonomy.py 的 ${pyName} 漂移 —— TS 多一档 = 模型能提议` +
        '一个字段/kind 但服务端拒（governance._guard_locked_fields / set_kind 校验失败）；' +
        'TS 少一档 = 服务端真实值域在 gateway schema 里没有落点，模型永远提不出那个选项。' +
        '改词表两侧必须同步。'
    ).toEqual(new Set(pyMembers))
  })
})

describe('抽取器失效必须红，不许平凡通过（canary）', () => {
  test('Python 侧：找不到常量 / 空集都要抛', () => {
    expect(() => pythonTuple('X = 1\n', 'CONTACT_KIND_VALUES')).toThrow()
    expect(() =>
      pythonTuple('CONTACT_KIND_VALUES: Tuple[str, ...] = ()\n', 'CONTACT_KIND_VALUES')
    ).toThrow()
  })

  test('TS 侧：找不到声明 / 空数组都要抛', () => {
    expect(() => tsArray('const x = 1\n', 'CONTACT_KINDS')).toThrow()
    expect(() => tsArray('const CONTACT_KINDS = [] as const\n', 'CONTACT_KINDS')).toThrow()
  })
})

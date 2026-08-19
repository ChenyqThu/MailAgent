/**
 * 头像取字。`old` = 现状（有 bug），`next` = 修复版。
 *
 * bug：`/[一-鿿]/.test(src)` 一见到中文就走「取后 2 字」，于是
 * `Lucien Chen（陈源泉）` → `slice(-2)` → "泉）"（把全角右括号也取进来了）。
 *
 * 修法：先剥掉括注（全角/半角），再判语种。剥完为空就退回原串，
 * 避免 `（陈源泉）` 这种「整个名字都在括号里」的输入变成 '?'。
 */
const BRACKETED = /[（(][^）)]*[）)]/g

export function initialsOld(name: string, email = ''): string {
  const src = (name || email.split('@')[0] || '').trim()
  if (!src) return '?'
  if (/[一-鿿]/.test(src)) return src.slice(-2)
  const parts = src.split(/[\s.]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return src.slice(0, 2).toUpperCase()
}

export function initialsNext(name: string, email = ''): string {
  const raw = (name || email.split('@')[0] || '').trim()
  if (!raw) return '?'
  // 常用名 = 括注之外的部分；剥完为空则整串都算常用名。
  const src = raw.replace(BRACKETED, ' ').replace(/\s+/g, ' ').trim() || raw
  if (/[一-鿿]/.test(src)) {
    const cjk = src.replace(/[^一-鿿]/g, '')
    return (cjk || src).slice(-2)
  }
  const parts = src.split(/[\s.]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return src.slice(0, 2).toUpperCase()
}

/** 验收用例：左=输入，中=现状，右=修复后应得。 */
export const INITIALS_CASES: [string, string][] = [
  ['Lucien Chen（陈源泉）', 'LC'],
  ['Echo Liu', 'EL'],
  ['唐铭阳', '铭阳'],
  ['孙晓宇', '晓宇'],
  ['陈源泉（Lucien）', '源泉'],
  ['曾东彪', '东彪'],
  ['（陈源泉）', '源泉'],
  ['Jean-Paul Sartre', 'JS'],
  ['赖涵', '赖涵']
]

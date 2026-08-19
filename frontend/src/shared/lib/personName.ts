// 人名 initials 单源（原 compose/recipient-avatar.tsx 的模块私有函数，通讯录
// Monogram（WP2）需要同一份口径后下沉到 lib —— react-refresh 规则不允许组件文件
// 兼职导出工具函数，且抄第二份就会漂（CLAUDE.md 跨边界手抄纪律）。
// 口径：先剥括注取常用名（见 BRACKETED_ALIAS），再判语种 —— 中文取后 2 字
// （size < INITIALS_SINGLE_GLYPH_MAX_SIZE 时只取首字，见下）；拉丁取首两词首字母
// （不足两词取前 2 字符，不受 size 影响——两个字母在小圆里本来就放得下）；空回 '?'。

/**
 * 小尺寸头像下中文 initials 收窄成单字（姓）的阈值（px 直径）。
 * 26 = Monogram 字号下限 `Math.max(10, size*0.4)` 不再生效的位置
 * （size*0.4 >= 10 ⟺ size >= 25，向上取整到 26）——低于它时 2 个 CJK 字会被
 * 强制撑到 ≥20px 宽塞进圆里，实测 18px 圆（compose 收件人 chip）贴边溢出。
 */
export const INITIALS_SINGLE_GLYPH_MAX_SIZE = 26

/**
 * 括注（全角或半角）—— Exchange 通讯簿里「英文名（中文名）」是常见写法。
 * 🔴 剥它是因为「一见中文就取后 2 字」会把**右括号**当成名字的一部分：
 * `Lucien Chen（陈源泉）` → `slice(-2)` → 「泉）」。剥完为空（整串都在括号里，
 * 如 `（陈源泉）`）则退回原串，否则会掉进 '?' 兜底。
 */
const BRACKETED_ALIAS = /[（(][^）)]*[）)]/g

export function contactInitials(name: string, email: string, size?: number): string {
  const raw = (name || email.split('@')[0] || '').trim()
  if (!raw) return '?'
  // 常用名 = 括注之外的部分。
  const src = raw.replace(BRACKETED_ALIAS, ' ').replace(/\s+/g, ' ').trim() || raw
  if (/[一-鿿]/.test(src)) {
    // 只在 CJK 字里取字：混排（`陈源泉 Lucien`、剥不干净的半个括号）下取尾 2 字
    // 同样会捞到拉丁字母或标点。全串无 CJK 不可能走到这里，`|| src` 只是防御 slice 空串。
    const cjk = src.replace(/[^一-鿿]/g, '') || src
    if (size !== undefined && size < INITIALS_SINGLE_GLYPH_MAX_SIZE) return cjk.slice(0, 1)
    return cjk.slice(-2)
  }
  const parts = src.split(/[\s.]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return src.slice(0, 2).toUpperCase()
}

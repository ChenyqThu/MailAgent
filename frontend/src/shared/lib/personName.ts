// 人名 initials 单源（原 compose/recipient-avatar.tsx 的模块私有函数，通讯录
// Monogram（WP2）需要同一份口径后下沉到 lib —— react-refresh 规则不允许组件文件
// 兼职导出工具函数，且抄第二份就会漂（CLAUDE.md 跨边界手抄纪律）。
// 口径：中文取后 2 字；拉丁取首两词首字母（不足两词取前 2 字符）；空回 '?'。

export function contactInitials(name: string, email: string): string {
  const src = (name || email.split('@')[0] || '').trim()
  if (!src) return '?'
  if (/[一-鿿]/.test(src)) return src.slice(-2)
  const parts = src.split(/[\s.]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return src.slice(0, 2).toUpperCase()
}

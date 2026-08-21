// IMAP modified UTF-7 (RFC 3501 §5.1.3) 解码 —— 侧边栏文件夹树的本地 seed 用
// (task 08-20-perf-shell-prefetch-sidebar §③)。
//
// 🔴 跨语言镜像声明: 算法单源是后端 `src/mail/backend/imap_utf7.py::decode_imap_utf7`。
// 它同时是两个关键值的派生源: ① discover 响应的 `display_name` (imap_client.py) 与
// ② `email_metadata.mailbox` (davmail_backend.py 抓信落库时 `decode_imap_utf7(imap_name)`)。
// 为什么不消灭镜像: seed 树的意义正是「不等任何网络往返、直接把 SYNC_FOLDERS 里的
// imap 原始名变成可点的过滤 key」, 而 display_name 只在 discover (真连 IMAP) 之后才有
// —— 只能本地解。一致性闸 = 两侧共享的实测向量 (`DMS&VvpO9lPRXgM-` ↔ `DMS固件发布`、
// `&W,mL3VOGU,KLsF9V-` ↔ `对话历史记录`, 同 multi-folder-sync gate 与
// tests/api/test_folder_discover.py 的 fixture), 见 tests/shared/lib/imapUtf7.test.ts。
//
// 规则 (与标准 UTF-7 的区别): 可打印 ASCII (0x20-0x7e) 原样, 但 `&` 转义为 `&-`;
// 其余字符以 `&` 引导一段 modified-BASE64 (UTF-16BE 字节) 以 `-` 结束, BASE64 里的
// `/` 用 `,` 代替且去掉填充 `=`。注意: 编码段内不含字面 `/`, 所以对原始 imap_name
// 按 '/' 切层级不会切进编码段。
//
// 非法分段尽力还原 (保留原文), 不抛异常 —— 与 Python 版逐分支对齐。

/** modified-BASE64 段 → unicode (UTF-16BE)。解不动返回 null (调用方保留原文)。 */
function decodeBase64Utf16Be(chunk: string): string | null {
  const b64 = chunk.replace(/,/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  let bytes: string
  try {
    bytes = atob(padded)
  } catch {
    return null
  }
  // UTF-16BE 必须偶数字节 (Python 的 .decode("utf-16-be") 对奇数字节抛 → 保留原文)。
  if (bytes.length % 2 !== 0) return null
  let out = ''
  for (let i = 0; i < bytes.length; i += 2) {
    // JS 字符串本身是 UTF-16 code unit 序列 —— 代理对两半按序拼即成正确的 astral 字符。
    out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1))
  }
  return out
}

/** modified UTF-7 (IMAP 文件夹名) → unicode。纯 ASCII 输入原样返回。 */
export function decodeImapUtf7(value: string): string {
  let res = ''
  let i = 0
  const n = value.length
  while (i < n) {
    const ch = value[i]
    if (ch === '&') {
      const end = value.indexOf('-', i)
      if (end === -1) {
        // 缺结束符: 按字面保留剩余内容 (对齐 Python 分支)。
        res += value.slice(i)
        break
      }
      const chunk = value.slice(i + 1, end)
      if (chunk === '') {
        res += '&' // `&-` = 字面 &
      } else {
        // 解码失败: 保留原始分段 (含 & 与 -), 不丢字符。
        res += decodeBase64Utf16Be(chunk) ?? value.slice(i, end + 1)
      }
      i = end + 1
    } else {
      res += ch
      i += 1
    }
  }
  return res
}

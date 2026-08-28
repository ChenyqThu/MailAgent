// Compose 表头的「发件人」只读 chip。
//
// 与 To/Cc/Bcc 的 chip 同一套材质与头像（`.recipient-chip` + RecipientAvatar），
// 名字口径也同一条：通讯录 display_name / formal_name（`is_self` 那条记录本身在库，
// resolve 不过滤 self）。解析不出名字就显示地址，不臆造。
//
// 认出名字时地址不消失，跟在 chip 后面以次级字阶常驻 —— 发件人是「发出去署谁的名」，
// 只显示一个中文名而看不到实际地址会让人不确定用的是哪个邮箱。

import { useMemo } from 'react'

import { RecipientAvatar } from './recipient-avatar'
import { useRecipientDirectoryNames } from './useRecipientDirectory'

interface Props {
  /** 本账号地址；null = 设置里还没读到（显示 `fallbackLabel`）。 */
  email: string | null
  /** 地址未知时的占位文案（i18n 由调用方给）。 */
  fallbackLabel: string
}

export function SenderChip({ email, fallbackLabel }: Props): React.ReactElement {
  const addresses = useMemo(() => (email ? [email] : []), [email])
  const directoryNames = useRecipientDirectoryNames(addresses)
  const name = email ? (directoryNames.get(email.trim().toLowerCase()) ?? '') : ''

  if (!email) {
    return <span className="recipient-chip">{fallbackLabel}</span>
  }

  return (
    <>
      <span className="recipient-chip" title={name ? `${name} <${email}>` : email}>
        <RecipientAvatar name={name} email={email} size={18} />
        <span className="max-w-[220px] truncate">{name || email}</span>
      </span>
      {name && <span className="min-w-0 truncate font-mono text-micro text-ink-fg-3">{email}</span>}
    </>
  )
}

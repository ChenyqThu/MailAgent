// DavMail 登录到期分档的**前端单源**（issue #68）。
//
// 真源在 Python：`src/mail/davmail_watchdog.py` 的 `AUTH_REMIND_DAYS` 与 `auth_expiry_level`
// —— level 由 watchdog live 计算、**不落盘**，所以每个自己重算 level 的读面都得知道这个数。
// 跨语言 import 不了 → 由 `frontend/tests/main/py_ts_constants_parity.test.ts` 对撞。
//
// 🔴 这类门槛已经漂过一次：token 老化门槛在 Python 侧曾有三份手抄，其中 CLI 那份**漏了
// critical 档**，同一个 token 在 web 面报 critical、`mailagent admin health` 只报 warning。
//
// 期限是租户条件访问的登录频率上限（默认 30 天，从最近一次交互认证起算）；剩余天数
// ≤ 0 → critical，≤ 此值 → warning。

/** 剩余天数 ≤ 此值 → level='warning'（提前提醒用户在 App 里重新认证）。 */
export const AUTH_REMIND_DAYS = 3

/** 镜像 Python `auth_expiry_level`：无记录 → null。 */
export function authExpiryLevel(daysLeft: number | null): 'critical' | 'warning' | null {
  if (daysLeft === null) return null
  if (daysLeft <= 0) return 'critical'
  if (daysLeft <= AUTH_REMIND_DAYS) return 'warning'
  return null
}

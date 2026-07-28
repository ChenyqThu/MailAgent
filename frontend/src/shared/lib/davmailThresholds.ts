// DavMail OAuth token 老化门槛的**前端单源**（issue #68）。
//
// 真源在 Python：`src/mail/davmail_watchdog.py` 的 `TOKEN_WARN_DAYS` / `TOKEN_CRITICAL_DAYS`
// —— level 由 watchdog live 计算、**不落盘**，所以每个自己重算 level 的读面都得知道这两个数。
// 跨语言 import 不了 → 由 `frontend/tests/main/py_ts_constants_parity.test.ts` 对撞。
//
// 🔴 这条已经漂过一次：Python 侧曾有三份手抄，其中 CLI 那份**漏了 critical 档**，于是同一个
// 87 天 token 在 web 面报 critical、`mailagent admin health` 只报 warning。TS 侧当时更糟 ——
// `handlers/admin.ts` 里是两处**裸魔数** `>= 87` / `>= 80`，连个名字都没有，grep 都不好找。
//
// refresh_token 的有效期是 90 天：80 天提醒、87 天紧急，留 3 天处置窗口。

/** ≥ 此天数 → level='warning'（还有时间从容重走 OAuth flow）。 */
export const TOKEN_WARN_DAYS = 80

/** ≥ 此天数 → level='critical'（距 90 天失效不足 3 天，需立即处理）。 */
export const TOKEN_CRITICAL_DAYS = 87

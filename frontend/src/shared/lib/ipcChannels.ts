// main ↔ renderer 的 IPC 通道名。**零 import 的叶子模块**（同 `ports.ts` 的理由，issue #68）：
// 通道名在两个进程各手抄一份的话，改一侧就静默失联 —— 广播照发、监听方永远收不到，而两侧
// 单测各自照绿。能消灭的镜像不建闸，直接单源。
//
// 现状说明：既有的 `mailagent:deeplink` / `notifications:navigate` 等仍是两侧字面量，那是
// 历史现状不是范式；本文件从新增通道开始收，不做顺手迁移。

/** serve-api 软门控就绪广播：main `backend_lifecycle.waitApiReady` → renderer
 *  `useApiReadyRefresh`（失效开窗那一瞬打空的 serve-api 系 query）。 */
export const API_READY_CHANNEL = 'mailagent:api-ready'

// 本机后端两个 loopback 端口的**唯一 TS 真源**（issue #68）。
//
// 之前有四份手抄：`backend_lifecycle.ts`（权威份）/ `daemon_api.ts` / `chat_local_bridge.ts`
// / `RemoteAccessTab.tsx`（renderer 侧还是字符串 '8200'）。后两处的注释各自写着「与
// backend_lifecycle 同源」，但没有任何机制保证——`daemon_api.ts` 甚至给出了不 import 的
// 理由：backend_lifecycle 顶层 `import { app } from 'electron'`，拉进来会逼它的单测 mock
// electron。那个理由是成立的，所以这里把常量下沉到一个**零 import 的叶子模块**，理由随之
// 消失：main 与 renderer 都能直接引，谁也不用 mock 谁。
//
// 值的另一半在 Python（`src/cli/main.py` 的 MAILAGENT_API_PORT 默认 / `src/config.py` 的
// `sse_local_port`），跨语言消灭不掉 → 由 tests/api/test_local_ports_parity.py 建闸对撞。

/** serve-api (uvicorn) 默认端口；env `MAILAGENT_API_PORT` 覆盖，host 恒 127.0.0.1。 */
export const DEFAULT_API_PORT = 8200

/** mail-sync 进程内 SSE server 默认端口；env `SSE_LOCAL_PORT` 覆盖。 */
export const DEFAULT_SSE_PORT = 9200

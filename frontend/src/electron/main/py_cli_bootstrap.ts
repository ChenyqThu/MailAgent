// 零依赖叶子模块 (08-12 win-port) — 打包态 Python CLI 的引导常量单源。
//
// 为什么单独一个文件: STALE_CMD_MARKER (backend_lifecycle 的残留进程清扫判据) 与
// PY_CLI_BOOTSTRAP (cli_runner Windows 打包态 spawn `python.exe -c <此串>`) 本质是
// 同一个事实的两个视角 —— marker 必须是 bootstrap 的子串, 否则 Windows 后端进程的
// 命令行不含 marker, 残留清扫会漏杀自家进程。若两常量分居 backend_lifecycle 与
// cli_runner, 会造成 backend_lifecycle → cli_runner → backend_lifecycle 的环
// (cli_runner 不能 import backend_lifecycle, 反向已存在), 且按仓规
// 「跨边界手抄常量先消灭镜像 — 正解是下沉零依赖叶子」故下沉于此。
//
// 🔴 三方强耦合 (改任一处必同步 + 有单测锁):
//   - frontend/scripts/build-python-venv.sh:85  (mac bin/mailagent sh wrapper)
//   - frontend/scripts/build-python-venv.ps1    (win Scripts/mailagent.cmd wrapper + 自检)
//   - 本文件 PY_CLI_BOOTSTRAP (win 打包态 spawn 的 -c 实参)
// 一致性由 frontend/tests/main/backend_lifecycle.test.ts 的 marker 测试锁死
// (读两个构建脚本文本断言含 marker)。

/** 残留进程识别标记: 只出现在打包态后端进程的命令行里 (dev 的 pip console_scripts
 *  shim 与 pm2 的 `python3 main.py` 都不含) → 启动自愈清扫绝不误杀外人。 */
export const STALE_CMD_MARKER = "prog_name='mailagent'"

/** Windows 打包态 CLI 引导代码: PBS win 布局无 bin/ 无 sh wrapper, cli_runner 直接
 *  spawn `python.exe -B -P -c <PY_CLI_BOOTSTRAP> <args...>`。
 *  用模板字面量嵌入 marker —— 结构上保证 marker ⊆ bootstrap, 不靠人肉同步。
 *  -B/-P 语义与 mac wrapper 相同 (禁写 .pyc / 禁 cwd 进 sys.path), 由调用方传参。 */
export const PY_CLI_BOOTSTRAP = `from src.cli.main import app; app(${STALE_CMD_MARKER})`

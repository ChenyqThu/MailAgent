// 零依赖叶子模块 (08-12 win-port) — spawn 内嵌 Python 时的 stdio 编码 env 单源。
//
// 病根 (Windows CI 实测, build-win.yml run 31779845638): Windows 上 CPython 的
// stdout/stderr 默认跟随控制台 code page (GitHub runner = cp1252), 而本仓的 CLI 帮助
// 文本 / loguru 日志 / 告警文案大量是中文 → 一输出就 UnicodeEncodeError:
//   'charmap' codec can't encode characters ... rich/_win32_console.py → cp1252.py encode
// 这不只是 CI 脚本问题: 打包后的 Windows app 里, Electron 主进程 spawn 的
// python.exe (长驻 serve / serve-api / 单次 CLI) 继承的同样是 cp1252 stdio ——
// 任何一行中文日志或异常消息都会把后端当场打崩。
//
// 两个 env 都给, 各自覆盖不同的失败面:
//   - PYTHONUTF8=1     : UTF-8 模式总开关 (PEP 540)。除 stdio 外还把 open() 的默认
//                        编码钉成 UTF-8 (否则 cp1252 会读坏本仓全 UTF-8 的 .env / 日志)。
//   - PYTHONIOENCODING : 兜住个别直接读 sys.stdout.encoding / 自行 reconfigure 的路径。
//
// 🔴 只在 win32 注入: darwin/linux 的 env 组装必须逐字节不变 (Windows 移植零回归红线)。
//    非 win32 返回空对象 → 调用点 `...pythonStdioEnv()` 展开后 env 与改动前完全一致。
//    darwin 零回归由 tests/main/python_stdio_env.test.ts 的断言钉住, 不靠注释。
//
// 🔴 手抄镜像 (改这里必同步, 有闸): frontend/scripts/build-python-venv.ps1 在脚本顶部
//    设同名两个 $env: —— 它跑 python.exe 自检 (mailagent --help 打中文) 时同样会崩。
//    ps1 是 PowerShell 不能 import TS, 故只能镜像 + 建闸 (同 STALE_CMD_MARKER 先例)。

/** Windows 下强制 Python 子进程 UTF-8 stdio 的 env 对。ps1 侧有同名镜像 + 一致性闸。 */
export const PYTHON_UTF8_ENV: Readonly<Record<string, string>> = Object.freeze({
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8'
})

/**
 * spawn 内嵌 Python 时要叠加的 stdio 编码 env。
 *
 * 用法 (两个 exec 入口共用, 不各抄一遍字面量):
 *   `const env = { ...process.env, ...业务 env, ...pythonStdioEnv() }`
 * 排在 `...process.env` 之后 = 父进程若带着错的 PYTHONIOENCODING 也压不过来 ——
 * 这是正确性地板不是偏好项 (读错编码 = 后端崩, 没有"用户想要 cp1252"这种场景)。
 *
 * @param platform 默认取 `process.platform`; 显式传值仅供单测覆盖两侧分支。
 * @returns win32 → 两个键的新对象; 其余平台 → 空对象 (展开后零影响)。
 */
export function pythonStdioEnv(platform: NodeJS.Platform = process.platform): Record<string, string> {
  return platform === 'win32' ? { ...PYTHON_UTF8_ENV } : {}
}

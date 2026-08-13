// electron-builder afterPack hook (打包 P1-8) — 在 electron-builder 给 .app 封签 *之前*,
// 先对嵌入式 CPython 的所有原生二进制 (.so/.dylib + python3.11) 做 ad-hoc 签名。
//
// 为什么 afterPack 要自己做完整签名 (实测结论):
//   electron-builder v26 对 `identity: null` 是 *完全跳过* macOS 签名 (日志:
//   "skipped macOS code signing reason=identity explicitly is set to null" +
//   "arm64 requires signing, but identity is set to null and signing is being skipped")。
//   但 arm64 macOS 要求每个可执行文件至少有 ad-hoc 签名才能运行 → 不签 = .app 跑不起来
//   (codesign --verify 报 "code has no resources")。所以这里 afterPack 自己用
//   `codesign --sign -` 做完整 ad-hoc 签名 (electron-builder 既然跳过, 不存在外层 seal
//   冲突)。先逐个签松散的 python .so (--deep 对 Resources 里的散装 .so 覆盖不全),
//   再对整个 .app 做一次 --deep ad-hoc 签 (覆盖 Frameworks/Helpers/主二进制)。
//   ad-hoc 先够本地/内部分发; 正式 Developer ID + 公证留 P6 (Apple 账号)。
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// codesign 偶发 EAGAIN: build 链 (vite/electron-vite/python provision) 刚跑完, 系统瞬时
// fork 资源未释放, afterPack 立刻 fork 上百个 codesign 子进程会撞 spawnSync EAGAIN。
// 短退避重试 (前面步骤资源很快释放, 实测重跑一次即过) → 免去人工重跑 electron-builder。
async function codesignWithRetry(args, label) {
  const MAX_ATTEMPTS = 4
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('codesign', args, { stdio: 'pipe' })
      return
    } catch (err) {
      const isEagain = err.code === 'EAGAIN' || /EAGAIN/.test(String(err.message))
      if (isEagain && attempt < MAX_ATTEMPTS) {
        const backoffMs = attempt * 250
        console.warn(
          `[afterPack] codesign EAGAIN (${label}; 尝试 ${attempt}/${MAX_ATTEMPTS}), ${backoffMs}ms 后重试 …`
        )
        await sleep(backoffMs)
        continue
      }
      throw err
    }
  }
}

/** 递归收集需签名的 Mach-O (真实文件, 跳过符号链接)。 */
function collectMachO(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      collectMachO(full, acc)
    } else if (entry.isFile()) {
      if (full.endsWith('.so') || full.endsWith('.dylib') || /\/bin\/python3(\.\d+)?$/.test(full)) {
        acc.push(full)
      }
    }
  }
  return acc
}

exports.default = async function afterPack(context) {
  // ── Windows (08-12 win-port): 无 Authenticode 签名 (07-08 拍板不做), 但保留嵌入式
  // python 存在性硬校验。mac 头号坑① 是 python 缺失 → 静默跳签 → 出无后端坏包;
  // win 没有签名步可跳, 等价灾难是「NSIS 包装好了但里面没后端」→ 这里直接 fail loud。
  // (mac 分支下面的软跳过行为保持原样 —— 零回归红线, 不顺手改。)
  if (context.electronPlatformName === 'win32') {
    // win-unpacked 布局: <appOutDir>/resources/ = process.resourcesPath (小写, 无 Contents/)
    const pyExe = path.join(context.appOutDir, 'resources', 'python', 'python.exe')
    const sitePackages = path.join(context.appOutDir, 'resources', 'python', 'Lib', 'site-packages', 'src')
    if (!fs.existsSync(pyExe)) {
      throw new Error(
        `[afterPack] win: 嵌入式 python 缺失 (${pyExe}) — ` +
          '先跑 pwsh frontend/scripts/build-python-venv.ps1 产出 resources/python 再打包'
      )
    }
    if (!fs.existsSync(sitePackages)) {
      throw new Error(
        `[afterPack] win: python 在但后端包缺失 (${sitePackages}) — ` +
          'build-python-venv.ps1 未完成 pip install 阶段? 重跑 provision'
      )
    }
    console.log('[afterPack] win: 嵌入式 python + 后端包校验通过 (Authenticode 签名按拍板不做)')
    return
  }
  if (context.electronPlatformName !== 'darwin') return

  // P6 Developer ID 构建门控 (CSC_LINK = CI 注入了 .p12 证书): electron-builder 在 sign
  // 阶段经 @electron/osx-sign 递归签整个 Contents/ 的所有 Mach-O (含 Resources/python 散装
  // .so/.dylib + bin/python3.11; inside-out + 安全 timestamp + entitlements), 再 notarytool
  // 公证。此时若 afterPack 再做 ad-hoc 预签是多余且有害的 —— ad-hoc 的 --timestamp=none 会令
  // 公证 reject ("signature does not include a secure timestamp")。故有证书时直接交还给
  // electron-builder。无 CSC_LINK (本地 dev / 内部分发; electron-builder identity 省略时 arm64
  // fallback ad-hoc) 才走下面的 afterPack ad-hoc 全签 (arm64 每个 Mach-O 至少要 ad-hoc 签才能跑)。
  if (process.env.CSC_LINK) {
    console.log(
      '[afterPack] Developer ID 构建 (CSC_LINK present) — 跳过 ad-hoc 预签, 交由 electron-builder + notarytool 签名/公证'
    )
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  const pyRoot = path.join(appPath, 'Contents', 'Resources', 'python')
  if (!fs.existsSync(pyRoot)) {
    console.log('[afterPack] 未发现嵌入式 python, 跳过 (', pyRoot, ')')
    return
  }

  const entitlements = path.join(context.packager.info.projectDir, 'build', 'entitlements.mac.plist')
  const targets = collectMachO(pyRoot, [])
  console.log(`[afterPack] 对 ${targets.length} 个嵌入式 python Mach-O 做 ad-hoc 预签名 …`)

  let signed = 0
  for (const file of targets) {
    try {
      await codesignWithRetry([
        '--force', '--sign', '-',
        '--options', 'runtime',
        '--entitlements', entitlements,
        '--timestamp=none',
        file,
      ], path.basename(file))
      signed++
    } catch (err) {
      console.error(`[afterPack] 散装 .so 签名失败: ${file}\n`, err.stderr?.toString() || err.message)
      throw err // 漏签即 SIGKILL, 必须让构建失败而非静默放行
    }
  }
  console.log(`[afterPack] 已签 ${signed} 个嵌入式 python Mach-O; 对整个 .app 做 --deep ad-hoc 签 …`)

  // electron-builder 跳过了签名 → 自己对整个 bundle 做完整 deep ad-hoc 签
  // (Frameworks/Helpers/主二进制 + 再覆盖一遍 .so)。inside-out, 一次完成。
  try {
    await codesignWithRetry([
      '--deep', '--force', '--sign', '-',
      '--options', 'runtime',
      '--entitlements', entitlements,
      '--timestamp=none',
      appPath,
    ], 'deep app')
  } catch (err) {
    console.error('[afterPack] 整 app deep 签名失败:\n', err.stderr?.toString() || err.message)
    throw err
  }


  // verify gate: ad-hoc 下用 --verify (不加 --deep --strict, 后者对 ad-hoc 误报)。
  // arm64 上能通过基础 verify 即表示可加载运行; 失败则构建中止。
  try {
    execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'pipe' })
    console.log('[afterPack] OK — 整 app ad-hoc 签名 + verify 通过 (arm64 可运行)')
  } catch (err) {
    console.error('[afterPack] codesign --verify 失败:\n', err.stderr?.toString() || err.message)
    throw err
  }
}

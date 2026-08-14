#Requires -Version 5.1
<#
build-python-venv.ps1 — Windows 等价的嵌入式 CPython 后端运行时构建脚本 (08-12 win-port)。

⚠️ 状态: 未经 Windows 真机验证 (在 macOS 上完成语法/逻辑 review; 首次真机/CI 跑通后删本行)。

与 build-python-venv.sh (macOS, 不动) 并列: 同一 PBS_TAG/PYVER, 同一「可重定位 standalone
CPython + site-packages 装后端」思路。差异全部来自 Windows PBS 布局:
  - mac:  python/bin/python3.11 + bin/mailagent (sh wrapper)
  - win:  python/python.exe + Lib/site-packages (无 bin/, 无 sh)
    → 打包态前端不走 wrapper: cli_runner.getMailagentCommand() 直接 spawn
      `python.exe -B -P -c <PY_CLI_BOOTSTRAP>` (见 src/electron/main/py_cli_bootstrap.ts)。
      本脚本仍生成 Scripts\mailagent.cmd 自定位 wrapper, 供本地调试 + 构建自检。

产物: frontend/resources/python/  (python.exe + Lib/site-packages 含 src/ + Scripts/mailagent.cmd)
  - 经 electron-builder extraResources 注入到 <app>/resources/python/

── lock 策略 (E0 WP5 打包再现性的 Windows 分叉) ──────────────────────────────────
mac 的 requirements.lock.txt 不适用 Windows: pin 基于 macOS arm64 解析、无环境 marker,
含 uvloop (win 无 wheel, 07-08 research 实证 pip install 直接失败) 与 pyobjc 系 (mac-only)。
Windows 用并列的 requirements.lock.win.txt (仓根), 生成机制:

  首次 (或依赖变更后) 在 Windows x64 真机 / CI windows runner 上:
    pwsh frontend/scripts/build-python-venv.ps1 -GenerateLock
  该模式 = 全新解析安装 (requirements.txt 滤掉 pyobjc 行 + pyproject [cli,api,memory]
  extras + pywin32) → pip freeze (排除项目本体) 覆写 requirements.lock.win.txt → 人工
  review diff 后提交进仓。CI 走 build-win.yml 的 generate_lock input, lock 以 artifact
  形式产出, 需人工下载提交 (CI 不回推 commit)。

  之后每次构建 (默认模式): 只认 requirements.lock.win.txt 锁定安装 (与 mac 同纪律:
  改 requirements.txt/pyproject 不重新生成 win lock = 改动不进 Windows 包)。
  lock 无真实 pin (占位态) 时 fail loud, 不静默回退到全新解析。

── pywin32 落位 (Outlook COM backend 依赖) ──────────────────────────────────────
pywin32 官方 postinstall 脚本 (pywin32_postinstall.py) 做两件打包场景不能做的事:
把 pywintypes311.dll / pythoncom311.dll 拷进 C:\Windows\System32 + 写 HKLM 注册表
(需管理员, 且不可重定位)。本脚本的可重定位替代:
  1. pywin32>=305 自带 site-packages/pywin32.pth → 导入期 pywin32_bootstrap 会
     os.add_dll_directory(pywin32_system32) — 正常 `import pythoncom` 已可解析;
  2. 双保险: 把 pywin32_system32/*.dll 拷到 python.exe 同目录 — Windows DLL 搜索
     顺序第一位是可执行文件所在目录, 覆盖任何绕过 site 处理的调用形态。
零注册表、零系统目录写入、随目录拷贝走。构建末尾 `import pythoncom` 自检验证落位。

── Windows 本地构建三步 (真机 dogfood) ──────────────────────────────────────────
  1. pwsh frontend/scripts/build-python-venv.ps1        # 产 resources/python
     (仓里 requirements.lock.win.txt 还是占位时, 先跑一次 -GenerateLock 并提交 lock)
  2. cd frontend && pnpm install                        # postinstall = electron-builder
     install-app-deps → better-sqlite3/keytar 编成 Electron win-x64 ABI。
     🔴 不要跑 rebuild:node / rebuild:electron (硬编码 --arch=arm64 + codesign, mac 专用);
     跑过 vitest (pnpm test 含 rebuild:node) 后, 用 `pnpm exec electron-builder
     install-app-deps` 切回 Electron ABI (mac 头号坑② 的 win 等价纪律)。
  3. pnpm run build
     && pnpm exec vite build --config vite.web.config.ts                 # web SPA pass1
     && $env:BUILD_SW='1'; pnpm exec vite build --config vite.web.config.ts  # pass2 (SW)
     && pnpm exec electron-builder --win --x64 --publish never
     (不能用 pnpm build:web / build:mac — 两个 script 用 POSIX env 前缀语法, Windows
      解析不了; mac 零回归红线不改 package.json, CI 见 build-win.yml 同款展开。)

用法: pwsh frontend/scripts/build-python-venv.ps1 [-Arch x64] [-GenerateLock]
  (x64 only — 07-08 拍板不出 Windows on ARM)
#>
[CmdletBinding()]
param(
  [ValidateSet('x64')]
  [string]$Arch = 'x64',
  # 全新解析依赖并覆写 requirements.lock.win.txt (bootstrap / 依赖变更时用; 平时锁定安装)
  [switch]$GenerateLock
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest 进度条会拖慢大文件下载

# 本进程内所有 python.exe 子进程恒 UTF-8 stdio。Windows 上 CPython 的 stdout 默认跟随
# 控制台 code page (GitHub runner = cp1252), 而本仓 CLI 帮助文本/日志大量是中文 ——
# §5 自检跑 `mailagent --help` 时实测 UnicodeEncodeError('charmap' codec) 直接把构建打红。
# 🔴 与运行时侧 src/electron/main/python_stdio_env.ts 的 PYTHON_UTF8_ENV 是同一份事实的
#    手抄镜像 (ps1 不能 import TS), 改任一处必同步 —— 闸见 tests/main/python_stdio_env.test.ts。
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

# 与 build-python-venv.sh 保持同版本 (改任一侧必同步另一侧 + 两个 CI cache key)
$PBS_TAG = '20260510'
$PYVER = '3.11.15'
$PBS_TRIPLE = 'x86_64-pc-windows-msvc'

$FrontendDir = Split-Path -Parent $PSScriptRoot   # scripts/ → frontend/
$RepoRoot = Split-Path -Parent $FrontendDir
$Out = Join-Path $FrontendDir 'resources\python'
$Cache = Join-Path $FrontendDir '.cache\pbs'
$Tarball = "cpython-$PYVER+$PBS_TAG-$PBS_TRIPLE-install_only.tar.gz"
$Url = "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_TAG/$Tarball"
$LockFile = Join-Path $RepoRoot 'requirements.lock.win.txt'

function Invoke-Checked {
  param([string]$Exe, [string[]]$ArgList, [string]$Label)
  & $Exe @ArgList
  if ($LASTEXITCODE -ne 0) { throw "[build-python-venv.ps1] $Label 失败 (exit=$LASTEXITCODE)" }
}

Write-Host "[build-python-venv.ps1] arch=$Arch py=$PYVER out=$Out generateLock=$GenerateLock"

# 1. 下载 standalone CPython (带缓存 + 重试, 镜像 .sh 的 curl --retry 3)
New-Item -ItemType Directory -Force -Path $Cache | Out-Null
$TarballPath = Join-Path $Cache $Tarball
if (-not (Test-Path $TarballPath)) {
  Write-Host "[build-python-venv.ps1] 下载 $Tarball ..."
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-WebRequest -Uri $Url -OutFile "$TarballPath.tmp" -UseBasicParsing
      Move-Item -Force "$TarballPath.tmp" $TarballPath
      break
    } catch {
      if ($attempt -eq 3) { throw }
      Write-Warning "下载失败 (尝试 $attempt/3), $(5 * $attempt)s 后重试: $_"
      Start-Sleep -Seconds (5 * $attempt)
    }
  }
} else {
  Write-Host "[build-python-venv.ps1] 命中缓存 $TarballPath"
}

# 2. 解出到 resources/ (tarball 顶层就是 python/)。tar.exe = Windows 10+ 内置 bsdtar,
#    windows-latest runner 自带。
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force -Path (Join-Path $FrontendDir 'resources') | Out-Null
Invoke-Checked 'tar' @('-xzf', $TarballPath, '-C', (Join-Path $FrontendDir 'resources')) 'tar 解压'
$Py = Join-Path $Out 'python.exe'
if (-not (Test-Path $Py)) { throw "[build-python-venv.ps1] 解压后未找到 $Py (PBS win 布局变了?)" }

# 3. 装后端依赖
Invoke-Checked $Py @('-m', 'pip', 'install', '--upgrade', 'pip', '-q') 'pip 自升级'

if ($GenerateLock) {
  # ── 生成模式: 全新解析 (Windows 平台原生 marker 解析), 产出 win lock ────────────
  # requirements.txt 滤掉 pyobjc 行: mac-only 无 win wheel (lock 头注释有案),
  # 其消费点 attachment_text.py 懒 import 软着陆 (Windows 上 OCR 自动降级, 07-08 调研)。
  Write-Host '[build-python-venv.ps1] -GenerateLock: 全新解析 requirements.txt (滤 pyobjc) + extras + pywin32 ...'
  $reqFiltered = Get-Content (Join-Path $RepoRoot 'requirements.txt') |
    Where-Object { $_ -notmatch '^\s*pyobjc' }
  $reqTmp = Join-Path ([System.IO.Path]::GetTempPath()) 'mailagent-requirements.win-filtered.txt'
  Set-Content -Path $reqTmp -Value $reqFiltered -Encoding UTF8
  Invoke-Checked $Py @('-m', 'pip', 'install', '-q', '-r', $reqTmp) 'pip install requirements (win 过滤)'
  # extras 语义同 .sh §3 备忘 (api=serve-api 必需 / memory=mem0 栈 / cli)。uvloop 由
  # uvicorn[standard] 的 sys_platform != 'win32' marker 在此步天然排除。
  Push-Location $RepoRoot
  try {
    Invoke-Checked $Py @('-m', 'pip', 'install', '-q', '.[cli,api,memory]') 'pip install .[cli,api,memory]'
  } finally {
    Pop-Location
  }
  # pywin32 = Outlook COM backend (MAILAGENT_BACKEND=outlook_com) 依赖。pyproject 尚无
  # win 专属 extra, 先在此显式钉入 lock; 后端侧声明 extra 后改走 .[win] 并删本行。
  Invoke-Checked $Py @('-m', 'pip', 'install', '-q', 'pywin32') 'pip install pywin32'

  Write-Host "[build-python-venv.ps1] pip freeze → $LockFile"
  $frozen = & $Py -m pip freeze
  if ($LASTEXITCODE -ne 0) { throw '[build-python-venv.ps1] pip freeze 失败' }
  # 排除项目本体 (freeze 输出 "mailagent @ file:///..."), 镜像 mac lock 纪律
  $pins = $frozen | Where-Object { $_ -notmatch '^mailagent[ @=]' }
  $lockHeader = @(
    '# requirements.lock.win.txt — Windows x64 嵌入式 CPython 运行时的全量依赖锁',
    '#   (E0 WP5 打包再现性的 Windows 分叉; mac 侧 = requirements.lock.txt, 两文件互不适用)',
    '#',
    '# 覆盖范围: build-python-venv.ps1 的完整安装集',
    '#   = requirements.txt (滤 pyobjc 行, mac-only) + pyproject [cli,api,memory] extras',
    '#     + pywin32 (outlook_com backend) 的全部传递闭包, 全 == pin。',
    '#   不含项目本体 mailagent (脚本单独以 --no-deps 安装);',
    '#   不含 uvloop (uvicorn[standard] 的 sys_platform marker 在 Windows 解析时排除)。',
    '#',
    "# 生成方式: Windows x64 / CPython $PYVER 上 pwsh frontend/scripts/build-python-venv.ps1 -GenerateLock",
    '#   (CI: Actions → Build Windows app → generate_lock=true, 下载 artifact 提交进仓)。',
    '# 更新方法: 改 requirements.txt / pyproject 后重跑 -GenerateLock 并 review diff 提交。',
    '#   🔴 只改声明源不重新生成本文件 = 改动不进 Windows 包 (provision 只认本文件)。',
    '#',
    "# generated_at: $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')) (win-x64, CPython $PYVER, PBS $PBS_TAG)",
    ''
  )
  Set-Content -Path $LockFile -Value ($lockHeader + $pins) -Encoding UTF8
  Write-Host "  win lock 已覆写 ($($pins.Count) pins) — review diff 后提交进仓"
  # 项目本体已随 .[cli,api,memory] 装入 (freeze 已排除), 无需再装
} else {
  # ── 默认模式: 锁定安装 (再现性闸: lock 是占位/无 pin 时 fail loud) ──────────────
  if (-not (Test-Path $LockFile)) {
    throw "[build-python-venv.ps1] 缺 $LockFile — 先在 Windows 上跑 -GenerateLock 生成并提交 (见脚本头)"
  }
  $pinCount = @(Get-Content $LockFile | Where-Object { $_ -match '==' -and $_ -notmatch '^\s*#' }).Count
  if ($pinCount -eq 0) {
    throw ('[build-python-venv.ps1] requirements.lock.win.txt 仍是占位 (0 个 pin) — ' +
      '先跑 `build-python-venv.ps1 -GenerateLock` 生成真实 lock 并提交进仓, 不做静默全新解析 (再现性纪律)')
  }
  Write-Host "[build-python-venv.ps1] pip install requirements.lock.win.txt ($pinCount pins) + . (--no-deps) ..."
  Invoke-Checked $Py @('-m', 'pip', 'install', '-q', '-r', $LockFile) 'pip install win lock'
  # --no-deps: 依赖全由 lock 提供, 项目本体安装不再触发解析 (镜像 .sh §3)
  Push-Location $RepoRoot
  try {
    Invoke-Checked $Py @('-m', 'pip', 'install', '-q', '--no-deps', '.') 'pip install 项目本体 (--no-deps)'
  } finally {
    Pop-Location
  }
}
# 清理 setuptools 在仓库根留下的 bdist 产物 (镜像 .sh)
Remove-Item -Recurse -Force (Join-Path $RepoRoot 'build') -ErrorAction SilentlyContinue

$SP = Join-Path $Out 'Lib\site-packages'
if (-not (Test-Path $SP)) { throw "[build-python-venv.ps1] 未找到 site-packages: $SP" }

# 3.5 pywin32 DLL 落位 (机制见脚本头「pywin32 落位」节)
$PwSys = Join-Path $SP 'pywin32_system32'
if (Test-Path $PwSys) {
  $dlls = @(Get-ChildItem -Path $PwSys -Filter '*.dll')
  foreach ($dll in $dlls) {
    Copy-Item -Force $dll.FullName (Join-Path $Out $dll.Name)
  }
  Write-Host "[build-python-venv.ps1] pywin32 落位: $($dlls.Count) 个 dll → python.exe 同目录"
} else {
  # lock 里没有 pywin32 时 (不该发生 — GenerateLock 恒装) 提醒而不中止:
  # COM backend 在运行时会因 import pythoncom 失败而 probe fail, 有明确报错面。
  Write-Warning '[build-python-venv.ps1] site-packages 无 pywin32_system32 — outlook_com backend 将不可用'
}

# 3.6 CLI wrapper (本地调试 + 自检用; 打包态前端不经它, 见脚本头)。
#     单引号 here-string: 内容零插值, 逐字写入 —— 其中 prog_name='mailagent' 是
#     backend_lifecycle.STALE_CMD_MARKER (残留进程清扫的归属判据), 一致性由
#     frontend/tests/main/backend_lifecycle.test.ts 的 marker 测试锁死 (读本文件断言)。
$ScriptsDir = Join-Path $Out 'Scripts'
New-Item -ItemType Directory -Force -Path $ScriptsDir | Out-Null
$wrapperBody = @'
@echo off
rem 自定位 launcher (打包可重定位) — 由 build-python-venv.ps1 生成, 勿手改。
rem -B: 禁写 .pyc (镜像 mac wrapper; win 无 sealed bundle 问题但保持产物只读纪律)。
rem -P (Python 3.11+): 禁止把 cwd 加入 sys.path — 防 cwd 下 src/ 遮蔽 site-packages
rem   后端包 (mac 侧实测过 serve 子命令消失, 同款防御)。
rem 打包态前端不经此文件: cli_runner.getMailagentCommand() 直接 spawn python.exe
rem   -B -P -c <PY_CLI_BOOTSTRAP> (免 cmd shell 一跳)。本 wrapper 供本地调试/构建自检。
rem UTF-8 stdio: 控制台 code page (cp936/cp1252) 下 CLI 打中文会 UnicodeEncodeError;
rem   setlocal 使其只作用于本次调用, 不污染调用者的 shell。运行时侧同源见
rem   src/electron/main/python_stdio_env.ts。
setlocal
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
"%~dp0..\python.exe" -B -P -c "from src.cli.main import app; app(prog_name='mailagent')" %*
'@
Set-Content -Path (Join-Path $ScriptsDir 'mailagent.cmd') -Value $wrapperBody -Encoding ASCII

# 4. 瘦身 (镜像 .sh §4: 测试/缓存/tkinter/pip; win 无 strip 步 — PE 无对应工具链, 跳过)
Write-Host '[build-python-venv.ps1] 瘦身 (__pycache__ / *.pyc / tkinter / pip / tests) ...'
Get-ChildItem -Path $Out -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $Out -Recurse -File -Filter '*.pyc' -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue
# stdlib 子树 (win 布局是 Lib\ 而非 lib/python3.11) + tcl 运行时 + tkinter 原生扩展
foreach ($rel in @('Lib\test', 'Lib\idlelib', 'Lib\tkinter', 'Lib\turtledemo', 'tcl')) {
  Remove-Item -Recurse -Force (Join-Path $Out $rel) -ErrorAction SilentlyContinue
}
Get-ChildItem -Path (Join-Path $Out 'DLLs') -File -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^(_tkinter\.pyd|tcl\d+t?\.dll|tk\d+t?\.dll)$' } |
  Remove-Item -Force -ErrorAction SilentlyContinue
# pip 运行时永不需要 (app 不在运行时装包); setuptools/pkg_resources/pygments 保留 (同 .sh §4)
Remove-Item -Recurse -Force (Join-Path $SP 'pip') -ErrorAction SilentlyContinue
Get-ChildItem -Path $SP -Directory -Filter 'pip-*.dist-info' -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
# (c-1) site-packages 内目录名精确等于 tests/test 的子目录 (mindepth 2 语义: 只扫包内,
#       不碰 $SP 顶层); 绝不匹配 testing (numpy.testing 等是公开 API, 同 .sh §4.4)
foreach ($pkgDir in Get-ChildItem -Path $SP -Directory) {
  Get-ChildItem -Path $pkgDir.FullName -Recurse -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -in @('tests', 'test') } |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# 4.6 体积审计快照 (镜像 .sh §4.6; win 独立文件, 不覆写 mac 的 venv-manifest.txt)
$Manifest = Join-Path $FrontendDir 'scripts\venv-manifest.win.txt'
Write-Host "[build-python-venv.ps1] 生成 $Manifest ..."
$totalMb = [math]::Round((Get-ChildItem -Path $Out -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
$top20 = Get-ChildItem -Path $SP -Directory | ForEach-Object {
  $kb = [math]::Round((Get-ChildItem -Path $_.FullName -Recurse -File -ErrorAction SilentlyContinue |
    Measure-Object Length -Sum).Sum / 1KB)
  [pscustomobject]@{ KB = $kb; Name = $_.Name }
} | Sort-Object KB -Descending | Select-Object -First 20
$manifestLines = @(
  '# venv-manifest.win.txt — Windows 嵌入式 CPython 运行时体积审计快照 (每次 provision 覆写, 由 build-python-venv.ps1 生成)'
  "generated_at: $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'))"
  "arch: $Arch"
  "pbs_tag: $PBS_TAG"
  "pyver: $PYVER"
  "total_size: ${totalMb}M"
  ''
  '## site-packages 包体积 top20 (KB, 降序)'
) + ($top20 | ForEach-Object { '  {0,8}K  {1}' -f $_.KB, $_.Name })
Set-Content -Path $Manifest -Value $manifestLines -Encoding UTF8

# 5. 自检: 可重定位调用链 + pywin32 落位。
#    src.config 有模块级 Config() 单例, import 即需必填字段; 构建环境无 .env, 注入
#    dummy env (仅自检子进程用, 不写入产物)。
Write-Host '[build-python-venv.ps1] 自检 (python.exe -c bootstrap 跑 mailagent --help) ...'
$env:NOTION_TOKEN = '_smoke'
$env:EMAIL_DATABASE_ID = '_smoke'
$env:USER_EMAIL = 'smoke@example.com'
try {
  # 5a. 打包态实际调用形态 (python.exe -B -P -c bootstrap) — 与 cli_runner 的
  #     getMailagentCommand 逐字对齐
  & $Py -B -P -c "from src.cli.main import app; app(prog_name='mailagent')" --help | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '[build-python-venv.ps1] 自检失败: python.exe -c bootstrap 调用链不通' }
  # 5b. 调试 wrapper 形态 (Scripts\mailagent.cmd)
  & cmd /c "`"$(Join-Path $ScriptsDir 'mailagent.cmd')`" --help" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '[build-python-venv.ps1] 自检失败: Scripts\mailagent.cmd wrapper 不通' }
  # 5c. pywin32 COM 落位 (装了才验; 缺失场景 3.5 已 warning)
  if (Test-Path (Join-Path $SP 'pywin32_system32')) {
    # 参数内不用双引号 (只用 python 单引号字符串): Windows PowerShell 5.1 对原生命令
    # 参数里的内嵌 " 不做转义会被剥掉; 5a 的 bootstrap 串同理已是外双内单形态。
    & $Py -B -P -c "import pythoncom, win32com.client, win32api; print('pywin32 OK')"
    if ($LASTEXITCODE -ne 0) { throw '[build-python-venv.ps1] 自检失败: pywin32 dll 落位后 import pythoncom 仍不通' }
  }
} finally {
  Remove-Item Env:NOTION_TOKEN, Env:EMAIL_DATABASE_ID, Env:USER_EMAIL -ErrorAction SilentlyContinue
}
Write-Host "  bootstrap + wrapper + CLI import 链 OK"

Write-Host "[build-python-venv.ps1] 完成: $Out (${totalMb}M)"

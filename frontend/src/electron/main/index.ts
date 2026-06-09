import { app, shell, BrowserWindow, ipcMain, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { bootNativeTheme, registerAppearanceIpc } from './appearance'
import { registerCliLifecycle } from './cli_runner'
import {
  registerBackendLifecycle,
  registerBackendQuitHook,
  resolveApiPort
} from './backend_lifecycle'
import { detectUserState } from './onboarding/detect'
import { registerOnboardingHandlers } from './handlers/onboarding'
import { MAIN_WINDOW, ONBOARDING_WINDOW } from './lib/window-config'
import { registerEmailHandlers } from './handlers/email'
import { registerFolderHandlers } from './handlers/folder'
import { registerReportHandlers } from './handlers/report'
import { registerAttachmentHandlers } from './handlers/attachment'
import { registerTranslateHandlers, abortAllTranslations } from './handlers/translate'
import { registerChatLocalBridge } from './chat_local_bridge'
import { getChatDb } from './chat_db'
import { registerWriteOpsHandlers } from './handlers/write_ops'
import { startEventsBridge } from './events_bridge'
import { registerDraftHandlers } from './handlers/draft'
// Sprint 6 §2.2 — admin / llm dashboard / calendar / settings IPC handlers.
import { registerAdminHandlers } from './handlers/admin'
import { registerLlmStatsHandlers } from './handlers/llm_stats'
import { registerCalendarHandlers } from './handlers/calendar'
import { registerSettingsHandlers } from './handlers/settings'
import { registerNotionAgentHandlers } from './handlers/notion_agent'
import { registerPromptHandlers } from './handlers/prompts'
// Sprint 8 §2.2 — electron-updater bridge (auto-updater state + IPC).
import { registerUpdaterHandlers } from './handlers/updater'
// Sprint 9 §2.2 — ping-island bridge (unix socket sender + appearance / AI
// draft envelopes + connection probe). The probe loop is auto-skipped in
// dev mode so a developer without ping-island.app doesn't see spurious
// probe-failure noise in the log.
import { registerIslandHandlers } from './handlers/island'
// Sprint 18 §PR B — repo-root .env read/write (env:get/:set) + pm2 restart
// bridge (services:restart/:status). Settings tabs use env:set on blur to
// persist managed keys to the Python-side .env, then surface RestartBanner
// (PR E) that calls services:restart('mail-sync').
import { registerEnvHandlers } from './handlers/env'
import { registerServicesHandlers } from './handlers/services'
// Sprint 19 — Load 项目根 .env into process.env BEFORE any module (chat/config,
// llm flags 等) reads it. electron-vite 不 auto-load 项目根 .env, env-handler
// 是给 Settings UI read/write 的另一条路径, 跟启动 env 注入是两件事. 详见
// lib/dotenv-bootstrap.ts header. 已 export 的 process.env 优先, 不被覆盖.
import { bootstrapDotenv } from './lib/dotenv-bootstrap'
// 打包首次运行 seed 出厂 prompt 模板 → userData/prompts (后端 LLM 默认读它)。见 lib/seed-prompts。
import { seedPromptTemplatesIfNeeded } from './lib/seed-prompts'
// Sprint 19 island F6 — mailagent:// deeplink (灵动岛 open_mail/open_notion →
// 打开前端对应邮件/视图). 解析 + cold-start buffer 在 ./deeplink.
import { dispatchDeeplink, extractDeeplinkFromArgv, setDeeplinkSink } from './deeplink'

bootstrapDotenv()

// F6 — 注册 mailagent:// custom protocol scheme. dev 模式 (electron-vite 跑
// electron 二进制) 需带 execPath + script path, 否则系统注册的是 Electron.app 而非
// 项目脚本. 生产模式 electron-builder.yml `protocols:` 已声明, 系统装 .app 时注册,
// 这里 setAsDefaultProtocolClient 是 runtime 兜底/dev 用.
if (is.dev && process.platform === 'win32' && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('mailagent', process.execPath, [process.argv[1]])
} else {
  app.setAsDefaultProtocolClient('mailagent')
}

// macOS 唤起 deeplink 走 open-url (不经 argv). 冷启动时 app 未 ready 也会触发 —
// dispatchDeeplink 内部 buffer 到 sink (whenReady 后注册) 再 flush.
app.on('open-url', (event, url) => {
  event.preventDefault()
  dispatchDeeplink(url)
})

// 邮件正文渲染在 <iframe srcdoc sandbox="allow-same-origin">。DOMPurify 已剥掉
// <a target>，所以正文里的链接点击是在 **iframe 子框架内原地导航** —— 既不触发
// setWindowOpenHandler (那只管 window.open / target=_blank)，又会被页面 CSP
// (default-src 'self') 挡成空白页 (用户报告: 点链接后正文变空白)。will-frame-
// navigate 覆盖所有框架(含 iframe): 子框架要导航到外部 scheme 时拦下, 改用系统
// 默认浏览器 / 邮件客户端打开。主框架(isMainFrame)导航不碰 —— dev HMR reload /
// 应用自身路由都走主框架, 误拦会破坏热重载。
function isExternalNavUrl(url: string): boolean {
  return /^(?:https?|mailto|tel|callto|sms):/i.test(url)
}

function attachExternalLinkGuard(contents: Electron.WebContents): void {
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && isExternalNavUrl(event.url)) {
      event.preventDefault()
      void shell.openExternal(event.url)
    }
  })
}

// Win/Linux deeplink 走二次启动 argv. single-instance lock 防多开 + 把 argv 里的
// url 转给已有实例. macOS 不依赖这条 (用 open-url), 但加上无害 + 防 macOS 多开.
// dev 模式跳过 (electron-vite restart 会触发多实例, lock 会误杀热重载).
if (!is.dev) {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    app.on('second-instance', (_event, argv) => {
      const url = extractDeeplinkFromArgv(argv)
      if (url) dispatchDeeplink(url)
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
      }
    })
  }
}

// macOS menu bar + Dock label needs to be set BEFORE app.whenReady() —
// otherwise the menu reads from the Electron binary's Info.plist
// (CFBundleName="Electron") instead of our product name. Production builds
// (electron-builder, productName=MailAgent) already get this right via the
// signed .app bundle's Info.plist; this fixes the dev experience.
app.setName('MailAgent')

function createWindow(opts: { onboarding?: boolean } = {}): void {
  // onboarding 模式: 用 ?onboarding=1 query 让 renderer main.tsx 渲染配置向导而非主 App
  // (复用 popout 的 ?popout=1 query 同款机制)。完成后 onboarding:complete 会 reload 去掉它。
  // V2.1 3c-3: 透传 serve-api 端口给 renderer —— ChatRuntime 的 loopback baseUrl
  // 端口须 = serve-api 实际端口 = chat_local_bridge webRequest filter 端口 (三者
  // 同源 resolveApiPort)；renderer 进程无 process.env，故经 `?apiPort=` 注入。
  const params = new URLSearchParams({ apiPort: String(resolveApiPort()) })
  if (opts.onboarding) params.set('onboarding', '1')
  const search = params.toString()
  // onboarding 向导用固定小窗 (768×640, 不可缩放, 居中); 主 App 用 1280×800。
  // 尺寸常量集中在 lib/window-config (reloadToMain 进主界面时也据此恢复, 防漂移)。
  // titleBarStyle 两者都保持 hiddenInset (OS 画红绿灯)。
  const dims = opts.onboarding ? ONBOARDING_WINDOW : MAIN_WINDOW
  const mainWindow = new BrowserWindow({
    width: dims.width,
    height: dims.height,
    minWidth: dims.minWidth,
    minHeight: dims.minHeight,
    resizable: !opts.onboarding,
    center: opts.onboarding ? true : undefined,
    show: false,
    title: 'MailAgent',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0E1013',
    webPreferences: {
      // electron-vite outputs the preload bundle as `.mjs` (ESM); Electron 28+
      // loads .mjs preloads natively. Sprint 1 hardcoded `.js` and the file
      // never existed → preload silently failed to load → window.electron
      // was undefined → every IPC call from Sprint 2 onward threw
      // "ipcRenderer.invoke missing — preload not loaded".
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (is.dev) {
      // Open devtools so renderer-side errors are visible without Cmd+Opt+I.
      // Detached panel keeps the inbox layout undisturbed.
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  })

  // Forward renderer console errors to the main process stdout so they
  // show up in `pnpm dev`'s log even without devtools open. Sprint 7 will
  // route these into a proper renderer-log panel; for Sprint 2 stdout is
  // good enough to catch React render exceptions.
  mainWindow.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event
    if (level === 'error' || level === 'warning') {
      console.error(`[renderer:${level}] ${message}\n  at ${sourceId}:${lineNumber}`)
    }
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer GONE] reason=${details.reason} exitCode=${details.exitCode}`)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  // 正文 iframe 内链接点击 → 默认浏览器 (见 attachExternalLinkGuard 注释)。
  attachExternalLinkGuard(mainWindow.webContents)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(
      search
        ? `${process.env['ELECTRON_RENDERER_URL']}?${search}`
        : process.env['ELECTRON_RENDERER_URL']
    )
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), search ? { search } : undefined)
  }
}

// Sprint 14 PR E — chat popout chrome. Spawned by the renderer via
// `window:openChatPopout` IPC; carries the email id through the URL
// search string so renderer/main.tsx can boot the popout shell before
// React.render. Sized smaller than the main window since the popout
// only hosts a single AI chat panel (no inbox / detail / settings).
function createPopoutWindow(emailId: number): void {
  const popout = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 360,
    minHeight: 520,
    show: false,
    title: 'MailAgent — AI Chat',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0E1013',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })

  popout.on('ready-to-show', () => {
    popout.show()
  })

  popout.webContents.on('console-message', (event) => {
    const { level, message, sourceId, lineNumber } = event
    if (level === 'error' || level === 'warning') {
      console.error(`[popout:${level}] ${message}\n  at ${sourceId}:${lineNumber}`)
    }
  })

  popout.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  attachExternalLinkGuard(popout.webContents)

  // V2.1 3c-3: popout 窗口同样需 apiPort (它也跑 ChatRuntime → loopback serve-api)。
  const search = `popout=1&email=${emailId}&apiPort=${resolveApiPort()}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    popout.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${search}`)
  } else {
    // Electron's loadFile accepts a `search` option that materialises
    // as `?popout=1&email=N` in window.location.search inside the
    // renderer — same shape the dev loadURL path produces, so the
    // bootPopoutModeFromQuery parser handles both transparently.
    popout.loadFile(join(__dirname, '../renderer/index.html'), { search })
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('ink.chenge.mailagent')

  // Sprint 11 user-feedback — dev-mode dock icon. Packaged builds inherit
  // the icon from electron-builder's `directories.buildResources: build`
  // (auto-applies `build/icon.icns` to the .app bundle); dev mode still
  // shows the generic Electron icon unless we set it explicitly here.
  // PNG path is more reliable than .icns for app.dock.setIcon on macOS in
  // dev mode (some macOS versions silently ignore .icns runtime overrides).
  if (process.platform === 'darwin' && app.dock && is.dev) {
    const iconPath = join(__dirname, '../../build/icons/1024.png')
    try {
      app.dock.setIcon(iconPath)
      console.log('[dock] dev icon set:', iconPath)
    } catch (err) {
      console.warn('[dock] dev icon load failed:', iconPath, err)
    }
  }

  // Sprint 11 user-feedback — macOS app menu name. Electron's binary
  // Info.plist hardcodes CFBundleName="Electron" so the leftmost macOS
  // app menu reads "Electron" in dev. Rebuild the app menu with the
  // product name explicitly to fix it. `app.setName` (done at module
  // load) drives `{appName}` substitution in the role labels — but the
  // menu first item label needs to be set explicitly because macOS hides
  // the literal label of the first menu and renders the app's CFBundleName.
  if (process.platform === 'darwin') {
    const appMenu = Menu.buildFromTemplate([
      {
        label: 'MailAgent',
        submenu: [
          { role: 'about', label: 'About MailAgent' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide', label: 'Hide MailAgent' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit', label: 'Quit MailAgent' }
        ]
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ])
    Menu.setApplicationMenu(appMenu)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // REVIEW-LOG C-07: set nativeTheme BEFORE BrowserWindow creation to avoid
  // first-paint flash; register appearance IPC sinks for renderer broadcasts.
  bootNativeTheme()
  registerAppearanceIpc()
  // REVIEW-LOG C-02: install before-quit hook so in-flight CLI subprocesses
  // get SIGTERM'd instead of orphaned when the user Cmd+Qs mid-call.
  registerCliLifecycle()
  // Sprint 1.2: IPC handlers (read-only — SQLite direct, ~4ms).
  // Write handlers (resync / update-flag) land in Sprint 5 atop cli_runner.
  registerEmailHandlers()
  // 邮件正文 iframe 内链接 → 系统默认浏览器。EmailBodyFrame 在 iframe 内拦截
  // <a> 点击 (导航前 preventDefault) 后调本 IPC —— 这是主路径, 因为 iframe 的
  // 页面 CSP (frame-src 'self') 会在渲染层把外部导航抢先拦成空白页, 主进程的
  // will-frame-navigate 兜底可能根本不触发。scheme 白名单防 file:// / javascript:。
  ipcMain.handle('shell:openExternal', (_evt, url: unknown) => {
    if (typeof url === 'string' && isExternalNavUrl(url)) {
      void shell.openExternal(url)
    }
  })
  // 多文件夹同步管理 IPC: folder discover / whitelist / 文件夹 CRUD / cleanup (davmail-only).
  registerFolderHandlers()
  // Sprint 20 — 报告 Agent (/agents 页): list/get 直读 sync_store.db,
  // runNow/getConfig/setConfig 经 `mailagent report` CLI fork.
  registerReportHandlers()
  registerAttachmentHandlers()
  registerTranslateHandlers()
  // V2.1 阶段 3c-4 cutover — chat 引擎全部下沉 renderer（ElectronApi.chat = ChatRuntime 经
  // loopback serve-api，3c-3）。main 不再持 chat IPC handler / dispatcher / 本地 backend
  // （custom-api + notion-agent 由 serve-api 接管）。仅保留 ai_chat.db schema bootstrap：
  // chat_db.ts 是 schema owner（CHAT_DB_VERSION），serve-api ChatDb 绝不建表 → 这里显式
  // getChatDb() 触发首次打开 + migrate，保证 renderer / serve-api 首次 HTTP 写前表已就位。
  try {
    getChatDb()
  } catch (err) {
    console.error('[chat] ai_chat.db bootstrap failed — chat 持久化可能不可用', err)
  }
  // V2.1 阶段 3c (3c-1) — 本地 renderer 直连 loopback serve-api 的透明 token + CORS
  // 注入桥。提前铺设 webRequest 拦截器；electron chat 切 ChatRuntime（3c-3）后 renderer
  // 才真正打 8200。dev 仅注 token（CORS 走 serve-api _DEV_CORS）。
  registerChatLocalBridge()
  // Sprint 5 §2.2 — Mail.app write commands (createDraft via AppleScript,
  // resync / llm:run / notion:updateFlag via `mailagent` CLI fork).
  registerDraftHandlers()
  registerWriteOpsHandlers()
  // Sprint 16 — 主进程持久连接 mail-sync 本地 SSE endpoint, 通过 IPC broadcast
  // 把事件转发给 renderer; 替换 EmailList / Sidebar 5s 硬轮询. 失败自动指数退避
  // 重连, renderer 通过 events:status 看连接状态决定是否启用 fallback polling.
  startEventsBridge()
  // Sprint 6 §2.2 — admin dashboard / LLM dashboard / calendar list /
  // settings page. Each handler group is read-only by default (admin:health,
  // admin:stats, llm:stats, calendar:recurringDiscover) with separate
  // write+auth channels for retry / replay / cleanup.
  registerAdminHandlers()
  registerLlmStatsHandlers()
  registerCalendarHandlers()
  registerSettingsHandlers()
  // Notion Agent CLI config bridge — Settings page reads/edits the bound
  // Custom Agent + default model in ~/.notionagents/notion_account.json.
  registerNotionAgentHandlers()
  registerPromptHandlers()
  // Sprint 8 §2.2 — electron-updater bridge.
  //
  // We pass the real `autoUpdater` lazily (require-after-app-ready) so test
  // harnesses can opt-out by stubbing the module — see
  // `tests/main/updater.test.ts`. The handler registration itself is
  // unconditional; in dev mode the handler will record `state: 'dev-disabled'`
  // and skip the auto-tick (electron-updater can't read app-update.yml until
  // packaged), but the IPC channels still respond so the SettingsPage UI
  // shows the dev sentinel instead of throwing on `updater:status`.
  let updaterStub: import('./handlers/updater').AutoUpdaterLike | undefined
  if (!is.dev) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
    updaterStub = autoUpdater as unknown as import('./handlers/updater').AutoUpdaterLike
  }
  registerUpdaterHandlers({ updater: updaterStub })
  // Sprint 9 §2.2 — register the IPC channels before createWindow so the
  // renderer's first `island:status` invoke (on TitleBar mount) hits a
  // handler that exists. Probe loop runs in production only.
  registerIslandHandlers()
  // Sprint 18 §PR B — env:* read/write + services:* pm2 control. Must be
  // wired before createWindow so SettingsPage's first env:get on mount has
  // a handler to hit. Both registrations are side-effect-only (no state).
  registerEnvHandlers()
  registerServicesHandlers()
  // 打包 P2/P3 — onboarding 向导 IPC (status / complete)。
  registerOnboardingHandlers()

  ipcMain.on('ping', () => console.log('pong'))

  // Sprint 14 PR E — popout opener. Fire-and-forget from the renderer
  // (the new BrowserWindow shows itself via ready-to-show); no return
  // value or envelope. Bad emailId is silently dropped — the renderer
  // already validates Number.isInteger before sending.
  ipcMain.on('window:openChatPopout', (_evt, emailId: number) => {
    if (!Number.isInteger(emailId) || emailId < 0) return
    createPopoutWindow(emailId)
  })

  // 打包 P1-4/P1-6 — 后端进程托管 + DB 就绪门控。仅打包模式 (app.isPackaged) 接管:
  //   spawn `mailagent serve` + `mailagent serve-api` (V2 远程访问 FastAPI, 默认开,
  //   MAILAGENT_REMOTE_ACCESS_ENABLED=false 可关; 注入三 env, cwd=DATA_ROOT) + 注册
  //   before-quit SIGTERM (覆盖两个进程), 然后等 **serve** 的 DB 就绪 (db_version==
  //   EXPECTED 且关键表齐全) 再开窗, 避免首帧 IPC 撞 "sync_store.db not found"。
  //   serve-api 是软门控 (内部 fire-and-forget 轮询 /api/health, 起不来只 warn 不阻塞
  //   开窗 —— 远程访问是增量能力, 本地 Electron 不依赖它)。dev / 服务器部署:
  //   registerBackendLifecycle 内部 start() 为 no-op (后端走 pm2), 不阻塞、行为零变更。
  // 降级: 后端起不来 (缺 .env / bad config → serve 崩 → waitReady 快速失败) 或大库迁移
  //   超 120s, 仍开窗 (renderer 各 IPC 自带 not-found 兜底, 用户见空态而非黑屏)。
  //   TODO P2/P3: 此处接 onboarding 门控 —— 新用户无配置时走配置向导而非降级空态。
  if (app.isPackaged) {
    // 打包首次运行: 把 bundle 出厂 prompt 模板 seed 到 <userData>/prompts —— 后端 LLM 默认
    // 读它, 首次该目录空会 fallback 空 prompt (分类质量退化)。须在 backend spawn 前; 仅 copy
    // 不存在的 (不覆盖用户在 Settings→AI 编辑过的); dev (src=dest) 自动跳过。non-fatal。
    seedPromptTemplatesIfNeeded()
    // 先检测用户状态决定分流:
    //   configured → 起后端 + 等 DB 就绪 + 开主窗;
    //   new / config-incomplete → 不起后端 (没 .env 起也会崩), 开 onboarding 向导窗,
    //     由 onboarding:complete 写完 .env 后再起后端 + reload 主界面。
    const state = detectUserState()
    if (state === 'configured') {
      const backendMgr = registerBackendLifecycle()
      const ready = await backendMgr.waitReady()
      if (!ready) {
        console.error(
          `[startup] 后端未在超时内就绪 (state=${backendMgr.getState()}); 降级开窗。` +
            '可能原因: bad config 或大库迁移超时。'
        )
      }
      createWindow()
    } else {
      registerBackendQuitHook() // 只挂退出钩子, 不 start
      console.log(`[startup] 用户状态=${state}, 进入 onboarding 配置向导。`)
      createWindow({ onboarding: true })
    }
  } else {
    // dev / 服务器部署: 后端走 pm2, 不接管; 行为零变更。
    createWindow()
  }

  // F6 — deeplink sink: 聚焦主窗口 + 把 target 转给 renderer (useDeeplinkRouter
  // 监听 'mailagent:deeplink' → router.navigate + setActive). createWindow 后注册,
  // 有 cold-start buffer 立即 flush. 主窗口取第一个非 popout window (popout 也是
  // BrowserWindow 但 title 不同 — 简化取 getAllWindows()[0], createWindow 先建主窗).
  setDeeplinkSink((target) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    win.webContents.send('mailagent:deeplink', target)
  })
  // Win/Linux 冷启动 argv 里的 deeplink (macOS 走 open-url, 已在 module 级注册).
  const coldUrl = extractDeeplinkFromArgv(process.argv)
  if (coldUrl) dispatchDeeplink(coldUrl)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Sprint 3 §2.2 + Sprint 4 §2.1 — abort any in-flight LLM async work on
// quit (translation requests + chat streams) so the CLI subprocess
// teardown (`registerCliLifecycle`) isn't the only path cleaning up.
app.on('before-quit', () => {
  abortAllTranslations()
  // V2.1 阶段 3c-4 cutover：chat dispatcher 的 _inflight 现在在 renderer 进程（ChatRuntime），
  // 随窗口生命周期销毁，main 不再持 → 无 abortAllChatSessions()。notion-agent 子进程串行闸
  // （drainNotionAgentGate）随 main execa backend 一并删除（serve-api asyncio spawn 接管）。
})

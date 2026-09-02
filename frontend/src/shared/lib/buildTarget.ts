// build target 判据的零依赖叶子（task 09-01-sidebar-fluid-optimization）。
//
// 读取链复刻 vite 自身的 env 来源：build 时 vite 从 process.env 的 VITE_* 注入
// import.meta.env，故生产取 import.meta.env（已注入），回退 process.env（vitest 下
// import.meta.env 不可达，单测经 vi.stubEnv('VITE_BUILD_TARGET','web') 走此腿）。
//
// 同一判据此前散在 CommandPalette / SearchTabPage / calendar/lib/capabilities 三处私有
// 拷贝（本批不动，后续收敛到这里）。🔴 别在这里 import 任何 store / hooks —— 它要能被
// 叶子 store（state/nav-shell）与 registry 同级的模块引用。

export function resolveBuildTarget(): string | undefined {
  const metaTarget = (import.meta as unknown as { env?: { VITE_BUILD_TARGET?: string } }).env
    ?.VITE_BUILD_TARGET
  if (metaTarget) return metaTarget
  if (typeof process !== 'undefined') return process.env?.VITE_BUILD_TARGET
  return undefined
}

/** 远程 web build（`mail.chenge.ink/app`）。Electron 主窗与 popout 恒 false。 */
export function isWebBuild(): boolean {
  return resolveBuildTarget() === 'web'
}

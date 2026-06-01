// 窗口尺寸单一来源 —— index.ts createWindow (新建窗口) 与 handlers/onboarding.ts
// reloadToMain (onboarding 小窗 → 主界面 in-place 恢复) 共享, 防止两处常量漂移。
//
// 漂移曾导致的 bug: 完成 onboarding / 跳过补全进主界面时, reloadToMain 只在原
// 768×640 resizable:false 小窗里 reload 主 App → 主界面被塞进小窗且无法调整大小
// (关闭重开应用才正常)。修复后 reloadToMain 用 MAIN_WINDOW 把窗口恢复成主窗尺寸 + 可缩放。

export const MAIN_WINDOW = {
  width: 1280,
  height: 800,
  minWidth: 940,
  minHeight: 600
} as const

export const ONBOARDING_WINDOW = {
  width: 768,
  height: 640,
  minWidth: 768,
  minHeight: 640
} as const

// chat-panel P4 Phase 00 spike — assistant-ui parity harness 入口（独立 vite，非默认 bundle）。
//
// 复用 renderer 的真实 index.css（同一套 ink-* / c-accent token + 主题三态 + accent override），
// 据 URL ?theme= / ?accent= 在 documentElement 上设 data-theme / data-accent —— 与生产
// appearance.ts 的 applyResolvedTheme / applyAccent 写的是同两个属性，故 token 解析完全一致。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { AssistantUiThreadPoc } from '../../src/electron/renderer/poc/AssistantUiThreadPoc'

// renderer 真实 token + tailwind base/utilities。
import '../../src/electron/renderer/index.css'

const params = new URLSearchParams(window.location.search)
const theme = params.get('theme') === 'light' ? 'light' : 'dark'
const accent = params.get('accent') // coral(默认,无属性) / cobalt / teal / rose / slate / olive

document.documentElement.setAttribute('data-theme', theme)
if (accent && accent !== 'coral') {
  document.documentElement.setAttribute('data-accent', accent)
} else {
  document.documentElement.removeAttribute('data-accent')
}

// 页面背景用 ink-0（app 最底层表面），让面板像「贴」在真实 app 背景上，便于判断 parity。
document.body.style.margin = '0'
document.body.style.minHeight = '100vh'
document.body.style.background = 'rgb(var(--ink-0))'
document.body.style.display = 'flex'
document.body.style.alignItems = 'center'
document.body.style.justifyContent = 'center'
document.body.style.padding = '24px'
document.body.style.fontFamily =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* 380×620 近似产品里 360px 右侧 AI 面板的尺寸 */}
    <div
      style={{
        width: 380,
        height: 620,
        overflow: 'hidden',
        borderRadius: 16,
        border: '1px solid var(--hairline)',
        boxShadow: '0 24px 60px rgb(0 0 0 / 0.35)'
      }}
    >
      <AssistantUiThreadPoc />
    </div>
  </StrictMode>
)

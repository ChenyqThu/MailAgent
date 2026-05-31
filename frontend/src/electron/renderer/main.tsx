import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Sprint 14 PR E — popout chrome must resolve BEFORE the App component
// mounts so the first paint already targets the correct shell (avoids a
// flash of inbox chrome before the popout takes over). The boot function
// reads `?popout=1&email=N` from window.location.search and sets the
// store synchronously; App.tsx subscribes via useSyncExternalStore in
// the next tick.
import { bootPopoutModeFromQuery } from '@shared/state/popout-mode'

import App from './App'
import { OnboardingErrorBoundary } from './onboarding/ErrorBoundary'
import OnboardingRoot from './onboarding/OnboardingRoot'

bootPopoutModeFromQuery()

// 打包 onboarding: 主进程对 new/config-incomplete 用户以 ?onboarding=1 开窗 → 渲染配置
// 向导而非主 App。向导完成后主进程 reload 窗口去掉该 query → 落回 App。隔离, 不碰主路径。
const isOnboarding = new URLSearchParams(window.location.search).has('onboarding')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isOnboarding ? (
      // ErrorBoundary so a render-phase throw (e.g. an unexpected exception that
      // escapes the .catch degradation paths) surfaces a reload affordance
      // instead of white-screening the onboarding window with zero escape hatch.
      <OnboardingErrorBoundary>
        <OnboardingRoot />
      </OnboardingErrorBoundary>
    ) : (
      <App />
    )}
  </StrictMode>
)

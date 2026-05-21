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

bootPopoutModeFromQuery()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

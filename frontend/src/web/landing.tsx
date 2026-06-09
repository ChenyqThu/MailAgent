import '../electron/renderer/index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import LandingPage from './LandingPage'

const rootElement = document.getElementById('root')

if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <LandingPage />
    </StrictMode>
  )
}

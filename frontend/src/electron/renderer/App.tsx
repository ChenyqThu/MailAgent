// Sprint 0 scaffold root. Mounts the i18n side-effect import, kicks off the
// appearance store boot (DOM is already coloured by the inline bootstrap in
// index.html — this just syncs the zustand store + registers the
// matchMedia listener for system mode), then hands off to TanStack Router.

import { useEffect } from 'react'
import '@shared/i18n'
import { bootAppearance } from '@shared/state/appearance'
import { AppRouter } from '@shared/router'

export default function App(): JSX.Element {
  useEffect(() => {
    bootAppearance()
  }, [])

  return <AppRouter />
}

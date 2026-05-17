import { RouterProvider } from '@tanstack/react-router'
import { router } from './router-instance'

export function AppRouter(): JSX.Element {
  return <RouterProvider router={router} />
}

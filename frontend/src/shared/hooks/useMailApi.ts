import { makeMailApi } from '../api/factory'
import type { MailApi } from '../api/types'

// Singleton accessor. Cheap to call from any component / hook.
export function useMailApi(): MailApi {
  return makeMailApi()
}

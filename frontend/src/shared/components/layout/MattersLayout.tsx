import { PageFrame } from './PageFrame'
import { MattersWorkspace } from '../matters/MattersWorkspace'

export function MattersLayout(): React.ReactElement {
  return (
    <PageFrame ariaLabel="matters" mainClassName="flex-1 min-w-0 overflow-hidden">
      <MattersWorkspace />
    </PageFrame>
  )
}

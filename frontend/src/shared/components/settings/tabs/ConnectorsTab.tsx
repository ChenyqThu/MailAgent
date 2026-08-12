import * as React from 'react'

import { ConnectorsConsolePage } from '@shared/components/connectors/ConnectorsConsolePage'

export function ConnectorsTab(): React.ReactElement {
  return (
    <div className="h-full min-h-0 overflow-hidden">
      <ConnectorsConsolePage />
    </div>
  )
}

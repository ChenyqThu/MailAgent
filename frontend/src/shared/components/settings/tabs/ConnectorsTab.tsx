import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { ConnectorsConsolePage } from '@shared/components/connectors/ConnectorsConsolePage'

import { McpServiceTab } from './McpServiceTab'

export interface ConnectorsTabProps {
  initialSection?: 'connectors' | 'mcp'
}

export function ConnectorsTab({ initialSection = 'connectors' }: ConnectorsTabProps): React.ReactElement {
  const { t } = useTranslation()
  const [section, setSection] = React.useState<'connectors' | 'mcp'>(initialSection)

  const [prevInitialSection, setPrevInitialSection] = React.useState(initialSection)
  if (prevInitialSection !== initialSection) {
    setPrevInitialSection(initialSection)
    setSection(initialSection)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div
        role="tablist"
        aria-label={t('settings.tabs.connectors')}
        className="flex shrink-0 items-center gap-1.5 border-b border-ink-border-soft bg-ink-1/60 px-4 py-2"
      >
        <button
          type="button"
          role="tab"
          aria-selected={section === 'connectors'}
          onClick={() => setSection('connectors')}
          className={`rounded-md px-3 py-1 text-aux transition-colors ${
            section === 'connectors'
              ? 'bg-ink-3 font-medium text-ink-fg'
              : 'text-ink-fg-2 hover:bg-ink-2 hover:text-ink-fg'
          }`}
        >
          {t('settings.connectorsTab.connectors')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'mcp'}
          onClick={() => setSection('mcp')}
          className={`rounded-md px-3 py-1 text-aux transition-colors ${
            section === 'mcp'
              ? 'bg-ink-3 font-medium text-ink-fg'
              : 'text-ink-fg-2 hover:bg-ink-2 hover:text-ink-fg'
          }`}
        >
          {t('settings.connectorsTab.mcp')}
        </button>
      </div>

      {section === 'connectors' ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <ConnectorsConsolePage />
        </div>
      ) : (
        <div id="settings-connectors-mcp" className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto w-full max-w-full md:max-w-[760px] px-4 sm:px-6 md:px-10 pt-6 md:pt-8 pb-24">
            <McpServiceTab />
          </div>
        </div>
      )}
    </div>
  )
}

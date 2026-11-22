// Extracted from CustomAgentDrawer.tsx — inline validation error banner & drawer footer actions.

import type React from 'react'

import type { ReportAgentConfig } from '@shared/api/types'
import { StatefulButton } from '@shared/components/ui/stateful-button'
import { ReportIcon } from '../primitives'
import type { CustomAgentFormController } from './useCustomAgentForm'

export function CustomAgentErrorBanner({ err }: { err: string | null }): React.ReactElement | null {
  if (!err) return null
  return (
    <div
      style={{
        fontSize: 12.5,
        color: 'rgb(var(--c-fail))',
        padding: '10px 12px',
        borderRadius: 9,
        background: 'rgb(var(--c-fail) / 0.10)',
        border: '1px solid rgb(var(--c-fail) / 0.25)',
        wordBreak: 'break-word'
      }}
    >
      {err}
    </div>
  )
}

export function CustomAgentDrawerFooter({
  form,
  cfg,
  create,
  onClose
}: {
  form: CustomAgentFormController
  cfg: ReportAgentConfig | null
  create: boolean
  onClose: () => void
}): React.ReactElement {
  const {
    t,
    agentPluginsEnabled,
    confirming,
    setConfirming,
    busy,
    saveFailed,
    onDelete,
    onExport,
    onSave
  } = form

  return (
    <footer
      className="flex items-center"
      style={{
        gap: 10,
        padding: '13px 18px',
        borderTop: '1px solid rgb(var(--ink-border-soft))',
        flexShrink: 0
      }}
    >
      {/* 删除：仅编辑既有时；两步确认。 */}
      {!create &&
        cfg &&
        (confirming ? (
          <span className="flex items-center" style={{ gap: 6 }}>
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              style={{
                fontFamily: 'inherit',
                fontSize: 13,
                padding: '7px 12px',
                borderRadius: 8,
                cursor: busy ? 'wait' : 'pointer',
                color: 'rgb(var(--c-fail))',
                background: 'rgb(var(--c-fail) / 0.12)',
                border: '1px solid rgb(var(--c-fail) / 0.3)'
              }}
            >
              {t('agents.custom.deleteConfirm')}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="btn-ghost"
              style={{ fontFamily: 'inherit' }}
            >
              {t('agents.search.deleteCancel')}
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="flex items-center"
            style={{
              gap: 6,
              fontFamily: 'inherit',
              fontSize: 13,
              padding: '8px 14px',
              borderRadius: 8,
              cursor: 'pointer',
              color: 'rgb(var(--c-fail))',
              background: 'transparent',
              border: '1px solid rgb(var(--c-fail) / 0.3)'
            }}
          >
            <ReportIcon name="x" size={14} />
            {t('agents.search.delete')}
          </button>
        ))}
      {!create && cfg?.type === 'custom' && agentPluginsEnabled ? (
        <button
          type="button"
          onClick={onExport}
          className="btn-ghost"
          style={{ fontFamily: 'inherit' }}
        >
          {t('agents.custom.export')}
        </button>
      ) : null}
      <span style={{ flex: 1 }} />
      <button
        type="button"
        onClick={onClose}
        className="btn-ghost"
        style={{ fontFamily: 'inherit' }}
      >
        {t('agents.config.cancel')}
      </button>
      <StatefulButton
        type="button"
        onClick={onSave}
        disabled={busy}
        state={busy ? 'loading' : saveFailed ? 'error' : 'idle'}
      >
        {create ? t('agents.custom.create') : t('agents.config.save')}
      </StatefulButton>
    </footer>
  )
}

// UserMdCompileSection — M3c 偏好编译触发面

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import type { CompileUserMdResult } from '@shared/api/types'
import { Button } from '@shared/components/ui/button'

import { Section } from '../parts/Section'
import { fetchUserMdCompileEnabled } from './shared'

export function UserMdCompileSection(): React.ReactElement | null {
  const { t } = useTranslation()
  const api = useMailApi()

  // All hooks must run unconditionally before any early return.
  const [compiling, setCompiling] = React.useState(false)
  const [result, setResult] = React.useState<CompileUserMdResult | null>(null)
  const [rollingBack, setRollingBack] = React.useState(false)

  const { data: enabled } = useQuery<boolean>({
    queryKey: ['chat', 'config', 'userMdCompileEnabled'],
    queryFn: fetchUserMdCompileEnabled,
    staleTime: 30_000,
    retry: false
  })

  // flag-off（false / undefined）→ 字节级不渲染（DOM 无此区块）。
  if (!enabled) return null

  async function handleCompile(): Promise<void> {
    setCompiling(true)
    setResult(null)
    try {
      const r = await api.chat.compileUserMd()
      setResult(r)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toastError(t('settings.userMdCompile.compileError'), msg)
    } finally {
      setCompiling(false)
    }
  }

  async function handleRollback(): Promise<void> {
    if (!result) return
    setRollingBack(true)
    try {
      await api.chat.rollbackProfileDoc({ name: 'user', toHash: result.beforeHash })
      setResult(null)
      toastSuccess(t('settings.userMdCompile.rolledBackToast'))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toastError(t('settings.userMdCompile.rollbackError'), msg)
    } finally {
      setRollingBack(false)
    }
  }

  return (
    <Section title={t('settings.userMdCompile.title')} helper={t('settings.userMdCompile.desc')}>
      <div className="px-4 py-3.5 space-y-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handleCompile()}
          disabled={compiling || rollingBack}
        >
          {compiling ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {compiling ? t('settings.userMdCompile.compiling') : t('settings.userMdCompile.button')}
        </Button>

        {result && !result.changed ? (
          <p className="text-aux text-ink-fg-3">{t('settings.userMdCompile.noChange')}</p>
        ) : null}

        {result && result.changed ? (
          <div className="space-y-2">
            <p className="text-micro text-ink-fg-3">{t('settings.userMdCompile.diffLabel')}</p>
            <pre className="text-micro text-ink-fg-2 whitespace-pre-wrap break-all font-mono leading-snug bg-ink-bg-2 rounded p-2 max-h-32 overflow-auto">
              {result.before.trim()}
            </pre>
            <pre className="text-micro text-ink-fg-1 whitespace-pre-wrap break-all font-mono leading-snug bg-ink-bg-2 rounded p-2 max-h-32 overflow-auto">
              {result.after.trim()}
            </pre>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleRollback()}
              disabled={rollingBack}
            >
              {rollingBack ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {rollingBack
                ? t('settings.userMdCompile.rollingBack')
                : t('settings.userMdCompile.rollback')}
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  )
}

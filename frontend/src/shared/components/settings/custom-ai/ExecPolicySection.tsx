// S2 W1 — 自动化策略 (exec whitelist rules) subsection

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, X } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError, toastSuccess } from '@shared/state/toast'
import { Switch } from '@shared/components/ui/switch'
import { Button } from '@shared/components/ui/button'

import { Section } from '../parts/Section'
import { fetchExecPolicyEnabled } from './shared'

/** Human-readable one-line summary of a structured matcher (read-only display; the model can't
 *  create rules, and narrowing = delete + recreate — so no editable form here). */
function formatMatcher(capability: string, matcher: Record<string, unknown>): string {
  if (capability === 'exec') {
    const argv0 = typeof matcher.argv0_realpath === 'string' ? matcher.argv0_realpath : '?'
    const tmpl = Array.isArray(matcher.argv_template) ? matcher.argv_template : []
    const args = tmpl
      .map((it) => {
        const o = it as { pin?: unknown; any?: unknown }
        return o?.any === true ? '<任意>' : typeof o?.pin === 'string' ? o.pin : '?'
      })
      .join(' ')
    const cwd = typeof matcher.cwd_scope === 'string' ? `（目录 ${matcher.cwd_scope}）` : ''
    return `${argv0}${args ? ' ' + args : ''}${cwd}`
  }
  if (capability === 'file_read' || capability === 'file_write') {
    return typeof matcher.realpath_prefix === 'string' ? matcher.realpath_prefix : '?'
  }
  if (capability === 'web') {
    return typeof matcher.origin === 'string' ? matcher.origin : '?'
  }
  return JSON.stringify(matcher)
}

const CAPABILITY_LABELS: Record<string, string> = {
  exec: '运行命令',
  file_read: '读文件',
  file_write: '写文件',
  web: '联网'
}

/** The 自动化策略 management page: list / enable-disable / delete the exec whitelist rules the owner
 *  created via the approval card's "总是允许". Self-gates on execPolicyEnabled (default OFF → null). */
export function ExecPolicySection(): React.ReactElement | null {
  const api = useMailApi()
  const qc = useQueryClient()

  const { data: enabled } = useQuery<boolean>({
    queryKey: ['chat', 'config', 'execPolicyEnabled'],
    queryFn: fetchExecPolicyEnabled,
    staleTime: 30_000,
    retry: false
  })

  const { data: rules, isError } = useQuery<import('@shared/api/types').ExecPolicyRule[]>({
    queryKey: ['execPolicy', 'rules'],
    queryFn: () => api.chat.listPolicyRules(),
    enabled: enabled === true,
    staleTime: 10_000
  })

  // flag-off (false / undefined) → byte-level no-render (DOM has no section).
  if (!enabled) return null

  const refetch = (): void => {
    void qc.invalidateQueries({ queryKey: ['execPolicy', 'rules'] })
  }

  const onToggle = async (id: number, next: boolean): Promise<void> => {
    try {
      await api.chat.setPolicyRuleEnabled(id, next)
      refetch()
    } catch (err) {
      toastError('自动化策略', (err as Error).message)
    }
  }
  const onDelete = async (id: number): Promise<void> => {
    try {
      await api.chat.deletePolicyRule(id)
      toastSuccess('已删除该策略')
      refetch()
    } catch (err) {
      toastError('自动化策略', (err as Error).message)
    }
  }

  const content: React.ReactNode = (() => {
    if (isError) {
      return <div className="px-4 py-3.5 text-aux text-ink-fg-3">加载策略失败。</div>
    }
    if (!rules) {
      return (
        <div className="flex items-center gap-2 px-4 py-3.5 text-aux text-ink-fg-2">
          <Loader2 className="size-3.5 animate-spin shrink-0" />
          加载中…
        </div>
      )
    }
    if (rules.length === 0) {
      return (
        <div className="px-4 py-3.5 text-aux text-ink-fg-3">
          还没有自动化策略。在助手请求运行命令 /
          读写文件时，勾选「总是允许」即可为该精确操作创建一条白名单，命中后免审批直接执行。
        </div>
      )
    }
    return (
      <div className="divide-y divide-ink-border-soft">
        {rules.map((rule) => (
          <div key={rule.id} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="rounded bg-ink-3 px-1.5 py-0.5 text-aux text-ink-fg-2">
                  {CAPABILITY_LABELS[rule.capability] ?? rule.capability}
                </span>
                {rule.dangerous && (
                  <span className="inline-flex items-center gap-1 rounded bg-fail/15 px-1.5 py-0.5 text-aux font-medium text-fail">
                    <AlertTriangle size={12} strokeWidth={2.5} />
                    高危 · 非沙箱
                  </span>
                )}
              </div>
              <div className="mt-1 break-all font-mono text-meta text-ink-fg">
                {formatMatcher(rule.capability, rule.matcher)}
              </div>
              <div className="mt-0.5 text-aux text-ink-fg-3">
                {`命中 ${rule.useCount} 次`}
                {rule.lastUsedAt ? ` · 最近 ${rule.lastUsedAt}` : ''}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Switch
                checked={rule.enabled}
                onCheckedChange={(v: boolean) => void onToggle(rule.id, v)}
                aria-label="启用/停用该策略"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onDelete(rule.id)}
                aria-label="删除该策略"
              >
                <X size={13} strokeWidth={2.5} />
              </Button>
            </div>
          </div>
        ))}
      </div>
    )
  })()

  return (
    <Section
      title="自动化策略"
      helper="助手运行命令 / 读写文件默认每次都需你审批。这里是你经「总是允许」为精确操作建立的白名单：命中的操作免审批直接执行，其余仍每次询问。放宽某条规则请删除后重新创建（不支持原地编辑，避免悄悄变宽）。"
    >
      {content}
    </Section>
  )
}

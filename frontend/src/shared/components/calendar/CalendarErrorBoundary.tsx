// F7 — CalendarErrorBoundary (React class component, hooks 不支持
// componentDidCatch). 包 5 个 view (Day/Week/Month/Agenda/Recurring),
// 避免任一 view rrule 解析失败 / Date.parse NaN / IPC reject throw 上冒
// 卸载整个 PageFrame → 黑屏.
//
// 切 view 时 view 自然 unmount, Boundary 也 unmount, state 重置 (无需
// 手动 reset prop). 用户也可点 [重试] 按钮触发 setState reset 让 children
// 在同 view 内重 mount.

import { Component, type ErrorInfo, type ReactNode } from 'react'
import i18n from 'i18next'
import { AlertCircle, RefreshCw } from 'lucide-react'

// F22 — ErrorBoundary 是 class component, hooks (useTranslation) 不可用.
// 走 i18next module-level singleton ``i18n.t(...)`` 拿翻译, 第二参 fallback
// 保护 key 漏不破.

interface Props {
  /** Identifier — 用于 log 跟 fallback 标题区分哪个 view crash. */
  viewName: string
  children: ReactNode
}

interface State {
  hasError: boolean
  errorMessage: string | null
}

export class CalendarErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, errorMessage: null }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: (error && error.message) || String(error)
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(
      `[calendar-error-boundary] view=${this.props.viewName} crashed:`,
      error,
      info.componentStack
    )
  }

  handleReset = (): void => {
    this.setState({ hasError: false, errorMessage: null })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      const msg = this.state.errorMessage
      return (
        <div className="h-full flex flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="w-12 h-12 rounded-full bg-coral/15 flex items-center justify-center">
            <AlertCircle size={22} strokeWidth={2} className="text-coral" />
          </div>
          <div className="text-aux text-ink-fg font-medium">
            {i18n.t('calendar.errorBoundary.title', '{view} 加载失败', {
              view: this.props.viewName
            })}
          </div>
          {msg && (
            <div className="text-meta font-mono text-ink-fg-2 max-w-md break-words">
              {msg.slice(0, 200)}
              {msg.length > 200 ? '…' : ''}
            </div>
          )}
          <div className="text-meta text-ink-fg-3">
            {i18n.t(
              'calendar.errorBoundary.hint',
              '切换视图或点 [重试] 重新加载. 详情见 DevTools console.'
            )}
          </div>
          <button
            type="button"
            className="today-btn mt-2"
            onClick={this.handleReset}
          >
            <RefreshCw size={13} strokeWidth={2} />
            {i18n.t('calendar.errorBoundary.retry', '重试')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

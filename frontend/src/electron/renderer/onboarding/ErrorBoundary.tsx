// Onboarding ErrorBoundary — last-resort escape hatch for render-phase throws.
//
// The wizard's IPC wrappers degrade gracefully (ipc.ts getInvoke() returns a
// rejecting stub, every async call has a .catch), so the EXPECTED failure modes
// no longer white-screen. This boundary is defense-in-depth for the UNEXPECTED:
// any other render-phase exception inside onboarding would otherwise blank the
// whole window with zero escape. Instead we show a reload affordance so the user
// can recover the window rather than being stuck on a white screen.

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export class OnboardingErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console for packaged-build diagnosis; never re-throw.
    console.error('[onboarding] render error caught by boundary:', error, info.componentStack)
  }

  private readonly reload = (): void => {
    // Reload the onboarding window in place — preserves the ?onboarding=1 query
    // so the user lands back at the wizard, not a half-configured main app.
    window.location.reload()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="ob">
        <div className="ob-titlebar">
          <span className="ob-title">设置 · MailAgent</span>
        </div>
        <div
          className="ob-body flex flex-col items-center justify-center text-center"
          style={{ padding: '40px 28px', gap: 14 }}
        >
          <div className="eyebrow" style={{ color: 'rgb(var(--c-fail))' }}>
            异常
          </div>
          <h1 className="wiz-h1">设置向导遇到问题</h1>
          <p className="wiz-lede" style={{ textAlign: 'center', maxWidth: 420 }}>
            向导渲染时出错，已停在安全状态。你可以重新加载窗口重试 —— 已填写但未提交的内容会重置。
          </p>
          <pre
            className="font-mono text-[11px] text-ink-fg-2"
            style={{
              maxWidth: 440,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              opacity: 0.75
            }}
          >
            {error.message}
          </pre>
          <button
            className="btn-primary mt-2"
            style={{ padding: '10px 22px' }}
            onClick={this.reload}
          >
            重新加载窗口
          </button>
        </div>
      </div>
    )
  }
}

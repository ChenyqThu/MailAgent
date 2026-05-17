// React 19 still uses class-based error boundaries — no hook equivalent. We
// keep this minimal: catch render-tree errors so the user sees the failing
// component path instead of a blank window. Sprint 7 polishes the visual.

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  info: ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to main-process stdout via console.error (forwarded by
    // main/index.ts console-message hook). Keep raw stack so we can copy-paste.
    console.error('[ErrorBoundary]', error, info.componentStack)
    this.setState({ info })
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div className="h-full w-full bg-ink-0 text-ink-fg p-8 overflow-auto">
        <h1 className="text-subj font-semibold text-fail mb-3">Render error</h1>
        <p className="text-body text-ink-fg-1 mb-4">
          {this.state.error.message || 'Unknown error'}
        </p>
        <pre className="text-meta font-mono text-ink-fg-2 whitespace-pre-wrap break-all bg-ink-1 border border-ink-border rounded p-3 mb-4">
          {this.state.error.stack ?? ''}
        </pre>
        {this.state.info?.componentStack && (
          <pre className="text-meta font-mono text-ink-fg-3 whitespace-pre-wrap break-all bg-ink-1 border border-ink-border-soft rounded p-3">
            Component stack:
            {this.state.info.componentStack}
          </pre>
        )}
      </div>
    )
  }
}

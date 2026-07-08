// React 19 still uses class-based error boundaries — no hook equivalent. We
// keep this minimal: catch render-tree errors so the user sees the failing
// component path instead of a blank window. Sprint 7 polishes the visual.
//
// fe-review P2-9 — optional panel-level recovery. `fallback` (render-prop)
// hands a host the caught error plus a `reset` handle for in-place recovery:
// React unmounted the crashed subtree when the boundary caught, so clearing
// the error re-renders `children` as a fresh mount (no remount-key machinery
// needed). `resetKeys` auto-clears a held error when the content identity
// under the boundary changes (e.g. the active chat session switches), so a
// crashed session's error screen never blocks a healthy one. Prop-less usage
// (App.tsx root) renders exactly as before.

import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface ErrorBoundaryFallbackCtx {
  error: Error
  reset: () => void
}

interface Props {
  children: ReactNode
  /** Console attribution when several boundaries are live ([ErrorBoundary:chat-panel]). */
  label?: string
  /** Recovery UI rendered instead of the default full-screen dump. */
  fallback?: (ctx: ErrorBoundaryFallbackCtx) => ReactNode
  /** While an error is held, a change in any of these values resets it. */
  resetKeys?: readonly unknown[]
}

interface State {
  error: Error | null
  info: ErrorInfo | null
}

function resetKeysChanged(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined
): boolean {
  if (prev === next) return false
  if (!prev || !next || prev.length !== next.length) return true
  return prev.some((value, i) => !Object.is(value, next[i]))
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to main-process stdout via console.error (forwarded by
    // main/index.ts console-message hook). Keep raw stack so we can copy-paste.
    const tag = this.props.label ? `[ErrorBoundary:${this.props.label}]` : '[ErrorBoundary]'
    console.error(tag, error, info.componentStack)
    this.setState({ info })
  }

  componentDidUpdate(prevProps: Props): void {
    if (this.state.error !== null && resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.reset()
    }
  }

  reset = (): void => {
    this.setState({ error: null, info: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    if (this.props.fallback) return this.props.fallback({ error, reset: this.reset })
    return (
      <div className="h-full w-full bg-ink-0 text-ink-fg p-8 overflow-auto">
        <h1 className="text-subj font-semibold text-fail mb-3">Render error</h1>
        <p className="text-body text-ink-fg-1 mb-4">{error.message || 'Unknown error'}</p>
        <pre className="text-meta font-mono text-ink-fg-2 whitespace-pre-wrap break-all bg-ink-1 border border-ink-border rounded p-3 mb-4">
          {error.stack ?? ''}
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

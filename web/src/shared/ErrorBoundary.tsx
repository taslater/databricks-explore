import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  /** What to draw after a render error. `reset` clears the error and renders the children again. */
  fallback: (error: Error, reset: () => void) => ReactNode
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Catches render errors below it so one crash does not blank the whole page. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render error caught by ErrorBoundary:', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    return this.state.error ? this.props.fallback(this.state.error, this.reset) : this.props.children
  }
}

/** Error card for the root boundary: the message, a retry and a reload. */
export function AppErrorCard({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="error-card app-error" role="alert">
      <strong>Something went wrong.</strong>
      <pre className="error-card-message">{error.message}</pre>
      <div className="error-card-actions">
        <button onClick={reset}>Try again</button>
        <button onClick={() => window.location.reload()}>Reload page</button>
      </div>
    </div>
  )
}

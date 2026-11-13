import { AppShell } from './shared/AppShell'
import { AppErrorCard, ErrorBoundary } from './shared/ErrorBoundary'

export default function App() {
  return (
    <ErrorBoundary fallback={(error, reset) => <AppErrorCard error={error} reset={reset} />}>
      <AppShell />
    </ErrorBoundary>
  )
}

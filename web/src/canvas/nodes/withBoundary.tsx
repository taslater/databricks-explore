import type { ComponentType } from 'react'
import type { NodeProps } from '@xyflow/react'
import { ErrorBoundary } from '../../shared/ErrorBoundary'
import { useCanvasStore } from '../../store/canvasStore'

/**
 * Wraps a canvas node so a render error shows an error card in that window only.
 * Reset renders the window again; Delete window removes it (the canvas keeps working).
 */
export function withBoundary<P extends NodeProps>(Inner: ComponentType<P>): ComponentType<P> {
  function Bounded(props: P) {
    const removeWindow = useCanvasStore((s) => s.removeWindow)
    return (
      <ErrorBoundary
        fallback={(error, reset) => (
          <div className="qw-node error-card" role="alert">
            <strong>This window crashed.</strong>
            <pre className="error-card-message">{error.message}</pre>
            <div className="error-card-actions nodrag">
              <button onClick={reset}>Reset window</button>
              <button onClick={() => removeWindow(props.id)}>Delete window</button>
            </div>
          </div>
        )}
      >
        <Inner {...props} />
      </ErrorBoundary>
    )
  }
  Bounded.displayName = `Bounded(${Inner.displayName ?? Inner.name})`
  return Bounded
}

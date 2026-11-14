import { useEffect, useState } from 'react'
import { undoAgentChange } from '../../api/agent'
import { useCanvasStore } from '../../store/canvasStore'
import { useUiStore } from '../../store/uiStore'
import { POLL_MS, pollNow, reloadInPlace } from './canvasSync'
import { useSyncStore } from './syncStore'

/**
 * Polls the open canvas's revision while the Canvas tab is showing, and renders what an agent's edit needs from the
 * person: the "Undo agent change" button, and the banner when the canvas changed under unsaved edits.
 * Mounted once, in the top bar (which is always there).
 */
export function AgentCanvasSync() {
  const view = useUiStore((s) => s.view)
  const name = useCanvasStore((s) => s.canvasName)
  const remote = useSyncStore((s) => s.remote)
  const conflict = useSyncStore((s) => s.conflict)
  const [problem, setProblem] = useState<string | null>(null)
  const watching = view === 'canvas' && name !== null

  useEffect(() => {
    if (!watching) return
    void pollNow()
    const timer = setInterval(() => void pollNow(), POLL_MS)
    return () => clearInterval(timer)
  }, [watching, name])

  const canUndo =
    watching && remote !== null && remote.name === name && remote.snapshots > 0 && (remote.by === 'agent' || remote.by === 'undo')

  async function onUndo() {
    if (name === null) return
    setProblem(null)
    try {
      await undoAgentChange(name)
      await pollNow()
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    }
  }

  async function onReload() {
    if (conflict === null) return
    try {
      await reloadInPlace(conflict, true)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      {canUndo && (
        <button onClick={() => void onUndo()} title="Put the canvas back as it was before the agent's last change">
          Undo agent change
        </button>
      )}
      {problem && (
        <span className="chip agent-problem" role="status" title={problem}>
          Undo failed
        </span>
      )}
      {watching && conflict !== null && (
        <div className="agent-banner" role="alert">
          <span>{conflict.by === 'ui' ? 'Another window changed this canvas.' : 'An agent changed this canvas.'} You have unsaved edits.</span>
          <button onClick={() => void onReload()}>Reload</button>
          <button onClick={() => useSyncStore.getState().keepMine()}>Keep mine</button>
        </div>
      )}
    </>
  )
}

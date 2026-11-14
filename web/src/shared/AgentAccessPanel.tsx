import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getAgentAccess, newAgentToken } from '../api/agent'
import { ConfirmDialog } from './Dialog'

/** The command with the token hidden, for showing on screen. */
export function maskToken(command: string, token: string): string {
  return token ? command.split(token).join('•'.repeat(12)) : command
}

/** "Agent access": the MCP URL and the ready-to-paste `claude mcp add` command, with Copy and New token. */
export function AgentAccessPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const access = useQuery({ queryKey: ['agent-access'], queryFn: getAgentAccess, staleTime: 0, retry: false })
  const rotate = useMutation({
    mutationFn: newAgentToken,
    onSuccess: (data) => qc.setQueryData(['agent-access'], data),
  })
  const [revealed, setRevealed] = useState(false)
  const [confirmingToken, setConfirmingToken] = useState(false)
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  const data = access.data

  async function copy() {
    if (!data) return
    try {
      await navigator.clipboard.writeText(data.command)
      setCopied('done')
    } catch {
      setCopied('failed')
    }
  }

  function onNewToken() {
    setConfirmingToken(false)
    setCopied(null)
    rotate.mutate()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal agent-access" role="dialog" aria-label="Agent access" onClick={(e) => e.stopPropagation()}>
        <h3>Agent access</h3>
        <p>
          A coding agent such as Claude Code can explore the catalog and work on canvases next to you, through this app. It can read
          the catalog, relationships and concepts, run read-only SQL on the warehouse you selected, and edit canvases (every
          agent edit can be undone). It never writes to the workspace and cannot connect or pick a profile. Only this computer can reach it.
        </p>
        {access.isError && <p className="error">{(access.error as Error).message}</p>}
        {data && (
          <>
            <p>Run this once in a terminal:</p>
            <pre className="agent-command" data-testid="agent-command">
              {revealed ? data.command : maskToken(data.command, data.token)}
            </pre>
            <div className="agent-actions">
              <button onClick={() => void copy()}>Copy command</button>
              <label>
                <input type="checkbox" checked={revealed} onChange={(e) => setRevealed(e.target.checked)} /> Show token
              </label>
              <button onClick={() => setConfirmingToken(true)} disabled={rotate.isPending}>
                New token
              </button>
              <span className="spacer" />
              {copied === 'done' && <span role="status">Copied</span>}
              {copied === 'failed' && <span role="status">Could not copy: select the command and copy it</span>}
            </div>
            <p className="muted">
              {data.tools} tools at {data.url}. The token is stored in the data folder (mode 0600). Anyone with it can use these tools while the
              app runs, so do not share it.
            </p>
          </>
        )}
        {rotate.isError && <p className="error">{(rotate.error as Error).message}</p>}
        <div className="agent-actions">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
        {confirmingToken && (
          <ConfirmDialog
            title="New token"
            message="Make a new token? Agents that use the current one are refused until you give them the new command."
            confirmLabel="Make new token"
            destructive
            onConfirm={onNewToken}
            onCancel={() => setConfirmingToken(false)}
          />
        )}
      </div>
    </div>
  )
}

// Agent access (the MCP server) and canvas revisions: types and fetch functions (contracts/mcp.md and contracts/api.md section 3).
import { ApiError } from './client'

export interface AgentAccess {
  url: string
  token: string
  /** The ready-to-paste `claude mcp add` command, token included. */
  command: string
  tools: number
}

/** Who wrote a canvas last: the page (`ui`), an agent over MCP, or an undo. */
export type CanvasWriter = 'ui' | 'agent' | 'undo'

export interface CanvasRevision {
  name: string
  revision: number
  by: CanvasWriter | null
  /** Agent writes that can still be undone. */
  snapshots: number
}

async function call<T>(method: string, path: string): Promise<T> {
  const res = await fetch(path, { method })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const err =
      data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `HTTP ${res.status}`
    throw new ApiError(res.status, err)
  }
  return data as T
}

export const getAgentAccess = () => call<AgentAccess>('GET', '/api/agent-access')

/** Replaces the token. Agents using the old one are refused until they are given the new one. */
export const newAgentToken = () => call<AgentAccess>('POST', '/api/agent-access/token')

/** The page polls this to notice that something else saved the open canvas. */
export const getCanvasRevision = (name: string) =>
  call<CanvasRevision>('GET', `/api/canvases/${encodeURIComponent(name)}/revision`)

/** Restores the state before the last agent write. */
export const undoAgentChange = (name: string) =>
  call<{ name: string; revision: number; snapshots: number }>('POST', `/api/canvases/${encodeURIComponent(name)}/undo`)

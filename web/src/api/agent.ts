// Agent access (the MCP server) and canvas revisions: types and fetch functions (contracts/mcp.md and contracts/api.md section 3).
import { ApiError } from './client'
import type { CanvasDoc, SavedResponse } from './types'

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

/** A save refused (409) because something else saved the canvas since the revision the page loaded. */
export class SaveConflict extends Error {
  readonly remote: CanvasRevision

  constructor(message: string, remote: CanvasRevision) {
    super(message)
    this.name = 'SaveConflict'
    this.remote = remote
  }
}

/**
 * Saves a canvas like POST /api/canvases, and tells the server which revision the page started from, so a newer
 * save by an agent is never overwritten unseen. `baseRevision` null skips the check. Throws SaveConflict on 409.
 */
export async function saveCanvasChecked(doc: CanvasDoc, baseRevision: number | null): Promise<SavedResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (baseRevision !== null) headers['X-Base-Revision'] = String(baseRevision)
  const res = await fetch('/api/canvases', { method: 'POST', headers, body: JSON.stringify(doc) })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  const body = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  if (res.status === 409 && typeof body.revision === 'number') {
    const remote: CanvasRevision = {
      name: doc.name,
      revision: body.revision,
      by: (body.by as CanvasWriter | null) ?? null,
      snapshots: typeof body.snapshots === 'number' ? body.snapshots : 0,
    }
    throw new SaveConflict(typeof body.error === 'string' ? body.error : 'canvas changed', remote)
  }
  if (!res.ok) throw new ApiError(res.status, typeof body.error === 'string' ? body.error : `HTTP ${res.status}`)
  return data as SavedResponse
}

export const getAgentAccess =() => call<AgentAccess>('GET', '/api/agent-access')

/** Replaces the token. Agents using the old one are refused until they are given the new one. */
export const newAgentToken = () => call<AgentAccess>('POST', '/api/agent-access/token')

/** The page polls this to notice that something else saved the open canvas. */
export const getCanvasRevision = (name: string) =>
  call<CanvasRevision>('GET', `/api/canvases/${encodeURIComponent(name)}/revision`)

/** Restores the state before the last agent write. */
export const undoAgentChange = (name: string) =>
  call<{ name: string; revision: number; snapshots: number }>('POST', `/api/canvases/${encodeURIComponent(name)}/undo`)

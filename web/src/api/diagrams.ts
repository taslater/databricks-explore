// Saved graphs (the Graph tab's diagrams): revisions, checked saves, rename and delete (contracts/api.md, "Diagrams").
import { ApiError } from './client'
import type { DiagramBody, SavedResponse } from './types'

/** Who wrote a saved graph last: the page (`ui`) or an agent over MCP. `null` for a graph saved before revisions. */
export type DiagramWriter = 'ui' | 'agent'

export interface DiagramRevision {
  /** The stored name (the file stem). */
  name: string
  revision: number
  by: DiagramWriter | null
}

/** A save refused (409) because something else saved the graph since the revision the page loaded. */
export class DiagramConflict extends Error {
  readonly remote: DiagramRevision

  constructor(message: string, remote: DiagramRevision) {
    super(message)
    this.name = 'DiagramConflict'
    this.remote = remote
  }
}

/** The name a graph is stored under: letters, digits, _ . - are kept and anything else becomes _ (as the server does). */
export const storedName = (name: string): string => name.trim().replace(/[^A-Za-z0-9_.-]/g, '_')

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...headers }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(path, init)
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  const fields = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return { res, fields }
}

function fail(status: number, fields: Record<string, unknown>): never {
  throw new ApiError(status, typeof fields.error === 'string' ? fields.error : `HTTP ${status}`)
}

/**
 * Saves a graph like POST /api/diagrams and tells the server which revision the page started from, so a newer save
 * by an agent is never overwritten unseen. `baseRevision` null skips the check. Throws DiagramConflict on 409.
 */
export async function saveDiagramChecked(body: DiagramBody, baseRevision: number | null): Promise<SavedResponse> {
  const headers: Record<string, string> = baseRevision === null ? {} : { 'X-Base-Revision': String(baseRevision) }
  const { res, fields } = await call('POST', '/api/diagrams', body, headers)
  if (res.status === 409 && typeof fields.revision === 'number') {
    const remote: DiagramRevision = {
      name: typeof fields.name === 'string' ? fields.name : body.name,
      revision: fields.revision,
      by: (fields.by as DiagramWriter | null) ?? null,
    }
    throw new DiagramConflict(typeof fields.error === 'string' ? fields.error : 'graph changed', remote)
  }
  if (!res.ok) fail(res.status, fields)
  return fields as unknown as SavedResponse
}

/** The page polls this to notice that something else saved the open graph. 404 (ApiError) when it was deleted or renamed. */
export async function getDiagramRevision(name: string): Promise<DiagramRevision> {
  const { res, fields } = await call('GET', `/api/diagrams/${encodeURIComponent(name)}/revision`)
  if (!res.ok) fail(res.status, fields)
  return fields as unknown as DiagramRevision
}

/** Renames a saved graph. Answers the new stored name and its revision. */
export async function renameDiagram(name: string, newName: string): Promise<{ renamed: string; revision: number }> {
  const { res, fields } = await call('POST', `/api/diagrams/${encodeURIComponent(name)}/rename`, { new_name: newName })
  if (!res.ok) fail(res.status, fields)
  return fields as unknown as { renamed: string; revision: number }
}

/** Deletes a saved graph; the server keeps a copy in its trash folder. */
export async function deleteDiagram(name: string): Promise<{ deleted: string; trash: string }> {
  const { res, fields } = await call('DELETE', `/api/diagrams/${encodeURIComponent(name)}`)
  if (!res.ok) fail(res.status, fields)
  return fields as unknown as { deleted: string; trash: string }
}

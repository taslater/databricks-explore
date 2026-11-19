// Live sync of the open saved graph with agents: notice that something else saved it, and either reload it in
// place or ask. The poll is plain functions over the store, so it can run from anywhere that stays mounted.
import { useEffect } from 'react'
import * as api from '../api/client'
import { ApiError } from '../api/client'
import { getDiagramRevision, type DiagramRevision } from '../api/diagrams'
import { fromDiagram } from './diagram'
import { useGraphStore, type OpenDiagram } from './graphStore'
import type { FlowEdge, FlowNode } from './types'

export const DIAGRAM_POLL_MS = 2000

/**
 * What the page holds, as a string: the tables with their positions and pins, the edges, the focus schema.
 * It is compared with the string taken when the graph was loaded or saved, to tell whether the person changed
 * anything since (a measured size or a selection is not a change).
 */
export function graphSignature(nodes: FlowNode[], edges: FlowEdge[], focusSchema: string | null): string {
  const n = nodes.map((x) => `${x.id}@${Math.round(x.position.x)},${Math.round(x.position.y)}${x.data.pinned ? 'p' : ''}`).sort()
  return JSON.stringify([focusSchema, n, edges.map((e) => e.id).sort()])
}

/** The signature of what is on screen now. */
export function currentSignature(): string {
  const g = useGraphStore.getState()
  return graphSignature(g.nodes, g.edges, g.focusSchema)
}

export type DiagramSyncAction = 'none' | 'reload' | 'banner'

/**
 * What to do with a poll answer. Nothing when the page has this revision already, or is mid-save (the answer may be
 * its own write). With no unsaved changes the graph reloads in place; with some, the person chooses.
 */
export function decideDiagramSync(
  known: OpenDiagram | null,
  remote: DiagramRevision,
  dirty: boolean,
  saving: boolean,
): DiagramSyncAction {
  if (known === null || known.name !== remote.name || remote.revision <= known.revision || saving) return 'none'
  return dirty ? 'banner' : 'reload'
}

/**
 * Loads the saved graph into the store and takes its signature. `force` skips the check that the page has no unsaved
 * changes (the banner's Reload, which throws them away). Returns false when the person edited while it fetched.
 */
export async function reloadOpenDiagram(remote: DiagramRevision, force = false): Promise<boolean> {
  const file = await api.getDiagram(remote.name)
  const g = useGraphStore.getState()
  if (g.openDiagram?.name !== remote.name) return false
  if (!force && g.openDiagram.signature !== currentSignature()) return false
  g.loadDiagram(fromDiagram(file))
  const after = useGraphStore.getState()
  after.setOpenDiagram({ name: remote.name, revision: remote.revision, signature: currentSignature() })
  after.setStatus(`graph ${remote.name} changed${remote.by ? ` by ${remote.by}` : ''} and was reloaded (revision ${remote.revision})`)
  return true
}

/** Applies one poll answer for the open graph. */
export async function handleDiagramRemote(remote: DiagramRevision): Promise<'none' | 'reload' | 'banner'> {
  const g = useGraphStore.getState()
  const open = g.openDiagram
  if (open === null || open.name !== remote.name) return 'none'
  const dirty = open.signature !== currentSignature()
  const action = decideDiagramSync(open, remote, dirty, g.diagramSaving)
  if (action === 'reload') {
    if (!(await reloadOpenDiagram(remote))) return 'none'
  } else if (action === 'banner' && g.diagramChanged?.revision !== remote.revision) {
    g.setDiagramChanged(remote)
  }
  return action
}

/** Asks the server for the open graph's revision now and applies the answer. Errors other than a missing graph are ignored: the next poll tries again. */
export async function pollDiagramNow(): Promise<void> {
  const open = useGraphStore.getState().openDiagram
  if (open === null) return
  try {
    await handleDiagramRemote(await getDiagramRevision(open.name))
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && useGraphStore.getState().openDiagram?.name === open.name) {
      const g = useGraphStore.getState()
      g.setOpenDiagram(null)
      g.setStatus(`graph ${open.name} was deleted or renamed outside the page; what is on screen is not saved`, true)
    }
  }
}

/** Polls the open graph while the Graph toolbar is mounted. */
export function useDiagramSync(): void {
  useEffect(() => {
    const id = setInterval(() => void pollDiagramNow(), DIAGRAM_POLL_MS)
    return () => clearInterval(id)
  }, [])
}

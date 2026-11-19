// Expanding one side of a table at a time: add its neighbors one hop, follow the chain to its end, or collapse what was added.
import type { QueryClient } from '@tanstack/react-query'
import * as api from '../api/client'
import { useUiStore } from '../store/uiStore'
import { useGraphStore } from './graphStore'
import {
  CHAIN_CAP,
  collapsible,
  expansionKey,
  neighborSet,
  shownNeighbors,
  sliceOf,
  type Direction,
} from './neighbors'
import { toRelations } from './relationships'

/** How long a relationships response read for counting or expanding one side stays fresh. */
export const NEIGHBORS_STALE_MS = 5 * 60_000

const sideWord = (dir: Direction) => (dir === 'up' ? 'upstream' : 'downstream')
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The expansion actions over one query client. `onArrive(before)` runs after tables were added (the page shows their
 * columns then, when Show columns is on); `before` is the ids on the graph before.
 */
export function makeExpansion(qc: QueryClient, onArrive: (before: string[]) => void) {
  const store = () => useGraphStore.getState()

  /** The relationships of one object through the page's cache: for counting and expanding, a few minutes old is fine. */
  async function relationsFor(name: string) {
    const profile = useUiStore.getState().connectedProfile
    return toRelations(
      await qc.fetchQuery({
        queryKey: ['relationships', profile, name],
        queryFn: () => api.getRelationships(name),
        staleTime: NEIGHBORS_STALE_MS,
        retry: false,
      }),
    )
  }

  /** Reads a table's relationships and keeps what they say about it: its neighbors, and its own facts (kind, self-reference, files). */
  async function readNeighbors(id: string) {
    const resp = await relationsFor(id)
    const set = neighborSet(resp, id)
    store().setNeighbors(id, set)
    const own = resp.nodes.find((n) => n.id === id)
    if (own && store().nodes.some((n) => n.id === id)) store().applyNodeFacts(own)
    return { resp, set }
  }

  /**
   * Adds the neighbors of one table on one side (upstream or downstream), one hop, with the edges that reach them. Which
   * neighbors count follows the filters (superseded ones stay out unless shown). Remembers what it added, for collapseDirection.
   */
  async function expandDirection(id: string, dir: Direction) {
    store().setStatus(`loading ${sideWord(dir)} of ${id}…`)
    try {
      const { resp, set } = await readNeighbors(id)
      const wanted = shownNeighbors(set, dir, store().filters)
      const before = store().nodes.map((n) => n.id)
      store().mergeRelations(sliceOf(resp, wanted))
      const added = store().nodes.map((n) => n.id).filter((n) => !before.includes(n))
      store().recordExpansion(expansionKey(id, dir), added)
      store().setStatus(added.length ? `added ${added.length} ${sideWord(dir)} of ${id}` : `nothing more ${sideWord(dir)} of ${id}`)
      onArrive(before)
    } catch (e) {
      store().setStatus(messageOf(e), true)
    }
  }

  /**
   * Follows one side of a table to the end of the chain, hop after hop (the walk lineage.walk makes, read through the
   * same cache), adding at most CHAIN_CAP tables. Says so in the status line when it stopped at the cap.
   */
  async function followDirection(id: string, dir: Direction) {
    const visited = new Set([id])
    const queue = [id]
    const added: string[] = []
    let stopped = false
    const before = store().nodes.map((n) => n.id)
    store().setStatus(`following ${sideWord(dir)} of ${id}…`)
    try {
      while (queue.length > 0) {
        const current = queue.shift()!
        if (store().nodes.find((n) => n.id === current)?.data.missing) continue
        const { resp, set } = await readNeighbors(current)
        const wanted = shownNeighbors(set, dir, store().filters)
        const onGraph = new Set(store().nodes.map((n) => n.id))
        const room = Math.max(0, CHAIN_CAP - added.length)
        const fresh = wanted.filter((n) => !onGraph.has(n.id))
        if (fresh.length > room) stopped = true
        const take = [...wanted.filter((n) => onGraph.has(n.id)), ...fresh.slice(0, room)]
        store().mergeRelations(sliceOf(resp, take))
        added.push(...fresh.slice(0, room).map((n) => n.id))
        for (const n of take) {
          if (!visited.has(n.id)) {
            visited.add(n.id)
            queue.push(n.id)
          }
        }
      }
      store().recordExpansion(expansionKey(id, dir), added)
      const note = stopped ? `. Stopped at ${CHAIN_CAP} tables; follow again from the last ones to go on.` : ''
      store().setStatus(`followed ${sideWord(dir)} of ${id}: ${added.length} table${added.length === 1 ? '' : 's'} added${note}`)
      onArrive(before)
    } catch (e) {
      store().setStatus(messageOf(e), true)
    }
  }

  /** Takes off what expandDirection or followDirection added, except tables something else on the graph is connected to. */
  function collapseDirection(id: string, dir: Direction) {
    const s = store()
    const key = expansionKey(id, dir)
    const on = new Set(s.nodes.map((n) => n.id))
    const keep = new Set(s.nodes.filter((n) => n.data.focus || n.data.pinned).map((n) => n.id))
    const gone = collapsible((s.expansions[key] ?? []).filter((n) => on.has(n)), id, s.edges, keep)
    useGraphStore.setState({ expansions: Object.fromEntries(Object.entries(s.expansions).filter(([k]) => k !== key)) })
    if (gone.length === 0) {
      s.setStatus('nothing to collapse: what it added is still in use')
      return
    }
    s.removeNodes(gone)
    s.setStatus(`collapsed ${gone.length} table${gone.length === 1 ? '' : 's'} ${sideWord(dir)} of ${id}`)
  }

  return { relationsFor, readNeighbors, expandDirection, followDirection, collapseDirection }
}

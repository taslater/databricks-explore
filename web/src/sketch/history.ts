// Undo and redo for the sketch. A snapshot holds the sketch nodes and connectors in full, and the
// geometry (position, size, stacking) of every node the host owns, so moving a query window or table
// card is undoable too. The text, SQL and titles of host windows are never part of a snapshot, so undo
// cannot throw away what was typed in a window. No React or store imports.
import type { Geometry, SketchEdge, SketchNode } from './types'

export interface Snapshot {
  nodes: SketchNode[]
  edges: SketchEdge[]
  host: Record<string, Geometry & { locked?: boolean }>
}

export interface History {
  past: Snapshot[]
  future: Snapshot[]
  /** Key and time of the last push, so a burst of typing makes one undo step. */
  lastKey: string | null
  lastAt: number
}

export const HISTORY_LIMIT = 100
/** Pushes with the same key closer together than this (ms) count as one step. */
export const COALESCE_MS = 1000

export const EMPTY_HISTORY: History = { past: [], future: [], lastKey: null, lastAt: 0 }

/**
 * Records `snap` (the state before a change) as an undo step and clears redo. A push with the same `key`
 * as the previous one, within COALESCE_MS, is skipped: the earlier snapshot already covers it.
 */
export function push(h: History, snap: Snapshot, key: string | null = null, now: number = Date.now()): History {
  if (key !== null && key === h.lastKey && now - h.lastAt < COALESCE_MS && h.past.length > 0) {
    return { ...h, future: [], lastAt: now }
  }
  const past = [...h.past, snap]
  if (past.length > HISTORY_LIMIT) past.shift()
  return { past, future: [], lastKey: key, lastAt: now }
}

/** The state to go back to, and the history after going back. Null when there is nothing to undo. */
export function undo(h: History, current: Snapshot): { history: History; snapshot: Snapshot } | null {
  if (h.past.length === 0) return null
  const snapshot = h.past[h.past.length - 1]
  return {
    snapshot,
    history: { past: h.past.slice(0, -1), future: [...h.future, current], lastKey: null, lastAt: 0 },
  }
}

export function redo(h: History, current: Snapshot): { history: History; snapshot: Snapshot } | null {
  if (h.future.length === 0) return null
  const snapshot = h.future[h.future.length - 1]
  return {
    snapshot,
    history: { past: [...h.past, current], future: h.future.slice(0, -1), lastKey: null, lastAt: 0 },
  }
}

/** True when two snapshots hold the same state. Used to drop a step that changed nothing. */
export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

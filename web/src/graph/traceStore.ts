// The column trace on screen: what was asked, which tables it added to the graph and where the others stood. UI only, never saved.
import { create } from 'zustand'
import type { TraceRequest } from '../api/columnTrace'
import type { ColumnInfo } from './columns'

export interface TraceState {
  request: TraceRequest | null
  /** Graph node ids the trace added, so clearing it takes them off again. */
  added: string[]
  /** Where each table that was on the graph stood when the trace began, so clearing it puts them back. */
  positions: Record<string, { x: number; y: number }>
  /** Columns of the tables on the path, for the ones whose node had not loaded them. Drawn, never put on the node. */
  columns: Record<string, ColumnInfo[]>
  begin: (request: TraceRequest, positions: TraceState['positions']) => void
  setAdded: (ids: string[]) => void
  setColumns: (columns: TraceState['columns']) => void
  reset: () => void
}

export const useTraceStore = create<TraceState>()((set) => ({
  request: null,
  added: [],
  positions: {},
  columns: {},
  begin: (request, positions) => set({ request, positions, added: [], columns: {} }),
  setAdded: (added) => set({ added }),
  setColumns: (columns) => set({ columns }),
  reset: () => set({ request: null, added: [], positions: {}, columns: {} }),
}))

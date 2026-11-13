import type { Edge, Node } from '@xyflow/react'
import type { GraphEdge } from '../api/types'

/** Data stored on a React Flow node. Fields marked "derived" are filled in by deriveFlow and never saved. */
export type TableNodeData = {
  /** Short table name (third dotted part of the full name). */
  name: string
  /** "catalog.schema" of the table. */
  schema: string
  /** Lowercased table_type from the server. */
  kind: string
  focus: boolean
  selfRef: boolean
  selfRefLastSeen?: string
  // derived
  showSchema?: boolean
  external?: boolean
  via?: string
  faded?: boolean
}

export type FlowNode = Node<TableNodeData, 'table'>

/** Data stored on a React Flow edge. `info` is the server edge object, kept verbatim for saving and details. */
export type EdgeData = {
  info: GraphEdge
  // derived
  stale?: boolean
  faded?: boolean
}

export type FlowEdge = Edge<EdgeData>

export type Selection = { kind: 'node' | 'edge'; id: string } | null

export interface EdgeFilters {
  lineage: boolean
  fk: boolean
  view_dep: boolean
  showStale: boolean
}

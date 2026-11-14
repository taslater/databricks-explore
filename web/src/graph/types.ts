import type { Edge, Node } from '@xyflow/react'
import type { GraphEdge, GraphEdgeKind } from '../api/types'
import type { ColumnInfo } from './columns'

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
  /** Columns, once loaded. Shown while `showColumns` is set. */
  columns?: ColumnInfo[]
  showColumns?: boolean
  /** Show every column of a wide table, not just the ones with an edge and the first few. */
  allColumns?: boolean
  // derived
  /** Names of the columns that have a column edge (set by deriveFlow). */
  involved?: string[]
  showSchema?: boolean
  external?: boolean
  via?: string
  faded?: boolean
}

export type FlowNode = Node<TableNodeData, 'table'>

/** A glossary concept drawn next to the tables it is linked to. Built by concepts/overlay.ts, never stored in the graph. */
export type ConceptNodeData = {
  conceptId: string
  name: string
  status: 'draft' | 'reviewed' | 'certified'
  domain: string | null
  /** One line per link on the graph, e.g. `defines orders.customer_id`. */
  targets: string[]
}

export type ConceptFlowNode = Node<ConceptNodeData, 'concept'>

/** Data stored on a React Flow edge. `info` is the server edge object, kept verbatim for saving and details. */
export type EdgeData = {
  info: GraphEdge
  // derived
  stale?: boolean
  faded?: boolean
}

export type FlowEdge = Edge<EdgeData>

export type Selection = { kind: 'node' | 'edge'; id: string } | null

/** One checkbox per edge kind, plus stale lineage and rejected edges (hidden unless asked for). */
export type EdgeFilters = Record<GraphEdgeKind, boolean> & {
  showStale: boolean
  showRejected: boolean
}

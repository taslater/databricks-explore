import type { Edge, Node } from '@xyflow/react'
import type { Cardinality, FileUpstream, GraphEdge, GraphEdgeKind, SelfRefFk } from '../api/types'
import type { NodeFacts } from '../api/nodeFacts'
import type { ColumnInfo } from './columns'
import type { EdgeFamily } from './edgeStyles'

/** Data stored on a React Flow node. Fields marked "derived" are filled in by deriveFlow and never saved. */
export type TableNodeData = {
  /** Short table name (third dotted part of the full name). */
  name: string
  /** "catalog.schema" of the table. */
  schema: string
  /** Lowercased table_type from the server. */
  kind: string
  focus: boolean
  /** Added on purpose (picker Add, Shift-click or a drop on the graph): it shows even when the filters hide all its edges, like the focus. */
  pinned?: boolean
  selfRef: boolean
  selfRefLastSeen?: string
  /** Self-referencing foreign keys, and files the table is loaded from: the markers of nodeMarks.ts. */
  selfRefFks?: SelfRefFk[]
  files?: FileUpstream[]
  /** The object does not exist. Drawn dashed with no fill, never expanded. */
  missing?: boolean
  missingReason?: string
  renamedTo?: string
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
  /** Neighbors not on the graph, upstream and downstream (set by withNeighborCounts, never saved). */
  more?: { up: number; down: number }
  /** Side keys (`r`, or `r:column` on a row) that carry edges in and out, so they anchor apart (graph/anchors.ts). */
  anchorSplit?: string[]
  faded?: boolean
  /** The table's `system.certification_status` tag, added at draw time (concepts/certification.ts) and never saved. */
  certification?: 'certified' | 'deprecated'
  /** The grain and the size and freshness last read, added at draw time (graph/nodeFacts.ts) and never saved. */
  facts?: NodeFacts
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
  /** The edge no longer holds (status `superseded`). */
  superseded?: boolean
  faded?: boolean
  /** `per a → per b`: the target is a GROUP BY of a different grain than the source (added at draw time, never saved). */
  grainChange?: string
  /** The crow's-foot ends read from keys and nullability, added at draw time (graph/EdgeEnds.tsx) and never saved. */
  cardinality?: Cardinality
}

export type FlowEdge = Edge<EdgeData>

export type Selection = { kind: 'node' | 'edge'; id: string } | null

/** One checkbox per edge family and per kind (an edge shows when both are on), plus superseded and rejected edges (hidden unless asked for). */
export type EdgeFilters = Record<GraphEdgeKind, boolean> & Record<EdgeFamily, boolean> & {
  showSuperseded: boolean
  showRejected: boolean
}

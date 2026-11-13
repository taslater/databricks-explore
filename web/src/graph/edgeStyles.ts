// How each relationship kind is drawn and named. Shared by the edge components and the legend.
import type { GraphEdgeKind } from '../api/types'
import { EDGE_COLORS } from './format'

export interface KindStyle {
  stroke: string
  strokeDasharray?: string
  strokeWidth?: number
}

/** Legacy kinds keep their look (lineage solid, FK dashed, view dep solid purple, stale lineage dotted gray). New kinds differ by color and dash. */
export const KIND_STYLE: Record<GraphEdgeKind | 'stale', KindStyle> = {
  lineage: { stroke: EDGE_COLORS.lineage },
  fk: { stroke: EDGE_COLORS.fk, strokeDasharray: '6 4' },
  view_dep: { stroke: EDGE_COLORS.view_dep },
  join_mined: { stroke: EDGE_COLORS.join_mined, strokeDasharray: '9 3 2 3' },
  manual: { stroke: EDGE_COLORS.manual, strokeWidth: 2.4 },
  sketch: { stroke: EDGE_COLORS.sketch, strokeDasharray: '1 4' },
  concept_link: { stroke: EDGE_COLORS.concept_link, strokeDasharray: '12 4' },
  ontology: { stroke: EDGE_COLORS.ontology, strokeDasharray: '14 3 2 3 2 3' },
  stale: { stroke: EDGE_COLORS.stale, strokeDasharray: '2 3' },
}

export const KIND_LABEL: Record<GraphEdgeKind, string> = {
  lineage: 'lineage',
  fk: 'FK',
  view_dep: 'view dep',
  join_mined: 'join (mined)',
  manual: 'manual',
  sketch: 'sketch',
  concept_link: 'concept link',
  ontology: 'ontology',
}

/** Kinds read from Unity Catalog every time. They are never stored. */
export const DERIVED_KINDS: readonly GraphEdgeKind[] = ['lineage', 'fk', 'view_dep']

/** Kinds kept in the relationship store. */
export const STORED_KINDS: readonly GraphEdgeKind[] = ['join_mined', 'manual', 'sketch', 'concept_link', 'ontology']

export const isDerivedKind = (kind: GraphEdgeKind): boolean => DERIVED_KINDS.includes(kind)

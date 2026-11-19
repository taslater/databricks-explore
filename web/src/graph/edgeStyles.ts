// How each relationship is drawn and named. Shared by the edge components, the filters and the legend.
// The family says what a relationship means, dashing says how sure we are, and Details says where it came from.
import type { GraphEdge, GraphEdgeKind } from '../api/types'
import { EDGE_COLORS, FAMILY_COLORS } from './format'

/** flow: data moves from source to target. reference: a key identifies a row elsewhere. meaning: concept, ontology and sketch links. */
export type EdgeFamily = 'flow' | 'reference' | 'meaning'

export const FAMILIES: readonly EdgeFamily[] = ['flow', 'reference', 'meaning']

// Python twin: edge_families.FAMILY_OF (checked by web/src/parity.test.ts and tests/test_parity.py).
export const FAMILY_OF: Record<GraphEdgeKind, EdgeFamily> = {
  lineage: 'flow',
  view_dep: 'flow',
  fk: 'reference',
  join_mined: 'reference',
  manual: 'reference',
  sketch: 'meaning',
  concept_link: 'meaning',
  ontology: 'meaning',
}

export const familyOf = (kind: GraphEdgeKind): EdgeFamily => FAMILY_OF[kind]

export const FAMILY_LABEL: Record<EdgeFamily, string> = {
  flow: 'data flows',
  reference: 'key reference',
  meaning: 'meaning link',
}

/** What each family covers, for the filter boxes' tooltips. */
export const FAMILY_HINT: Record<EdgeFamily, string> = {
  flow: 'Lineage and view dependencies: data moves from the source to the target.',
  reference: 'Foreign keys and joins: a key in one table identifies a row in another.',
  meaning: 'Concept, ontology and sketch links. Off until asked for.',
}

export interface KindStyle {
  stroke: string
  strokeDasharray?: string
  strokeWidth?: number
}

/** Dash of an inferred or proposed edge. A meaning edge is dotted already, so it keeps its dots. */
export const INFERRED_DASH = '6 4'

/** Family styles, solid. An edge that is not declared or measured adds the dash (see edgeStyle). */
export const FAMILY_STYLE: Record<EdgeFamily, KindStyle> = {
  flow: { stroke: FAMILY_COLORS.flow, strokeWidth: 1.8 },
  reference: { stroke: FAMILY_COLORS.reference, strokeWidth: 1.2 },
  meaning: { stroke: FAMILY_COLORS.meaning, strokeWidth: 1, strokeDasharray: '1 4' },
}

/** An edge that no longer holds, drawn dotted gray whatever its family. */
export const SUPERSEDED_STYLE: KindStyle = { stroke: EDGE_COLORS.superseded, strokeWidth: 1.6, strokeDasharray: '2 3' }

/** Confidence: dashed when the edge is proposed (mined and not accepted, suggestions). Declared, derived, accepted and drawn edges are solid. */
export const isInferred = (info: GraphEdge): boolean => info.status === 'proposed'

/** The line style of an edge: its family's, dashed when inferred, gray and dotted when superseded. */
export function edgeStyle(family: EdgeFamily, inferred: boolean, superseded = false): KindStyle {
  if (superseded) return SUPERSEDED_STYLE
  const base = FAMILY_STYLE[family]
  return inferred && family !== 'meaning' ? { ...base, strokeDasharray: INFERRED_DASH } : base
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

/** The kinds of a family, in the order the filters list them. */
export const KINDS_OF: Record<EdgeFamily, readonly GraphEdgeKind[]> = {
  flow: ['lineage', 'view_dep'],
  reference: ['fk', 'join_mined', 'manual'],
  meaning: ['sketch', 'concept_link', 'ontology'],
}

/** Kinds read from Unity Catalog every time. They are never stored. */
export const DERIVED_KINDS: readonly GraphEdgeKind[] = ['lineage', 'fk', 'view_dep']

/** Kinds kept in the relationship store. */
export const STORED_KINDS: readonly GraphEdgeKind[] = ['join_mined', 'manual', 'sketch', 'concept_link', 'ontology']

export const isDerivedKind = (kind: GraphEdgeKind): boolean => DERIVED_KINDS.includes(kind)

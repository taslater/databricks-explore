// Where the app learned an edge, in one line for the Details panel. Pure: no React.
import type { GraphEdge } from '../api/types'
import { familyOf, FAMILY_LABEL } from './edgeStyles'
import { fmtTime, lastPart } from './format'

/** The date part of a lineage or provenance time, or null when there is none. */
const dayOf = (s: string | null | undefined): string | null => (s ? fmtTime(s).slice(0, 10) : null)

/** E.g. "foreign key constraint `fk_orders_customer`", "definition of view `v_daily_revenue`", "drawn by you". */
export function edgeSource(info: GraphEdge): string {
  const p = info.provenance
  const last = dayOf(info.evidence?.last_seen ?? info.last_seen)
  switch (info.kind) {
    case 'fk':
      return info.constraint ? `foreign key constraint \`${info.constraint}\`` : 'foreign key constraint'
    case 'view_dep':
      return `definition of view \`${lastPart(info.target)}\``
    case 'lineage': {
      const what = p?.origin.endsWith(':column_lineage') ? 'column lineage' : 'lineage'
      return `Unity Catalog ${what}${last ? `, last seen ${last}` : ''}`
    }
    case 'join_mined': {
      const ev = info.evidence
      // A table-level edge adds up its column pairs' runs, which counts a composite-key statement once per column, so only a column edge states them.
      const counts =
        ev && info.source_column
          ? [ev.runs != null && `${ev.runs} runs`, ev.users != null && `${ev.users} users`].filter(Boolean).join(' by ')
          : ''
      return `mined from ${counts || 'query history'}${last ? `, last on ${last}` : ''}`
    }
    case 'manual':
      return 'drawn by you'
    case 'sketch':
      return p?.source_ref ? `sketched on canvas ${p.source_ref}` : 'sketched on a canvas'
    case 'concept_link':
      return 'glossary concept link'
    case 'ontology':
      return `ontology import${p?.source_ref ? ` (${p.source_ref})` : ''}`
  }
  return p?.origin ?? FAMILY_LABEL[familyOf(info.kind)]
}

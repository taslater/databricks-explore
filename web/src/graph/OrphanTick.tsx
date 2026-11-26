// The mark for orphans: a small red tick across a reference edge near the referenced table. A clean relationship gets nothing.
import type { Position } from '@xyflow/react'
import type { RelationshipProfile } from '../api/types'
import { orphanText, TICK_AT, TICK_HALF, tickPlace } from './relProfile'

/** The tick sits where the line leaves the table at (x, y) on `side`, past the crow's-foot glyph. Hovering it says how many rows have no match. */
export function OrphanTick({ x, y, side, profile, faded }: { x: number; y: number; side: Position; profile: RelationshipProfile; faded?: boolean }) {
  const at = tickPlace(x, y, side)
  return (
    <g transform={`translate(${at.x} ${at.y}) rotate(${at.rotate})`} opacity={faded ? 0.2 : 1} data-testid="orphan-tick" style={{ pointerEvents: 'all' }}>
      <title>{orphanText(profile) ?? ''}</title>
      <line x1={TICK_AT - 2.5} y1={-TICK_HALF} x2={TICK_AT + 2.5} y2={TICK_HALF} stroke="var(--edge-orphan)" strokeWidth={2.4} strokeLinecap="round" />
      <line x1={TICK_AT} y1={-TICK_HALF - 3} x2={TICK_AT} y2={TICK_HALF + 3} stroke="transparent" strokeWidth={10} />
    </g>
  )
}

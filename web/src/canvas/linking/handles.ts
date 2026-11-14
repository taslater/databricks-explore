// Which side of each window a derived link leaves and enters. Pure, so tests call it directly.
import type { Side } from '../../sketch/types'

interface Box {
  position: { x: number; y: number }
  size: { w: number; h: number }
}

/**
 * Picks the facing sides of two windows: right to left when the target lies mostly to the right, bottom to top
 * when it lies mostly below, and the reverse for the other two directions. Keeps derived links short and tidy
 * now that every window has handles on all four sides.
 */
export function facingHandles(source: Box, target: Box): { source: Side; target: Side } {
  const dx = target.position.x + target.size.w / 2 - (source.position.x + source.size.w / 2)
  const dy = target.position.y + target.size.h / 2 - (source.position.y + source.size.h / 2)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { source: 'r', target: 'l' } : { source: 'l', target: 'r' }
  return dy >= 0 ? { source: 'b', target: 't' } : { source: 't', target: 'b' }
}

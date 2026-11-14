import { useSketchStore } from '../sketchStore'
import type { SketchNode } from '../types'

/** The sketch node with this id, or undefined once it is gone. */
export function useSketchNode(id: string): SketchNode | undefined {
  return useSketchStore((s) => s.nodes.find((n) => n.id === id))
}

/** Props the resizer of every sketch node shares. Resizing is one undo step, and snaps to the grid when snap is on. */
export function useResizeHandlers(id: string) {
  const checkpoint = useSketchStore((s) => s.checkpoint)
  const resizeNode = useSketchStore((s) => s.resizeNode)
  return {
    onResizeStart: () => checkpoint(`resize:${id}:${Date.now()}`),
    onResize: (_: unknown, p: { x: number; y: number; width: number; height: number }) =>
      resizeNode(id, { x: p.x, y: p.y }, { w: p.width, h: p.height }),
  }
}

// Glue between the layout routes and the canvas: builds the canvas the routes read from the stores, and applies
// what they return through the sketch store, so one undo (Cmd/Ctrl+Z) reverts a whole Tidy or Arrange.
import type { CanvasDoc } from '../../api/types'
import type { LayoutChange } from '../../api/layout'
import { GRID } from '../../sketch/model'
import { useSketchStore, type LayoutPatch } from '../../sketch/sketchStore'
import { useCanvasStore } from '../../store/canvasStore'
import { toCanvasFile } from '../persistence/canvasFile'

/** The canvas as the browser holds it now, unsaved edits included. Not validated here: the route does that. */
export function currentDoc(): CanvasDoc {
  const { viewport, windows, canvasName } = useCanvasStore.getState()
  const { nodes, edges } = useSketchStore.getState()
  return toCanvasFile(
    { viewport, windows, sketchNodes: nodes, edges },
    { name: canvasName ?? 'unsaved', profile: null, warehouseId: null },
  )
}

/** The grid size to judge against: the sketch's snap size while snapping is on, else none. */
export function currentGrid(): number | undefined {
  return useSketchStore.getState().snap ? GRID : undefined
}

/** Node and connector changes from a route, as the sketch store's patch. */
export function changesToPatch(changes: LayoutChange[]): LayoutPatch {
  const patch: LayoutPatch = { nodes: {}, edges: {} }
  for (const c of changes) {
    if (c.kind === 'node') {
      patch.nodes[c.id] = { position: { x: c.to.x, y: c.to.y }, size: { w: c.to.w, h: c.to.h } }
    } else {
      patch.edges[c.id] = { source_handle: c.to.source_handle, target_handle: c.to.target_handle } as LayoutPatch['edges'][string]
    }
  }
  return patch
}

/** Applies the changes as one undo step. Returns how many nodes and connectors changed. */
export function applyChanges(changes: LayoutChange[]): number {
  return useSketchStore.getState().applyLayout(changesToPatch(changes))
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** What to tell the person after a route's changes were applied. */
export function appliedNote(count: number, before: number, after: number): string {
  if (count === 0) return 'Nothing to change.'
  return `Changed ${plural(count, 'item')}; score ${before} to ${after}. Cmd/Ctrl+Z undoes it.`
}

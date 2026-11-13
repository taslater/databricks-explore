// Geometry for a maximized query window. Pure, so it can be tested without React Flow.

/** Gap kept around a maximized window, in screen pixels: room above for the canvas buttons, a margin elsewhere. */
export const MAX_INSET = { top: 54, side: 8, bottom: 8 }

export interface Frame {
  position: { x: number; y: number }
  size: { w: number; h: number }
}

/**
 * Where a maximized window sits, in canvas coordinates, so that it fills the visible canvas.
 * Only the node React Flow draws changes. The window in the store keeps its own position and size,
 * so restoring is just clearing `maximizedId` and nothing is saved with the maximized size.
 */
export function maximizedFrame(
  view: { x: number; y: number; zoom: number },
  box: { width: number; height: number },
): Frame {
  const z = view.zoom
  return {
    position: { x: (MAX_INSET.side - view.x) / z, y: (MAX_INSET.top - view.y) / z },
    size: {
      w: Math.max(0, box.width - 2 * MAX_INSET.side) / z,
      h: Math.max(0, box.height - MAX_INSET.top - MAX_INSET.bottom) / z,
    },
  }
}

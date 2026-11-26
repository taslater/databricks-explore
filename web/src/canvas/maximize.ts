// Geometry for a maximized query window. Pure, so it can be tested without React Flow.

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

/** Smallest gap kept around a maximized window, in screen pixels. Panels floating over the canvas widen it. */
export const MAX_INSET: Insets = { top: 8, right: 8, bottom: 8, left: 8 }

export interface Frame {
  position: { x: number; y: number }
  size: { w: number; h: number }
}

/**
 * Where a maximized window sits, in canvas coordinates, so that it fills the visible canvas inside `insets`
 * (the space floating panels cover). Only the node React Flow draws changes. The window in the store keeps its own
 * position and size, so restoring is just clearing `maximizedId` and nothing is saved with the maximized size.
 */
export function maximizedFrame(
  view: { x: number; y: number; zoom: number },
  box: { width: number; height: number },
  insets: Insets = MAX_INSET,
): Frame {
  const z = view.zoom
  return {
    position: { x: (insets.left - view.x) / z, y: (insets.top - view.y) / z },
    size: {
      w: Math.max(0, box.width - insets.left - insets.right) / z,
      h: Math.max(0, box.height - insets.top - insets.bottom) / z,
    },
  }
}

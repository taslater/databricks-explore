// Which windows the Delete key may remove. No React or store imports.
import type { CanvasWindow } from '../api/types'

type WindowContent = Pick<CanvasWindow, 'type' | 'text' | 'sql' | 'chart'>

/** True when a note has no text or a query window has no SQL and no chart: there is nothing in it to lose. */
export function isEmptyWindow(w: WindowContent): boolean {
  if (w.type === 'note') return (w.text ?? '').trim() === ''
  if (w.type === 'query') return (w.sql ?? '').trim() === '' && !w.chart
  return false
}

/**
 * True when Delete may remove the window. A table card can be fetched again, and an empty note or query window
 * holds nothing. A window with text or SQL keeps its X button, so one stray key cannot throw work away.
 */
export function isRemovableWindow(w: WindowContent): boolean {
  return w.type === 'table' || isEmptyWindow(w)
}

// A brief highlight on the text a run just sent, so it is clear what ran.
import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

const setFlash = StateEffect.define<Array<{ from: number; to: number }>>()
const flashMark = Decoration.mark({ class: 'cm-ran-flash' })

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        const marks: Range<Decoration>[] = e.value.filter((r) => r.to > r.from).map((r) => flashMark.range(r.from, r.to))
        next = Decoration.set(marks, true)
      }
    }
    return next
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** How long the highlight stays, in milliseconds. */
export const FLASH_MS = 700

/** The extension that draws the highlight. */
export const flashExtension: Extension = [
  flashField,
  EditorView.baseTheme({
    '.cm-ran-flash': { backgroundColor: 'var(--flash)', borderRadius: '2px' },
  }),
]

/** Highlights the ranges, then clears them after FLASH_MS. */
export function flashRanges(view: EditorView, ranges: Array<{ from: number; to: number }>) {
  const len = view.state.doc.length
  view.dispatch({ effects: setFlash.of(ranges.map((r) => ({ from: Math.min(r.from, len), to: Math.min(r.to, len) }))) })
  window.setTimeout(() => {
    // The view may have been destroyed (window deleted) before the timer fired.
    if (view.dom.isConnected) view.dispatch({ effects: setFlash.of([]) })
  }, FLASH_MS)
}

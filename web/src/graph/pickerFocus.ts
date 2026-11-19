// Keeping the picker's search box focused while the list is clicked, so a path can be typed straight through.

/** The part of an input this needs, so tests can pass a plain object. */
export interface FocusableInput {
  value: string
  focus: () => void
  setSelectionRange: (start: number, end: number) => void
}

/** For a row's `onMouseDown`: stops the click from moving focus off the search box (it does not stop the click itself). */
export function keepInputFocus(e: { preventDefault: () => void }): void {
  e.preventDefault()
}

/** Focuses the box and puts the caret after its text. Safe to call with no box. */
export function focusAtEnd(input: FocusableInput | null | undefined): void {
  if (!input) return
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}

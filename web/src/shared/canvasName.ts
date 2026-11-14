// Turns what a person types into a canvas name the server accepts: letters, digits, `_`, `.` and `-`.
// Case is kept ("Returns tour" becomes "Returns-tour").

/** Spaces and other characters the server refuses become `-`. Repeats collapse and `-` at either end is trimmed. */
export function toCanvasName(input: string): string {
  return input
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
}

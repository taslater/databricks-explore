// Pure helpers for `{{title}}` references between query windows. No React or store imports,
// so the store can use them and tests can call them directly.
import type { CanvasWindow } from '../../api/types'

/** The exact token a reference to `title` is written as in SQL. */
export function refToken(title: string): string {
  return `{{${title}}}`
}

/**
 * Replaces every exact `{{oldTitle}}` token in `sql` with `{{newTitle}}`.
 *
 * This is a plain text replacement. It does not parse SQL, so a token inside a string
 * literal or a comment is replaced too. Spaced forms such as `{{ old }}` are not replaced.
 */
export function replaceRefs(sql: string, oldTitle: string, newTitle: string): string {
  return sql.split(refToken(oldTitle)).join(refToken(newTitle))
}

/**
 * Returns the windows after window `id` is renamed to `newTitle`. Every other window whose
 * SQL contains `{{oldTitle}}` gets the token replaced. The window's own SQL is left alone.
 *
 * The caller checks that `newTitle` is unique. Windows that do not change keep their object
 * identity, and the result is a new array when anything changes.
 */
export function renameInWindows(windows: CanvasWindow[], id: string, newTitle: string): CanvasWindow[] {
  const target = windows.find((w) => w.id === id)
  if (target === undefined || target.title === newTitle) return windows
  const oldToken = refToken(target.title)
  return windows.map((w) => {
    if (w.id === id) return { ...w, title: newTitle }
    if (w.sql === undefined || !w.sql.includes(oldToken)) return w
    return { ...w, sql: replaceRefs(w.sql, target.title, newTitle) }
  })
}

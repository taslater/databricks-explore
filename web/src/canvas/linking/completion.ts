// `{{` autocomplete for window titles. Inside an open `{{` reference the popup shows only the
// titles of the other query windows. The SQL language's own sources (keywords and schema) are
// replaced by an override there, and they still run everywhere else.
import {
  autocompletion,
  type CompletionSource,
} from '@codemirror/autocomplete'
import {
  keywordCompletionSource,
  schemaCompletionSource,
  StandardSQL,
  type SQLConfig,
} from '@codemirror/lang-sql'
import type { Extension } from '@codemirror/state'
import { queryClient } from '../../api/queryClient'
import { useCanvasStore } from '../../store/canvasStore'
import { useUiStore } from '../../store/uiStore'
import { joinSource, joinTrigger } from './joinCompletion'

/** The part of CodeMirror's CompletionContext these sources use. */
type SourceContext = { matchBefore(expr: RegExp): { from: number; to: number; text: string } | null }

/** The part of EditorView that an apply function uses. */
interface EditView {
  state: { doc: { sliceString(from: number, to: number): string } }
  dispatch(spec: { changes: { from: number; to: number; insert: string }; selection: { anchor: number } }): void
}

/** An unfinished `{{` reference up to the cursor. Titles cannot contain braces, so the match stops at one. */
const OPEN_REF = /\{\{[^{}\n]*$/

/**
 * Completion source for a window with id `ownId`. Offers the titles of the other query
 * windows. Its own title is left out, since a self-reference is always a cycle. The window
 * list is read from the store on every call, so the options are never stale.
 */
export function windowTitleSource(ownId: string) {
  return (ctx: SourceContext) => {
    const open = ctx.matchBefore(OPEN_REF)
    if (open === null) return null
    const options = useCanvasStore
      .getState()
      .windows.filter((w) => w.type === 'query' && w.id !== ownId)
      .map((w) => ({ label: w.title, type: 'variable', detail: 'window', apply: applyTitle(w.title) }))
    if (options.length === 0) return null
    // Filtering starts after the two opening braces, so typed text matches the title itself.
    return { from: open.from + 2, options }
  }
}

/** Wraps a SQL source so that it returns nothing while the cursor is inside an open `{{`. */
function silentInRef(source: CompletionSource): CompletionSource {
  return (ctx) => (ctx.matchBefore(OPEN_REF) !== null ? null : source(ctx))
}

/**
 * The override source list: the window-title source first, then each SQL source made silent
 * inside `{{`. Inside a reference only window titles can come back. Outside one, the SQL
 * sources answer as before.
 */
export function refSources(ownId: string, sqlSources: CompletionSource[]): CompletionSource[] {
  return [windowTitleSource(ownId), ...sqlSources.map(silentInRef)]
}

/**
 * Autocomplete for a SQL editor in window `ownId`. `sqlConfig` must be the same config passed
 * to `sql()`, so the SQL sources here match the ones the language would have registered.
 * Uses CodeMirror's override mechanism: with an override set, the language data sources are
 * not consulted, so the override list above is the only completion source.
 * `remote` is the on-demand Unity Catalog name source, if any.
 */
export function windowRefCompletion(
  ownId: string,
  sqlConfig: SQLConfig,
  remote?: CompletionSource,
  joins: CompletionSource = joinSource(queryClient, () => useUiStore.getState().connectedProfile),
): Extension[] {
  const dialect = sqlConfig.dialect ?? StandardSQL
  const sqlSources: CompletionSource[] = [
    joins,
    schemaCompletionSource(sqlConfig),
    keywordCompletionSource(dialect, sqlConfig.upperCaseKeywords, sqlConfig.keywordCompletion),
    ...(remote ? [remote] : []),
  ]
  return [
    autocompletion({ override: refSources(ownId, sqlSources) }),
    joinTrigger(queryClient, () => useUiStore.getState().connectedProfile),
  ]
}

/**
 * Inserts `title}}` after the `{{` that is already in the text. If closeBrackets already put
 * `}}` after the cursor, that pair is replaced, so the result is exactly `{{title}}`.
 */
function applyTitle(title: string) {
  return (view: EditView, _completion: unknown, from: number, to: number) => {
    const end = view.state.doc.sliceString(to, to + 2) === '}}' ? to + 2 : to
    const insert = `${title}}}`
    view.dispatch({ changes: { from, to: end, insert }, selection: { anchor: from + insert.length } })
  }
}

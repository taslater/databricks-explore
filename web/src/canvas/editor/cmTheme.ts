// The SQL editor's theme: every colour is a design token (CSS variable), so one theme serves light and dark and follows the stylesheet.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--accent-strong)', fontWeight: 'var(--fw-strong)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--ok)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--orange)' },
  { tag: [t.lineComment, t.blockComment, t.comment], color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.function(t.variableName)], color: 'var(--purple)' },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--grey-700)' },
])

const base = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--surface)' },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--select-fill)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-pop)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--text)' },
  '.cm-completionDetail': { color: 'var(--muted)' },
})

/** The editor theme for the theme in force; dark also tells CodeMirror's own defaults (selection, cursor layers) which way to lean. */
export const cmTheme = (dark: boolean): Extension => [EditorView.theme({}, { dark }), base, syntaxHighlighting(highlight)]

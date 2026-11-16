// The right-click menu of a query window's editor: expand a *, run, copy. Shift+right-click keeps the browser's menu.
import { useCallback, useState, type MouseEvent, type MutableRefObject, type ReactNode } from 'react'
import type { EditorView } from '@codemirror/view'
import * as api from '../../api/client'
import { ContextMenu, wantsBrowserMenu, type MenuItem } from '../../shared/ContextMenu'
import { expansionChange, starAtCursor, starRequest } from './expandStar'

interface Options {
  viewRef: MutableRefObject<EditorView | null>
  /** Runs the selection or the statement at the cursor ('current'), or every statement ('all'). */
  run: (mode: 'current' | 'all') => void
  canRun: boolean
  /** Shows a line of text in the window's message line. */
  say: (text: string) => void
}

/** Replaces the `*` at `pos` with its columns, asking the server. Says why in the message line when it cannot. */
async function expandStarAt(view: EditorView, pos: number, say: (text: string) => void) {
  const doc = view.state.doc.toString()
  const request = starRequest(doc, pos)
  if (!request) {
    say('There is no statement here to expand.')
    return
  }
  try {
    const result = await api.expandStar({ sql: request.sql, offset: request.offset })
    // The user may have typed while the server worked; a range computed for older text would land in the wrong place.
    if (view.state.doc.toString() !== doc) {
      say('The statement changed before the * could be expanded. Try again.')
      return
    }
    view.dispatch({ changes: expansionChange(request, result) })
    view.focus()
    say(`Expanded * into ${result.count} column${result.count === 1 ? '' : 's'}.`)
  } catch (e) {
    say(e instanceof Error ? e.message : String(e))
  }
}

/** A handler for the editor's `onContextMenu`, and the menu to render (outside the editor) while one is open. */
export function useEditorMenu({ viewRef, run, canRun, say }: Options): {
  onContextMenu: (e: MouseEvent) => void
  menu: ReactNode
} {
  const [open, setOpen] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const close = useCallback(() => setOpen(null), [])

  const onContextMenu = (e: MouseEvent) => {
    const view = viewRef.current
    // A menu drawn from inside this subtree (React bubbles portal events) must not open another.
    if (!view || wantsBrowserMenu(e) || !e.currentTarget.contains(e.target as Node)) return
    e.preventDefault()
    // Like any editor, a right-click outside the selection moves the cursor there first.
    const clicked = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head
    const range = view.state.selection.main
    if (clicked < range.from || clicked > range.to) view.dispatch({ selection: { anchor: clicked } })
    const selection = view.state.selection.main
    const doc = view.state.doc.toString()
    const onStar = starAtCursor(doc, clicked)
    const items: MenuItem[] = [
      {
        kind: 'action',
        label: 'Expand * into columns',
        run: () => void expandStarAt(view, clicked, say),
        disabled: !onStar,
        title: onStar ? undefined : 'Right-click on a * or alias.* in a SELECT list',
      },
      { kind: 'separator' },
      {
        kind: 'action',
        label: selection.empty ? 'Run statement at cursor' : 'Run selection',
        run: () => run('current'),
        disabled: !canRun,
      },
      { kind: 'action', label: 'Run all statements', run: () => run('all'), disabled: !canRun },
      { kind: 'separator' },
      {
        kind: 'action',
        label: 'Copy',
        run: () => void navigator.clipboard?.writeText(doc.slice(selection.from, selection.to)).catch(() => {}),
        disabled: selection.empty,
      },
    ]
    setOpen({ x: e.clientX, y: e.clientY, items })
  }

  return { onContextMenu, menu: open ? <ContextMenu x={open.x} y={open.y} items={open.items} onClose={close} /> : null }
}

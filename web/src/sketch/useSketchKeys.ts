// Keyboard shortcuts for the sketch. One window listener, mounted by the host while its canvas is showing.
import { useEffect } from 'react'
import { GRID } from './model'
import { useSketchStore } from './sketchStore'
import type { Tool } from './types'

/** Letter to tool. Also the tooltip text in the palette. */
export const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  h: 'hand',
  c: 'connect',
  r: 'rect',
  u: 'rounded',
  o: 'ellipse',
  d: 'diamond',
  b: 'cylinder',
  t: 'text',
  s: 'sticky',
  f: 'frame',
  p: 'placeholder',
}

export function keyForTool(tool: Tool): string {
  return Object.entries(TOOL_KEYS).find(([, t]) => t === tool)?.[0].toUpperCase() ?? ''
}

/** True when the key press belongs to something that takes text or has its own shortcuts. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor, .ag-root, .qw-node, .react-flow__panel .canvas-toolbar') !== null
}

/**
 * Shortcuts: V select, H hand, C connect, R rectangle, U rounded rectangle, O ellipse, D diamond, B database,
 * T text, S sticky note, F frame, P placeholder table, G grid snap. Cmd/Ctrl: Z undo, Shift+Z or Y redo, C copy,
 * V paste, D duplicate, A select all, ] and [ forward and backward (with Shift: to front and back),
 * Shift+L lock. Delete removes, Esc deselects and returns to Select, arrows nudge (Shift for a grid step),
 * Enter or F2 edits the label. `extra` adds host shortcuts, keyed by lowercase letter (the Canvas adds Q and N).
 */
export function useSketchKeys(extra: Record<string, () => void> = {}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return
      const st = useSketchStore.getState()
      const mod = e.metaKey || e.ctrlKey
      const typing = isTypingTarget(e.target)

      if (e.key === 'Escape') {
        if (typing && st.editingId === null && st.editingEdgeId === null) return
        st.setTool('select')
        st.select([], [])
        return
      }
      if (typing) return
      // Leave text selection copies and the browser's own shortcuts alone when nothing in the sketch is selected.
      const hasSelection = st.selectedIds.length > 0 || st.selectedEdgeIds.length > 0

      if (mod) {
        const k = e.key.toLowerCase()
        if (k === 'z') {
          e.preventDefault()
          if (e.shiftKey) st.redo()
          else st.undo()
        } else if (k === 'y') {
          e.preventDefault()
          st.redo()
        } else if (k === 'c') {
          if (st.selectedIds.length === 0 || (window.getSelection()?.toString() ?? '') !== '') return
          e.preventDefault()
          st.copySelection()
        } else if (k === 'v') {
          if (!st.clipboard) return
          e.preventDefault()
          st.paste()
        } else if (k === 'd') {
          e.preventDefault()
          st.duplicate()
        } else if (k === 'a') {
          e.preventDefault()
          st.selectAll()
        } else if (e.code === 'BracketRight') {
          e.preventDefault()
          st.reorder(e.shiftKey ? 'front' : 'forward')
        } else if (e.code === 'BracketLeft') {
          e.preventDefault()
          st.reorder(e.shiftKey ? 'back' : 'backward')
        } else if (e.shiftKey && e.code === 'KeyL') {
          e.preventDefault()
          st.toggleLock()
        }
        return
      }
      if (e.altKey) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!hasSelection) return
        e.preventDefault()
        st.removeSelection()
        return
      }
      if (e.key.startsWith('Arrow')) {
        if (st.selectedIds.length === 0) return
        e.preventDefault()
        const step = e.shiftKey ? GRID : 1
        st.nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)
        return
      }
      if (e.key === 'Enter' || e.key === 'F2') {
        if (st.selectedEdgeIds.length === 1 && st.selectedIds.length === 0) {
          e.preventDefault()
          st.setEditingEdge(st.selectedEdgeIds[0])
        } else if (st.selectedIds.length === 1) {
          const n = st.nodes.find((x) => x.id === st.selectedIds[0])
          if (n && n.type !== 'placeholder' && !n.locked) {
            e.preventDefault()
            st.setEditing(n.id)
          }
        }
        return
      }
      if (e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k === 'g') {
        st.setSnap(!st.snap)
        return
      }
      const tool = TOOL_KEYS[k]
      if (tool) {
        e.preventDefault()
        st.setTool(tool)
        return
      }
      const fn = extra[k]
      if (fn) {
        e.preventDefault()
        fn()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [extra])
}

import { useEffect, useState, type ReactNode } from 'react'
import { SideHandles } from '../../sketch/nodes/SideHandles'
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react'
import Markdown, { type Components } from 'react-markdown'
import type { CanvasWindow } from '../../api/types'
import { titleError, useCanvasStore } from '../../store/canvasStore'

export type NoteFlowNode = Node<Record<string, unknown>, 'note'>

/**
 * Markdown note. Reads its window from the canvas store by id. The body renders as
 * Markdown, and Edit switches it to a textarea. Raw HTML in the text is not rendered
 * (react-markdown escapes it by default).
 */
export function NoteWindow({ id, selected }: NodeProps<NoteFlowNode>) {
  const win = useCanvasStore((s) => s.windows.find((w) => w.id === id))
  if (!win) return null
  return <NoteBody win={win} selected={selected} />
}

function NoteBody({ win, selected }: { win: CanvasWindow; selected: boolean }) {
  const id = win.id
  const collapsed = win.collapsed ?? false
  const text = win.text ?? ''
  const [editing, setEditing] = useState(false)
  const setText = useCanvasStore((s) => s.setText)
  const setCollapsed = useCanvasStore((s) => s.setCollapsed)
  const removeWindow = useCanvasStore((s) => s.removeWindow)
  const resizeWindow = useCanvasStore((s) => s.resizeWindow)

  return (
    <>
      <div className={`qw-node note-node${selected ? ' selected' : ''}`}>
        <NodeResizer
          isVisible={selected && !collapsed}
          minWidth={220}
          minHeight={120}
          onResize={(_, p) => resizeWindow(id, { x: p.x, y: p.y }, { w: p.width, h: p.height })}
        />

        <div className="qw-header">
          <button
            className="qw-icon nodrag"
            onClick={() => setCollapsed(id, !collapsed)}
            aria-label={collapsed ? 'Expand window' : 'Collapse window'}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? '▸' : '▾'}
          </button>
          <WindowTitle id={id} title={win.title} />
          {!collapsed && (
            <button
              className="qw-icon qw-text nodrag"
              onClick={() => setEditing((e) => !e)}
              aria-pressed={editing}
              title={editing ? 'Show the rendered Markdown' : 'Edit the Markdown'}
            >
              {editing ? 'Done' : 'Edit'}
            </button>
          )}
          <button
            className="qw-icon nodrag"
            onClick={() => removeWindow(id)}
            aria-label="Delete window"
            title="Delete window"
          >
            ✕
          </button>
        </div>

        {!collapsed && (
          <div className="note-body nodrag nowheel">
            {editing ? (
              <textarea
                className="note-editor"
                value={text}
                aria-label="Note text (Markdown)"
                placeholder="Write Markdown here"
                autoFocus
                onChange={(e) => setText(id, e.target.value)}
              />
            ) : (
              <div className="note-preview" onDoubleClick={() => setEditing(true)}>
                <NotePreview text={text} />
              </div>
            )}
          </div>
        )}
      </div>
      <SideHandles />
    </>
  )
}

const markdownComponents: Components = {
  // Links open in a new tab so the canvas stays put.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
}

function NotePreview({ text }: { text: string }): ReactNode {
  if (text.trim() === '') return <p className="hint">Empty note. Use Edit to write Markdown.</p>
  return <Markdown components={markdownComponents}>{text}</Markdown>
}

/**
 * Inline-editable title for note and table windows. Same rules as the query window title:
 * unique on the canvas, no braces, committed on blur or Enter, reverted on Escape.
 */
export function WindowTitle({ id, title }: { id: string; title: string }) {
  const windows = useCanvasStore((s) => s.windows)
  const renameWindow = useCanvasStore((s) => s.renameWindow)
  const [draft, setDraft] = useState(title)

  // Follow the store when the title changes from somewhere else (for example a canvas load).
  useEffect(() => setDraft(title), [title])

  const error = titleError(draft.trim(), windows, id)

  return (
    <div className="qw-title">
      <input
        className="qw-title-input nodrag"
        value={draft}
        aria-label="Window title"
        aria-invalid={error !== null}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => renameWindow(id, draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(title)
        }}
      />
      {error !== null && <div className="error qw-error">{error}</div>}
    </div>
  )
}

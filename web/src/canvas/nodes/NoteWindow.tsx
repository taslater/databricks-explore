import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SideHandles } from '../../sketch/nodes/SideHandles'
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CanvasWindow } from '../../api/types'
import { useCanvasStore } from '../../store/canvasStore'
import { WindowTitle } from './WindowTitle'

export type NoteFlowNode = Node<Record<string, unknown>, 'note'>

/**
 * Markdown note (GitHub-flavored, so tables work). Reads its window from the canvas store by id. The body renders as
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
  const editor = useRef<HTMLTextAreaElement>(null)
  const setText = useCanvasStore((s) => s.setText)
  const setCollapsed = useCanvasStore((s) => s.setCollapsed)
  const removeWindow = useCanvasStore((s) => s.removeWindow)
  const resizeWindow = useCanvasStore((s) => s.resizeWindow)

  // Focus the textarea with the cursor at the end as soon as it mounts. autoFocus alone loses to the focus
  // the node takes on click, and then the typing goes to the canvas shortcuts. Done again on the next frame,
  // after the click that opened it has finished.
  useEffect(() => {
    if (!editing) return
    function focusEnd() {
      const el = editor.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
    focusEnd()
    const raf = requestAnimationFrame(() => {
      if (editor.current && document.activeElement !== editor.current) focusEnd()
    })
    return () => cancelAnimationFrame(raf)
  }, [editing])

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
                ref={editor}
                className="note-editor"
                value={text}
                aria-label="Note text (Markdown)"
                placeholder="Write Markdown here"
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

// GitHub-flavored Markdown: tables, strikethrough, task lists and bare links.
const remarkPlugins = [remarkGfm]

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
  return <Markdown remarkPlugins={remarkPlugins} components={markdownComponents}>{text}</Markdown>
}

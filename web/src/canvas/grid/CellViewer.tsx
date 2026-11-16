import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { viewerCopyText, viewerText } from './actions'
import { writeClipboard } from './clipboard'
import type { Cell } from './columns'

/**
 * Small popover with one cell's full value as selectable text (JSON pretty-printed when it parses), opened by
 * double-clicking a cell. Drawn in a portal on the body for the same reason as CopyMenu: the canvas is scaled
 * and moved by CSS transforms. Esc or a click elsewhere closes it.
 */
export function CellViewer({
  x,
  y,
  title,
  value,
  onClose,
}: {
  x: number
  y: number
  title: string
  value: Cell
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [copied, setCopied] = useState<boolean | null>(null)

  // Keep it on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    })
  }, [x, y, value])

  useEffect(() => {
    ref.current?.focus()
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', esc, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', esc, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div ref={ref} className="qw-viewer" style={pos} role="dialog" aria-label={`Value of ${title}`} tabIndex={-1}>
      <div className="qw-viewer-head">
        <span className="qw-viewer-title">{title}</span>
        <button
          className="qw-viewer-copy"
          onClick={async () => setCopied(await writeClipboard(viewerCopyText(value)))}
        >
          {copied === null ? 'Copy' : copied ? 'Copied' : 'Copy failed'}
        </button>
      </div>
      <pre className={`qw-viewer-body qw-selectable${value === null ? ' qw-null' : ''}`}>{viewerText(value)}</pre>
    </div>,
    document.body,
  )
}

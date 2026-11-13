import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type MenuItem =
  | { kind: 'action'; label: string; run: () => void }
  | { kind: 'title'; label: string }
  | { kind: 'separator' }
  /** A format that can be copied with or without headers. */
  | { kind: 'format'; label: string; run: (headers: boolean) => void; headerLabel?: string }

/**
 * Floating menu at a screen position. Drawn in a portal on the body, because the canvas is scaled and moved
 * by CSS transforms, which would throw off fixed positioning from inside a window.
 */
export function CopyMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    })
  }, [x, y, items.length])

  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('contextmenu', away, true)
    document.addEventListener('keydown', esc, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('contextmenu', away, true)
      document.removeEventListener('keydown', esc, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div ref={ref} className="qw-menu" style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) => {
        if (item.kind === 'separator') return <div key={i} className="qw-menu-sep" role="separator" />
        if (item.kind === 'title') {
          return (
            <div key={i} className="qw-menu-title">
              {item.label}
            </div>
          )
        }
        if (item.kind === 'action') {
          return (
            <button
              key={i}
              className="qw-menu-item"
              role="menuitem"
              onClick={() => {
                item.run()
                onClose()
              }}
            >
              {item.label}
            </button>
          )
        }
        return (
          <div key={i} className="qw-menu-format" role="group" aria-label={item.label}>
            <span className="qw-menu-format-label">{item.label}</span>
            {[true, false].map((headers) => (
              <button
                key={String(headers)}
                className="qw-menu-item qw-menu-mini"
                role="menuitem"
                aria-label={`${item.label} ${headers ? 'with' : 'without'} headers`}
                onClick={() => {
                  item.run(headers)
                  onClose()
                }}
              >
                {headers ? (item.headerLabel ?? 'Headers') : 'No headers'}
              </button>
            ))}
          </div>
        )
      })}
    </div>,
    document.body,
  )
}

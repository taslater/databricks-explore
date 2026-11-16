// The shared right-click menu: a floating list at a screen position, with submenus, disabled items and keyboard navigation.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { isFocusable, NAV_START, navigate, type NavState } from './menuNav'

export type MenuItem =
  | { kind: 'action'; label: string; run: () => void; disabled?: boolean; title?: string }
  | { kind: 'title'; label: string }
  | { kind: 'separator' }
  /** A format that can be copied with or without headers. */
  | { kind: 'format'; label: string; run: (headers: boolean) => void; headerLabel?: string }
  /** An item that opens a list of more items to its right. */
  | { kind: 'submenu'; label: string; items: MenuItem[]; disabled?: boolean; title?: string }

/**
 * True when the right-click should get the browser's own menu: Shift held, as everywhere we add a menu.
 * Call it first in an `onContextMenu` handler and return without `preventDefault` when it is true.
 */
export function wantsBrowserMenu(e: { shiftKey: boolean }): boolean {
  return e.shiftKey
}

/**
 * Floating menu at a screen position. Drawn in a portal on the body, because the canvas is scaled and moved
 * by CSS transforms, which would throw off fixed positioning from inside a window.
 * Keys: Up/Down move, Right opens a submenu, Left closes it, Enter runs, Escape closes.
 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [nav, setNav] = useState<NavState>(NAV_START)
  const navRef = useRef(nav)
  navRef.current = nav
  const itemsRef = useRef(items)
  itemsRef.current = items

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
    const key = (e: KeyboardEvent) => {
      const result = navigate(itemsRef.current, navRef.current, e.key)
      if (!result) return
      e.preventDefault()
      e.stopPropagation()
      if ('close' in result) onClose()
      else if ('run' in result) {
        const item = result.run
        if (item.kind === 'action') item.run()
        else if (item.kind === 'format') item.run(true)
        onClose()
      } else setNav(result.state)
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('contextmenu', away, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('contextmenu', away, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  return createPortal(
    <div ref={ref} className="qw-menu" style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      <MenuList items={items} depth={0} nav={nav} setNav={setNav} onClose={onClose} />
    </div>,
    document.body,
  )
}

function MenuList({
  items,
  depth,
  nav,
  setNav,
  onClose,
}: {
  items: MenuItem[]
  depth: number
  nav: NavState
  setNav: (n: NavState) => void
  onClose: () => void
}) {
  // The path above this list is shared with everything above it.
  const above = nav.path.slice(0, depth)
  const point = (i: number, subOpen: boolean) => setNav({ path: [...above, i], subOpen })
  return (
    <>
      {items.map((item, i) => {
        const active = nav.path[depth] === i
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
              className={`qw-menu-item${active ? ' active' : ''}`}
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              onMouseEnter={() => isFocusable(item) && point(i, false)}
              onClick={() => {
                item.run()
                onClose()
              }}
            >
              {item.label}
            </button>
          )
        }
        if (item.kind === 'submenu') {
          const shown = !item.disabled && active && (depth < nav.path.length - 1 || nav.subOpen)
          return (
            <div key={i} className="qw-menu-sub">
              <button
                className={`qw-menu-item qw-menu-has-sub${active ? ' active' : ''}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={shown}
                disabled={item.disabled}
                title={item.title}
                onMouseEnter={() => isFocusable(item) && point(i, true)}
                onClick={() => !item.disabled && point(i, true)}
              >
                {item.label}
                <span className="qw-menu-arrow" aria-hidden="true">
                  ▸
                </span>
              </button>
              {shown && (
                <SubPanel>
                  <MenuList items={item.items} depth={depth + 1} nav={nav} setNav={setNav} onClose={onClose} />
                </SubPanel>
              )}
            </div>
          )
        }
        return (
          <div
            key={i}
            className={`qw-menu-format${active ? ' active' : ''}`}
            role="group"
            aria-label={item.label}
            onMouseEnter={() => point(i, false)}
          >
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
    </>
  )
}

/** A submenu panel beside its item. It opens to the left instead when the right side would leave the screen. */
function SubPanel({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [flip, setFlip] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.getBoundingClientRect().right > window.innerWidth - 4) setFlip(true)
  }, [])
  return (
    <div ref={ref} className={`qw-menu qw-menu-panel${flip ? ' flip' : ''}`} role="menu">
      {children}
    </div>
  )
}

// Keyboard navigation for the shared context menu, as pure functions so it can be tested without a DOM.
import type { MenuItem } from './ContextMenu'

/** Which item is highlighted at each open level, and whether the last one's submenu is showing without a highlight in it. */
export interface NavState {
  /** One index per level. Every level before the last has its submenu open. */
  path: number[]
  /** The last item is a submenu whose panel is showing (opened by pointing at it), with nothing highlighted inside. */
  subOpen: boolean
}

export const NAV_START: NavState = { path: [], subOpen: false }

/** What a key does: a new state, an item to run, or closing the menu. */
export type NavResult = { state: NavState } | { run: MenuItem } | { close: true } | null

/** An item the keyboard can land on. */
export function isFocusable(item: MenuItem): boolean {
  if (item.kind === 'title' || item.kind === 'separator') return false
  if (item.kind === 'action' || item.kind === 'submenu') return !item.disabled
  return true
}

/** The items of the list at `depth` along `path` (depth 0 is the root list). */
export function listAt(root: MenuItem[], path: number[], depth: number): MenuItem[] {
  let items = root
  for (let d = 0; d < depth; d++) {
    const item = items[path[d]]
    if (!item || item.kind !== 'submenu') return []
    items = item.items
  }
  return items
}

/** The next focusable index from `from` (-1 for none yet), wrapping at either end. -1 when nothing can be focused. */
export function stepIndex(items: MenuItem[], from: number, dir: 1 | -1): number {
  const n = items.length
  if (!items.some(isFocusable)) return -1
  let i = from
  for (let k = 0; k < n; k++) {
    i = i < 0 ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n
    if (isFocusable(items[i])) return i
  }
  return -1
}

/** Applies one key. Returns null for a key the menu does not use. */
export function navigate(root: MenuItem[], nav: NavState, key: string): NavResult {
  const depth = Math.max(0, nav.path.length - 1)
  const items = listAt(root, nav.path, depth)
  const current = nav.path.length ? items[nav.path[depth]] : undefined
  const at = (index: number): NavResult =>
    index < 0 ? null : { state: { path: [...nav.path.slice(0, depth), index], subOpen: false } }
  switch (key) {
    case 'Escape':
      return { close: true }
    case 'ArrowDown':
      return at(stepIndex(items, nav.path.length ? nav.path[depth] : -1, 1))
    case 'ArrowUp':
      return at(stepIndex(items, nav.path.length ? nav.path[depth] : -1, -1))
    case 'Home':
      return at(stepIndex(items, -1, 1))
    case 'End':
      return at(stepIndex(items, -1, -1))
    case 'ArrowRight':
    case 'Enter':
    case ' ': {
      if (!current || !isFocusable(current)) return null
      if (current.kind === 'submenu') {
        const first = current.items.findIndex(isFocusable)
        return first < 0 ? null : { state: { path: [...nav.path, first], subOpen: false } }
      }
      return key === 'ArrowRight' ? null : { run: current }
    }
    case 'ArrowLeft':
      return nav.path.length > 1 ? { state: { path: nav.path.slice(0, -1), subOpen: false } } : null
    default:
      return null
  }
}

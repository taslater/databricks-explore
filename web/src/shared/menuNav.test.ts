import { describe, expect, it } from 'vitest'
import type { MenuItem } from './ContextMenu'
import { NAV_START, navigate, stepIndex, type NavState } from './menuNav'

const noop = () => {}
const items: MenuItem[] = [
  { kind: 'title', label: 'T' },
  { kind: 'action', label: 'a', run: noop },
  { kind: 'action', label: 'off', run: noop, disabled: true },
  {
    kind: 'submenu',
    label: 'sub',
    items: [
      { kind: 'action', label: 'x', run: noop, disabled: true },
      { kind: 'action', label: 'y', run: noop },
    ],
  },
  { kind: 'separator' },
]

const state = (path: number[], subOpen = false): NavState => ({ path, subOpen })

describe('menu keyboard navigation', () => {
  it('moves down and up over items it can land on, wrapping', () => {
    expect(navigate(items, NAV_START, 'ArrowDown')).toEqual({ state: state([1]) })
    expect(navigate(items, state([1]), 'ArrowDown')).toEqual({ state: state([3]) })
    expect(navigate(items, state([3]), 'ArrowDown')).toEqual({ state: state([1]) })
    expect(navigate(items, NAV_START, 'ArrowUp')).toEqual({ state: state([3]) })
    expect(navigate(items, state([1]), 'ArrowUp')).toEqual({ state: state([3]) })
  })
  it('opens a submenu with Right and lands on its first usable item', () => {
    expect(navigate(items, state([3]), 'ArrowRight')).toEqual({ state: state([3, 1]) })
  })
  it('closes a submenu with Left', () => {
    expect(navigate(items, state([3, 1]), 'ArrowLeft')).toEqual({ state: state([3]) })
    expect(navigate(items, state([1]), 'ArrowLeft')).toBeNull()
  })
  it('stays inside the open submenu when moving', () => {
    expect(navigate(items, state([3, 1]), 'ArrowDown')).toEqual({ state: state([3, 1]) })
  })
  it('runs the highlighted action with Enter, and not a disabled one', () => {
    expect(navigate(items, state([1]), 'Enter')).toEqual({ run: items[1] })
    expect(navigate(items, state([2]), 'Enter')).toBeNull()
    expect(navigate(items, NAV_START, 'Enter')).toBeNull()
  })
  it('opens a submenu with Enter', () => {
    expect(navigate(items, state([3]), 'Enter')).toEqual({ state: state([3, 1]) })
  })
  it('closes on Escape and ignores other keys', () => {
    expect(navigate(items, NAV_START, 'Escape')).toEqual({ close: true })
    expect(navigate(items, NAV_START, 'a')).toBeNull()
  })
  it('finds nothing to step to when every item is disabled', () => {
    expect(stepIndex([{ kind: 'action', label: 'x', run: noop, disabled: true }], -1, 1)).toBe(-1)
  })
})

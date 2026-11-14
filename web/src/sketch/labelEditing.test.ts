import { describe, expect, it } from 'vitest'
import { isLabelable, newSketchNode } from './model'
import { createSketchStore } from './sketchStore'
import { isTypingEvent, isTypingTarget, labelSeed, TYPING_SELECTOR } from './useSketchKeys'
import type { SketchType } from './types'

const key = (k: string, extra: object = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...extra })
const el = (matches: boolean) => ({ closest: () => (matches ? {} : null) }) as unknown as EventTarget

describe('shortcut guard', () => {
  it('treats text fields, editors and grids as typing targets', () => {
    for (const part of ['input', 'textarea', 'select', 'contenteditable', '.cm-editor', '.ag-root', '.qw-node', '[role="textbox"]']) {
      expect(TYPING_SELECTOR).toContain(part)
    }
    expect(isTypingTarget(el(true))).toBe(true)
    expect(isTypingTarget(el(false))).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget({} as EventTarget)).toBe(false)
  })

  it('counts a key as typing when the focused element is a field, whatever the event target', () => {
    const body = el(false)
    expect(isTypingEvent({ target: body }, null)).toBe(false)
    expect(isTypingEvent({ target: body }, el(true) as unknown as Element)).toBe(true)
    expect(isTypingEvent({ target: el(true) }, null)).toBe(true)
  })
})

describe('label seed (typing on a selected node)', () => {
  const shape = newSketchNode('s1', 'shape', { x: 0, y: 0 }, { shape: 'rect' })
  const table = newSketchNode('s2', 'placeholder', { x: 0, y: 0 })
  const locked = { ...newSketchNode('s3', 'sticky', { x: 0, y: 0 }), locked: true }
  const nodes = [shape, table, locked]

  it('starts editing the only selected labelable node with the typed character', () => {
    expect(labelSeed(key('r'), nodes, ['s1'], [])).toEqual({ id: 's1', seed: 'r' })
    expect(labelSeed(key('R', { shiftKey: true }), nodes, ['s1'], [])).toEqual({ id: 's1', seed: 'R' })
    expect(labelSeed(key('='), nodes, ['s1'], [])).toEqual({ id: 's1', seed: '=' })
  })

  it('does nothing without exactly one labelable node', () => {
    expect(labelSeed(key('r'), nodes, [], [])).toBeNull()
    expect(labelSeed(key('r'), nodes, ['s1', 's2'], [])).toBeNull()
    expect(labelSeed(key('r'), nodes, ['s2'], [])).toBeNull()
    expect(labelSeed(key('r'), nodes, ['s3'], [])).toBeNull()
    expect(labelSeed(key('r'), nodes, ['missing'], [])).toBeNull()
    expect(labelSeed(key('r'), nodes, ['s1'], ['e1'])).toBeNull()
  })

  it('ignores shortcuts, navigation keys and space', () => {
    expect(labelSeed(key('c', { metaKey: true }), nodes, ['s1'], [])).toBeNull()
    expect(labelSeed(key('c', { ctrlKey: true }), nodes, ['s1'], [])).toBeNull()
    expect(labelSeed(key('x', { altKey: true }), nodes, ['s1'], [])).toBeNull()
    for (const k of ['Enter', 'Escape', 'Delete', 'ArrowLeft', 'Shift', 'F2', ' ']) expect(labelSeed(key(k), nodes, ['s1'], [])).toBeNull()
  })
})

describe('labelable nodes', () => {
  it('excludes placeholder tables and locked nodes', () => {
    expect(isLabelable({ type: 'shape' })).toBe(true)
    expect(isLabelable({ type: 'frame' })).toBe(true)
    expect(isLabelable({ type: 'placeholder' })).toBe(false)
    expect(isLabelable({ type: 'shape', locked: true })).toBe(false)
  })
})

describe('editing a new node', () => {
  const types: [SketchType, string | undefined][] = [
    ['shape', 'rect'],
    ['shape', 'rounded'],
    ['shape', 'ellipse'],
    ['shape', 'diamond'],
    ['shape', 'cylinder'],
    ['text', undefined],
    ['sticky', undefined],
    ['frame', undefined],
    ['placeholder', undefined],
  ]
  it.each(types)('opens the label of a new %s (%s) for typing', (type, shape) => {
    const store = createSketchStore()
    const id = store.getState().addNode(type, { x: 0, y: 0 }, { shape: shape as never })
    expect(store.getState().editingId).toBe(id)
    expect(store.getState().editingSeed).toBeNull()
    expect(store.getState().selectedIds).toEqual([id])
    expect(store.getState().tool).toBe('select')
  })

  it('opens a node placed by a tool, and carries the seed character', () => {
    const store = createSketchStore()
    const id = store.getState().placeTool('rect', { x: 10, y: 10 })
    expect(store.getState().editingId).toBe(id)
    store.getState().setEditing(null)
    store.getState().setEditing(id, 'q')
    expect(store.getState().editingSeed).toBe('q')
    store.getState().setEditing(id)
    expect(store.getState().editingSeed).toBeNull()
    store.getState().setEditing(id, 'q')
    store.getState().setEditing(null)
    expect(store.getState()).toMatchObject({ editingId: null, editingSeed: null })
  })

  it('ends editing when the tool changes', () => {
    const store = createSketchStore()
    store.getState().addNode('shape', { x: 0, y: 0 })
    store.getState().setTool('hand')
    expect(store.getState().editingId).toBeNull()
  })
})

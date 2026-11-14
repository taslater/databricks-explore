import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CanvasWindow } from '../../api/types'
import { useCanvasStore } from '../../store/canvasStore'
import { refSources, windowTitleSource } from './completion'
import { renameInWindows, replaceRefs } from './refs'

function win(id: string, title: string, sql?: string, type: CanvasWindow['type'] = 'query'): CanvasWindow {
  return { id, type, title, position: { x: 0, y: 0 }, size: { w: 100, h: 100 }, sql, collapsed: false }
}

describe('replaceRefs', () => {
  it('replaces every exact {{old}} token', () => {
    expect(replaceRefs('SELECT * FROM {{a}} JOIN {{a}}', 'a', 'b')).toBe('SELECT * FROM {{b}} JOIN {{b}}')
  })

  it('leaves near-miss tokens alone', () => {
    const sql = 'SELECT {{ a }}, {{ab}}, {a}, {{a}b}}'
    expect(replaceRefs(sql, 'a', 'b')).toBe('SELECT {{ a }}, {{ab}}, {a}, {{a}b}}')
  })

  it('treats the title literally, with no regex meaning', () => {
    expect(replaceRefs('SELECT * FROM {{x.y}} , {{xzy}}', 'x.y', 'z')).toBe('SELECT * FROM {{z}} , {{xzy}}')
  })
})

describe('renameInWindows', () => {
  it('updates other windows that reference the old title, and leaves the rest alone', () => {
    const a = win('w1', 'alpha', 'SELECT 1')
    const b = win('w2', 'beta', 'SELECT * FROM {{alpha}}')
    const c = win('w3', 'gamma', 'SELECT * FROM {{alpha}} UNION ALL SELECT * FROM {{alpha}}')
    const d = win('w4', 'delta', 'SELECT 2')
    const out = renameInWindows([a, b, c, d], 'w1', 'first')

    expect(out.map((w) => w.title)).toEqual(['first', 'beta', 'gamma', 'delta'])
    expect(out[1].sql).toBe('SELECT * FROM {{first}}')
    expect(out[2].sql).toBe('SELECT * FROM {{first}} UNION ALL SELECT * FROM {{first}}')
    expect(out[3]).toBe(d)
  })

  it('does not rewrite the renamed window own SQL', () => {
    const a = win('w1', 'alpha', 'SELECT * FROM {{alpha}}')
    expect(renameInWindows([a], 'w1', 'first')[0].sql).toBe('SELECT * FROM {{alpha}}')
  })

  it('skips non-query windows and windows with no sql', () => {
    const note = win('w2', 'notes', undefined, 'note')
    const q = win('w3', 'q', undefined)
    const out = renameInWindows([win('w1', 'alpha'), note, q], 'w1', 'first')
    expect(out[1]).toBe(note)
    expect(out[2]).toBe(q)
  })

  it('returns the same array when the title does not change', () => {
    const ws = [win('w1', 'alpha', 'SELECT * FROM {{alpha}}')]
    expect(renameInWindows(ws, 'w1', 'alpha')).toBe(ws)
  })
})

describe('renameWindow store action', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      windows: [win('w1', 'alpha', 'SELECT 1'), win('w2', 'beta', 'SELECT * FROM {{alpha}}')],
    })
  })

  it('rejects a duplicate title and changes nothing', () => {
    const before = useCanvasStore.getState().windows
    const err = useCanvasStore.getState().renameWindow('w2', 'alpha')
    expect(err).toMatch(/already named "alpha"/)
    expect(useCanvasStore.getState().windows).toBe(before)
  })

  it('renames the window and its references in one update', () => {
    const err = useCanvasStore.getState().renameWindow('w1', 'first')
    expect(err).toBeNull()
    const ws = useCanvasStore.getState().windows
    expect(ws[0].title).toBe('first')
    expect(ws[1].sql).toBe('SELECT * FROM {{first}}')
  })
})

/** Minimal stand-in for CodeMirror's CompletionContext over a plain string. */
function ctxAt(doc: string, pos: number): CompletionContext {
  const fake = {
    matchBefore(expr: RegExp) {
      const m = new RegExp(`(?:${expr.source})$`).exec(doc.slice(0, pos))
      if (m === null) return null
      return { from: pos - m[0].length, to: pos, text: m[0] }
    },
  }
  return fake as unknown as CompletionContext
}

type Option = { label: string; apply: (v: FakeView, c: unknown, from: number, to: number) => void }
type FakeView = {
  state: { doc: { sliceString(from: number, to: number): string } }
  dispatch(spec: { changes: { from: number; to: number; insert: string }; selection: { anchor: number } }): void
}

/** Runs a completion source at `pos`, returns its result, and runs an option's apply on a copy of `doc`. */
function complete(doc: string, pos: number) {
  const src = windowTitleSource('w1')
  return src(ctxAt(doc, pos)) as { from: number; options: Option[] } | null
}

function applyOption(doc: string, from: number, to: number, option: Option): { text: string; cursor: number } {
  let text = doc
  let cursor = -1
  const view: FakeView = {
    state: { doc: { sliceString: (a, b) => doc.slice(a, b) } },
    dispatch: (spec) => {
      const { from: f, to: t, insert } = spec.changes
      text = doc.slice(0, f) + insert + doc.slice(t)
      cursor = spec.selection.anchor
    },
  }
  option.apply(view, null, from, to)
  return { text, cursor }
}

describe('{{ completion source', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      windows: [win('w1', 'alpha', ''), win('w2', 'beta', ''), win('w3', 'notes', 'x', 'note')],
    })
  })

  it('does nothing without an open {{', () => {
    expect(complete('SELECT * FROM ', 14)).toBeNull()
    expect(complete('SELECT * FROM {{a}} ', 19)).toBeNull()
  })

  it('offers query window titles only, excluding the window own title', () => {
    const doc = 'SELECT * FROM {{'
    const res = complete(doc, doc.length)
    expect(res).not.toBeNull()
    expect(res!.options.map((o) => o.label)).toEqual(['beta'])
    expect(res!.from).toBe(doc.length)
  })

  it('inserts {{title}} and skips an auto-closed }} after the cursor', () => {
    const doc = 'SELECT * FROM {{}}'
    const res = complete(doc, 16)!
    const { text, cursor } = applyOption(doc, res.from, 16, res.options[0])
    expect(text).toBe('SELECT * FROM {{beta}}')
    expect(cursor).toBe(text.length)
  })

  it('inserts {{title}} when the user typed part of a title with no closing braces', () => {
    const doc = 'SELECT * FROM {{be'
    const res = complete(doc, doc.length)!
    expect(res.from).toBe(16)
    const { text } = applyOption(doc, res.from, doc.length, res.options[0])
    expect(text).toBe('SELECT * FROM {{beta}}')
  })
})

describe('{{ override with the SQL sources', () => {
  /** Stand-ins for lang-sql's keyword and schema sources. They always have something to offer. */
  const sqlSources: CompletionSource[] = [
    () => ({ from: 0, options: [{ label: 'SELECT', type: 'keyword' }] }),
    () => ({ from: 0, options: [{ label: 'orders', type: 'variable' }] }),
  ]

  /** Runs every override source at `pos` and returns the labels of all options that come back. */
  function labelsAt(doc: string, pos: number): string[] {
    const ctx = ctxAt(doc, pos)
    return refSources('w1', sqlSources).flatMap((src) => {
      const res = src(ctx) as CompletionResult | null
      return res ? res.options.map((o) => o.label) : []
    })
  }

  beforeEach(() => {
    useCanvasStore.setState({
      windows: [win('w1', 'alpha', ''), win('w2', 'beta', ''), win('w3', 'notes', 'x', 'note')],
    })
  })

  it('inside an open {{ only other query window titles come back', () => {
    expect(labelsAt('SELECT * FROM {{', 16)).toEqual(['beta'])
    expect(labelsAt('SELECT * FROM {{be', 18)).toEqual(['beta'])
  })

  it('inside an open {{ with no other query window, nothing comes back, not the SQL sources', () => {
    useCanvasStore.setState({ windows: [win('w1', 'alpha', '')] })
    expect(labelsAt('SELECT * FROM {{', 16)).toEqual([])
  })

  it('outside {{ the SQL sources answer as before', () => {
    expect(labelsAt('SELECT ', 7)).toEqual(['SELECT', 'orders'])
    expect(labelsAt('SELECT * FROM {{a}} ', 19)).toEqual(['SELECT', 'orders'])
  })
})

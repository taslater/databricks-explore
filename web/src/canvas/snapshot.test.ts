import { describe, expect, it } from 'vitest'
import type { CanvasWindow, QueryResult } from '../api/types'
import { fromCanvasFile, parseCanvasFile, toCanvasFile } from './persistence/canvasFile'
import {
  MAX_RESULT_BYTES,
  MAX_RESULT_ROWS,
  buildSnapshot,
  firstSave,
  freshness,
  referencedWindows,
  relativeTime,
  snapshotLine,
  snapshotResult,
  statementsOf,
} from './snapshot'
import { useCanvasStore } from '../store/canvasStore'

function result(rows: (string | null)[][], extra: Partial<QueryResult> = {}): QueryResult {
  return {
    statement_id: 'st-1',
    columns: [
      { name: 'day', type: 'DATE', type_text: 'date' },
      { name: 'hours', type: 'DECIMAL' },
    ],
    rows,
    row_count: rows.length,
    truncated: false,
    ms: 12,
    ...extra,
  }
}

const ran = new Date('2026-11-14T10:00:05.123Z')

describe('buildSnapshot', () => {
  it('keeps the columns, the rows and the hash, and stamps the time without milliseconds', () => {
    const snap = buildSnapshot(result([['2026-11-02', '8.5'], ['2026-11-03', null]]), 'abc123', ran)
    expect(snap).toEqual({
      columns: [
        { name: 'day', type: 'DATE', type_text: 'date' },
        { name: 'hours', type: 'DECIMAL' },
      ],
      rows: [['2026-11-02', '8.5'], ['2026-11-03', null]],
      row_count: 2,
      truncated: false,
      ran_at: '2026-11-14T10:00:05Z',
      sql_hash: 'abc123',
    })
  })

  it('caps the rows at 500 and says it was truncated', () => {
    const rows = Array.from({ length: 1200 }, (_, i) => [String(i), '1'])
    const snap = buildSnapshot(result(rows), 'h', ran)
    expect(snap.rows).toHaveLength(MAX_RESULT_ROWS)
    expect(snap.row_count).toBe(1200)
    expect(snap.truncated).toBe(true)
  })

  it('caps the size and says it was truncated', () => {
    const rows = Array.from({ length: 200 }, () => ['x'.repeat(5000), '1'])
    const snap = buildSnapshot(result(rows), 'h', ran)
    expect(snap.rows.length).toBeGreaterThan(0)
    expect(snap.rows.length).toBeLessThan(200)
    expect(new TextEncoder().encode(JSON.stringify(snap.rows)).length).toBeLessThanOrEqual(MAX_RESULT_BYTES)
    expect(snap.truncated).toBe(true)
  })

  it('keeps truncated when the run itself was cut at its row limit', () => {
    expect(buildSnapshot(result([['a', '1']], { truncated: true }), 'h', ran).truncated).toBe(true)
    expect(buildSnapshot(result([['a', '1']], { truncated: null }), 'h', ran).truncated).toBe(false)
  })

  it('turns back into a result the grid and chart can show', () => {
    const snap = buildSnapshot(result([['2026-11-02', '8.5']]), 'h', ran)
    const shown = snapshotResult(snap)
    expect(shown.rows).toEqual(snap.rows)
    expect(shown.columns).toEqual(snap.columns)
    expect(shown.row_count).toBe(1)
    expect(shown.statement_id).toBe(snapshotResult(snap).statement_id) // stable, so the grid is not rebuilt
  })
})

describe('the snapshot in the canvas file', () => {
  const win: CanvasWindow = {
    id: 'w1',
    type: 'query',
    title: 'daily',
    position: { x: 0, y: 0 },
    size: { w: 500, h: 300 },
    sql: 'SELECT 1',
    collapsed: false,
    view: 'chart',
    chart: { vega_lite: { mark: 'bar', encoding: {} } },
    result: buildSnapshot(result([['2026-11-02', '8.5']]), 'h1', ran),
  }

  it('survives save and load, view included', () => {
    const file = toCanvasFile({ viewport: { x: 0, y: 0, zoom: 1 }, windows: [win] }, { name: 'c', profile: null, warehouseId: null })
    const restored = fromCanvasFile(parseCanvasFile(JSON.parse(JSON.stringify(file))))
    expect(restored.windows).toEqual([win])
  })

  it('is refused above 500 rows', () => {
    const big = { ...win.result!, rows: Array.from({ length: 501 }, () => ['a', 'b']) }
    const file = toCanvasFile({ viewport: { x: 0, y: 0, zoom: 1 }, windows: [{ ...win, result: big }] }, { name: 'c', profile: null, warehouseId: null })
    expect(() => parseCanvasFile(JSON.parse(JSON.stringify(file)))).toThrow(/windows\[0\]\.result\.rows/)
  })

  it('is refused with an unknown view', () => {
    const file = toCanvasFile({ viewport: { x: 0, y: 0, zoom: 1 }, windows: [{ ...win, view: 'map' as never }] }, { name: 'c', profile: null, warehouseId: null })
    expect(() => parseCanvasFile(JSON.parse(JSON.stringify(file)))).toThrow(/view/)
  })

  it('leaves a window without a result or view exactly as it was', () => {
    const plain: CanvasWindow = { id: 'w2', type: 'query', title: 'p', position: { x: 0, y: 0 }, size: { w: 5, h: 5 }, sql: 'SELECT 1', collapsed: false }
    const file = toCanvasFile({ viewport: { x: 0, y: 0, zoom: 1 }, windows: [plain] }, { name: 'c', profile: null, warehouseId: null })
    expect(file.windows[0]).not.toHaveProperty('result')
    expect(file.windows[0]).not.toHaveProperty('view')
  })
})

describe('freshness', () => {
  const snap = buildSnapshot(result([]), 'h1', ran)

  it('is fresh when a statement of the current SQL hashes to the saved hash', () => {
    expect(freshness(snap, ['h0', 'h1'])).toBe('fresh')
  })

  it('is stale when none does, and when the SQL cannot be expanded any more', () => {
    expect(freshness(snap, ['h2'])).toBe('stale')
    expect(freshness(snap, [null])).toBe('stale')
    expect(freshness(snap, [])).toBe('stale')
  })

  it('is unknown while the hashes are not in', () => {
    expect(freshness(snap, undefined)).toBe('unknown')
  })
})

describe('snapshotLine and relativeTime', () => {
  const t0 = Date.parse('2026-11-14T10:00:00Z')

  it('says how long ago', () => {
    expect(relativeTime('2026-11-14T09:59:50Z', t0)).toBe('just now')
    expect(relativeTime('2026-11-14T09:55:00Z', t0)).toBe('5 minutes ago')
    expect(relativeTime('2026-11-14T09:59:00Z', t0)).toBe('1 minute ago')
    expect(relativeTime('2026-11-14T07:00:00Z', t0)).toBe('3 hours ago')
    expect(relativeTime('2026-11-12T10:00:00Z', t0)).toBe('2 days ago')
    expect(relativeTime('2026-09-01T10:00:00Z', t0)).toBe('on 2026-09-01')
    expect(relativeTime('nonsense', t0)).toBe('an unknown time ago')
    expect(relativeTime('2026-11-14T10:05:00Z', t0)).toBe('just now') // a clock a little ahead is not "in the future"
  })

  it('tells a reader how to refresh, and says loudly when the SQL changed', () => {
    const snap = buildSnapshot(result([['a', '1']]), 'h', new Date('2026-11-14T09:55:00Z'))
    expect(snapshotLine(snap, 'fresh', t0)).toBe('Result from 5 minutes ago, 1 row · Run to refresh')
    expect(snapshotLine(snap, 'unknown', t0)).toBe('Result from 5 minutes ago, 1 row · Run to refresh')
    expect(snapshotLine(snap, 'stale', t0)).toBe('Result from 5 minutes ago, 1 row. The SQL has changed since. Run to refresh.')
  })

  it('names the cut when the saved rows are a part', () => {
    const snap = buildSnapshot(result(Array.from({ length: 600 }, (_, i) => [String(i), '1'])), 'h', new Date('2026-11-14T09:55:00Z'))
    expect(snapshotLine(snap, 'fresh', t0)).toContain('first 500 of 600 rows')
  })
})

describe('statementsOf and referencedWindows', () => {
  it('splits a window into the statements a run of all of it would send', () => {
    expect(statementsOf('SELECT 1;\nSELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(statementsOf('')).toEqual([])
  })

  const q = (id: string, title: string, sql: string): CanvasWindow => ({
    id, type: 'query', title, position: { x: 0, y: 0 }, size: { w: 1, h: 1 }, sql, collapsed: false,
  })

  it('follows references through other windows, and ignores unknown titles and cycles', () => {
    const ws = [q('a', 'a', 'SELECT * FROM {{b}}'), q('b', 'b', 'SELECT * FROM {{c}} JOIN {{ghost}}'), q('c', 'c', 'SELECT 1'), q('d', 'd', 'SELECT 2')]
    expect(referencedWindows('SELECT * FROM {{ a }}', ws)).toEqual({ a: ws[0].sql, b: ws[1].sql, c: 'SELECT 1' })
    const loop = [q('x', 'x', '{{y}}'), q('y', 'y', '{{x}}')]
    expect(Object.keys(referencedWindows('{{x}}', loop)).sort()).toEqual(['x', 'y'])
    expect(referencedWindows('SELECT 1', ws)).toEqual({})
  })
})

describe('firstSave', () => {
  it('is true once per statement id', () => {
    expect(firstSave('stmt-a')).toBe(true)
    expect(firstSave('stmt-a')).toBe(false)
    expect(firstSave('stmt-b')).toBe(true)
  })
})

describe('the saved view and result in the canvas store', () => {
  it('setView saves a chart choice and writes nothing for the default tab, setResult keeps the snapshot', () => {
    const base: CanvasWindow = { id: 'w1', type: 'query', title: 't', position: { x: 0, y: 0 }, size: { w: 1, h: 1 }, sql: 'SELECT 1', collapsed: false }
    useCanvasStore.setState({ windows: [base] })
    useCanvasStore.getState().setView('w1', 'results')
    expect(useCanvasStore.getState().windows[0]).not.toHaveProperty('view')
    useCanvasStore.getState().setView('w1', 'chart')
    expect(useCanvasStore.getState().windows[0].view).toBe('chart')
    const snap = buildSnapshot(result([['a', '1']]), 'h', ran)
    useCanvasStore.getState().setResult('w1', snap)
    expect(useCanvasStore.getState().windows[0].result).toEqual(snap)
    useCanvasStore.setState({ windows: [] })
  })
})

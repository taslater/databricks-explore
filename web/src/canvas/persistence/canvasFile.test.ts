import { describe, expect, it } from 'vitest'
import type { CanvasWindow } from '../../api/types'
import { fromCanvasFile, parseCanvasFile, toCanvasFile } from './canvasFile'

const meta = { name: 'hours', profile: 'dev', warehouseId: null }
const viewport = { x: 10, y: -4, zoom: 0.8 }

const windows: CanvasWindow[] = [
  {
    id: 'w1',
    type: 'query',
    title: 'daily_hours',
    position: { x: 0, y: 0 },
    size: { w: 520, h: 360 },
    sql: 'SELECT day, hours FROM main.default.hours',
    collapsed: false,
  },
  {
    id: 'w2',
    type: 'note',
    title: 'note',
    position: { x: 560, y: 0 },
    size: { w: 320, h: 220 },
    text: '# Plan\n\n- check `daily_hours`\n\n<b>raw html</b>',
    collapsed: true,
  },
  {
    id: 'w3',
    type: 'table',
    title: 'orders',
    position: { x: 0, y: 420 },
    size: { w: 320, h: 300 },
    table: 'main.sales.orders',
    collapsed: false,
  },
]

/** Store state to the file, through JSON text and validation, and back to store fields. */
function roundTrip(input: CanvasWindow[]) {
  const file = toCanvasFile({ viewport, windows: input }, meta)
  const parsed = parseCanvasFile(JSON.parse(JSON.stringify(file)))
  return { file, restored: fromCanvasFile(parsed) }
}

describe('canvas file round trip with note and table windows', () => {
  it('restores note and table windows unchanged', () => {
    const { restored } = roundTrip(windows)
    expect(restored.windows).toEqual(windows)
    expect(restored.canvasName).toBe('hours')
    expect(restored.viewport).toEqual(viewport)
  })

  it('writes only the fields each window type owns', () => {
    const { file } = roundTrip(windows)
    const [query, note, table] = file.windows
    expect(query).not.toHaveProperty('text')
    expect(query).not.toHaveProperty('table')
    expect(note).toMatchObject({ type: 'note', text: windows[1].text, collapsed: true })
    expect(note).not.toHaveProperty('sql')
    expect(note).not.toHaveProperty('table')
    expect(table).toMatchObject({ type: 'table', table: 'main.sales.orders', collapsed: false })
    expect(table).not.toHaveProperty('text')
  })

  it('saves the editor split on a query window and omits it when unset', () => {
    const split: CanvasWindow[] = [{ ...windows[0], editor_split: 62.5 }, windows[2]]
    const { file, restored } = roundTrip(split)
    expect(file.windows[0]).toMatchObject({ editor_split: 62.5 })
    expect(file.windows[1]).not.toHaveProperty('editor_split')
    expect(restored.windows).toEqual(split)
  })

  it('rejects an editor split outside 0 to 100', () => {
    const base = toCanvasFile({ viewport, windows: [{ ...windows[0], editor_split: 40 }] }, meta)
    const bad = structuredClone(base)
    bad.windows[0].editor_split = 100
    expect(() => parseCanvasFile(bad)).toThrow(/editor_split/)
  })

  it('keeps an empty note body', () => {
    const empty: CanvasWindow[] = [{ ...windows[1], text: '' }]
    expect(roundTrip(empty).restored.windows).toEqual(empty)
  })

  it('rejects a note without text and a table without a name', () => {
    const base = toCanvasFile({ viewport, windows }, meta)
    const noText = structuredClone(base)
    delete noText.windows[1].text
    expect(() => parseCanvasFile(noText)).toThrow(/text/)

    const noTable = structuredClone(base)
    delete noTable.windows[2].table
    expect(() => parseCanvasFile(noTable)).toThrow(/table/)
  })
})

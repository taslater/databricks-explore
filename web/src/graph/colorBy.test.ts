import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { NodeMeta } from '../api/nodeMeta'
import { colorNodes, parseColorBy, tagKeys, typeLegend, valueColors, valueOf, withFills, type ColorInput } from './colorBy'
import { fromDiagram, toDiagramBody } from './diagram'
import { graphSignature } from './diagramSync'
import { NO_VALUE_FILL, OTHER_FILL, PALETTE, hashText, nodeFill } from './format'
import { ICON_LABEL, TypeIcon, iconKind } from './TypeIcon'
import type { FlowNode } from './types'

const input = (id: string, extra: Partial<ColorInput> = {}): ColorInput => ({ id, schema: id.split('.').slice(0, 2).join('.'), ...extra })
const meta = (owner: string | null, tags: Record<string, string> | null = null): NodeMeta => ({ owner, tags, tags_fetched_at: tags ? 't' : null })
const counts = (...values: string[]) => new Map(values.map((v) => [v, 1]))

describe('valueColors', () => {
  it('gives a value the same color whenever nothing collides with it, in any graph', () => {
    const alone = valueColors(counts('analytics')).fills.get('analytics')
    expect(alone).toBeDefined()
    expect(PALETTE).toContain(alone)
    expect(valueColors(counts('analytics')).fills.get('analytics')).toBe(alone) // and again: no randomness
    expect(hashText('analytics')).toBe(hashText('analytics'))
    expect(PALETTE[hashText('analytics') % PALETTE.length]).toBe(alone)
  })

  it('resolves collisions in sorted order, so the same set always gets the same colors', () => {
    // Find two values whose hashes name the same slot.
    const names = Array.from({ length: 200 }, (_, i) => `v${i}`)
    const a = names.find((n) => names.some((m) => m !== n && hashText(m) % 8 === hashText(n) % 8))!
    const b = names.find((m) => m !== a && hashText(m) % 8 === hashText(a) % 8)!
    const first = valueColors(counts(a, b)).fills
    const again = valueColors(counts(b, a)).fills // the order they arrive in does not matter
    expect([...first].sort()).toEqual([...again].sort())
    expect(first.get(a)).not.toBe(first.get(b))
    const [early, late] = [a, b].sort()
    expect(first.get(early)).toBe(PALETTE[hashText(early) % 8]) // the earlier name keeps its own slot
    expect(first.get(late)).toBe(PALETTE[(hashText(early) + 1) % 8])
  })

  it('colors the eight most common values and puts the rest in other', () => {
    const many = new Map(Array.from({ length: 11 }, (_, i) => [`s${String(i).padStart(2, '0')}`, 20 - i] as [string, number]))
    const { fills, other } = valueColors(many)
    expect(fills.size).toBe(8)
    expect(new Set(fills.values()).size).toBe(8) // eight distinct colors
    expect(other).toEqual(['s08', 's09', 's10']) // the three least common
    const tie = valueColors(new Map(Array.from({ length: 9 }, (_, i) => [`t${i}`, 1] as [string, number])))
    expect(tie.other).toEqual(['t8']) // ties go by name
  })
})

describe('colorNodes', () => {
  const nodes = [
    input('c.bronze.a'),
    input('c.bronze.b'),
    input('c.silver.c'),
    input('c.gold.d'),
    input('ph:new', { schema: 'placeholder' }),
    input('c.gold.gone', { missing: true }),
  ]

  it('colors by schema with a legend of the schemas present, and leaves nodes with no value white', () => {
    const { fills, legend } = colorNodes('schema', nodes, undefined)
    expect(legend.entries.map((e) => [e.value, e.count])).toEqual([['c.bronze', 2], ['c.gold', 1], ['c.silver', 1]])
    expect(fills.get('c.bronze.a')).toBe(fills.get('c.bronze.b'))
    expect(fills.get('c.bronze.a')).not.toBe(fills.get('c.silver.c'))
    expect(fills.get('ph:new')).toBe(NO_VALUE_FILL)
    expect(fills.get('c.gold.gone')).toBe(NO_VALUE_FILL)
    expect(legend.other).toBeNull()
    expect(colorNodes('catalog', nodes, undefined).legend.entries.map((e) => e.value)).toEqual(['c'])
  })

  it('lists only the values on screen and reads the owner without a warehouse', () => {
    const m = { 'c.bronze.a': meta('data-engineering'), 'c.silver.c': meta('analytics'), 'c.bronze.b': meta(null) }
    const { fills, legend } = colorNodes('owner', nodes.slice(0, 3), m)
    expect(legend.entries.map((e) => e.value)).toEqual(['analytics', 'data-engineering'])
    expect(fills.get('c.bronze.b')).toBe(NO_VALUE_FILL)
    const one = colorNodes('owner', [nodes[0]], m)
    expect(one.legend.entries.map((e) => e.value)).toEqual(['data-engineering'])
    // Alone, a value takes the slot its hash names. Beside a value that hashes to the same slot it may move on, so compare with one that does not collide.
    expect(one.legend.entries[0].fill).toBe(PALETTE[hashText('data-engineering') % PALETTE.length])
    const platform = { 'c.bronze.a': meta('platform'), 'c.silver.c': meta('finance') }
    expect(hashText('platform') % 8).not.toBe(hashText('finance') % 8)
    const both = colorNodes('owner', nodes.slice(0, 3), platform).legend.entries
    expect(colorNodes('owner', [nodes[2]], platform).legend.entries[0].fill).toBe(both.find((e) => e.value === 'finance')!.fill) // the same color in another graph
  })

  it('sends values beyond eight to the other bucket, in grey, and says how many', () => {
    const wide = Array.from({ length: 10 }, (_, i) => input(`c.s${i}.t`))
    const { fills, legend } = colorNodes('schema', wide, undefined)
    expect(legend.entries).toHaveLength(8)
    expect(legend.other).toEqual({ values: 2, count: 2 })
    expect([...fills.values()].filter((f) => f === OTHER_FILL)).toHaveLength(2)
  })

  it('colors by a tag value, treats a bare tag as set and an unread table as having none', () => {
    const m = { 'c.a.x': meta(null, { domain: 'sales' }), 'c.a.y': meta(null, { domain: 'ops', pii: '' }), 'c.a.z': meta(null, {}), 'c.a.w': meta(null) }
    const ns = ['x', 'y', 'z', 'w'].map((t) => input(`c.a.${t}`))
    expect(colorNodes('tag:domain', ns, m).legend.entries.map((e) => e.value)).toEqual(['ops', 'sales'])
    expect(colorNodes('tag:pii', ns, m).legend.entries.map((e) => e.value)).toEqual(['(set)'])
    expect(colorNodes('tag:domain', ns, m).fills.get('c.a.z')).toBe(NO_VALUE_FILL)
    expect(tagKeys({ ...m, 'c.a.v': meta(null, { 'system.certification_status': 'certified' }) })).toEqual(['domain', 'pii'])
  })

  it('uses fixed colors for certification and freshness, and only the values present', () => {
    const stats = (late: boolean, cadence: number | null) => ({ grain: null, stats: { late, cadence_seconds: cadence, last_write: { at: 'x' } } as never })
    const cert = colorNodes('certification', [input('c.a.x', { certification: 'certified' }), input('c.a.y', { certification: 'deprecated' }), input('c.a.z')], undefined)
    expect(cert.legend.entries.map((e) => e.value)).toEqual(['certified', 'deprecated'])
    expect(cert.fills.get('c.a.x')).not.toBe(cert.fills.get('c.a.y'))
    const fresh = colorNodes('freshness', [input('c.a.x', { facts: stats(true, 60) }), input('c.a.y', { facts: stats(false, 60) }), input('c.a.z', { facts: stats(false, null) }), input('c.a.w')], undefined)
    expect(fresh.legend.entries.map((e) => e.value)).toEqual(['late', 'on time'])
    expect(fresh.fills.get('c.a.z')).toBe(NO_VALUE_FILL) // no cadence: not known to be on time
    expect(valueOf('freshness', input('c.a.w'))).toBeNull()
  })
})

describe('typeLegend, withFills and parseColorBy', () => {
  it('lists the type fills present, and the objects that match none as other', () => {
    expect(typeLegend(['managed', 'table', 'view', 'metric_view', 'streaming_table']).map((e) => [e.value, e.count])).toEqual([['table', 2], ['view / MV', 2], ['streaming', 1]])
    expect(typeLegend(['view']).map((e) => e.value)).toEqual(['view / MV'])
    expect(typeLegend(['view'])[0].fill).toBe(nodeFill('view'))
    expect(typeLegend(['weird'])).toEqual([{ value: 'other', fill: nodeFill(''), count: 1 }])
  })

  it('adds a fill to the nodes it knows and leaves nodes alone without fills', () => {
    const ns = [{ id: 'a', data: { name: 'a' } }, { id: 'b', data: {} }]
    expect(withFills(ns, null)).toBe(ns)
    const out = withFills(ns, new Map([['a', '#fff']]))
    expect(out[0].data).toEqual({ name: 'a', fill: '#fff' })
    expect(out[1]).toBe(ns[1])
  })

  it('reads a saved color_by and falls back to type', () => {
    expect(['schema', 'tag:domain', 'type', 'owner', 'freshness'].map(parseColorBy)).toEqual(['schema', 'tag:domain', 'type', 'owner', 'freshness'])
    for (const bad of [undefined, null, 3, '', 'tag:', 'tag:  ', 'colour']) expect(parseColorBy(bad)).toBe('type')
  })
})

describe('saving', () => {
  const node = (id: string): FlowNode => ({ id, type: 'table', position: { x: 0, y: 0 }, data: { name: id, schema: 'c.s', kind: 'table', focus: false, selfRef: false } })

  it('writes color_by unless it is the default and reads it back', () => {
    const payload = { nodes: [node('c.s.t')], edges: [], focusSchema: 'c.s' }
    expect(toDiagramBody('g', payload)).not.toHaveProperty('color_by')
    expect(toDiagramBody('g', { ...payload, colorBy: 'type' })).not.toHaveProperty('color_by')
    const body = toDiagramBody('g', { ...payload, colorBy: 'tag:domain' })
    expect(body.color_by).toBe('tag:domain')
    expect(fromDiagram({ saved_at: 'now', ...body }).colorBy).toBe('tag:domain')
    expect(fromDiagram({ saved_at: 'now', ...toDiagramBody('g', payload) }).colorBy).toBe('type')
  })

  it('counts a change of what the fill means as a change of the page', () => {
    const base = graphSignature([node('a')], [], 's')
    expect(graphSignature([node('a')], [], 's', 'type')).toBe(base)
    expect(graphSignature([node('a')], [], 's', 'owner')).not.toBe(base)
  })
})

describe('TypeIcon', () => {
  it('names the kind: a view is not a table, whatever the fill', () => {
    expect(['managed', 'table', undefined, 'view', 'persisted_view', 'materialized_view', 'streaming_table', 'metric_view', 'external', 'foreign'].map((k) => iconKind(k))).toEqual([
      'table', 'table', 'table', 'view', 'view', 'materialized_view', 'streaming_table', 'metric_view', 'external', 'foreign',
    ])
    const html = (k: string) => renderToStaticMarkup(createElement(TypeIcon, { kind: k }))
    expect(html('view')).toContain('aria-label="view"')
    expect(html('materialized_view')).toContain('data-kind="materialized_view"')
    expect(new Set(Object.values(ICON_LABEL)).size).toBe(7)
    const shapes = new Set(['table', 'view', 'materialized_view', 'streaming_table', 'metric_view', 'external', 'foreign'].map(html))
    expect(shapes.size).toBe(7) // seven different pictures
  })
})

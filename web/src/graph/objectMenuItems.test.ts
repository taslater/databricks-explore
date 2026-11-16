import { describe, expect, it, vi } from 'vitest'
import type { MenuItem } from '../shared/ContextMenu'
import { objectMenuItems, type ObjectMenuDeps } from './objectMenuItems'

function deps(columns: () => Promise<string[]> = () => Promise.resolve(['id', 'name'])): ObjectMenuDeps {
  return {
    columns,
    openSql: vi.fn(),
    copy: vi.fn(),
    addCard: vi.fn(),
    addToGraph: vi.fn(),
    openInGraph: vi.fn(),
    fail: vi.fn(),
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

function find(items: MenuItem[], label: string): MenuItem {
  for (const item of items) {
    if ('label' in item && item.label === label) return item
    if (item.kind === 'submenu') {
      const inner = item.items.find((i) => 'label' in i && i.label === label)
      if (inner) return inner
    }
  }
  throw new Error(`no item ${label}`)
}

function run(item: MenuItem) {
  if (item.kind !== 'action') throw new Error('not an action')
  item.run()
}

describe('objectMenuItems', () => {
  it('opens a SELECT with explicit columns without running anything', async () => {
    const d = deps()
    run(find(objectMenuItems('dev.crm.t', 'MANAGED', d), 'SELECT … LIMIT 10 in new query window'))
    await flush()
    expect(d.openSql).toHaveBeenCalledWith('SELECT\n  id,\n  name\nFROM dev.crm.t\nLIMIT 10')
  })
  it('falls back to SELECT * and says so when the columns cannot be read', async () => {
    const d = deps(() => Promise.reject(new Error('nope')))
    run(find(objectMenuItems('dev.crm.t', null, d), 'SELECT'))
    await flush()
    expect(d.openSql).toHaveBeenCalledWith('SELECT\n  *\nFROM dev.crm.t\nLIMIT 10')
    expect(d.fail).toHaveBeenCalledWith(expect.stringContaining('nope'))
  })
  it('scripts DESCRIBE DETAIL for a table and disables it for a view', () => {
    const d = deps()
    run(find(objectMenuItems('a.b.t', 'EXTERNAL', d), 'DESCRIBE DETAIL'))
    expect(d.openSql).toHaveBeenCalledWith('DESCRIBE DETAIL a.b.t')
    const forView = objectMenuItems('a.b.v', 'VIEW', d)
    expect(find(forView, 'DESCRIBE HISTORY')).toMatchObject({ disabled: true })
    expect(find(forView, 'SHOW CREATE TABLE')).not.toMatchObject({ disabled: true })
  })
  it('copies the name, the column list and a SELECT', async () => {
    const d = deps()
    const items = objectMenuItems('a.b.t', null, d)
    run(find(items, 'Full name'))
    run(find(items, 'Column list'))
    run(find(items, 'SELECT statement'))
    await flush()
    expect(d.copy).toHaveBeenNthCalledWith(1, 'a.b.t')
    expect(d.copy).toHaveBeenNthCalledWith(2, 'id, name')
    expect(d.copy).toHaveBeenNthCalledWith(3, 'SELECT\n  id,\n  name\nFROM a.b.t\nLIMIT 10')
  })
  it('wires the card and graph actions', () => {
    const d = deps()
    const items = objectMenuItems('a.b.t', null, d)
    run(find(items, 'Add table card to canvas'))
    run(find(items, 'Add to graph'))
    run(find(items, 'Open in graph'))
    expect([d.addCard, d.addToGraph, d.openInGraph].map((f) => vi.mocked(f).mock.calls.length)).toEqual([1, 1, 1])
  })
})

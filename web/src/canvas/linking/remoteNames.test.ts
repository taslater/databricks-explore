import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../api/client'
import type { Cached } from '../../api/types'
import { buildSqlNamespace } from '../useSqlNamespace'
import { remoteNameSource } from './remoteNames'

vi.mock('../../api/client', () => ({
  getCatalogs: vi.fn(),
  getSchemas: vi.fn(),
  getObjects: vi.fn(),
}))

const PROFILE = 'dev-profile'

function cached<T>(data: T): Cached<T> {
  return { fetched_at: '2026-11-11T00:00:00Z', data }
}

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

type FakeView = {
  state: { doc: { sliceString(from: number, to: number): string } }
  dispatch(spec: { changes: { from: number; to: number; insert: string }; selection: { anchor: number } }): void
}
type ApplyFn = (view: FakeView, completion: unknown, from: number, to: number) => void

let qc: QueryClient

/** Runs the source with the cursor at the end of `doc`. */
async function run(doc: string, profile: string | null = PROFILE): Promise<CompletionResult | null> {
  return (await remoteNameSource(qc, profile)(ctxAt(doc, doc.length))) as CompletionResult | null
}

/** Applies the option with `label` the way CodeMirror would, and returns the new document. */
function applied(doc: string, res: CompletionResult | null, label: string): string {
  const opt = res?.options.find((o) => o.label === label)
  if (!res || !opt) throw new Error(`no option "${label}"`)
  let text = doc
  const view: FakeView = {
    state: { doc: { sliceString: (a, b) => doc.slice(a, b) } },
    dispatch: (spec) => {
      const { from, to, insert } = spec.changes
      text = doc.slice(0, from) + insert + doc.slice(to)
    },
  }
  const apply = opt.apply as unknown as ApplyFn
  apply(view, opt, res.from, doc.length)
  return text
}

beforeEach(() => {
  qc = new QueryClient()
  vi.mocked(api.getCatalogs).mockReset()
  vi.mocked(api.getSchemas).mockReset()
  vi.mocked(api.getObjects).mockReset()
})

describe('remoteNameSource', () => {
  it('a plain word with no dot returns null and makes no remote call', async () => {
    expect(await run('SELECT dev')).toBeNull()
    expect(api.getCatalogs).not.toHaveBeenCalled()
    expect(api.getSchemas).not.toHaveBeenCalled()
    expect(api.getObjects).not.toHaveBeenCalled()
  })

  it('returns null when no profile is connected', async () => {
    expect(await run('SELECT dev.', null)).toBeNull()
    expect(api.getSchemas).not.toHaveBeenCalled()
  })

  it('dev. lists the schemas of catalog dev and never fetches the catalog list', async () => {
    vi.mocked(api.getSchemas).mockResolvedValue(
      cached([
        { name: 'crm', comment: null },
        { name: 'sales', comment: null },
      ]),
    )
    const doc = 'SELECT dev.'
    const res = await run(doc)
    expect(api.getSchemas).toHaveBeenCalledWith('dev')
    expect(api.getCatalogs).not.toHaveBeenCalled()
    expect(res?.from).toBe(doc.length)
    expect(res?.options.map((o) => o.label)).toEqual(['crm', 'sales'])
    expect(res?.options[0].type).toBe('namespace')
  })

  it('dev.crm. lists the tables of dev.crm, and a partly typed name keeps the same level', async () => {
    vi.mocked(api.getObjects).mockResolvedValue(
      cached([
        { name: 'dim_customer', full_name: 'dev.crm.dim_customer', type: 'TABLE', comment: null },
        { name: 'fact_sales', full_name: 'dev.crm.fact_sales', type: 'VIEW', comment: null },
      ]),
    )
    const doc = 'SELECT * FROM dev.crm.dim_customer'
    const res = await run(doc)
    expect(api.getObjects).toHaveBeenCalledWith('dev', 'crm')
    expect(api.getSchemas).not.toHaveBeenCalled()
    expect(res?.from).toBe(doc.length - 'dim_customer'.length)
    expect(res?.options.map((o) => o.label)).toEqual(['dim_customer', 'fact_sales'])
    expect(res?.options[0].type).toBe('class')
    expect(res?.options[0].detail).toBe('TABLE')
  })

  it('a second call for a level already fetched makes no second fetch', async () => {
    vi.mocked(api.getObjects).mockResolvedValue(
      cached([{ name: 'dim', full_name: 'dev.crm.dim', type: 'TABLE', comment: null }]),
    )
    expect(await run('SELECT * FROM dev.crm.')).not.toBeNull()
    expect(await run('SELECT * FROM dev.crm.d')).toBeNull()
    expect(api.getObjects).toHaveBeenCalledTimes(1)
  })

  it('a level already in the cache is not fetched, and the namespace source lists it', async () => {
    qc.setQueryData(['schemas', PROFILE, 'dev'], cached([{ name: 'crm', comment: null }]))
    expect(await run('SELECT dev.')).toBeNull()
    expect(api.getSchemas).not.toHaveBeenCalled()
  })

  it('a name deeper than a table is left to the namespace source', async () => {
    expect(await run('SELECT dev.crm.dim.')).toBeNull()
    expect(api.getObjects).not.toHaveBeenCalled()
  })

  it('a name with a hyphen is inserted in backticks, not double quotes', async () => {
    vi.mocked(api.getSchemas).mockResolvedValue(
      cached([
        { name: 'my-schema', comment: null },
        { name: 'crm', comment: null },
      ]),
    )
    const doc = 'SELECT dev.'
    const res = await run(doc)
    expect(applied(doc, res, 'my-schema')).toBe('SELECT dev.`my-schema`')
    expect(applied(doc, res, 'crm')).toBe('SELECT dev.crm')
  })

  it('a backtick the user already typed is not doubled', async () => {
    vi.mocked(api.getSchemas).mockResolvedValue(cached([{ name: 'my-schema', comment: null }]))
    const doc = 'SELECT dev.`my-'
    const res = await run(doc)
    expect(res?.from).toBe(doc.length - 'my-'.length)
    expect(applied(doc, res, 'my-schema')).toBe('SELECT dev.`my-schema`')
  })

  it('a fetch error gives null, and the same level is not fetched again right away', async () => {
    vi.mocked(api.getSchemas).mockRejectedValue(new Error('catalog not found'))
    expect(await run('SELECT o.')).toBeNull()
    expect(await run('SELECT o.c')).toBeNull()
    expect(api.getSchemas).toHaveBeenCalledTimes(1)
  })
})

describe('buildSqlNamespace', () => {
  it('includes cached catalogs and schemas, with tables under them, for the connected profile only', () => {
    qc.setQueryData(
      ['catalogs', PROFILE],
      cached([
        { name: 'dev', type: null, comment: null },
        { name: 'prod', type: null, comment: null },
      ]),
    )
    qc.setQueryData(
      ['schemas', PROFILE, 'dev'],
      cached([
        { name: 'crm', comment: null },
        { name: 'sales', comment: null },
      ]),
    )
    qc.setQueryData(
      ['objects', PROFILE, 'dev', 'crm'],
      cached([{ name: 'dim', full_name: 'dev.crm.dim', type: 'TABLE', comment: null }]),
    )
    qc.setQueryData(['schemas', 'other-profile', 'x'], cached([{ name: 'y', comment: null }]))

    expect(buildSqlNamespace(qc, PROFILE)).toEqual({ dev: { crm: { dim: [] }, sales: {} }, prod: {} })
  })
})

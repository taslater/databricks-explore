// Writes a SELECT that joins tables along the relationships the app knows. Pure apart from `loadJoins`, which the
// caller supplies (the app reads GET /api/relationships/joins through the query cache).
import type { JoinKey, JoinsResponse } from '../api/types'
import { flipKey, rankKeys } from '../canvas/linking/joinKeys'
import { quoteName } from '../canvas/linking/sqlRefs'

export type LoadJoins = (table: string) => Promise<JoinsResponse['joins']>

/** One join of the plan: `table` joins `to`, on `key` (its columns read from `to`'s side first: `here` is `to`'s). */
export interface JoinStep {
  table: string
  to: string
  key: JoinKey
}

export type JoinPlan =
  | { ok: true; first: string; steps: JoinStep[]; added: string[] }
  | { ok: false; message: string }

/** How many tables are read while searching, and how many hops a path may take. */
export const MAX_LOADS = 30
export const MAX_HOPS = 4

const lower = (s: string) => s.toLowerCase()
const lastPart = (t: string) => t.split('.').pop() ?? t

/**
 * Plans the joins that connect `tables`. The first table starts the query. Each other table is joined along the
 * shortest chain of known relationships from the tables already in the query, adding the tables in between.
 * Nothing is guessed: when two tables have no chain of known relationships the plan says so.
 */
export async function planJoins(tables: readonly string[], loadJoins: LoadJoins): Promise<JoinPlan> {
  const wanted = tables.filter((t, i) => tables.findIndex((u) => lower(u) === lower(t)) === i)
  if (wanted.length === 0) return { ok: false, message: 'Select at least one table.' }
  if (wanted.length === 1) return { ok: true, first: wanted[0], steps: [], added: [] }

  // best[a][b]: the best key from a to b, columns read from a's side. Filled as tables are loaded, from either side.
  const best = new Map<string, Map<string, { name: string; key: JoinKey }>>()
  const names = new Map<string, string>()
  const loaded = new Set<string>()
  let loads = 0
  const setBest = (a: string, b: string, keys: JoinKey[]) => {
    const key = rankKeys(keys)[0]
    if (!key) return
    names.set(lower(a), a)
    names.set(lower(b), b)
    const row = best.get(lower(a)) ?? new Map()
    const old = row.get(lower(b))
    const merged = rankKeys(old ? [old.key, key] : [key])[0]
    row.set(lower(b), { name: b, key: merged })
    best.set(lower(a), row)
  }
  async function load(table: string): Promise<void> {
    if (loaded.has(lower(table)) || loads >= MAX_LOADS) return
    loaded.add(lower(table))
    loads++
    for (const j of await loadJoins(table)) {
      setBest(table, j.table, j.keys)
      if (lower(j.table) !== lower(table)) setBest(j.table, table, j.keys.map(flipKey))
    }
  }

  // Every asked table is read first: a foreign key is only visible from the table that declares it.
  for (const t of wanted) await load(t)
  const inQuery = new Map<string, string>([[lower(wanted[0]), wanted[0]]])
  const steps: JoinStep[] = []
  for (const target of wanted.slice(1)) {
    if (inQuery.has(lower(target))) continue
    // Breadth first from every table in the query at once, so the nearest one is used.
    const from = new Map<string, string | null>([...inQuery.keys()].map((k) => [k, null]))
    let frontier = [...inQuery.keys()]
    let found = false
    for (let hop = 0; hop < MAX_HOPS && !found && frontier.length > 0; hop++) {
      for (const t of frontier) await load(names.get(t) ?? inQuery.get(t) ?? t)
      const next: string[] = []
      for (const t of frontier) {
        for (const [other] of best.get(t) ?? []) {
          if (from.has(other)) continue
          from.set(other, t)
          next.push(other)
          if (other === lower(target)) found = true
        }
      }
      frontier = next
    }
    if (!found) {
      return {
        ok: false,
        message: `No known relationship path joins ${lastPart(target)} to ${[...inQuery.values()].map(lastPart).join(', ')}. Add a relationship or accept a suggested one first.`,
      }
    }
    const chain: string[] = []
    for (let t: string | null = lower(target); t !== null && !inQuery.has(t); t = from.get(t) ?? null) chain.unshift(t)
    for (const t of chain) {
      const parent = from.get(t)!
      const edge = best.get(parent)!.get(t)!
      const table = edge.name
      steps.push({ table, to: inQuery.get(parent)!, key: edge.key })
      inQuery.set(t, table)
    }
  }
  const asked = new Set(wanted.map(lower))
  return { ok: true, first: wanted[0], steps, added: steps.map((s) => s.table).filter((t) => !asked.has(lower(t))) }
}

const RESERVED = new Set([
  'as', 'at', 'by', 'in', 'is', 'on', 'or', 'to', 'of', 'if', 'no', 'not', 'and', 'all', 'any', 'asc', 'end', 'for',
  'int', 'key', 'row', 'set', 'top', 'use', 'any',
])

/** Short, distinct aliases: the initials of the name's words (`order_items` is `oi`), longer or numbered on a clash. */
export function aliasesFor(tables: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const table of tables) {
    const name = lastPart(table).toLowerCase()
    const words = name.split(/[^a-z0-9]+/).filter(Boolean)
    const initials = words.map((w) => w[0]).join('') || 't'
    const candidates = [initials, name.replace(/[^a-z0-9]/g, '').slice(0, 2), name.replace(/[^a-z0-9]/g, '').slice(0, 3)]
    let alias = candidates.find((c) => /^[a-z]/.test(c) && !used.has(c) && !RESERVED.has(c))
    for (let n = 2; !alias; n++) {
      const c = `${initials}${n}`
      if (!used.has(c)) alias = c
    }
    used.add(alias)
    out.set(lower(table), alias)
  }
  return out
}

/** The SQL for a plan: SELECT *, the first table, one JOIN per step with its key ANDed, and LIMIT 100. */
export function joinSql(plan: Extract<JoinPlan, { ok: true }>, limit = 100): string {
  const all = [plan.first, ...plan.steps.map((s) => s.table)]
  const alias = aliasesFor(all)
  const ref = (t: string) => `${t.split('.').map(quoteName).join('.')} ${alias.get(lower(t))}`
  const lines = ['SELECT *', `FROM ${ref(plan.first)}`]
  for (const s of plan.steps) {
    const left = alias.get(lower(s.to))!
    const right = alias.get(lower(s.table))!
    lines.push(`JOIN ${ref(s.table)}`)
    s.key.pairs.forEach((p, i) =>
      lines.push(`  ${i === 0 ? 'ON' : 'AND'} ${left}.${quoteName(p.here)} = ${right}.${quoteName(p.there)}`),
    )
  }
  lines.push(`LIMIT ${limit}`)
  return lines.join('\n')
}

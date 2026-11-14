// Join-aware completion for the query editor: after `ON`, the conditions the app knows between the tables already
// in the statement and the one just joined; in `USING (`, the shared columns; after `JOIN`, tables known to join
// to the ones in FROM. The knowledge comes from GET /api/relationships/joins (foreign keys, mined joins that were
// not rejected, manual edges), cached per table in TanStack Query.
import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import { startCompletion } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import type { QueryClient } from '@tanstack/react-query'
import * as api from '../../api/client'
import { JOIN_KEYS_STALE_MS } from '../../api/hooks'
import type { Cached, JoinKey, JoinsResponse, ObjectSummary } from '../../api/types'
import { compareKeys, flipKey, keyDetail, rankKeys } from './joinKeys'
import {
  joinContext,
  quoteName,
  resolveRefs,
  statementBeforeCursor,
  type JoinContext,
  type ResolvedRef,
} from './sqlRefs'

export type JoinsOf = (table: string) => JoinsResponse['joins'] | undefined

export interface JoinOption {
  label: string
  detail: string
  boost: number
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const MAX_BOOST = 99
const boostFor = (index: number) => Math.max(-MAX_BOOST, MAX_BOOST - index)
const lastPart = (table: string) => table.split('.').pop() ?? table

interface Found {
  text: string
  key: JoinKey
}

/** Keys joining `left` to `right`, with columns read from `left`'s side. Both tables' answers are used. */
function keysBetween(left: string, right: string, joinsOf: JoinsOf): JoinKey[] {
  const fromLeft = joinsOf(left)?.find((j) => same(j.table, right))?.keys ?? []
  if (same(left, right)) return fromLeft
  const fromRight = (joinsOf(right)?.find((j) => same(j.table, left))?.keys ?? []).map(flipKey)
  return [...fromLeft, ...fromRight]
}

/** Join conditions for the table just joined (the last of `refs`) against each table before it, best first. */
function conditions(refs: readonly ResolvedRef[], joinsOf: JoinsOf, using: boolean): Found[] {
  const joined = refs[refs.length - 1]
  if (!joined?.table) return []
  const out: Found[] = []
  for (const left of refs.slice(0, -1)) {
    if (!left.table) continue
    for (const key of rankKeys(keysBetween(left.table, joined.table, joinsOf))) {
      if (using) {
        if (!key.pairs.every((p) => same(p.here, p.there))) continue
        out.push({ text: key.pairs.map((p) => quoteName(p.here)).join(', '), key })
      } else {
        const text = key.pairs
          .map((p) => `${quoteName(left.alias)}.${quoteName(p.here)} = ${quoteName(joined.alias)}.${quoteName(p.there)}`)
          .join(' AND ')
        out.push({ text, key })
      }
    }
  }
  return out
}

function ranked(found: Found[]): JoinOption[] {
  const seen = new Set<string>()
  return found
    .sort((a, b) => compareKeys(a.key, b.key))
    .filter((f) => !seen.has(f.text) && !!seen.add(f.text))
    .map((f, i) => ({ label: f.text, detail: keyDetail(f.key), boost: boostFor(i) }))
}

/** Tables known to join to those already in FROM, best join first. Tables already in the statement are left out. */
function joinableTables(refs: readonly ResolvedRef[], joinsOf: JoinsOf): JoinOption[] {
  const present = new Set(refs.map((r) => r.table?.toLowerCase()).filter((t): t is string => !!t))
  const best = new Map<string, { table: string; key: JoinKey; via: string }>()
  for (const ref of refs) {
    if (!ref.table) continue
    for (const j of joinsOf(ref.table) ?? []) {
      if (present.has(j.table.toLowerCase()) && !same(j.table, ref.table)) continue
      const key = rankKeys(j.keys)[0]
      if (!key) continue
      const old = best.get(j.table.toLowerCase())
      if (!old || compareKeys(key, old.key) < 0) best.set(j.table.toLowerCase(), { table: j.table, key, via: lastPart(ref.table) })
    }
  }
  return [...best.values()]
    .sort((a, b) => compareKeys(a.key, b.key) || a.table.localeCompare(b.table))
    .map((b, i) => ({
      label: b.table.split('.').map(quoteName).join('.'),
      detail: `${keyDetail(b.key)} · joins ${b.via}`,
      boost: boostFor(i),
    }))
}

/** The options for one cursor position. Pure: `joinsOf` says what is known about each table. */
export function joinOptions(ctx: JoinContext, refs: readonly ResolvedRef[], joinsOf: JoinsOf): JoinOption[] {
  if (ctx.spot === 'join') return joinableTables(refs, joinsOf)
  if (ctx.spot === 'on') return ranked(conditions(refs, joinsOf, false))
  const columns = ranked(conditions(refs, joinsOf, true))
  if (!ctx.afterComma) return columns
  // After a comma in `USING (a, `: one column at a time.
  const single = new Map<string, JoinOption>()
  for (const o of columns) for (const name of o.label.split(', ')) if (!single.has(name)) single.set(name, { ...o, label: name })
  return [...single.values()].map((o, i) => ({ ...o, boost: boostFor(i) }))
}

/** After a failed read, the same table is not asked again for this long, so typing does not call the API per key. */
const RETRY_AFTER_MS = 30_000

async function loadJoins(qc: QueryClient, profile: string, table: string): Promise<JoinsResponse | undefined> {
  const queryKey = ['joinKeys', profile, table]
  const state = qc.getQueryState(queryKey)
  if (state?.status === 'error' && Date.now() - state.errorUpdatedAt < RETRY_AFTER_MS) return undefined
  try {
    return await qc.fetchQuery({ queryKey, queryFn: () => api.getJoinKeys(table), staleTime: JOIN_KEYS_STALE_MS, retry: false })
  } catch {
    return undefined
  }
}

/** Table names the cache already knows, to settle short names in a statement. */
function cachedTables(qc: QueryClient, profile: string): string[] {
  return qc
    .getQueriesData<Cached<ObjectSummary[]>>({ queryKey: ['objects', profile] })
    .flatMap(([, cached]) => cached?.data.map((o) => o.full_name) ?? [])
}

const MAX_TABLES = 8

/** What to offer at `pos` in `doc`, or null when the cursor is not at a join. */
export async function joinCompletions(
  qc: QueryClient,
  profile: string | null,
  doc: string,
  pos: number,
): Promise<{ from: number; options: JoinOption[] } | null> {
  if (profile === null) return null
  const ctx = joinContext(statementBeforeCursor(doc, pos))
  if (!ctx) return null
  const refs = resolveRefs(ctx.refs, cachedTables(qc, profile))
  const tables = [...new Set(refs.flatMap((r) => (r.table ? [r.table] : [])))].slice(0, MAX_TABLES)
  const loaded = new Map<string, JoinsResponse['joins']>()
  await Promise.all(
    tables.map(async (t) => {
      const r = await loadJoins(qc, profile, t)
      if (r) loaded.set(t.toLowerCase(), r.joins)
    }),
  )
  const options = joinOptions(ctx, refs, (t) => loaded.get(t.toLowerCase()))
  return options.length > 0 ? { from: pos - ctx.typed.length, options } : null
}

const VALID_TYPED = /^[\w.`$]*$/

/** Completion source for join conditions, USING lists and joined tables. */
export function joinSource(qc: QueryClient, getProfile: () => string | null): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const found = await joinCompletions(qc, getProfile(), ctx.state.doc.toString(), ctx.pos)
    if (!found) return null
    return {
      from: found.from,
      validFor: VALID_TYPED,
      options: found.options.map((o) => ({ label: o.label, detail: o.detail, type: 'property', boost: o.boost })),
    }
  }
}

/** Text right before the cursor where a join suggestion should open without being asked: `ON `, `JOIN `, `USING (`. */
const OPENS = /(?:\b(?:ON|JOIN)\s|\bUSING\s*\(\s*|\bUSING\s*\([\w\s,`]*,\s*)$/i

/**
 * Opens the popup when the user types a space after `ON` or `JOIN`, or `(` after `USING`, but only if there is
 * something to offer: asking CodeMirror to open it with nothing from this source would list every keyword.
 */
export function joinTrigger(qc: QueryClient, getProfile: () => string | null) {
  return EditorView.updateListener.of((update) => {
    if (!update.docChanged || !update.transactions.some((t) => t.isUserEvent('input.type'))) return
    const pos = update.state.selection.main.head
    if (!OPENS.test(update.state.doc.sliceString(Math.max(0, pos - 80), pos))) return
    const doc = update.state.doc.toString()
    const view = update.view
    void joinCompletions(qc, getProfile(), doc, pos).then((found) => {
      if (found && view.state.selection.main.head === pos) startCompletion(view)
    })
  })
}

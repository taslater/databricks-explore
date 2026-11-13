// On-demand Unity Catalog names for a dotted name in the SQL editor. `dev.` lists the schemas
// of catalog `dev`, and `dev.crm.` lists the tables of `dev.crm`. Only the level being completed
// is fetched, and the result goes into the TanStack Query cache under the same keys the hooks use.
// A level already in the cache is left to the namespace source (useSqlNamespace), so a cached
// name is never listed twice.
import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import * as api from '../../api/client'
import type { Cached } from '../../api/types'

/** A dotted name up to the cursor. Each part is a plain word or a `backticked` name, so names with hyphens work. */
const DOTTED = /(?:(?:`[^`\n]+`|\w+)\.)+(?:`[^`\n]*`?|\w*)$/
/** What CodeMirror may keep typing into a result: a plain word, or the rest of a backticked name. */
const VALID_PLAIN = /^\w*$/
const VALID_QUOTED = /^[^`\n]*`?$/
const PLAIN_IDENT = /^[A-Za-z_][A-Za-z_0-9]*$/
/** After a failed fetch, the same level is not fetched again for this long. Without it, typing `o.col` (an alias) would call the API on every keystroke. */
const RETRY_AFTER_MS = 30_000

/** The part of a Unity Catalog name that these options need. Schemas and objects both have a `name`. */
interface Named {
  name: string
  type?: string | null
}

type EditView = { dispatch(spec: { changes: { from: number; to: number; insert: string }; selection: { anchor: number } }): void }

/**
 * Completion source for names after a dot. Returns null when the text is not a dotted name,
 * when the profile is not connected, when the level is already cached (the namespace source
 * lists it), when a recent fetch failed, and when the name is deeper than a table.
 */
export function remoteNameSource(qc: QueryClient, profile: string | null): CompletionSource {
  return (ctx: CompletionContext) => {
    if (profile === null) return null
    const match = ctx.matchBefore(DOTTED)
    if (match === null) return null

    const parts = match.text.split('.')
    const last = parts[parts.length - 1]
    // An opening backtick the user typed stays out of the filter text, so `my-` still matches `my-cat`.
    const typedOpen = last.startsWith('`')
    const from = match.to - last.length + (typedOpen ? 1 : 0)
    const path = parts.slice(0, -1).map(unquote)

    if (path.length === 1) {
      const [catalog] = path
      return listLevel(qc, ['schemas', profile, catalog], () => api.getSchemas(catalog), {
        from,
        typedOpen,
        kind: 'namespace',
        detail: 'schema',
      })
    }
    if (path.length === 2) {
      const [catalog, schema] = path
      return listLevel(qc, ['objects', profile, catalog, schema], () => api.getObjects(catalog, schema), {
        from,
        typedOpen,
        kind: 'class',
        detail: 'table',
      })
    }
    return null
  }
}

interface ListOptions {
  from: number
  typedOpen: boolean
  kind: 'namespace' | 'class'
  /** Shown when an item has no type of its own, for example a schema. */
  detail: string
}

async function listLevel(
  qc: QueryClient,
  key: QueryKey,
  load: () => Promise<Cached<Named[]>>,
  opts: ListOptions,
): Promise<CompletionResult | null> {
  const cached = await loadLevel(qc, key, load)
  if (cached === null || cached.data.length === 0) return null
  return {
    from: opts.from,
    validFor: opts.typedOpen ? VALID_QUOTED : VALID_PLAIN,
    options: cached.data.map((item) => ({
      label: item.name,
      type: opts.kind,
      detail: item.type ?? opts.detail,
      apply: applyName(item.name, opts.typedOpen),
    })),
  }
}

/**
 * Returns the cached level, fetching it when it is missing. Returns null (never throws) when
 * the level is already cached, when the last fetch failed recently, or when the fetch fails.
 */
async function loadLevel(
  qc: QueryClient,
  key: QueryKey,
  load: () => Promise<Cached<Named[]>>,
): Promise<Cached<Named[]> | null> {
  if (qc.getQueryData(key) !== undefined) return null
  const state = qc.getQueryState(key)
  if (state?.status === 'error' && Date.now() - state.errorUpdatedAt < RETRY_AFTER_MS) return null
  try {
    return await qc.ensureQueryData({ queryKey: key, queryFn: load, retry: false })
  } catch {
    return null
  }
}

/**
 * Inserts a name. A name that is not a plain identifier gets backticks, which Databricks SQL
 * uses for quoting (double quotes are string literals there). If the user already typed the
 * opening backtick, only the closing one is added.
 */
function applyName(name: string, typedOpen: boolean) {
  const escaped = name.replace(/`/g, '``')
  const insert = typedOpen ? `${escaped}\`` : PLAIN_IDENT.test(name) ? name : `\`${escaped}\``
  return (view: EditView, _completion: unknown, from: number, to: number) => {
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } })
  }
}

/** Removes the backticks around a quoted name. Names are otherwise used literally. */
function unquote(part: string): string {
  return part.replace(/^`|`$/g, '')
}

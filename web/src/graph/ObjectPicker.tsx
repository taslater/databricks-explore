// Object picker: Drill-down, Tree, and Search. Port of the three legacy modes in static/app.js.
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import * as api from '../api/client'
import { useCatalogs, useObjects, useSchemas, useSearch } from '../api/hooks'
import type { ObjectSummary } from '../api/types'
import { useUiStore, type PickMode } from '../store/uiStore'
import { messageOf, useGraphActions } from './actions'
import { shortType } from './format'
import { useGraphStore } from './graphStore'
import { tableDragProps } from '../shared/tableDrag'

const MODES: { id: PickMode; label: string }[] = [
  { id: 'drill', label: 'Drill-down' },
  { id: 'tree', label: 'Tree' },
  { id: 'search', label: 'Search' },
]

const matches = (name: string, filter: string) => name.toLowerCase().includes(filter)

/** Shift, Cmd or Ctrl on a click adds the object to the graph instead of starting a new one, as on the graph itself. */
const addsToGraph = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => e.shiftKey || e.metaKey || e.ctrlKey

/** Click opens the object as a new graph; with Shift, Cmd or Ctrl it is added to the graph on screen. */
type OpenHandler = (fullName: string, add: boolean) => void

function useOpenHandler(): OpenHandler {
  const actions = useGraphActions()
  return useCallback(
    (fullName: string, add: boolean) => {
      if (add) void actions.addObject(fullName)
      else actions.openObject(fullName)
    },
    [actions],
  )
}

/** The row's "+" button: adds the object to the graph and keeps what is there. */
function AddButton({ fullName, onOpen }: { fullName: string; onOpen: OpenHandler }) {
  return (
    <button
      className="pick-add"
      title="Add to the graph, keeping what is there (or Shift-click the row)"
      aria-label={`Add ${fullName} to the graph`}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(fullName, true)
      }}
    >
      +
    </button>
  )
}

/** Mode dropdown, refresh, filter, then the list for the chosen mode. The mode is remembered. */
export function ObjectPicker() {
  const mode = useUiStore((s) => s.pickMode)
  const setMode = useUiStore((s) => s.setPickMode)
  const profile = useUiStore((s) => s.connectedProfile)
  const drill = useUiStore((s) => s.drill)
  const qc = useQueryClient()
  const [filter, setFilter] = useState('')
  const [refreshError, setRefreshError] = useState<string | null>(null)

  /** Re-reads the list the user is looking at, bypassing the server-side cache (`refresh=1`). */
  async function refresh() {
    setRefreshError(null)
    const opts = { staleTime: 0, retry: false }
    try {
      if (mode === 'drill') {
        if (!drill.catalog) {
          await qc.fetchQuery({ queryKey: ['catalogs', profile], queryFn: () => api.getCatalogs(true), ...opts })
        } else if (!drill.schema) {
          const catalog = drill.catalog
          await qc.fetchQuery({
            queryKey: ['schemas', profile, catalog],
            queryFn: () => api.getSchemas(catalog, true),
            ...opts,
          })
        } else {
          const catalog = drill.catalog
          const schema = drill.schema
          await qc.fetchQuery({
            queryKey: ['objects', profile, catalog, schema],
            queryFn: () => api.getObjects(catalog, schema, true),
            ...opts,
          })
        }
      } else if (mode === 'tree') {
        // Legacy tree refresh re-reads catalogs only. Schemas and objects load from the server cache.
        await qc.fetchQuery({ queryKey: ['catalogs', profile], queryFn: () => api.getCatalogs(true), ...opts })
      } else {
        await qc.invalidateQueries({ queryKey: ['search'] })
      }
    } catch (e) {
      setRefreshError(messageOf(e))
    }
  }

  return (
    <div className="object-picker">
      <div className="pickbar">
        <select
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as PickMode)
            setFilter('')
          }}
          aria-label="Picker mode"
        >
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button onClick={refresh} disabled={!profile} title="Refresh this list" aria-label="Refresh list">
          ↻
        </button>
      </div>
      <input
        className="pick-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="filter"
        aria-label="Filter"
      />
      {refreshError && <div className="error">{refreshError}</div>}
      {!profile ? (
        <p className="hint">Connect to browse.</p>
      ) : mode === 'drill' ? (
        <DrillDown filter={filter} onNavigate={() => setFilter('')} />
      ) : mode === 'tree' ? (
        <TreeBrowser filter={filter.toLowerCase()} />
      ) : (
        <SearchBrowser filter={filter} />
      )}
    </div>
  )
}

// ---- Drill-down -----------------------------------------------------------

interface Item {
  name: string
  type: string | null
  comment: string | null
  /** Set only for objects. Used to open the object and to highlight the focus node. */
  fullName?: string
}

function DrillDown({ filter, onNavigate }: { filter: string; onNavigate: () => void }) {
  const drill = useUiStore((s) => s.drill)
  const setDrill = useUiStore((s) => s.setDrill)
  const profile = useUiStore((s) => s.connectedProfile)
  const focusId = useGraphStore((s) => s.nodes.find((n) => n.data.focus)?.id)
  const open = useOpenHandler()
  const catalogs = useCatalogs()
  const schemas = useSchemas(drill.catalog)
  const objects = useObjects(drill.catalog, drill.schema)

  const level = !drill.catalog ? 'catalogs' : !drill.schema ? 'schemas' : 'objects'
  const active = level === 'catalogs' ? catalogs : level === 'schemas' ? schemas : objects

  let items: Item[] = []
  if (level === 'catalogs') {
    items = (catalogs.data?.data ?? []).map((c) => ({ name: c.name, type: c.type, comment: c.comment }))
  } else if (level === 'schemas') {
    items = (schemas.data?.data ?? []).map((s) => ({ name: s.name, type: null, comment: s.comment }))
  } else {
    items = (objects.data?.data ?? []).map((o: ObjectSummary) => ({
      name: o.name,
      type: o.type,
      comment: o.comment,
      fullName: o.full_name,
    }))
  }

  function pick(x: Item, add: boolean) {
    if (level === 'catalogs') setDrill({ catalog: x.name, schema: null })
    else if (level === 'schemas') setDrill({ catalog: drill.catalog, schema: x.name })
    else if (x.fullName) {
      open(x.fullName, add)
      // Adding keeps the filter, so several objects can be added from one filtered list.
      if (add) return
    }
    onNavigate()
  }

  const f = filter.toLowerCase()
  return (
    <>
      <div className="crumbs">
        <button
          className="crumb"
          onClick={() => {
            onNavigate()
            setDrill({ catalog: null, schema: null })
          }}
        >
          catalogs
        </button>
        {drill.catalog && (
          <>
            {' › '}
            <button
              className="crumb"
              onClick={() => {
                onNavigate()
                setDrill({ catalog: drill.catalog, schema: null })
              }}
            >
              {drill.catalog}
            </button>
          </>
        )}
        {drill.schema && (
          <>
            {' › '}
            <b>{drill.schema}</b>
          </>
        )}
      </div>
      <ListStatus
        loading={active.isPending}
        error={active.isError ? messageOf(active.error) : null}
        text={`${items.length} ${level} · cached ${active.data?.fetched_at ?? ''}`}
      />
      <ul className="pick-list">
        {items
          .filter((x) => x.name.toLowerCase().includes(f))
          .map((x) => {
            const selected = x.fullName !== undefined && x.fullName === focusId
            return (
              <li
                key={x.name}
                className={`pick-item${selected ? ' sel' : ''}`}
                title={x.fullName ?? (x.comment ? `${x.name}\n${x.comment}` : x.name)}
                onClick={(e) => pick(x, addsToGraph(e))}
                {...(x.fullName ? tableDragProps(x.fullName) : {})}
              >
                <span className="nm">{x.name}</span>
                <span className="tag">{shortType(x.type)}</span>
                {x.fullName && <AddButton fullName={x.fullName} onOpen={open} />}
              </li>
            )
          })}
      </ul>
      {!profile && <p className="hint">Connect to browse.</p>}
    </>
  )
}

function ListStatus({ loading, error, text }: { loading: boolean; error: string | null; text: string }) {
  if (error) return <div className="pick-status error">{error}</div>
  if (loading) return <div className="pick-status">loading…</div>
  return <div className="pick-status">{text}</div>
}

// ---- Tree -----------------------------------------------------------------

/**
 * Filter rule from the legacy tree: a branch is shown if its own name matches or if any loaded child is shown.
 * Each branch reports its visibility to its parent. That keeps the child state in the parent, so the
 * branch can stay mounted (and keep its expansion) while it is hidden.
 */
function useBranchVisibility(
  key: string,
  own: boolean,
  filter: string,
  onVisible?: (key: string, visible: boolean) => void,
) {
  const [kids, setKids] = useState<Record<string, boolean>>({})
  const reportKid = useCallback(
    (k: string, v: boolean) => setKids((prev) => (prev[k] === v ? prev : { ...prev, [k]: v })),
    [],
  )
  const anyKid = Object.values(kids).some(Boolean)
  const visible = !filter || own || anyKid
  useEffect(() => {
    onVisible?.(key, visible)
  }, [key, visible, onVisible])
  useEffect(() => () => onVisible?.(key, false), [key, onVisible])
  return { visible, reportKid }
}

function TreeBrowser({ filter }: { filter: string }) {
  const catalogs = useCatalogs()
  const open = useOpenHandler()
  return (
    <>
      <ListStatus
        loading={catalogs.isPending}
        error={catalogs.isError ? messageOf(catalogs.error) : null}
        text={`${catalogs.data?.data.length ?? 0} catalogs · cached ${catalogs.data?.fetched_at ?? ''}`}
      />
      <ul className="tree">
        {(catalogs.data?.data ?? []).map((c) => (
          <CatalogBranch key={c.name} name={c.name} type={c.type} filter={filter} onOpen={open} />
        ))}
      </ul>
    </>
  )
}

function CatalogBranch({
  name,
  type,
  filter,
  onOpen,
}: {
  name: string
  type: string | null
  filter: string
  onOpen: OpenHandler
}) {
  const [open, setOpen] = useState(false)
  const schemas = useSchemas(open ? name : null)
  const { visible, reportKid } = useBranchVisibility(name, matches(name, filter), filter)
  return (
    <li className={visible ? undefined : 'hidden'}>
      <div className="tree-row" onClick={() => setOpen((o) => !o)}>
        <span className="tw">{open ? '▾' : '▸'}</span>
        <span className="nm">{name}</span>
        <span className="tag">{shortType(type)}</span>
      </div>
      {open && (
        <ul>
          {schemas.isPending && <li className="hint">loading…</li>}
          {schemas.isError && <li className="error">{messageOf(schemas.error)}</li>}
          {(schemas.data?.data ?? []).map((s) => (
            <SchemaBranch
              key={s.name}
              catalog={name}
              name={s.name}
              filter={filter}
              onVisible={reportKid}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function SchemaBranch({
  catalog,
  name,
  filter,
  onVisible,
  onOpen,
}: {
  catalog: string
  name: string
  filter: string
  onVisible: (key: string, visible: boolean) => void
  onOpen: OpenHandler
}) {
  const [open, setOpen] = useState(false)
  const objects = useObjects(open ? catalog : null, open ? name : null)
  const { visible, reportKid } = useBranchVisibility(name, matches(name, filter), filter, onVisible)
  return (
    <li className={visible ? undefined : 'hidden'}>
      <div className="tree-row" onClick={() => setOpen((o) => !o)}>
        <span className="tw">{open ? '▾' : '▸'}</span>
        <span className="nm">{name}</span>
      </div>
      {open && (
        <ul>
          {objects.isPending && <li className="hint">loading…</li>}
          {objects.isError && <li className="error">{messageOf(objects.error)}</li>}
          {(objects.data?.data ?? []).map((o) => (
            <ObjectLeaf key={o.full_name} item={o} filter={filter} onVisible={reportKid} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  )
}

function ObjectLeaf({
  item,
  filter,
  onVisible,
  onOpen,
}: {
  item: ObjectSummary
  filter: string
  onVisible: (key: string, visible: boolean) => void
  onOpen: OpenHandler
}) {
  const { visible } = useBranchVisibility(item.name, matches(item.name, filter), filter, onVisible)
  return (
    <li className={visible ? undefined : 'hidden'}>
      <div
        className="tree-row"
        title={item.full_name}
        onClick={(e) => onOpen(item.full_name, addsToGraph(e))}
        {...tableDragProps(item.full_name)}
      >
        <span className="tw" />
        <span className="nm">{item.name}</span>
        <span className="tag">{shortType(item.type)}</span>
        <AddButton fullName={item.full_name} onOpen={onOpen} />
      </div>
    </li>
  )
}

// ---- Search ---------------------------------------------------------------

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

/** Server search after 3 characters, debounced 300 ms. The server source note says whether the search covers all catalogs. */
function SearchBrowser({ filter }: { filter: string }) {
  const open = useOpenHandler()
  const trimmed = filter.trim()
  const enough = trimmed.length >= 3
  const debounced = useDebounced(trimmed, 300)
  const term = enough && debounced.length >= 3 ? debounced : ''
  const search = useSearch(term)

  let status = 'type at least 3 characters'
  let error: string | null = null
  if (enough) {
    if (search.isError) error = messageOf(search.error)
    else if (!term || search.isPending) status = 'searching…'
    else status = `${search.data.data.length} hits · ${search.data.source}`
  }
  const rows = enough && term && search.data ? search.data.data : []

  return (
    <>
      <div className={`pick-status${error ? ' error' : ''}`}>{error ?? status}</div>
      <ul className="pick-list">
        {rows.map((o) => (
          <li
            key={o.full_name}
            className="pick-item"
            title={o.full_name}
            onClick={(e) => open(o.full_name, addsToGraph(e))}
            {...tableDragProps(o.full_name)}
          >
            <span className="nm">{o.full_name}</span>
            <span className="tag">{shortType(o.type)}</span>
            <AddButton fullName={o.full_name} onOpen={open} />
          </li>
        ))}
      </ul>
    </>
  )
}

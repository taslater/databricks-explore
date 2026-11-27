// Object picker: Drill-down, Tree, and Search. Port of the three legacy modes in static/app.js.
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type RefObject } from 'react'
import * as api from '../api/client'
import { useCatalogs, useFunctions, useObjects, useSchemas, useSearch } from '../api/hooks'
import type { ObjectSummary } from '../api/types'
import { openSqlInCanvas } from '../ask/canvasAction'
import { describeFunctionSql } from '../shared/scriptAs'
import { useUiStore, type PickMode } from '../store/uiStore'
import { messageOf, useGraphActions } from './actions'
import { shortStamp, shortType } from './format'
import { useGraphStore } from './graphStore'
import { tableDragProps } from '../shared/tableDrag'
import { countText, isFunction, passesTypes, presentGroups, type TypeGroup } from './objectTypes'
import { Highlighted, PickerFilter, TypeChips } from './PickerFilter'
import { focusAtEnd, keepInputFocus } from './pickerFocus'
import { compileFilter, matchName, rankItems, regexError, type Compiled, type Ranked } from './pickerMatch'
import { completeLast, pathPrefix, resolvePath, splitPath } from './pickerPath'
import { ObjectMenuHost, useObjectContextMenu } from './objectMenu'

const MODES: { id: PickMode; label: string }[] = [
  { id: 'drill', label: 'Drill-down' },
  { id: 'tree', label: 'Tree' },
  { id: 'search', label: 'Search' },
]

/** Lets the filter input hand its key presses to the list that is showing. Returns true when it used the key. */
type KeyNav = MutableRefObject<((e: KeyboardEvent<HTMLInputElement>) => boolean) | null>

/** Shift, Cmd or Ctrl on a click adds the object to the graph instead of starting a new one, as on the graph itself. */
const addsToGraph = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => e.shiftKey || e.metaKey || e.ctrlKey

/**
 * Click opens the object as a new graph; with Shift, Cmd or Ctrl it is added to the graph on screen. A function has no
 * graph node, so a click puts DESCRIBE FUNCTION in a new query window (not run) instead.
 */
type OpenHandler = (fullName: string, add: boolean, type?: string | null) => void

function useOpenHandler(): OpenHandler {
  const actions = useGraphActions()
  return useCallback(
    (fullName: string, add: boolean, type?: string | null) => {
      if (isFunction(type)) openSqlInCanvas(describeFunctionSql(fullName))
      else if (add) void actions.addObject(fullName)
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

/** The type chips, bound to the remembered selection. */
function PickerTypes({ present }: { present: ReadonlySet<TypeGroup> | null }) {
  const selected = useUiStore((s) => s.pickTypes)
  const setTypes = useUiStore((s) => s.setPickTypes)
  return <TypeChips selected={selected} present={present} onChange={setTypes} />
}

const PLACEHOLDERS: Record<PickMode, string> = {
  drill: 'filter — type dev.schema. to drill',
  tree: 'filter — * ? globs, dev.schema.table',
  search: 'search — dev.schema.name, cust*',
}

/** Mode dropdown, refresh, filter, then the list for the chosen mode. The mode is remembered. */
export function ObjectPicker() {
  const mode = useUiStore((s) => s.pickMode)
  const setMode = useUiStore((s) => s.setPickMode)
  const profile = useUiStore((s) => s.connectedProfile)
  const drill = useUiStore((s) => s.drill)
  const regex = useUiStore((s) => s.pickRegex)
  const setRegex = useUiStore((s) => s.setPickRegex)
  const qc = useQueryClient()
  // In Drill-down the filter text is the path to where the list is, so it starts as the current position.
  const [filter, setFilter] = useState(() => (mode === 'drill' && !regex ? pathPrefix(drill) : ''))
  const navRef: KeyNav = useRef(null)
  const inputRef = useRef<HTMLInputElement>(null)
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
      <ObjectMenuHost />
      <div className="pickbar">
        <select
          value={mode}
          onChange={(e) => {
            const next = e.target.value as PickMode
            setMode(next)
            setFilter(next === 'drill' && !regex ? pathPrefix(drill) : '')
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
      <PickerFilter
        inputRef={inputRef}
        value={filter}
        onChange={setFilter}
        onKeyDown={(e) => {
          if (mode === 'drill' && navRef.current?.(e)) return
          if (e.key === 'Escape' && filter) {
            e.preventDefault()
            setFilter('')
          }
        }}
        placeholder={PLACEHOLDERS[mode]}
        regex={regex}
        onToggleRegex={
          mode === 'search'
            ? undefined // the server does the matching in Search, and it knows globs but not regular expressions
            : () => {
                setRegex(!regex)
                setFilter(!regex || mode !== 'drill' ? '' : pathPrefix(drill))
              }
        }
        error={regex && mode !== 'search' ? regexError(filter) : null}
      />
      {refreshError && <div className="error">{refreshError}</div>}
      {!profile ? (
        <p className="hint">Connect to browse.</p>
      ) : mode === 'drill' ? (
        <DrillDown filter={filter} setFilter={setFilter} regex={regex} navRef={navRef} inputRef={inputRef} />
      ) : mode === 'tree' ? (
        <TreeBrowser filter={filter} regex={regex} />
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

/**
 * The Drill-down list. Outside regex mode the filter text is the path to the list, so `dev.hr.emp` means catalog dev,
 * schema hr, objects matching emp. Typing drills, and clicking or tabbing writes the matching path back into the text.
 */
function DrillDown({
  filter,
  setFilter,
  regex,
  navRef,
  inputRef,
}: {
  filter: string
  setFilter: (text: string) => void
  regex: boolean
  navRef: KeyNav
  inputRef: RefObject<HTMLInputElement | null>
}) {
  const drill = useUiStore((s) => s.drill)
  const setDrill = useUiStore((s) => s.setDrill)
  const profile = useUiStore((s) => s.connectedProfile)
  const focusId = useGraphStore((s) => s.nodes.find((n) => n.data.focus)?.id)
  const open = useOpenHandler()
  const menu = useObjectContextMenu()
  const catalogs = useCatalogs()
  const schemas = useSchemas(drill.catalog)
  const objects = useObjects(drill.catalog, drill.schema)
  const functions = useFunctions(drill.catalog, drill.schema)
  const types = useUiStore((s) => s.pickTypes)
  const listRef = useRef<HTMLUListElement>(null)
  /** The highlighted row, and whether the arrow keys have moved it (an untouched top row is not highlighted). */
  const [hi, setHi] = useState(0)
  const [navigated, setNavigated] = useState(false)
  /** The drill position this component last set, to tell its own moves from ones made elsewhere. */
  const applied = useRef(drill)

  const level = !drill.catalog ? 'catalogs' : !drill.schema ? 'schemas' : 'objects'
  const active = level === 'catalogs' ? catalogs : level === 'schemas' ? schemas : objects

  const items: Item[] = useMemo(() => {
    if (level === 'catalogs') return (catalogs.data?.data ?? []).map((c) => ({ name: c.name, type: c.type, comment: c.comment }))
    if (level === 'schemas') return (schemas.data?.data ?? []).map((s) => ({ name: s.name, type: null, comment: s.comment }))
    return [...(objects.data?.data ?? []), ...(functions.data?.data ?? [])]
      .map((o: ObjectSummary) => ({ name: o.name, type: o.type, comment: o.comment, fullName: o.full_name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [level, catalogs.data, schemas.data, objects.data, functions.data])
  // The type chips narrow only the objects level. `items` stays whole, for the "12 of 80" count and the greyed chips.
  const typed = useMemo(
    () => (level === 'objects' ? items.filter((x) => passesTypes(x.type, types)) : items),
    [items, level, types],
  )
  const present = useMemo(() => (level === 'objects' && items.length ? presentGroups(items.map((x) => x.type)) : null), [items, level])

  const catalogNames = catalogs.data ? catalogs.data.data.map((c) => c.name) : null
  const schemaNames = schemas.data ? schemas.data.data.map((s) => s.name) : null
  const res = regex ? null : resolvePath(filter, catalogNames, (c) => (c === drill.catalog ? schemaNames : null))
  const levelText = res ? res.filter : filter

  const compiled = useMemo(() => compileFilter(levelText, regex), [levelText, regex])
  const { primary, rest } = useMemo(() => rankItems(typed, compiled, (x) => x.name), [typed, compiled])
  const rows: Ranked<Item>[] = [...primary, ...rest]
  const hot = Math.min(hi, rows.length - 1)
  const showHot = navigated || levelText !== ''

  /** Moves to a drill position and writes its path into the filter, so the text and the list agree. */
  function go(next: { catalog: string | null; schema: string | null }) {
    applied.current = next
    setDrill(next)
    setFilter(regex ? '' : pathPrefix(next))
  }

  // Follow the filter text: completed segments drill, and deleting past a dot goes back up. A position changed from
  // elsewhere (not by this filter) is written back into the text instead.
  const resCatalog = res?.catalog ?? null
  const resSchema = res?.schema ?? null
  const resPending = res?.pending ?? false
  useEffect(() => {
    const a = applied.current
    if (a.catalog !== drill.catalog || a.schema !== drill.schema) {
      applied.current = drill
      if (!regex) setFilter(pathPrefix(drill))
      return
    }
    if (regex) return
    let next = { catalog: resCatalog, schema: resSchema }
    if (resPending) {
      // The data for the next segment is still loading: take only the part that is known.
      if (resCatalog === null || resCatalog === drill.catalog) return
      next = { catalog: resCatalog, schema: null }
    }
    if (next.catalog !== drill.catalog || next.schema !== drill.schema) {
      applied.current = next
      setDrill(next)
    }
  }, [drill, regex, resCatalog, resSchema, resPending, setDrill, setFilter])

  useEffect(() => {
    setHi(0)
    setNavigated(false)
  }, [levelText, level])

  useEffect(() => {
    if (navigated) listRef.current?.querySelector<HTMLElement>(`[data-idx="${hot}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [hot, navigated])

  /** After a click moved the path, the box keeps the focus with the caret at the end, so typing goes on to the next level. */
  function goAndRefocus(next: { catalog: string | null; schema: string | null }) {
    go(next)
    setTimeout(() => focusAtEnd(inputRef.current), 0) // after React has written the new path into the box
  }

  function pick(x: Item, add: boolean) {
    if (level === 'catalogs') goAndRefocus({ catalog: x.name, schema: null })
    else if (level === 'schemas') goAndRefocus({ catalog: drill.catalog, schema: x.name })
    else if (x.fullName) {
      open(x.fullName, add, x.type)
      if (isFunction(x.type)) return // its description is in a query window; the list stays as it was
      // Adding keeps the filter, so several objects can be added from one filtered list.
      if (add) return
      setFilter(regex ? '' : pathPrefix(drill))
    }
  }

  useEffect(() => {
    navRef.current = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (rows.length === 0) return false
        e.preventDefault()
        setNavigated(true)
        setHi(Math.min(rows.length - 1, Math.max(0, hot + (e.key === 'ArrowDown' ? 1 : -1))))
        return true
      }
      if (e.key === 'Enter') {
        const row = showHot ? rows[hot] : undefined
        if (!row) return false
        e.preventDefault()
        pick(row.item, addsToGraph(e))
        return true
      }
      if (e.key === 'Tab' && !e.shiftKey && !regex) {
        // The highlighted row, or the top one when the arrow keys have not moved yet.
        const row = showHot ? rows[hot] : rows[0]
        if (!row) return false
        e.preventDefault()
        setFilter(completeLast(filter, row.item.name, level !== 'objects'))
        return true
      }
      if (e.key === 'Escape' && !regex) {
        // First Escape drops the segment being typed and keeps the path; the next one (in the caller) clears it all.
        const { last, head } = splitPath(filter)
        if (last === '') return false
        e.preventDefault()
        setFilter(head)
        return true
      }
      return false
    }
    return () => {
      navRef.current = null
    }
  })

  const renderRow = (r: Ranked<Item>, idx: number, dim: boolean) => {
    const x = r.item
    const selected = x.fullName !== undefined && x.fullName === focusId
    return (
      <li
        key={x.name}
        data-idx={idx}
        className={`pick-item${selected ? ' sel' : ''}${showHot && idx === hot ? ' hi' : ''}${dim ? ' dim' : ''}`}
        title={x.fullName ?? (x.comment ? `${x.name}\n${x.comment}` : x.name)}
        onMouseDown={x.fullName ? undefined : keepInputFocus} // catalogs and schemas: the box keeps focus while the path is typed
        onClick={(e) => pick(x, addsToGraph(e))}
        {...(x.fullName && !isFunction(x.type) ? tableDragProps(x.fullName) : {})}
        {...(x.fullName ? menu(x.fullName, x.type) : {})}
      >
        <span className="nm">
          <Highlighted name={x.name} ranges={r.match.ranges} />
        </span>
        <span className="tag">{shortType(x.type)}</span>
        {x.fullName && !isFunction(x.type) && <AddButton fullName={x.fullName} onOpen={open} />}
      </li>
    )
  }

  const shown = countText(rows.length, items.length)
  const functionsNote = level === 'objects' && functions.isError ? ' · functions unavailable' : ''
  return (
    <>
      <div className="crumbs">
        <button className="crumb" onMouseDown={keepInputFocus} onClick={() => goAndRefocus({ catalog: null, schema: null })}>
          catalogs
        </button>
        {drill.catalog && (
          <>
            {' › '}
            <button className="crumb" onMouseDown={keepInputFocus} onClick={() => goAndRefocus({ catalog: drill.catalog, schema: null })}>
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
        text={res?.problem ?? `${shown} ${level} · cached ${shortStamp(active.data?.fetched_at)}${functionsNote}`}
        title={active.data?.fetched_at ? `Cached ${active.data.fetched_at}` : undefined}
      />
      {level === 'objects' && <PickerTypes present={present} />}
      <ul className="pick-list" ref={listRef}>
        {primary.map((r, i) => renderRow(r, i, false))}
        {primary.length > 0 && rest.length > 0 && <li className="pick-divider" role="separator" />}
        {rest.map((r, i) => renderRow(r, primary.length + i, true))}
      </ul>
      {!profile && <p className="hint">Connect to browse.</p>}
    </>
  )
}

function ListStatus({ loading, error, text, title }: { loading: boolean; error: string | null; text: string; title?: string }) {
  if (error) return <div className="pick-status error">{error}</div>
  if (loading) return <div className="pick-status">loading…</div>
  return (
    <div className="pick-status" title={title}>
      {text}
    </div>
  )
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
  filters: TreeFilters,
  onVisible?: (key: string, visible: boolean) => void,
) {
  const [kids, setKids] = useState<Record<string, boolean>>({})
  const reportKid = useCallback(
    (k: string, v: boolean) => setKids((prev) => (prev[k] === v ? prev : { ...prev, [k]: v })),
    [],
  )
  const anyKid = Object.values(kids).some(Boolean)
  // With a dotted filter each level has its own text, so a branch stays only for its own name.
  const visible = !filters.active || own || (!filters.dotted && anyKid)
  useEffect(() => {
    onVisible?.(key, visible)
  }, [key, visible, onVisible])
  useEffect(() => () => onVisible?.(key, false), [key, onVisible])
  return { visible, reportKid }
}

/** The filter for each tree level (catalog, schema, object). A dotted filter gives each level its own segment. */
interface TreeFilters {
  levels: [Compiled, Compiled, Compiled]
  active: boolean
  dotted: boolean
  /** The object type groups to show; empty shows all. It narrows objects only, never catalogs or schemas. */
  types: readonly TypeGroup[]
}

function treeFilters(text: string, regex: boolean, types: readonly TypeGroup[]): TreeFilters {
  const segs = regex ? [text] : [...splitPath(text).done, splitPath(text).last]
  const dotted = segs.length > 1
  const levels = (dotted ? [0, 1, 2].map((i) => compileFilter(segs[i] ?? '', false)) : Array(3).fill(compileFilter(text, regex))) as TreeFilters['levels']
  return { levels, dotted, types, active: types.length > 0 || levels.some((l) => l.kind !== 'none' && l.kind !== 'invalid') }
}

function TreeBrowser({ filter, regex }: { filter: string; regex: boolean }) {
  const types = useUiStore((s) => s.pickTypes)
  const filters = useMemo(() => treeFilters(filter, regex, types), [filter, regex, types])
  const catalogs = useCatalogs()
  const open = useOpenHandler()
  return (
    <>
      <PickerTypes present={null} />
      <ListStatus
        loading={catalogs.isPending}
        error={catalogs.isError ? messageOf(catalogs.error) : null}
        text={`${catalogs.data?.data.length ?? 0} catalogs · cached ${shortStamp(catalogs.data?.fetched_at)}`}
        title={catalogs.data?.fetched_at ? `Cached ${catalogs.data.fetched_at}` : undefined}
      />
      <ul className="tree">
        {(catalogs.data?.data ?? []).map((c) => (
          <CatalogBranch key={c.name} name={c.name} type={c.type} filters={filters} onOpen={open} />
        ))}
      </ul>
    </>
  )
}

function CatalogBranch({
  name,
  type,
  filters,
  onOpen,
}: {
  name: string
  type: string | null
  filters: TreeFilters
  onOpen: OpenHandler
}) {
  const [open, setOpen] = useState(false)
  const schemas = useSchemas(open ? name : null)
  const match = matchName(filters.levels[0], name)
  const { visible, reportKid } = useBranchVisibility(name, match !== null, filters)
  return (
    <li className={visible ? undefined : 'hidden'}>
      <div className="tree-row" onClick={() => setOpen((o) => !o)}>
        <span className="tw">{open ? '▾' : '▸'}</span>
        <span className="nm">
          <Highlighted name={name} ranges={match?.ranges ?? []} />
        </span>
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
              filters={filters}
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
  filters,
  onVisible,
  onOpen,
}: {
  catalog: string
  name: string
  filters: TreeFilters
  onVisible: (key: string, visible: boolean) => void
  onOpen: OpenHandler
}) {
  const [open, setOpen] = useState(false)
  const objects = useObjects(open ? catalog : null, open ? name : null)
  const functions = useFunctions(open ? catalog : null, open ? name : null)
  const match = matchName(filters.levels[1], name)
  const { visible, reportKid } = useBranchVisibility(name, match !== null, filters, onVisible)
  return (
    <li className={visible ? undefined : 'hidden'}>
      <div className="tree-row" onClick={() => setOpen((o) => !o)}>
        <span className="tw">{open ? '▾' : '▸'}</span>
        <span className="nm">
          <Highlighted name={name} ranges={match?.ranges ?? []} />
        </span>
      </div>
      {open && (
        <ul>
          {objects.isPending && <li className="hint">loading…</li>}
          {objects.isError && <li className="error">{messageOf(objects.error)}</li>}
          {[...(objects.data?.data ?? []), ...(functions.data?.data ?? [])].map((o) => (
            <ObjectLeaf key={o.full_name} item={o} filters={filters} onVisible={reportKid} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  )
}

function ObjectLeaf({
  item,
  filters,
  onVisible,
  onOpen,
}: {
  item: ObjectSummary
  filters: TreeFilters
  onVisible: (key: string, visible: boolean) => void
  onOpen: OpenHandler
}) {
  const menu = useObjectContextMenu()
  const match = matchName(filters.levels[2], item.name)
  const { visible } = useBranchVisibility(item.name, match !== null && passesTypes(item.type, filters.types), filters, onVisible)
  const fn = isFunction(item.type)
  return (
    <li className={visible ? undefined : 'hidden'}>
      <div
        className="tree-row"
        title={item.full_name}
        onClick={(e) => onOpen(item.full_name, addsToGraph(e), item.type)}
        {...(fn ? {} : tableDragProps(item.full_name))}
        {...menu(item.full_name, item.type)}
      >
        <span className="tw" />
        <span className="nm">
          <Highlighted name={item.name} ranges={match?.ranges ?? []} />
        </span>
        <span className="tag">{shortType(item.type)}</span>
        {!fn && <AddButton fullName={item.full_name} onOpen={onOpen} />}
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
  const menu = useObjectContextMenu()
  const trimmed = filter.trim()
  const enough = trimmed.length >= 3
  const debounced = useDebounced(trimmed, 300)
  const term = enough && debounced.length >= 3 ? debounced : ''
  const search = useSearch(term)
  const types = useUiStore((s) => s.pickTypes)

  let status = 'type at least 3 characters'
  let error: string | null = null
  if (enough) {
    if (search.isError) error = messageOf(search.error)
    else if (!term || search.isPending) status = 'searching…'
  }
  const hits = enough && term && search.data ? search.data.data : []
  const rows = hits.filter((o) => passesTypes(o.type, types))
  if (enough && !error && term && search.data) status = `${countText(rows.length, hits.length)} hits · ${search.data.source}`

  return (
    <>
      <div className={`pick-status${error ? ' error' : ''}`}>{error ?? status}</div>
      <PickerTypes present={hits.length ? presentGroups(hits.map((o) => o.type)) : null} />
      <ul className="pick-list">
        {rows.map((o) => (
          <li
            key={o.full_name}
            className="pick-item"
            title={o.full_name}
            onClick={(e) => open(o.full_name, addsToGraph(e), o.type)}
            {...(isFunction(o.type) ? {} : tableDragProps(o.full_name))}
            {...menu(o.full_name, o.type)}
          >
            <span className="nm">{o.full_name}</span>
            <span className="tag">{shortType(o.type)}</span>
            {!isFunction(o.type) && <AddButton fullName={o.full_name} onOpen={open} />}
          </li>
        ))}
      </ul>
    </>
  )
}

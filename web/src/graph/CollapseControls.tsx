// The toolbar's Group control, and what Details says about groups, collapsed groups and merged edges.
import { useMemo } from 'react'
import { countText, isMergedEdgeId, isSummaryId } from './collapse'
import { useNodeColors } from './ColorByControl'
import { tagKeys } from './colorBy'
import { useGraphStore } from './graphStore'
import { useCollapseView } from './useCollapse'

const NOWRAP = { whiteSpace: 'nowrap', flexShrink: 0 } as const

/** Group by schema (the default), by a tag, or not at all, and whether chains of pass-through views are drawn as one edge. */
export function GroupControl() {
  const grouping = useGraphStore((s) => s.grouping)
  const hasNodes = useGraphStore((s) => s.nodes.length > 0)
  const { meta } = useNodeColors()
  const keys = useMemo(() => {
    const read = tagKeys(meta)
    return grouping.by.startsWith('tag:') && !read.includes(grouping.by.slice(4)) ? [...read, grouping.by.slice(4)].sort() : read
  }, [meta, grouping.by])
  const { setGroupBy, setChains } = useGraphStore.getState()
  return (
    <>
      <label style={NOWRAP} title="Draw the tables of a schema (or the value of a tag) as one box. A big group collapses to one node.">
        Group by{' '}
        <select value={grouping.by} onChange={(e) => setGroupBy(e.target.value as typeof grouping.by)} aria-label="Group by" disabled={!hasNodes}>
          <option value="schema">Schema</option>
          <option value="none">None</option>
          {keys.map((k) => (
            <option key={k} value={`tag:${k}`}>
              Tag {k}
            </option>
          ))}
        </select>
      </label>
      <button
        style={NOWRAP}
        aria-pressed={grouping.chains}
        disabled={!hasNodes}
        onClick={() => setChains(!grouping.chains)}
        title="Leave out a view with one flow edge in and one out, and draw its neighbors as one edge marked 'via 1 view'"
      >
        Chains
      </button>
    </>
  )
}

/** The groups on the graph, each with a button to open or collapse it. Nothing when the graph has none. */
export function GroupsSection() {
  const view = useCollapseView()
  const { setGroupCollapsed, setGroupsCollapsed } = useGraphStore.getState()
  if (view.groups.length === 0 && view.chains.length === 0) return null
  const elided = view.chains.filter((c) => c.elided)
  return (
    <div data-testid="groups-section">
      <h4>Groups</h4>
      <ul className="constraints">
        {view.groups.map((g) => (
          <li key={g.key}>
            <button className="link" onClick={() => setGroupCollapsed(g.key, !g.collapsed)} title={g.collapsed ? 'Draw its tables' : 'Collapse it to one node'}>
              {g.collapsed ? '▸' : '▾'} {g.label}
            </button>{' '}
            · {countText(g.members.length, g.noun)}
          </li>
        ))}
      </ul>
      {view.groups.length > 0 && (
        <p className="hint">
          <button onClick={() => setGroupsCollapsed(view.groups.map((g) => g.key), true)}>Collapse all</button>{' '}
          <button onClick={() => setGroupsCollapsed(view.groups.map((g) => g.key), false)}>Open all</button>
        </p>
      )}
      {elided.length > 0 && <p className="hint">{countText(elided.reduce((n, c) => n + c.views.length, 0), 'view')} left out in {countText(elided.length, 'chain')}. Click a "via" pill to draw them.</p>}
    </div>
  )
}

/** Details of a collapsed group's node or of an edge that merges others. Nothing for anything else. */
export function CollapseDetails() {
  const selection = useGraphStore((s) => s.selection)
  const view = useCollapseView()
  const edges = useGraphStore((s) => s.edges)
  if (!selection) return null
  if (selection.kind === 'node' && isSummaryId(selection.id)) {
    const g = view.groups.find((x) => `summary:${x.key}` === selection.id)
    if (!g) return null
    return (
      <div data-testid="group-details">
        <h3>{g.key}</h3>
        <p>
          {countText(g.members.length, g.noun)}, collapsed. The count is what opening it shows under the current filters.
        </p>
        <p>
          <button onClick={() => useGraphStore.getState().setGroupCollapsed(g.key, false)}>Open</button>{' '}
          {g.defaultCollapsed && <span className="hint">It starts collapsed because it holds more than 8 and neither the focus nor a pinned table.</span>}
        </p>
        <ul className="constraints">
          {g.members.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </div>
    )
  }
  if (selection.kind === 'edge' && isMergedEdgeId(selection.id)) {
    const e = view.edges.find((x) => x.id === selection.id)
    const m = e?.data?.merged
    if (!e || !m) return null
    const info = new Map(edges.map((x) => [x.id, x.data!.info]))
    return (
      <div data-testid="merged-edge-details">
        <h3>
          {e.source} → {e.target}
        </h3>
        {m.chain ? (
          <>
            <p>
              Goes through {countText(m.views, 'view')} that only pass it on: {m.viaNodes?.join(' → ')}.
            </p>
            <p>
              <button onClick={() => useGraphStore.getState().showChain(m.chain!)}>Draw the views</button>
            </p>
          </>
        ) : (
          <p>Stands for {countText(m.parts.length, 'edge')}, merged because one end is a collapsed group.</p>
        )}
        <ul className="constraints">
          {m.parts.map((p) => {
            const i = info.get(p)
            return <li key={p}>{i ? `${i.source} → ${i.target}` : p}</li>
          })}
        </ul>
      </div>
    )
  }
  return null
}

// The Graph's lens switch (Flow, Model, All) in the toolbar, and what Details says about a table's role in the model.
import { useEffect, useMemo } from 'react'
import { columnLevel } from './columns'
import { useGraphActions } from './actions'
import { columnsBusy } from './columnsRun'
import { dropSoonLayouts, useGraphStore } from './graphStore'
import { drawnSize, sizesAgree, untilSteady } from './measured'
import { anyOverlap, graphRoles, isModified, LENS_HINT, LENS_LABEL, LENSES } from './lens'
import { layoutInput } from './layoutInput'

const NOWRAP = { whiteSpace: 'nowrap', flexShrink: 0 } as const

/** Flow, Model or All: a preset for one question. Changing an edge filter afterwards marks the lens modified, with a reset. */
export function LensSwitch() {
  const lens = useGraphStore((s) => s.lens)
  const filters = useGraphStore((s) => s.filters)
  const hasNodes = useGraphStore((s) => s.nodes.length > 0)
  const request = useGraphStore((s) => s.columnsRequest)
  const actions = useGraphActions()
  const modified = isModified(filters, lens)

  // The column level the lens asks for (none for Flow and All, the keys for Model). Layout requests are held until the columns are in.
  useEffect(() => {
    if (!request) return
    let live = true
    void (async () => {
      const keys = request === 'keys'
      const tables = useGraphStore.getState().nodes.filter((n) => !n.id.startsWith('ph:'))
      const needed = keys ? tables.some((n) => columnLevel(n.data) !== 'keys') : tables.some((n) => n.data.showColumns)
      // A run for the lens before this one may still be loading columns; it ends at its next table, and this one follows it.
      if (needed || columnsBusy()) await actions.setAllColumns(keys, () => !live)
      // Tables the lens shows again were measured at the level they had when they were last drawn: wait until React Flow has measured them as they are now.
      await untilSteady(
        () => {
          const g = useGraphStore.getState()
          const shown = new Set(layoutInput(g, new Set()).nodes.filter((n) => !n.hidden).map((n) => n.id))
          return sizesAgree(g.nodes, shown, drawnSize)
        },
        () => !live,
      )
      if (!live) return
      // The positions that came back stay: what the column change queued would only move them.
      if (useGraphStore.getState().lensHold) dropSoonLayouts()
      useGraphStore.getState().finishLensColumns()
      // Positions that came back were made for the sizes the nodes had then. When they no longer fit, lay the graph out again.
      const g = useGraphStore.getState()
      if (g.layoutPending) return
      const laid = layoutInput(g, new Set()).nodes.filter((n) => !n.hidden)
      if (anyOverlap(laid.map((n) => ({ x: n.x, y: n.y, width: n.width, height: n.height })))) g.requestLayout()
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request])

  return (
    <span className="lens-switch" role="group" aria-label="Lens" style={NOWRAP}>
      {LENSES.map((l) => (
        <button key={l} style={NOWRAP} aria-pressed={lens === l} disabled={!hasNodes} title={LENS_HINT[l]} onClick={() => useGraphStore.getState().setLens(l)}>
          {LENS_LABEL[l]}
        </button>
      ))}
      {modified && (
        <>
          <span className="hint" title="The edge filters are not the lens's own">
            modified
          </span>
          <button style={NOWRAP} onClick={() => useGraphStore.getState().resetLens()} title={`Put the edge filters back to the ${LENS_LABEL[lens]} lens`}>
            Reset
          </button>
        </>
      )}
    </span>
  )
}

/** Fact or dimension, with the reason, for a table a key reference touches. Inferred for the layout and never stored. */
export function NodeRole({ id }: { id: string }) {
  const nodes = useGraphStore((s) => s.nodes)
  const edges = useGraphStore((s) => s.edges)
  const role = useMemo(
    () =>
      graphRoles(
        nodes.map((n) => n.id),
        edges.map((e) => e.data!.info),
      ).get(id),
    [nodes, edges, id],
  )
  if (!role) return null
  return (
    <p className="node-role" title="Inferred from the key references on the graph, for the Model lens's layout. Not stored.">
      <strong>{role.role === 'fact' ? 'Fact' : 'Dimension'}</strong> <span className="hint">{role.reason}</span>
    </p>
  )
}

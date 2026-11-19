import { EdgeLabelRenderer } from '@xyflow/react'
import { useNodeFacts, type NodeFacts, type TableStats } from '../api/nodeFacts'
import { ago, grainChange, shortBytes, sizeBadge, spanLabel } from './cardFacts'
import { useStatsDialog } from './TableStatsDialog'
import { useGraphStore } from './graphStore'
import type { FlowEdge } from './types'

type Facts = NodeFacts | undefined

/** "Late: no write for 3 d, usually every 1 d". Empty when the table is not late. */
function lateText(stats: TableStats): string {
  if (!stats.late || !stats.last_write || stats.cadence_seconds === null) return ''
  const since = (Date.now() - Date.parse(stats.last_write.at)) / 1000
  return `Late: no write for ${spanLabel(since)}, usually every ${spanLabel(stats.cadence_seconds)}`
}

/** An amber dot before the name of a table that is late against its own write cadence. On-time and unknown tables get nothing. */
export function LateDot({ facts }: { facts: Facts }) {
  if (!facts?.stats?.late) return null
  return <span className="late-dot" title={lateText(facts.stats)} aria-label="late" role="img" />
}

/** The muted badge at the end of the name row: rows when known, else size. */
export function SizeBadge({ facts }: { facts: Facts }) {
  const text = sizeBadge(facts?.stats)
  if (!text || !facts?.stats) return null
  const s = facts.stats
  const title = [s.rows !== null ? `${s.rows.toLocaleString()} rows` : null, s.bytes !== null ? shortBytes(s.bytes) : null, `read ${ago(s.fetched_at)}`]
    .filter(Boolean)
    .join(' · ')
  return (
    <span className="size-badge" title={title} data-testid="size-badge">
      {text}
    </span>
  )
}

/** One muted line under the name saying what a row is. Only when it is known. */
export function GrainLine({ facts }: { facts: Facts }) {
  const g = facts?.grain
  if (!g) return null
  return (
    <div className="tbl-grain" title={g.source + (g.columns.length > 3 ? `: ${g.columns.join(', ')}` : '')} data-testid="grain-line">
      {g.label}
    </div>
  )
}

/** The Σ on a flow edge whose target is a GROUP BY of a different grain. Click selects the edge. */
export function EdgeGrainGlyph({ id, change, x, y, faded }: { id: string; change?: string; x: number; y: number; faded?: boolean }) {
  if (!change) return null
  return (
    <EdgeLabelRenderer>
      <button
        className="edge-glyph nodrag nopan"
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, opacity: faded ? 0.2 : 1 }}
        title={`Aggregates: ${change}`}
        aria-label={`Aggregates: ${change}`}
        onClick={() => useGraphStore.getState().setSelection({ kind: 'edge', id })}
      >
        Σ
      </button>
    </EdgeLabelRenderer>
  )
}

/** Details for a table: its grain with the basis, then size, files, layout, the last write, the cadence and the rows written per write. */
export function NodeFactsDetails({ id }: { id: string }) {
  const facts = useNodeFacts([id]).data?.[id]
  const openDialog = useStatsDialog((s) => s.open)
  const g = facts?.grain
  const s = facts?.stats
  return (
    <>
      {g && (
        <div data-testid="grain-details">
          <h4>Grain</h4>
          <p>
            {g.label}
            <span className="hint"> · {g.source}</span>
          </p>
          {g.columns.length > 3 && <p className="hint">{g.columns.join(', ')}</p>}
        </div>
      )}
      <h4>Size and history</h4>
      {s ? (
        <div data-testid="stats-details">
          <table className="cols">
            <tbody>
              <Row label="Rows" value={s.rows !== null ? s.rows.toLocaleString() : 'not known'} />
              <Row label="Size" value={s.bytes !== null ? shortBytes(s.bytes) : 'not known'} />
              <Row label="Files" value={s.files !== null ? s.files.toLocaleString() : 'not known'} />
              {s.clustering.length > 0 && <Row label="Clustered by" value={s.clustering.join(', ')} />}
              {s.partitioning.length > 0 && <Row label="Partitioned by" value={s.partitioning.join(', ')} />}
              <Row
                label="Last write"
                value={
                  s.last_write
                    ? `${ago(s.last_write.at)}, ${s.last_write.operation}${writer(s.last_write)}`
                    : 'none in the last 50 commits'
                }
              />
              <Row label="Usually every" value={s.cadence_seconds !== null ? spanLabel(s.cadence_seconds) : 'not enough writes'} />
            </tbody>
          </table>
          {lateText(s) && <p className="late-text">{lateText(s)}</p>}
          <WriteStrip writes={s.writes} />
          {s.history_error && <p className="error">History not read: {s.history_error}</p>}
          <p className="hint">
            <span title={s.fetched_at ?? ''}>Read {ago(s.fetched_at)}.</span>{' '}
            <button onClick={() => openDialog([id])}>Read again</button>
          </p>
        </div>
      ) : (
        <p className="hint">
          Not read yet. <button onClick={() => openDialog([id])}>Read size and history</button>
        </p>
      )}
    </>
  )
}

function writer(w: NonNullable<TableStats['last_write']>): string {
  const who = w.job ? `job ${w.job}` : w.notebook ? `notebook ${w.notebook}` : w.user
  return who ? ` by ${who}` : ''
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td>{label}</td>
      <td>{value}</td>
    </tr>
  )
}

/** A small bar strip of rows written per write, oldest first. A write whose rows are not known is a short grey tick. */
function WriteStrip({ writes }: { writes: TableStats['writes'] }) {
  if (writes.length === 0) return null
  const max = Math.max(1, ...writes.map((w) => w.rows ?? 0))
  const w = 8
  return (
    <svg
      className="write-strip"
      width={writes.length * w}
      height={28}
      role="img"
      aria-label={`Rows written by each of the last ${writes.length} writes`}
    >
      {writes.map((x, i) => {
        const h = x.rows === null ? 3 : Math.max(2, (x.rows / max) * 26)
        return (
          <rect key={i} x={i * w + 1} y={28 - h} width={w - 2} height={h} className={x.rows === null ? 'unknown' : ''}>
            <title>{`${x.at}: ${x.rows === null ? 'rows not known' : x.rows.toLocaleString() + ' rows'}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}

/** On a flow edge's details: the change of grain, `per order_id × line_no → per customer_id × order_date`. Nothing when there is none. */
export function EdgeGrainDetails({ edge }: { edge: FlowEdge }) {
  const info = edge.data?.info
  const facts = useNodeFacts(info ? [info.source, info.target] : [], !!info && !info.source_column).data
  const change = info && facts && (info.kind === 'view_dep' || info.kind === 'lineage') ? grainChange(facts[info.source]?.grain, facts[info.target]?.grain) : null
  if (!change || !info) return null
  return (
    <div data-testid="edge-grain">
      <h4>Aggregates</h4>
      <p>{change}</p>
      <p className="hint">{facts?.[info.target]?.grain?.source}</p>
    </div>
  )
}

// The small icon before a node's name: what kind of object it is, so the fill is free for "Color by".
import type { ReactNode } from 'react'

export type IconKind = 'table' | 'view' | 'materialized_view' | 'streaming_table' | 'metric_view' | 'external' | 'foreign'

/** The icon for a node's kind (the lowercased table type). Managed and unknown types are tables. */
export function iconKind(kind: string | undefined): IconKind {
  const k = (kind ?? '').toLowerCase()
  if (k === 'view' || k === 'persisted_view') return 'view'
  if (k === 'materialized_view' || k === 'streaming_table' || k === 'metric_view' || k === 'external' || k === 'foreign') return k
  return 'table'
}

export const ICON_LABEL: Record<IconKind, string> = {
  table: 'table',
  view: 'view',
  materialized_view: 'materialized view',
  streaming_table: 'streaming table',
  metric_view: 'metric view',
  external: 'external table',
  foreign: 'foreign table',
}

const GRID = (
  <>
    <rect x="1.5" y="2.5" width="9" height="7" />
    <path d="M1.5 5h9M5 5v4.5" />
  </>
)

const EYE = (
  <>
    <path d="M1 6c1.4-2.4 3-3.5 5-3.5s3.6 1.1 5 3.5c-1.4 2.4-3 3.5-5 3.5S2.4 8.4 1 6z" />
    <circle cx="6" cy="6" r="1.4" fill="currentColor" />
  </>
)

const SHAPES: Record<IconKind, ReactNode> = {
  table: GRID,
  view: EYE,
  // a view whose result is stored: the eye inside a frame
  materialized_view: (
    <>
      <rect x="0.8" y="1.8" width="10.4" height="8.4" />
      <path d="M2.8 6c1-1.6 2-2.3 3.2-2.3s2.2.7 3.2 2.3c-1 1.6-2 2.3-3.2 2.3S3.8 7.6 2.8 6z" />
    </>
  ),
  // a stream: three waves
  streaming_table: <path d="M1 3.5c1.2-1.2 2.4-1.2 3.5 0s2.3 1.2 3.5 0 2-1 3-.3M1 6.5c1.2-1.2 2.4-1.2 3.5 0s2.3 1.2 3.5 0 2-1 3-.3M1 9.5c1.2-1.2 2.4-1.2 3.5 0s2.3 1.2 3.5 0 2-1 3-.3" />,
  // measures: bars
  metric_view: <path d="M2.5 10V6.5M6 10V2.5M9.5 10V5M1 10.5h10" />,
  // a table with an arrow leaving it: the data lives outside
  external: (
    <>
      <path d="M1.5 2.5h5M1.5 2.5v7h7v-3.5M1.5 5h5" />
      <path d="M6.5 5.5l4-4M7.8 1.5h2.7v2.7" />
    </>
  ),
  // the same, dashed: a foreign catalog, read through a connection
  foreign: (
    <>
      <path d="M1.5 2.5h5M1.5 2.5v7h7v-3.5M1.5 5h5" strokeDasharray="1.6 1" />
      <path d="M6.5 5.5l4-4M7.8 1.5h2.7v2.7" />
    </>
  ),
}

/** The icon of one kind. Always shown, so the type reads the same whatever the fill means. */
export function TypeIcon({ kind, size = 12 }: { kind: string | undefined; size?: number }) {
  const k = iconKind(kind)
  return (
    <svg
      className="type-icon"
      data-testid="type-icon"
      data-kind={k}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinejoin="round"
      strokeLinecap="round"
      role="img"
      aria-label={ICON_LABEL[k]}
    >
      <title>{ICON_LABEL[k]}</title>
      {SHAPES[k]}
    </svg>
  )
}

// Layout: types and fetch functions for the doctor, tidy and arrange routes (contracts/api.md section 3b).
import { ApiError } from './client'
import type { CanvasDoc } from './types'

export type IssueSeverity = 'error' | 'warning' | 'info'

export type IssueKind =
  | 'overlap'
  | 'near_alignment'
  | 'uneven_spacing'
  | 'edge_through_node'
  | 'derived_through_node'
  | 'edge_crossings'
  | 'bad_handle_side'
  | 'outside_frame'
  | 'label_overflow'
  | 'label_collision'
  | 'far_away'
  | 'off_grid'
  | 'empty_label'

export type TidyRule = 'fit_labels' | 'frames' | 'overlaps' | 'align' | 'spacing' | 'grid' | 'handles' | 'place_labels' | 'lines'

/** The body to send to the tidy route (with the canvas) to fix one issue. */
export interface IssueFix {
  tool: 'tidy'
  rules: TidyRule[]
  ids: string[]
}

export interface LayoutIssue {
  id: string
  kind: IssueKind
  severity: IssueSeverity
  nodes: string[]
  /** Connector ids, for issues about connectors. */
  edges?: string[]
  message: string
  fix: IssueFix | null
}

export interface LayoutMetrics {
  node_count: number
  edge_count: number
  overlap_area: number
  edge_crossings: number
  edge_length_mean: number
  edge_length_variance: number
  alignment_score: number
  whitespace_ratio: number
}

export interface LayoutReport {
  score: number
  metrics: LayoutMetrics
  issues: LayoutIssue[]
}

export interface NodeChange {
  kind: 'node'
  id: string
  from: { x: number; y: number; w: number; h: number }
  to: { x: number; y: number; w: number; h: number }
}

export interface EdgeChange {
  kind: 'edge'
  id: string
  from: { source_handle: string | null; target_handle: string | null; label_offset?: number }
  to: { source_handle: string | null; target_handle: string | null; label_offset?: number }
}

export type LayoutChange = NodeChange | EdgeChange

export interface LayoutResult {
  changes: LayoutChange[]
  canvas: CanvasDoc
  score: { before: number; after: number }
}

export type ArrangeMode = 'grid' | 'row' | 'column' | 'layered' | 'place'

async function call<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const err =
      data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `HTTP ${res.status}`
    throw new ApiError(res.status, err)
  }
  return data as T
}

export const layoutDoctor = (canvas: CanvasDoc, grid?: number) =>
  call<LayoutReport>('/api/layout/doctor', { canvas, ...(grid ? { grid } : {}) })

export const layoutTidy = (canvas: CanvasDoc, opts: { ids?: string[]; rules?: TidyRule[]; grid?: number } = {}) =>
  call<LayoutResult>('/api/layout/tidy', { canvas, ...opts })

export const layoutArrange = (
  canvas: CanvasDoc,
  mode: ArrangeMode,
  opts: { ids?: string[]; options?: Record<string, unknown>; grid?: number } = {},
) => call<LayoutResult>('/api/layout/arrange', { canvas, mode, ...opts })

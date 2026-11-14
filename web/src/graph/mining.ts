// Pure helpers for the mining panels: progress text, result summary, suggestion labels. No React, no fetch.
import type { MiningPhase, MiningResult, MiningStatus, Relationship } from '../api/types'
import { columnLabel } from './columns'

const PHASE_TEXT: Record<MiningPhase, string> = {
  history: 'Reading query history',
  lineage: 'Reading table lineage',
  extract: 'Extracting joins',
  foreign_keys: 'Checking foreign keys',
  save: 'Saving suggestions',
}

/** One line for a run in progress, with a count where the phase has one. */
export function progressText(status: Pick<MiningStatus, 'phase' | 'progress'>): string {
  const base = status.phase ? PHASE_TEXT[status.phase] : 'Working'
  const { done, total } = status.progress
  return total > 0 && (status.phase === 'extract' || status.phase === 'foreign_keys')
    ? `${base}… ${done} of ${total}`
    : `${base}…`
}

/** Share of the run done, 0 to 1, or null when the phase has no count (the bar then shows as indeterminate). */
export function progressFraction(status: Pick<MiningStatus, 'phase' | 'progress'>): number | null {
  const { done, total } = status.progress
  if ((status.phase === 'extract' || status.phase === 'foreign_keys') && total > 0) return Math.min(1, done / total)
  return null
}

/** The lines of a finished run's summary. Counts of zero are left out, except the headline ones. */
export function resultLines(r: MiningResult): string[] {
  const lines = [
    `${r.statements} statements read, ${r.with_joins} with joins`,
    `${r.created} new suggestions, ${r.updated} updated`,
  ]
  if (r.skipped_fk) lines.push(`${r.skipped_fk} pairs skipped: already declared foreign keys`)
  if (r.unparsed) lines.push(`${r.unparsed} statements could not be parsed`)
  if (r.redacted_skipped) lines.push(`${r.redacted_skipped} statements had redacted text`)
  if (r.no_lineage) lines.push(`${r.no_lineage} statements had no lineage row (short table names there are dropped)`)
  if (r.fk_unreadable_tables) lines.push(`${r.fk_unreadable_tables} tables' foreign keys could not be read`)
  if (r.capped) lines.push('Row cap reached: run again to continue from where it stopped')
  return lines
}

/** `orders.customer_id ↔ customers.id`, for a stored column edge. */
export function pairLabel(r: Pick<Relationship, 'source' | 'target'>): string {
  const side = (e: Relationship['source']) => (e.column ? columnLabel(e.table, e.column) : (e.table.split('.').pop() ?? e.table))
  return `${side(r.source)} ↔ ${side(r.target)}`
}

/** The date part of an ISO timestamp, for compact lists. */
export const dayOf = (s: string | null | undefined): string => (s ? s.slice(0, 10) : '')

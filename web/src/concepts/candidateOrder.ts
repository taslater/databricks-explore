import type { Candidate } from '../api/concepts'

/** One candidate's identity: a table, or one of its columns. */
export const candidateKey = (h: Pick<Candidate, 'table' | 'column'>): string => `${h.table}#${h.column ?? ''}`

/**
 * The hits in the order they first appeared. The server sorts linked hits last, so a refetch after a Link click
 * would move that row to the bottom and put another row's button under the cursor. Rows keep their place instead;
 * a hit that was not there before goes at the end, in the server's order. A null order means "as the server sent it".
 */
export function inFirstOrder<T extends Pick<Candidate, 'table' | 'column'>>(hits: T[], order: string[] | null): T[] {
  if (order === null) return hits
  const rank = new Map(order.map((k, i) => [k, i]))
  const unseen = order.length
  return hits
    .map((h, i) => ({ h, i, r: rank.get(candidateKey(h)) ?? unseen }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.h)
}

// Certification badges: which tables and columns carry system.certification_status, and how to read it for a link or a node.
import type { Certification, CertificationStatus } from '../api/concepts'

/** The status of a table, or of one of its columns when a column is given. Undefined when it has none or nothing was read. */
export function certificationOf(
  cert: Certification | undefined,
  table: string,
  column?: string | null,
): CertificationStatus | undefined {
  if (!cert) return undefined
  return column ? cert.columns[`${table}#${column}`] : cert.tables[table]
}

/** "Certification: 5 min ago", or "Certification: not loaded" when the cache has never been filled. */
export function certificationLabel(fetchedAt: string | null | undefined, nowMs: number): string {
  const t = fetchedAt ? Date.parse(fetchedAt) : NaN
  if (Number.isNaN(t)) return 'Certification: not loaded'
  const minutes = Math.floor(Math.max(0, nowMs - t) / 60000)
  if (minutes < 1) return 'Certification: just now'
  if (minutes < 60) return `Certification: ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Certification: ${hours} h ago`
  return `Certification: ${Math.floor(hours / 24)} d ago`
}

/** The same nodes, each table with its certification status in `data.certification`. Nodes without one come back untouched. */
export function withCertification<N extends { id: string; data: object }>(nodes: N[], cert: Certification | undefined): N[] {
  if (!cert || Object.keys(cert.tables).length === 0) return nodes
  return nodes.map((n) => {
    const status = cert.tables[n.id]
    return status ? { ...n, data: { ...n.data, certification: status } } : n
  })
}

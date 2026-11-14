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

/** The same nodes, each table with its certification status in `data.certification`. Nodes without one come back untouched. */
export function withCertification<N extends { id: string; data: object }>(nodes: N[], cert: Certification | undefined): N[] {
  if (!cert || Object.keys(cert.tables).length === 0) return nodes
  return nodes.map((n) => {
    const status = cert.tables[n.id]
    return status ? { ...n, data: { ...n.data, certification: status } } : n
  })
}

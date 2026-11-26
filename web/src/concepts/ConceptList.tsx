import { CONCEPT_STATUSES, type ConceptList as ConceptListData, type ConceptStatus } from '../api/concepts'
import { useConceptsStore } from './conceptsStore'

/** Search box, domain and status filters, and the concepts that match. */
export function ConceptList({
  list,
  loading,
  error,
}: {
  list: ConceptListData | undefined
  loading: boolean
  error: string | null
}) {
  const filters = useConceptsStore((s) => s.filters)
  const selected = useConceptsStore((s) => s.selected)
  const { setFilters, select } = useConceptsStore.getState()
  const filtered = !!(filters.q || filters.domain || filters.status)

  return (
    <aside className="concept-list" aria-label="Concepts">
      <div className="concept-filters">
        <input
          type="search"
          placeholder="Search name, synonyms, definition"
          aria-label="Search concepts"
          value={filters.q}
          onChange={(e) => setFilters({ q: e.target.value })}
        />
        <div className="concept-filter-row">
          <select aria-label="Domain" value={filters.domain} onChange={(e) => setFilters({ domain: e.target.value })}>
            <option value="">all domains</option>
            {list?.domains.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select
            aria-label="Status"
            value={filters.status}
            onChange={(e) => setFilters({ status: e.target.value as '' | ConceptStatus })}
          >
            <option value="">all statuses</option>
            {CONCEPT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {loading && <p className="hint">Loading…</p>}
      <ul className="concept-items">
        {list?.concepts.map((c) => (
          <li key={c.id}>
            <button
              className={`concept-item${selected === c.id ? ' active' : ''}`}
              onClick={() => select(c.id)}
              aria-current={selected === c.id}
            >
              <span className="concept-item-name">{c.name}</span>
              <span className={`concept-badge status-${c.status}`}>{c.status}</span>
              <span className="concept-item-meta">
                {[c.domain, c.link_count ? `${c.link_count} link${c.link_count === 1 ? '' : 's'}` : null, c.provenance.origin === 'manual' ? null : c.provenance.origin]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {list && list.concepts.length === 0 && filtered && <p className="hint">No concepts match.</p>}
    </aside>
  )
}

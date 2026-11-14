// UI state for the Concepts tab: which concept is open and how the list is filtered. Server data is in TanStack Query.
import { create } from 'zustand'
import type { ConceptFilters } from '../api/concepts'

/** An id, 'new' for the empty editor, or null for none. */
export type Selected = string | 'new' | null

interface ConceptsState {
  selected: Selected
  filters: ConceptFilters
  suggestOpen: boolean
  /** A line under the toolbar: what an import or export did, or an error. */
  notice: { text: string; error: boolean } | null
  select: (selected: Selected) => void
  setFilters: (patch: Partial<ConceptFilters>) => void
  setSuggestOpen: (open: boolean) => void
  setNotice: (text: string | null, error?: boolean) => void
}

export const useConceptsStore = create<ConceptsState>()((set) => ({
  selected: null,
  filters: { q: '', domain: '', status: '' },
  suggestOpen: false,
  notice: null,
  select: (selected) => set({ selected }),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  setSuggestOpen: (suggestOpen) => set({ suggestOpen }),
  setNotice: (text, error = false) => set({ notice: text ? { text, error } : null }),
}))

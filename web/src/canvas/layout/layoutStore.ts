// UI state shared by the Doctor panel and the Arrange menu: whether the panel is open and the last message.
import { create } from 'zustand'

interface LayoutUiState {
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
  /** The last result or error, shown next to the buttons. */
  note: { text: string; error: boolean } | null
  setNote: (text: string | null, error?: boolean) => void
}

export const useLayoutUi = create<LayoutUiState>()((set) => ({
  panelOpen: false,
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  note: null,
  setNote: (text, error = false) => set({ note: text === null ? null : { text, error } }),
}))

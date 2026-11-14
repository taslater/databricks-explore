// Save state for the canvas toolbar. UI only. The canvas data lives in canvasStore.
import { create } from 'zustand'

/**
 * unnamed: a new canvas with no name yet, so nothing autosaves.
 * unsaved: named, with changes not yet written.
 * saving:  a write is in flight.
 * saved:   the server has the current state.
 * error:   the last save or open failed. `message` says why.
 */
export type PersistPhase = 'unnamed' | 'unsaved' | 'saving' | 'saved' | 'error'

interface PersistStatusState {
  phase: PersistPhase
  /** Error text or a notice. Cleared by the next status change that passes no message. */
  message: string | null
  messageIsError: boolean
  /** JSON of the last state known to be on the server. Autosave skips writes that match it. */
  savedJson: string | null
  /** Profile named in the file that was last opened. A save made with no connection keeps it. */
  fileProfile: string | null
  /** Counts canvases opened from the list. The view fits itself to the content each time it changes. */
  openSeq: number
  setStatus: (phase: PersistPhase, message?: string | null, isError?: boolean) => void
  markSaved: (json: string) => void
}

export const usePersistStore = create<PersistStatusState>()((set) => ({
  phase: 'unnamed',
  message: null,
  messageIsError: false,
  savedJson: null,
  fileProfile: null,
  openSeq: 0,
  setStatus: (phase, message = null, isError = false) =>
    set({ phase, message, messageIsError: isError }),
  markSaved: (json) => set({ phase: 'saved', savedJson: json, message: null, messageIsError: false }),
}))

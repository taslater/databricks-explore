// Live sync state: which revision of the open canvas this page has, what the server says now, and a change waiting
// for the person's choice. UI only. The canvas data lives in canvasStore and sketchStore.
import { create } from 'zustand'
import type { CanvasRevision } from '../../api/agent'

interface SyncState {
  /** The revision of `name` that this page last loaded or saved. */
  known: { name: string; revision: number } | null
  setKnown: (name: string, revision: number) => void
  /** The newest answer from the revision poll for the open canvas. */
  remote: CanvasRevision | null
  setRemote: (remote: CanvasRevision | null) => void
  /** A newer revision that arrived while this page had unsaved edits. The banner offers Reload and Keep mine. */
  conflict: CanvasRevision | null
  setConflict: (conflict: CanvasRevision | null) => void
  /** Counts "Keep mine" clicks, so the persistence hook (which owns the save queue) can write the page's version. */
  keepRequests: number
  keepMine: () => void
}

export const useSyncStore = create<SyncState>()((set, get) => ({
  known: null,
  setKnown: (name, revision) => set({ known: { name, revision } }),
  remote: null,
  setRemote: (remote) => set({ remote }),
  conflict: null,
  setConflict: (conflict) => set({ conflict }),
  keepRequests: 0,
  keepMine: () => {
    const { conflict } = get()
    if (conflict === null) return
    // Accept the newer revision as the base, so the next save is the person's own choice to overwrite it.
    set((s) => ({ known: { name: conflict.name, revision: conflict.revision }, conflict: null, keepRequests: s.keepRequests + 1 }))
  },
}))

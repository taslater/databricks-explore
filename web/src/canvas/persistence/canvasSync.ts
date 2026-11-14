// Live sync with agents: notice that something else saved the open canvas, and either reload it in place or
// ask. The poll is plain functions over the stores, so it can run from anywhere that stays mounted.
import * as api from '../../api/client'
import { getCanvasRevision, type CanvasRevision } from '../../api/agent'
import { useCanvasStore } from '../../store/canvasStore'
import { useSketchStore } from '../../sketch/sketchStore'
import { fromCanvasFile, parseCanvasFile } from './canvasFile'
import { usePersistStore, type PersistPhase } from './persistStore'
import { useSyncStore } from './syncStore'
import { buildFile, saveProfile } from './useCanvasPersistence'

export const POLL_MS = 2000

export type SyncAction = 'none' | 'reload' | 'banner'

/**
 * What to do with a poll answer. Nothing when the page has this revision already (or is mid-save, when the
 * answer may just be its own write). With no unsaved edits the canvas reloads in place; with some, the person chooses.
 */
export function decideSync(
  known: { name: string; revision: number } | null,
  remote: CanvasRevision,
  phase: PersistPhase,
): SyncAction {
  if (known === null || known.name !== remote.name || remote.revision <= known.revision) return 'none'
  if (phase === 'saving') return 'none'
  return phase === 'saved' ? 'reload' : 'banner'
}

/**
 * Loads the saved canvas into the stores and keeps the viewport the person has now. `force` skips the check that
 * the page has no unsaved edits (used by the banner's Reload, which throws them away).
 */
export async function reloadInPlace(remote: CanvasRevision, force = false): Promise<boolean> {
  const file = parseCanvasFile(await api.getCanvas(remote.name))
  const canvas = useCanvasStore.getState()
  if (canvas.canvasName !== remote.name) return false
  if (!force && usePersistStore.getState().phase !== 'saved') return false // edited while we fetched: the next poll decides
  const viewport = canvas.viewport
  const loaded = fromCanvasFile(file)
  useCanvasStore.getState().loadState({ ...loaded, viewport })
  useSketchStore.getState().load(loaded.sketchNodes, loaded.edges)
  usePersistStore.setState({ fileProfile: file.profile ?? null })
  usePersistStore.getState().markSaved(buildFile(remote.name, saveProfile()).json) // loading is not an edit
  useSyncStore.getState().setKnown(remote.name, remote.revision)
  useSyncStore.getState().setConflict(null)
  return true
}

/** Applies one poll answer for the open canvas. */
export async function handleRemote(remote: CanvasRevision): Promise<void> {
  const sync = useSyncStore.getState()
  if (useCanvasStore.getState().canvasName !== remote.name) return
  sync.setRemote(remote)
  if (sync.known === null || sync.known.name !== remote.name) {
    sync.setKnown(remote.name, remote.revision) // nothing to compare with yet: start from what the server has
    return
  }
  const action = decideSync(sync.known, remote, usePersistStore.getState().phase)
  if (action === 'reload') await reloadInPlace(remote)
  else if (action === 'banner' && sync.conflict?.revision !== remote.revision) sync.setConflict(remote)
}

/** Asks the server for the open canvas's revision now and applies the answer. Errors are ignored: the next poll tries again. */
export async function pollNow(): Promise<void> {
  const name = useCanvasStore.getState().canvasName
  if (name === null) return
  try {
    await handleRemote(await getCanvasRevision(name))
  } catch {
    // The canvas may not be saved yet, or the server is restarting.
  }
}

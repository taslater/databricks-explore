// Runs once on page load. Reconnects to the profile the user last connected to and
// re-applies their SQL warehouse, so a page reload does not drop the connection.
// It never opens a browser (interactive=false) and never picks a profile the user did not connect to.
// With nothing remembered (empty localStorage), it still adopts the profile the server reports as connected.
import type { QueryClient } from '@tanstack/react-query'
import { useUiStore } from '../store/uiStore'
import * as api from './client'
import type { SessionResponse } from './types'

let started = false

export async function restoreSession(qc: QueryClient): Promise<void> {
  // StrictMode and dev reloads can run effects twice. One restore per page load is enough.
  if (started) return
  started = true

  const ui = useUiStore.getState()
  const target = ui.lastConnectedProfile
  if (target === null) {
    try {
      const current = await api.getSession()
      if (current.profile === null) return
      useUiStore.getState().setConnectedProfile(current.profile)
      if (useUiStore.getState().warehouseId === null && current.warehouse_id !== null) {
        useUiStore.getState().setWarehouseId(current.warehouse_id)
      }
    } catch {
      // No server session to adopt. The Connect button still works.
    }
    return
  }

  let session: SessionResponse
  try {
    session = await api.getSession()
    // Server still has its connection (plain page reload). Otherwise reconnect without a browser.
    if (session.profile !== target) {
      const who = await api.connect(target, false)
      session = { profile: who.profile, warehouse_id: null }
    }
  } catch {
    useUiStore
      .getState()
      .setRestoreMessage(`Could not reconnect to ${target}. Click Connect to sign in again.`)
    return
  }
  // The profile is marked connected only after the saved warehouse is on the server again. Marking it first let
  // queries that need a warehouse (certification) fire while the server had none, and they failed.
  await restoreWarehouse(qc, target, session)
  useUiStore.getState().setConnectedProfile(target)
}

async function restoreWarehouse(qc: QueryClient, target: string, session: SessionResponse): Promise<void> {
  const warehouseId = useUiStore.getState().warehouseId
  if (warehouseId === null || session.warehouse_id === warehouseId) return

  try {
    // Warehouses are keyed by profile, so this also fills the cache the Picker reads.
    const warehouses = await qc.fetchQuery({
      queryKey: ['warehouses', target],
      queryFn: api.getWarehouses,
    })
    if (!warehouses.some((w) => w.id === warehouseId)) {
      // The saved warehouse is gone or not visible to this profile. Forget it.
      useUiStore.getState().setWarehouseId(null)
      return
    }
    await api.setWarehouse(warehouseId)
  } catch {
    useUiStore.getState().setRestoreMessage('Reconnected, but the SQL warehouse could not be restored. Pick it again.')
  }
}

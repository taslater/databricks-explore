import { useConnect, useProfiles, useSetWarehouse, useWarehouses } from '../api/hooks'
import { ObjectPicker } from '../graph/ObjectPicker'
import { useUiStore } from '../store/uiStore'

export { TABLE_DRAG_MIME, tableDragProps } from './tableDrag'

interface PickerProps {
  onCollapse: () => void
}

/** Left panel: connect to a profile, choose a SQL warehouse, then browse objects. */
export function Picker({ onCollapse }: PickerProps) {
  const profiles = useProfiles()
  const selected = useUiStore((s) => s.selectedProfile)
  const setSelected = useUiStore((s) => s.setSelectedProfile)
  const connected = useUiStore((s) => s.connectedProfile)
  const restoreMessage = useUiStore((s) => s.restoreMessage)
  const warehouseId = useUiStore((s) => s.warehouseId)
  const setWarehouseId = useUiStore((s) => s.setWarehouseId)
  const connect = useConnect()
  const warehouses = useWarehouses()
  const setWarehouse = useSetWarehouse()

  let status = 'Not connected'
  if (connect.isPending) status = 'Connecting. A browser window may open for login.'
  else if (connected) status = `Connected to ${connected}`

  return (
    <div className="picker">
      <div className="panel-header">
        <strong>Picker</strong>
        <button onClick={onCollapse} title="Hide picker" aria-label="Hide picker">
          «
        </button>
      </div>

      <section className="panel-section">
        <label className="field">
          Profile
          <select
            value={selected ?? ''}
            onChange={(e) => setSelected(e.target.value || null)}
            disabled={connect.isPending}
          >
            <option value="">choose a profile</option>
            {profiles.data?.profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {profiles.isError && <div className="error">{profiles.error.message}</div>}
        <button
          disabled={!selected || connect.isPending}
          onClick={() =>
            selected && connect.mutate(selected, { onSuccess: () => setWarehouseId(null) })
          }
        >
          Connect
        </button>
        <div className="status">{status}</div>
        {connect.isError && <div className="error">{connect.error.message}</div>}
        {restoreMessage && !connect.isPending && <div className="error">{restoreMessage}</div>}

        {connected !== null && (
          <label className="field">
            SQL warehouse
            <select
              value={warehouseId ?? ''}
              disabled={warehouses.isPending || setWarehouse.isPending}
              title="Optional. Search covers all catalogs only when a warehouse is set."
              onChange={(e) => {
                const id = e.target.value || null
                // Only once the server has it, so search and the certification refresh never ask before the warehouse is set.
                setWarehouse.mutate(id, { onSuccess: () => setWarehouseId(id) })
              }}
            >
              <option value="">no SQL warehouse</option>
              {warehouses.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({(w.state ?? '').toLowerCase()})
                </option>
              ))}
            </select>
          </label>
        )}
        {warehouses.isError && <div className="error">{warehouses.error.message}</div>}
        {setWarehouse.isError && <div className="error">{setWarehouse.error.message}</div>}
      </section>

      <section className="panel-section">
        <ObjectPicker />
      </section>
    </div>
  )
}

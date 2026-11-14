import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

// Every test re-imports the modules: restoreSession keeps a once-per-page-load flag.
const api = {
  getSession: vi.fn(),
  connect: vi.fn(),
  getWarehouses: vi.fn(),
  setWarehouse: vi.fn(),
}
vi.mock('./client', () => api)

type Store = typeof import('../store/uiStore')['useUiStore']
let restoreSession: typeof import('./restoreSession')['restoreSession']
let useUiStore: Store

beforeEach(async () => {
  vi.resetModules()
  Object.values(api).forEach((f) => f.mockReset())
  ;({ restoreSession } = await import('./restoreSession'))
  ;({ useUiStore } = await import('../store/uiStore'))
  useUiStore.setState({
    selectedProfile: null,
    connectedProfile: null,
    lastConnectedProfile: null,
    warehouseId: null,
    restoreMessage: null,
  })
})

const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

describe('restoreSession', () => {
  it('stays disconnected when nothing is remembered and the server has no connection', async () => {
    api.getSession.mockResolvedValue({ profile: null, warehouse_id: null })
    await restoreSession(qc())
    expect(api.connect).not.toHaveBeenCalled()
    expect(useUiStore.getState().connectedProfile).toBeNull()
  })

  it('takes the connection from the server when localStorage is empty', async () => {
    api.getSession.mockResolvedValue({ profile: 'dev', warehouse_id: 'wh1' })
    await restoreSession(qc())
    expect(api.connect).not.toHaveBeenCalled()
    expect(useUiStore.getState().connectedProfile).toBe('dev')
    expect(useUiStore.getState().warehouseId).toBe('wh1')
  })

  it('ignores a failing session call when nothing is remembered', async () => {
    api.getSession.mockRejectedValue(new Error('down'))
    await restoreSession(qc())
    expect(useUiStore.getState().connectedProfile).toBeNull()
    expect(useUiStore.getState().restoreMessage).toBeNull()
  })

  it('keeps the server connection when it is still on the same profile (plain reload)', async () => {
    useUiStore.setState({ lastConnectedProfile: 'dev' })
    api.getSession.mockResolvedValue({ profile: 'dev', warehouse_id: null })
    await restoreSession(qc())
    expect(api.connect).not.toHaveBeenCalled()
    expect(useUiStore.getState().connectedProfile).toBe('dev')
  })

  it('reconnects without a browser when the server restarted', async () => {
    useUiStore.setState({ lastConnectedProfile: 'dev' })
    api.getSession.mockResolvedValue({ profile: null, warehouse_id: null })
    api.connect.mockResolvedValue({ profile: 'dev', user: 'u', host: 'h', workspace_id: '1' })
    await restoreSession(qc())
    expect(api.connect).toHaveBeenCalledWith('dev', false)
    expect(useUiStore.getState().connectedProfile).toBe('dev')
  })

  it('shows a message and stays disconnected when reconnect fails', async () => {
    useUiStore.setState({ lastConnectedProfile: 'dev' })
    api.getSession.mockResolvedValue({ profile: null, warehouse_id: null })
    api.connect.mockRejectedValue(new Error('401'))
    await restoreSession(qc())
    expect(useUiStore.getState().connectedProfile).toBeNull()
    expect(useUiStore.getState().restoreMessage).toMatch(/Click Connect/)
  })

  it('re-applies the saved warehouse when it is still listed', async () => {
    useUiStore.setState({ lastConnectedProfile: 'dev', warehouseId: 'wh1' })
    api.getSession.mockResolvedValue({ profile: null, warehouse_id: null })
    api.connect.mockResolvedValue({ profile: 'dev', user: null, host: 'h', workspace_id: null })
    api.getWarehouses.mockResolvedValue([{ id: 'wh1', name: 'Main', state: 'RUNNING' }])
    api.setWarehouse.mockResolvedValue({ warehouse_id: 'wh1' })
    await restoreSession(qc())
    expect(api.setWarehouse).toHaveBeenCalledWith('wh1')
    expect(useUiStore.getState().warehouseId).toBe('wh1')
  })

  it('forgets a saved warehouse that no longer exists', async () => {
    useUiStore.setState({ lastConnectedProfile: 'dev', warehouseId: 'gone' })
    api.getSession.mockResolvedValue({ profile: 'dev', warehouse_id: null })
    api.getWarehouses.mockResolvedValue([{ id: 'wh1', name: 'Main', state: 'RUNNING' }])
    await restoreSession(qc())
    expect(api.setWarehouse).not.toHaveBeenCalled()
    expect(useUiStore.getState().warehouseId).toBeNull()
  })

  it('runs only once per page load', async () => {
    useUiStore.setState({ lastConnectedProfile: 'dev' })
    api.getSession.mockResolvedValue({ profile: 'dev', warehouse_id: null })
    const client = qc()
    await restoreSession(client)
    await restoreSession(client)
    expect(api.getSession).toHaveBeenCalledTimes(1)
  })
})

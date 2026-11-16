import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type MainView = 'graph' | 'canvas' | 'concepts' | 'ask'

/** Object picker modes. The legacy UI used the same localStorage key. */
export type PickMode = 'drill' | 'tree' | 'search'

const PICK_MODES: PickMode[] = ['drill', 'tree', 'search']

function readPickMode(): PickMode {
  try {
    const v = localStorage.getItem('pickMode') as PickMode | null
    return v && PICK_MODES.includes(v) ? v : 'drill'
  } catch {
    return 'drill'
  }
}

function readPickRegex(): boolean {
  try {
    return localStorage.getItem('pickRegex') === '1'
  } catch {
    return false
  }
}

/** UI-only state. Server data lives in TanStack Query (src/api/hooks.ts). */
interface UiState {
  view: MainView
  pickerCollapsed: boolean
  /** Profile chosen in the picker (not necessarily connected yet). Persisted. */
  selectedProfile: string | null
  /** Profile the server is connected to. Null until POST /api/connect succeeds. Not persisted. */
  connectedProfile: string | null
  /**
   * Profile the user last connected to successfully. Persisted. On page load the app
   * reconnects to this profile (never to a profile the user did not connect to).
   */
  lastConnectedProfile: string | null
  /** Warehouse chosen in the picker. Null means none. Persisted. */
  warehouseId: string | null
  /** Set when the automatic reconnect on load fails. Cleared on the next connect. Not persisted. */
  restoreMessage: string | null
  pickMode: PickMode
  /** Whether the picker's filter is a regular expression (the `.*` toggle). Remembered in localStorage like pickMode. */
  pickRegex: boolean
  /** Whether the Canvas tab shows the properties panel (the Details area). Not persisted. */
  canvasDetailsOpen: boolean
  /** Drill-down position in the object picker. */
  drill: { catalog: string | null; schema: string | null }
  setView: (view: MainView) => void
  setCanvasDetailsOpen: (open: boolean) => void
  setPickerCollapsed: (collapsed: boolean) => void
  setSelectedProfile: (profile: string | null) => void
  setConnectedProfile: (profile: string | null) => void
  setWarehouseId: (id: string | null) => void
  setRestoreMessage: (message: string | null) => void
  setPickMode: (mode: PickMode) => void
  setPickRegex: (on: boolean) => void
  setDrill: (drill: { catalog: string | null; schema: string | null }) => void
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      view: 'graph',
      pickerCollapsed: false,
      selectedProfile: null,
      connectedProfile: null,
      lastConnectedProfile: null,
      warehouseId: null,
      restoreMessage: null,
      pickMode: readPickMode(),
      pickRegex: readPickRegex(),
      canvasDetailsOpen: false,
      drill: { catalog: null, schema: null },
      setView: (view) => set({ view }),
      setCanvasDetailsOpen: (canvasDetailsOpen) => set({ canvasDetailsOpen }),
      setPickerCollapsed: (pickerCollapsed) => set({ pickerCollapsed }),
      setSelectedProfile: (selectedProfile) => set({ selectedProfile }),
      setConnectedProfile: (connectedProfile) =>
        set({
          connectedProfile,
          // Only a real connection updates the remembered profile. Disconnecting keeps it.
          lastConnectedProfile: connectedProfile ?? get().lastConnectedProfile,
          restoreMessage: null,
        }),
      setWarehouseId: (warehouseId) => set({ warehouseId }),
      setRestoreMessage: (restoreMessage) => set({ restoreMessage }),
      setPickMode: (pickMode) => {
        try {
          localStorage.setItem('pickMode', pickMode)
        } catch {
          // Storage can be unavailable. The mode still applies for this session.
        }
        set({ pickMode })
      },
      setPickRegex: (pickRegex) => {
        try {
          localStorage.setItem('pickRegex', pickRegex ? '1' : '0')
        } catch {
          // Storage can be unavailable. The switch still applies for this session.
        }
        set({ pickRegex })
      },
      setDrill: (drill) => set({ drill }),
    }),
    {
      name: 'explorer-ui',
      // Only the connection choices are saved. Everything else is reset on each load.
      partialize: (s) => ({
        selectedProfile: s.selectedProfile,
        lastConnectedProfile: s.lastConnectedProfile,
        warehouseId: s.warehouseId,
      }),
    },
  ),
)

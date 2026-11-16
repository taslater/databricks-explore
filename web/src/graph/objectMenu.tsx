// The right-click menu on an object in the picker: a hook that gives a row its handler, and a host that draws the menu.
import { useCallback, type MouseEvent } from 'react'
import { create } from 'zustand'
import * as api from '../api/client'
import { queryClient } from '../api/queryClient'
import { openSqlInCanvas } from '../ask/canvasAction'
import { ContextMenu, wantsBrowserMenu, type MenuItem } from '../shared/ContextMenu'
import { columnNames } from '../shared/scriptAs'
import { useUiStore } from '../store/uiStore'
import { useGraphActions } from './actions'
import { useGraphStore } from './graphStore'
import { objectMenuItems } from './objectMenuItems'

interface OpenMenu {
  x: number
  y: number
  items: MenuItem[]
}

const useObjectMenuStore = create<{ menu: OpenMenu | null; set: (m: OpenMenu | null) => void }>((set) => ({
  menu: null,
  set: (menu) => set({ menu }),
}))

/** The object's column names, from the same cache as the table card (GET /api/object). */
function loadColumns(fullName: string): Promise<string[]> {
  const profile = useUiStore.getState().connectedProfile
  return queryClient
    .fetchQuery({ queryKey: ['object', profile, fullName], queryFn: () => api.getObject(fullName), staleTime: 60_000, retry: false })
    .then((obj) => columnNames(obj.data.columns))
}

function copyText(text: string) {
  if (text) void navigator.clipboard?.writeText(text).catch(() => {})
}

/** Returns a function that gives a picker row its `onContextMenu`. Shift+right-click keeps the browser's menu. */
export function useObjectContextMenu() {
  const actions = useGraphActions()
  return useCallback(
    (fullName: string, type: string | null | undefined) => ({
      onContextMenu: (e: MouseEvent) => {
        if (wantsBrowserMenu(e)) return
        e.preventDefault()
        const items = objectMenuItems(fullName, type, {
          columns: () => loadColumns(fullName),
          openSql: (sql) => void openSqlInCanvas(sql),
          copy: copyText,
          addCard: () => void actions.sendTables([fullName]),
          addToGraph: () => void actions.addObject(fullName),
          openInGraph: () => actions.openObject(fullName),
          fail: (message) => useGraphStore.getState().setStatus(message, true),
        })
        useObjectMenuStore.getState().set({ x: e.clientX, y: e.clientY, items })
      },
    }),
    [actions],
  )
}

/** Draws the open object menu. Rendered once, by the picker. */
export function ObjectMenuHost() {
  const menu = useObjectMenuStore((s) => s.menu)
  const close = useCallback(() => useObjectMenuStore.getState().set(null), [])
  if (!menu) return null
  return <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />
}

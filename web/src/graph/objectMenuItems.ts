// The items of the object right-click menu, built from the object's name and kind and a few actions. No React, no fetch.
import type { MenuItem } from '../shared/ContextMenu'
import {
  columnList,
  countSql,
  describeDetailSql,
  describeHistorySql,
  hasDeltaLog,
  objectKind,
  selectSql,
  showCreateSql,
} from '../shared/scriptAs'

/** What the menu needs from the app. */
export interface ObjectMenuDeps {
  /** Column names from the object's details (cached). Rejects when they cannot be read. */
  columns: () => Promise<string[]>
  /** Puts SQL into a new query window, without running it. */
  openSql: (sql: string) => void
  copy: (text: string) => void
  addCard: () => void
  addToGraph: () => void
  openInGraph: () => void
  /** Tells the user something went wrong. */
  fail: (message: string) => void
}

const NOT_FOR_VIEWS = 'Views have no Delta log'

/** The menu for one object: SELECT, "Script as", "Copy", and the graph and canvas actions. `type` is the object's table type. */
export function objectMenuItems(fullName: string, type: string | null | undefined, deps: ObjectMenuDeps): MenuItem[] {
  const kind = objectKind(type)
  const delta = hasDeltaLog(kind)

  /** Runs `make` with the columns; when they cannot be read it falls back to `SELECT *` and says why. */
  const withColumns = (make: (columns: string[]) => void) => () => {
    deps.columns().then(make, (e: unknown) => {
      deps.fail(`Could not read the columns of ${fullName}: ${e instanceof Error ? e.message : String(e)}`)
      make([])
    })
  }
  const script = (sql: string) => () => deps.openSql(sql)

  return [
    {
      kind: 'action',
      label: 'SELECT … LIMIT 10 in new query window',
      run: withColumns((cols) => deps.openSql(selectSql(fullName, cols))),
    },
    {
      kind: 'submenu',
      label: 'Script as',
      items: [
        { kind: 'action', label: 'SELECT', run: withColumns((cols) => deps.openSql(selectSql(fullName, cols))) },
        { kind: 'action', label: 'SELECT COUNT(*)', run: script(countSql(fullName)) },
        {
          kind: 'action',
          label: 'DESCRIBE DETAIL',
          run: script(describeDetailSql(fullName)),
          disabled: !delta,
          title: delta ? undefined : NOT_FOR_VIEWS,
        },
        {
          kind: 'action',
          label: 'DESCRIBE HISTORY',
          run: script(describeHistorySql(fullName)),
          disabled: !delta,
          title: delta ? undefined : NOT_FOR_VIEWS,
        },
        { kind: 'action', label: 'SHOW CREATE TABLE', run: script(showCreateSql(fullName)) },
      ],
    },
    {
      kind: 'submenu',
      label: 'Copy',
      items: [
        { kind: 'action', label: 'Full name', run: () => deps.copy(fullName) },
        { kind: 'action', label: 'Column list', run: withColumns((cols) => deps.copy(columnList(cols))) },
        { kind: 'action', label: 'SELECT statement', run: withColumns((cols) => deps.copy(selectSql(fullName, cols))) },
      ],
    },
    { kind: 'separator' },
    { kind: 'action', label: 'Add table card to canvas', run: deps.addCard },
    { kind: 'action', label: 'Add to graph', run: deps.addToGraph },
    { kind: 'action', label: 'Open in graph', run: deps.openInGraph },
  ]
}

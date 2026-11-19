// A lens switch's column-level change must not outlive its lens: it ended up showing columns in Flow and laying the graph out again.
import { describe, expect, it } from 'vitest'
import { columnsBusy, runColumns } from './columnsRun'

/** A table's load that finishes when the test says so. */
function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

function board(ids: string[]) {
  const shown = new Set<string>()
  const events: string[] = []
  return {
    shown,
    events,
    job: (show: boolean, load: (id: string) => Promise<void>, stop?: () => boolean) => ({
      show,
      ids: () => ids,
      reset: () => {},
      load: async (id: string) => {
        events.push('load ' + id)
        await load(id)
        shown.add(id)
      },
      hide: (id: string) => {
        events.push('hide ' + id)
        shown.delete(id)
      },
      stop,
    }),
  }
}

describe('a column-level change', () => {
  it('shows the keys of every table, one after another', async () => {
    const b = board(['a', 'b', 'c'])
    await runColumns(b.job(true, async () => {}))
    expect([...b.shown]).toEqual(['a', 'b', 'c'])
    expect(columnsBusy()).toBe(false)
  })

  it('stops at the next table when its lens is gone, and takes off the one it was loading', async () => {
    const b = board(['a', 'b', 'c'])
    const first = gate()
    let live = true
    const run = runColumns(b.job(true, (id) => (id === 'a' ? first.opened : Promise.resolve()), () => !live))
    await Promise.resolve()
    live = false // Flow was picked while the Model lens's first table was loading
    first.open()
    await run
    expect(b.events).toEqual(['load a', 'hide a'])
    expect(b.shown.size).toBe(0)
  })

  it('lets the next change start only when the one before has ended, so nothing it hides is shown again', async () => {
    const b = board(['a', 'b', 'c'])
    const first = gate()
    let live = true
    const model = runColumns(b.job(true, (id) => (id === 'a' ? first.opened : Promise.resolve()), () => !live))
    await Promise.resolve()
    live = false
    const flow = runColumns(b.job(false, async () => {}))
    await Promise.resolve()
    expect(b.events).toEqual(['load a']) // Flow's change waits for the load in flight
    expect(columnsBusy()).toBe(true)
    first.open()
    await Promise.all([model, flow])
    expect(b.events).toEqual(['load a', 'hide a', 'hide a', 'hide b', 'hide c'])
    expect(b.shown.size).toBe(0)
    expect(columnsBusy()).toBe(false)
  })
})

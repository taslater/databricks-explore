import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasWindow } from '../api/types'
import { useCanvasStore } from '../store/canvasStore'
import { MAX_PARALLEL, planWindowRuns, runAllWindows, runFinished, runSucceeded, stopRunAll, useBatchStore } from './runAll'
import { IDLE_RUN, useRunStore } from './runState'
import * as api from '../api/client'

vi.mock('../api/client', () => ({
  submitQueryAsync: vi.fn(),
  cancelQuery: vi.fn(() => Promise.resolve({})),
}))

const q = (id: string, title: string, sql: string): CanvasWindow => ({
  id, type: 'query', title, position: { x: 0, y: 0 }, size: { w: 1, h: 1 }, sql, collapsed: false,
})

describe('planWindowRuns', () => {
  it('puts a window after the windows it references, and keeps canvas order otherwise', () => {
    const plan = planWindowRuns([q('top', 'top', 'SELECT * FROM {{mid}}'), q('mid', 'mid', 'SELECT * FROM {{base}}'), q('base', 'base', 'SELECT 1'), q('solo', 'solo', 'SELECT 2')])
    expect(plan.order).toEqual(['base', 'solo', 'mid', 'top'])
    expect(plan.waitsFor).toEqual({ base: [], solo: [], mid: ['base'], top: ['mid'] })
    expect(plan.skipped).toEqual([])
  })

  it('reads a diamond: the shared window first, the join last', () => {
    const plan = planWindowRuns([q('j', 'j', '{{l}} {{r}}'), q('l', 'l', '{{s}}'), q('r', 'r', '{{s}}'), q('s', 's', 'SELECT 1')])
    expect(plan.order.indexOf('s')).toBeLessThan(plan.order.indexOf('l'))
    expect(plan.order.indexOf('s')).toBeLessThan(plan.order.indexOf('r'))
    expect(plan.order[plan.order.length - 1]).toBe('j')
  })

  it('skips windows with no SQL, and cycles with whatever waits on them', () => {
    const plan = planWindowRuns([q('a', 'a', '{{b}}'), q('b', 'b', '{{a}}'), q('c', 'c', '{{a}}'), q('e', 'e', '  '), q('f', 'f', 'SELECT 1'), q('me', 'me', '{{me}}')])
    expect(plan.order).toEqual(['f'])
    expect(plan.skipped.map((s) => [s.id, s.reason])).toEqual([['e', 'empty'], ['a', 'cycle'], ['b', 'cycle'], ['c', 'cycle'], ['me', 'cycle']])
  })

  it('ignores a reference to a title that is not a query window, and windows that are not queries', () => {
    const note: CanvasWindow = { id: 'n', type: 'note', title: 'n', position: { x: 0, y: 0 }, size: { w: 1, h: 1 }, text: 'hi', collapsed: false }
    const plan = planWindowRuns([note, q('a', 'a', 'SELECT * FROM {{ghost}} JOIN {{n}}')])
    expect(plan.order).toEqual(['a'])
    expect(plan.waitsFor.a).toEqual([])
  })
})

describe('runFinished and runSucceeded', () => {
  it('is not finished while submitting or scripting, or while a statement has no final state', () => {
    expect(runFinished({ ...IDLE_RUN, token: 1, submitting: true }, 1)).toBe(false)
    expect(runFinished({ ...IDLE_RUN, token: 1, scriptActive: true, ids: ['s'], states: ['SUCCEEDED'] }, 1)).toBe(false)
    expect(runFinished({ ...IDLE_RUN, token: 1, ids: ['s'], states: [null] }, 1)).toBe(false)
    expect(runFinished({ ...IDLE_RUN, token: 1, sqls: ['x'], ids: ['s'], states: ['FAILED'] }, 1)).toBe(true)
    expect(runFinished({ ...IDLE_RUN, token: 2 }, 1)).toBe(true) // another run took the window over
  })

  it('counts a run as a success only when every statement ran and succeeded', () => {
    expect(runSucceeded({ ...IDLE_RUN, sqls: ['a'], ids: ['s'], states: ['SUCCEEDED'] })).toBe(true)
    expect(runSucceeded({ ...IDLE_RUN, sqls: ['a', 'b'], ids: ['s'], states: ['SUCCEEDED'] })).toBe(false)
    expect(runSucceeded({ ...IDLE_RUN, sqls: ['a'], ids: ['s'], states: ['FAILED'] })).toBe(false)
    expect(runSucceeded({ ...IDLE_RUN, sqls: ['a'], submitError: 'boom' })).toBe(false)
  })
})

describe('runAllWindows', () => {
  const started: string[] = []

  beforeEach(() => {
    stopRunAll()
    useRunStore.getState().clearAll()
    useBatchStore.setState({ active: false, total: 0, finished: 0, summary: null })
    started.length = 0
    let n = 0
    vi.mocked(api.submitQueryAsync).mockReset()
    vi.mocked(api.submitQueryAsync).mockImplementation((body) => {
      started.push(body.sql)
      return Promise.resolve({ statement_id: `st-${++n}`, sql_hash: `h${n}` })
    })
    useCanvasStore.setState({ canvasName: 'c', windows: [] })
  })

  /** What a window's component does: a submitted statement reaches its final state. */
  function finish(id: string, state: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED') {
    const run = useRunStore.getState().runs[id]
    useRunStore.getState().settle(id, run.ids.length - 1, state)
    if (run.scriptActive) useRunStore.getState().endScript(id)
  }

  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('starts the windows nothing waits on, then each window once what it references has finished', async () => {
    useCanvasStore.setState({ windows: [q('top', 'top', 'SELECT * FROM {{base}}'), q('base', 'base', 'SELECT 1')] })
    runAllWindows()
    expect(useBatchStore.getState()).toMatchObject({ active: true, total: 2, finished: 0 })
    expect(Object.keys(useRunStore.getState().runs)).toEqual(['base']) // top waits
    await flush()
    finish('base')
    expect(Object.keys(useRunStore.getState().runs).sort()).toEqual(['base', 'top'])
    await flush()
    finish('top')
    expect(useBatchStore.getState()).toMatchObject({ active: false, finished: 2, summary: 'Ran 2 windows' })
    // The submitted SQL carries the windows map, so {{base}} expands on the server as in a single run.
    expect(api.submitQueryAsync).toHaveBeenCalledTimes(2)
    expect(vi.mocked(api.submitQueryAsync).mock.calls[1][0].windows).toEqual({ top: 'SELECT * FROM {{base}}', base: 'SELECT 1' })
  })

  it('goes on after a failure and reports it', async () => {
    useCanvasStore.setState({ windows: [q('a', 'a', 'SELECT 1'), q('b', 'b', 'SELECT * FROM {{a}}')] })
    runAllWindows()
    await flush()
    finish('a', 'FAILED')
    await flush()
    finish('b')
    expect(useBatchStore.getState().summary).toBe('Ran 2 windows; 1 failed')
  })

  it('runs at most MAX_PARALLEL windows at once', async () => {
    useCanvasStore.setState({ windows: Array.from({ length: 7 }, (_, i) => q(`w${i}`, `w${i}`, `SELECT ${i}`)) })
    runAllWindows()
    expect(Object.keys(useRunStore.getState().runs)).toHaveLength(MAX_PARALLEL)
    await flush()
    finish('w0')
    expect(Object.keys(useRunStore.getState().runs)).toHaveLength(MAX_PARALLEL + 1)
  })

  it('runs every statement of a window with several, in its own component, and finishes when the script does', async () => {
    useCanvasStore.setState({ windows: [q('a', 'a', 'SELECT 1; SELECT 2')] })
    runAllWindows()
    expect(useRunStore.getState().runs.a.sqls).toEqual(['SELECT 1', 'SELECT 2'])
    await flush()
    const s = useRunStore.getState()
    s.settle('a', 0, 'SUCCEEDED')
    s.nextStatement('a')
    expect(useBatchStore.getState().active).toBe(true) // the script is not over
    s.submitted('a', s.runs.a.token, 'st-x', 'hx')
    s.settle('a', 1, 'SUCCEEDED')
    s.endScript('a')
    expect(useBatchStore.getState().summary).toBe('Ran 1 window')
  })

  it('says so when there is nothing to run, and names what it skipped', () => {
    runAllWindows()
    expect(useBatchStore.getState().summary).toBe('No query windows to run.')
    useCanvasStore.setState({ windows: [q('a', 'a', '{{b}}'), q('b', 'b', '{{a}}'), q('f', 'f', 'SELECT 1')] })
    runAllWindows()
    stopRunAll()
    useRunStore.getState().clearAll()
    useCanvasStore.setState({ windows: [q('a', 'a', '{{b}}'), q('b', 'b', '{{a}}')] })
    runAllWindows()
    expect(useBatchStore.getState().summary).toBe('No query window has SQL to run.')
  })

  it('stop cancels what is running on the warehouse and starts nothing more', async () => {
    useCanvasStore.setState({ windows: [q('a', 'a', 'SELECT 1'), q('b', 'b', '{{a}}')] })
    runAllWindows()
    await flush()
    stopRunAll()
    expect(api.cancelQuery).toHaveBeenCalledWith('st-1')
    expect(useBatchStore.getState()).toMatchObject({ active: false, summary: 'Stopped after 0 of 2 windows' })
    expect(Object.keys(useRunStore.getState().runs)).toEqual(['a'])
  })

  it('ends when another canvas is opened', async () => {
    useCanvasStore.setState({ windows: [q('a', 'a', 'SELECT 1'), q('b', 'b', '{{a}}')] })
    runAllWindows()
    await flush()
    useCanvasStore.setState({ canvasName: 'other' })
    finish('a')
    expect(useBatchStore.getState().summary).toMatch(/another canvas was opened/)
    expect(Object.keys(useRunStore.getState().runs)).toEqual(['a'])
  })

  it('does not start a second batch while one is running', () => {
    useCanvasStore.setState({ windows: [q('a', 'a', 'SELECT 1')] })
    runAllWindows()
    runAllWindows()
    expect(api.submitQueryAsync).toHaveBeenCalledTimes(1)
  })
})

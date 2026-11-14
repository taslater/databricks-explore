import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IDLE_RUN, scriptTally, submitStatement, useRunStore } from './runState'
import * as api from '../api/client'

vi.mock('../api/client', () => ({ submitQueryAsync: vi.fn() }))

const run = (id: string) => useRunStore.getState().runs[id] ?? IDLE_RUN

beforeEach(() => {
  useRunStore.getState().clearAll()
  vi.mocked(api.submitQueryAsync).mockReset()
})

describe('run state', () => {
  it('is empty until a run starts, and a fresh read (a remounted window) sees the run that was there', () => {
    expect(run('w1')).toBe(IDLE_RUN)
    const token = useRunStore.getState().begin('w1', ['select 1'])
    useRunStore.getState().submitted('w1', token, 'st-1')
    useRunStore.getState().settle('w1', 0, 'SUCCEEDED')
    expect(run('w1').ids).toEqual(['st-1'])
    expect(run('w1').states).toEqual(['SUCCEEDED'])
    expect(run('w1').submitting).toBe(false)
  })

  it('keeps the statement id of every statement of a script', () => {
    const s = useRunStore.getState()
    const token = s.begin('w1', ['a', 'b', 'c'])
    expect(run('w1').scriptActive).toBe(true)
    s.submitted('w1', token, 's1')
    expect(s.settle('w1', 0, 'SUCCEEDED')).toBe(true)
    s.nextStatement('w1')
    s.submitted('w1', token, 's2')
    s.settle('w1', 1, 'SUCCEEDED')
    s.nextStatement('w1')
    s.submitted('w1', token, 's3')
    s.settle('w1', 2, 'SUCCEEDED')
    s.endScript('w1')
    expect(run('w1').ids).toEqual(['s1', 's2', 's3'])
    expect(scriptTally(run('w1'))).toEqual({ ok: 3, total: 3 })
    expect(run('w1').scriptActive).toBe(false)
    s.setSelected('w1', 0)
    expect(run('w1').selected).toBe(0)
  })

  it('counts a failed statement in the tally and records it only once', () => {
    const s = useRunStore.getState()
    const token = s.begin('w1', ['a', 'b', 'c'])
    s.submitted('w1', token, 's1')
    s.settle('w1', 0, 'SUCCEEDED')
    s.nextStatement('w1')
    s.submitted('w1', token, 's2')
    expect(s.settle('w1', 1, 'FAILED')).toBe(true)
    expect(s.settle('w1', 1, 'FAILED')).toBe(false) // a remount must not advance the script again
    expect(scriptTally(run('w1'))).toEqual({ ok: 1, total: 3 })
  })

  it('ignores a submit answer from an earlier run', () => {
    const s = useRunStore.getState()
    const old = s.begin('w1', ['a'])
    s.begin('w1', ['b'])
    s.submitted('w1', old, 'late')
    expect(run('w1').ids).toEqual([])
    expect(run('w1').submitting).toBe(true)
  })

  it('records a submit answer that arrives while no window is mounted', async () => {
    vi.mocked(api.submitQueryAsync).mockResolvedValue({ statement_id: 'st-9' } as never)
    const token = useRunStore.getState().begin('w1', ['select 1'])
    submitStatement('w1', token, { sql: 'select 1' })
    await vi.waitFor(() => expect(run('w1').ids).toEqual(['st-9']))
    expect(run('w1').submitting).toBe(false)
  })

  it('records a failed submit and stops the script', async () => {
    vi.mocked(api.submitQueryAsync).mockRejectedValue(new Error('no warehouse'))
    const token = useRunStore.getState().begin('w1', ['a', 'b'])
    submitStatement('w1', token, { sql: 'a' })
    await vi.waitFor(() => expect(run('w1').submitError).toBe('no warehouse'))
    expect(run('w1').scriptActive).toBe(false)
    expect(run('w1').submitting).toBe(false)
  })

  it('drops the state of deleted windows, or of every window not kept', () => {
    const s = useRunStore.getState()
    for (const id of ['w1', 'w2', 'w3']) s.begin(id, ['x'])
    s.clearWindows(['w1'])
    expect(Object.keys(useRunStore.getState().runs).sort()).toEqual(['w2', 'w3'])
    s.clearExcept(new Set(['w3']))
    expect(Object.keys(useRunStore.getState().runs)).toEqual(['w3'])
    s.clearAll()
    expect(useRunStore.getState().runs).toEqual({})
  })

  it('keeps the chosen tab and notice with the window', () => {
    const s = useRunStore.getState()
    s.setTab('w1', 'chart')
    s.setNotice('w1', 'Nothing to run.')
    expect(run('w1').tab).toBe('chart')
    expect(run('w1').notice).toBe('Nothing to run.')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AskPoll } from '../api/ask'
import { MAX_POLL_FAILURES, ask, cancel, newConversation } from './askActions'
import { applyPoll, newTurn, pollDelay, useAskStore } from './askStore'
import { openSqlInCanvas } from './canvasAction'
import { useCanvasStore } from '../store/canvasStore'
import { useUiStore } from '../store/uiStore'

function poll(over: Partial<AskPoll> = {}): AskPoll {
  return {
    conversation_id: 'c1',
    response_id: 'r1',
    status: 'in_progress',
    deep_link: null,
    final_answer: null,
    progress_steps: [],
    query_items: [],
    tables: [],
    error: null,
    ...over,
  }
}

describe('applyPoll', () => {
  const t0 = newTurn('t', 'q')

  it('shows progress while running', () => {
    const t = applyPoll(t0, poll({ progress_steps: ['one', 'two'], deep_link: 'https://x/thread' }))
    expect(t.state).toBe('running')
    expect(t.steps).toEqual(['one', 'two'])
    expect(t.deepLink).toBe('https://x/thread')
  })

  it('keeps the steps when the finished poll has none, and takes the answer, SQL and tables', () => {
    const running = applyPoll(t0, poll({ progress_steps: ['one'] }))
    const done = applyPoll(
      running,
      poll({
        status: 'completed',
        final_answer: 'The answer',
        query_items: [{ item_id: 'i1', sql: 'SELECT 1' }],
        tables: [{ name: 'a.b.c', url: 'https://x' }],
      }),
    )
    expect(done.state).toBe('completed')
    expect(done.steps).toEqual(['one'])
    expect(done.answer).toBe('The answer')
    expect(done.items).toEqual([{ item_id: 'i1', sql: 'SELECT 1' }])
    expect(done.tables.map((x) => x.name)).toEqual(['a.b.c'])
  })

  it('maps failed and incomplete and carries the error', () => {
    expect(applyPoll(t0, poll({ status: 'failed', error: 'bad table' }))).toMatchObject({ state: 'failed', error: 'bad table' })
    expect(applyPoll(t0, poll({ status: 'incomplete' })).state).toBe('incomplete')
  })

  it('ignores a late poll for a canceled turn', () => {
    const canceled = { ...t0, state: 'canceled' as const }
    expect(applyPoll(canceled, poll({ status: 'completed', final_answer: 'late' }))).toBe(canceled)
  })
})

describe('pollDelay', () => {
  it('starts at 2 s and eases to 5 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(pollDelay)).toEqual([2000, 2000, 2000, 3000, 4000, 5000, 5000, 5000])
  })
})

describe('openSqlInCanvas', () => {
  beforeEach(() => {
    useCanvasStore.setState({ windows: [] })
    useUiStore.setState({ view: 'ask' })
  })

  it('adds a query window with the SQL and shows the Canvas tab', () => {
    const id = openSqlInCanvas('SELECT 1')
    const win = useCanvasStore.getState().windows.find((w) => w.id === id)
    expect(win).toMatchObject({ type: 'query', sql: 'SELECT 1' })
    // On an empty canvas the corner is under the toolbar and palette, so the window starts clear of them.
    expect(win!.position.x).toBeGreaterThanOrEqual(72)
    expect(win!.position.y).toBeGreaterThanOrEqual(110)
    expect(useUiStore.getState().view).toBe('canvas')
  })

  it('places the next window to the right of the existing ones', () => {
    const first = useCanvasStore.getState().windows
    expect(first).toHaveLength(0)
    openSqlInCanvas('SELECT 1')
    const [w1] = useCanvasStore.getState().windows
    const id = openSqlInCanvas('SELECT 2')
    const w2 = useCanvasStore.getState().windows.find((w) => w.id === id)!
    expect(w2.position.x).toBeGreaterThanOrEqual(w1.position.x + w1.size.w)
  })
})

describe('the turn loop', () => {
  type Handler = (url: string, init?: RequestInit) => unknown
  let handler: Handler
  let calls: { url: string; body: unknown }[]

  function respond(body: unknown, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), { status }))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    useAskStore.getState().clear()
    calls = []
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined })
        return handler(url, init)
      }),
    )
  })

  afterEach(() => {
    newConversation()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const turns = () => useAskStore.getState().turns

  it('asks, polls until completed, and keeps the conversation id for the next question', async () => {
    let polls = 0
    handler = (url) => {
      if (url === '/api/ask') return respond({ conversation_id: 'c1', response_id: 'r1', status: 'in_progress' })
      polls += 1
      return respond(
        polls < 2
          ? poll({ progress_steps: ['looking'] })
          : poll({ status: 'completed', final_answer: 'Done', query_items: [{ item_id: 'i', sql: 'SELECT 1' }] }),
      )
    }
    await ask('  how many?  ')
    expect(turns()[0]).toMatchObject({ question: 'how many?', state: 'running', responseId: 'r1' })
    expect(calls[0]).toEqual({ url: '/api/ask', body: { question: 'how many?' } })

    await vi.advanceTimersByTimeAsync(2000)
    expect(turns()[0]).toMatchObject({ state: 'running', steps: ['looking'] })
    await vi.advanceTimersByTimeAsync(2000)
    expect(turns()[0]).toMatchObject({ state: 'completed', answer: 'Done' })
    const before = calls.length
    await vi.advanceTimersByTimeAsync(20000)
    expect(calls.length).toBe(before) // no polling after the end

    handler = (url) =>
      url === '/api/ask' ? respond({ conversation_id: 'c1', response_id: 'r2', status: 'in_progress' }) : respond(poll())
    await ask('and then?')
    expect(calls.at(-1)?.body).toEqual({ question: 'and then?', conversation_id: 'c1' })
    expect(turns()).toHaveLength(2)
  })

  it('does not start a second turn while one is running, or an empty one', async () => {
    handler = () => respond({ conversation_id: 'c1', response_id: 'r1', status: 'in_progress' })
    await ask('   ')
    expect(turns()).toHaveLength(0)
    await ask('one')
    await ask('two')
    expect(turns()).toHaveLength(1)
  })

  it('shows the server message when the ask is refused', async () => {
    handler = () => respond({ error: 'Genie One refused the request.' }, 403)
    await ask('q')
    expect(turns()[0]).toMatchObject({ state: 'error', error: 'Genie One refused the request.' })
    expect(useAskStore.getState().conversationId).toBeNull()
  })

  it('retries a failed poll and gives up after the limit', async () => {
    handler = (url) =>
      url === '/api/ask' ? respond({ conversation_id: 'c1', response_id: 'r1', status: 'in_progress' }) : respond({ error: 'down' }, 502)
    await ask('q')
    for (let i = 0; i < MAX_POLL_FAILURES - 1; i++) {
      await vi.advanceTimersByTimeAsync(2000)
      expect(turns()[0].state).toBe('running')
    }
    await vi.advanceTimersByTimeAsync(2000)
    expect(turns()[0]).toMatchObject({ state: 'error', error: 'down' })
  })

  it('cancel stops polling and asks the server to stop', async () => {
    handler = (url) =>
      url === '/api/ask' ? respond({ conversation_id: 'c1', response_id: 'r1', status: 'in_progress' }) : respond({ conversation_id: 'c1', cancel_requested: true })
    await ask('q')
    await cancel()
    expect(turns()[0].state).toBe('canceled')
    expect(calls.at(-1)).toEqual({ url: '/api/ask/cancel', body: { conversation_id: 'c1' } })
    const before = calls.length
    await vi.advanceTimersByTimeAsync(20000)
    expect(calls.length).toBe(before)
    await ask('next') // a canceled turn no longer blocks the box
    expect(turns()).toHaveLength(2)
  })

  it('a cancel while the question is still being sent stops the turn once it starts', async () => {
    let release: (r: Response) => void = () => undefined
    handler = (url) =>
      url === '/api/ask'
        ? new Promise<Response>((resolve) => {
            release = resolve
          })
        : respond({ conversation_id: 'c1', cancel_requested: true })
    const pending = ask('q')
    await cancel()
    expect(turns()[0].state).toBe('canceled')
    release(new Response(JSON.stringify({ conversation_id: 'c1', response_id: 'r1', status: 'in_progress' })))
    await pending
    await vi.advanceTimersByTimeAsync(20000)
    expect(turns()[0].state).toBe('canceled')
    expect(calls.map((c) => c.url)).toEqual(['/api/ask', '/api/ask/cancel'])
  })

  it('a failed cancel call is reported on the turn', async () => {
    handler = (url) =>
      url === '/api/ask' ? respond({ conversation_id: 'c1', response_id: 'r1', status: 'in_progress' }) : respond({ error: 'nope' }, 502)
    await ask('q')
    await cancel()
    expect(turns()[0]).toMatchObject({ state: 'canceled', error: 'Genie may still be working: nope' })
  })

  it('new conversation clears the thread and the conversation id', async () => {
    handler = () => respond({ conversation_id: 'c1', response_id: 'r1', status: 'in_progress' })
    await ask('q')
    newConversation()
    expect(turns()).toHaveLength(0)
    expect(useAskStore.getState().conversationId).toBeNull()
    handler = () => respond({ conversation_id: 'c2', response_id: 'r9', status: 'in_progress' })
    await ask('fresh')
    expect(calls.at(-1)?.body).toEqual({ question: 'fresh' })
  })
})

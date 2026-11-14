// What the Ask tab does: start a turn, poll it until it ends, cancel it, start over. The browser polls, not the server.
import { askGenie, cancelAsk, pollAsk } from '../api/ask'
import { applyPoll, isActive, newTurn, pollDelay, useAskStore } from './askStore'

/** Polls that fail in a row before the turn is marked as an error. */
export const MAX_POLL_FAILURES = 3

let counter = 0
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function stopPolling(turnId: string) {
  clearTimeout(timers.get(turnId))
  timers.delete(turnId)
}

function stillActive(turnId: string): boolean {
  const t = useAskStore.getState().turns.find((x) => x.id === turnId)
  return t !== undefined && isActive(t)
}

/** Polls once after the delay for `attempt`, then schedules the next unless the turn ended. */
function schedulePoll(turnId: string, conversationId: string, responseId: string, attempt: number, failures: number) {
  timers.set(
    turnId,
    setTimeout(async () => {
      if (!stillActive(turnId)) return
      try {
        const p = await pollAsk(conversationId, responseId)
        useAskStore.getState().patch(turnId, (t) => applyPoll(t, p))
        failures = 0
      } catch (e) {
        failures += 1
        if (failures >= MAX_POLL_FAILURES) {
          useAskStore.getState().patch(turnId, { state: 'error', error: messageOf(e) })
          return
        }
      }
      if (stillActive(turnId)) schedulePoll(turnId, conversationId, responseId, attempt + 1, failures)
    }, pollDelay(attempt)),
  )
}

/** Asks a question in the open conversation (or starts one) and polls until Genie finishes. Does nothing while a turn runs. */
export async function ask(question: string): Promise<void> {
  const text = question.trim()
  const store = useAskStore.getState()
  if (!text || store.turns.some(isActive)) return
  const id = `turn-${(counter += 1)}`
  store.add(newTurn(id, text))
  try {
    const started = await askGenie(text, store.conversationId)
    const turn = useAskStore.getState().turns.find((t) => t.id === id)
    if (turn) useAskStore.getState().setConversationId(started.conversation_id)
    if (!turn || turn.state === 'canceled') {
      // The thread was cleared, or Cancel was pressed, while the request was out: stop what just started.
      void cancelAsk(started.conversation_id).catch(() => undefined)
      return
    }
    useAskStore.getState().patch(id, { responseId: started.response_id, state: 'running' })
    schedulePoll(id, started.conversation_id, started.response_id, 0, 0)
  } catch (e) {
    useAskStore.getState().patch(id, { state: 'error', error: messageOf(e) })
  }
}

/** Stops the running turn. The turn shows as canceled at once; the server is asked to stop in the background. */
export async function cancel(): Promise<void> {
  const { turns, conversationId, patch } = useAskStore.getState()
  const running = turns.find(isActive)
  if (!running) return
  stopPolling(running.id)
  patch(running.id, { state: 'canceled', error: null })
  if (conversationId) {
    try {
      await cancelAsk(conversationId)
    } catch (e) {
      useAskStore.getState().patch(running.id, { error: `Genie may still be working: ${messageOf(e)}` })
    }
  }
}

/** Clears the thread and forgets the conversation, so the next question starts a new one. A running turn is canceled first. */
export function newConversation(): void {
  void cancel()
  for (const id of [...timers.keys()]) stopPolling(id)
  useAskStore.getState().clear()
}

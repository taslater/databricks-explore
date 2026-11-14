// Session state for the Ask tab: the thread of turns and the open conversation. Nothing is persisted, so a reload clears it.
import { create } from 'zustand'
import type { AskPoll, AskQueryItem, AskTable } from '../api/ask'

export type TurnState = 'starting' | 'running' | 'completed' | 'incomplete' | 'failed' | 'canceled' | 'error'

export interface Turn {
  id: string
  question: string
  responseId: string | null
  state: TurnState
  /** What Genie has done so far. A finished poll may carry none, so earlier steps are kept. */
  steps: string[]
  /** Markdown, untrusted. */
  answer: string | null
  deepLink: string | null
  items: AskQueryItem[]
  tables: AskTable[]
  error: string | null
}

export const isActive = (t: Turn): boolean => t.state === 'starting' || t.state === 'running'

export function newTurn(id: string, question: string): Turn {
  return {
    id,
    question,
    responseId: null,
    state: 'starting',
    steps: [],
    answer: null,
    deepLink: null,
    items: [],
    tables: [],
    error: null,
  }
}

/** The turn after one poll. A turn that was canceled stays canceled when a late poll arrives. */
export function applyPoll(turn: Turn, p: AskPoll): Turn {
  if (turn.state === 'canceled') return turn
  return {
    ...turn,
    state: p.status === 'in_progress' ? 'running' : p.status,
    steps: p.progress_steps.length > 0 ? p.progress_steps : turn.steps,
    answer: p.final_answer ?? turn.answer,
    deepLink: p.deep_link ?? turn.deepLink,
    items: p.query_items.length > 0 ? p.query_items : turn.items,
    tables: p.tables.length > 0 ? p.tables : turn.tables,
    error: p.error,
  }
}

/** Milliseconds to wait before poll number `attempt` (0 is the first): 2 s at first, easing to 5 s. */
export function pollDelay(attempt: number): number {
  return Math.min(5000, 2000 + Math.max(0, attempt - 2) * 1000)
}

interface AskState {
  turns: Turn[]
  /** The open conversation, set by the first answer. Null until then. */
  conversationId: string | null
  add: (turn: Turn) => void
  patch: (id: string, change: Partial<Turn> | ((t: Turn) => Turn)) => void
  setConversationId: (id: string | null) => void
  clear: () => void
}

export const useAskStore = create<AskState>()((set) => ({
  turns: [],
  conversationId: null,
  add: (turn) => set((s) => ({ turns: [...s.turns, turn] })),
  patch: (id, change) =>
    set((s) => ({
      turns: s.turns.map((t) => (t.id !== id ? t : typeof change === 'function' ? change(t) : { ...t, ...change })),
    })),
  setConversationId: (conversationId) => set({ conversationId }),
  clear: () => set({ turns: [], conversationId: null }),
}))

// Ask: types and fetch functions for Genie One questions (contracts/api.md section 7).
import { ApiError } from './client'
import type { QueryResult } from './types'

export type AskStatus = 'in_progress' | 'completed' | 'incomplete' | 'failed'

export interface AskStart {
  conversation_id: string
  response_id: string
  status: AskStatus
}

export interface AskTable {
  /** catalog.schema.table */
  name: string
  url: string
}

export interface AskQueryItem {
  item_id: string
  sql: string
}

export interface AskPoll {
  conversation_id: string
  response_id: string
  status: AskStatus
  deep_link: string | null
  /** Markdown. Untrusted text. */
  final_answer: string | null
  progress_steps: string[]
  query_items: AskQueryItem[]
  tables: AskTable[]
  error: string | null
}

/** The Result shape of POST /api/query, plus what Genie adds. */
export interface AskResult extends QueryResult {
  state: string | null
  /** False while the rows are not available yet. */
  ready: boolean
  total_row_count: number | null
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(path, init)
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const err =
      data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `HTTP ${res.status}`
    throw new ApiError(res.status, err)
  }
  return data as T
}

const enc = encodeURIComponent

/** Starts a turn. Pass the conversation id of an earlier answer for a follow-up. */
export const askGenie = (question: string, conversationId?: string | null) =>
  call<AskStart>('POST', '/api/ask', conversationId ? { question, conversation_id: conversationId } : { question })

/** One upstream poll. The caller repeats it every few seconds until the status is not in_progress. */
export const pollAsk = (conversationId: string, responseId: string) =>
  call<AskPoll>('GET', `/api/ask/poll?conversation_id=${enc(conversationId)}&response_id=${enc(responseId)}`)

export const getAskResult = (conversationId: string, responseId: string, itemId: string) =>
  call<AskResult>(
    'GET',
    `/api/ask/result?conversation_id=${enc(conversationId)}&response_id=${enc(responseId)}&item_id=${enc(itemId)}`,
  )

export const cancelAsk = (conversationId: string) =>
  call<{ conversation_id: string; cancel_requested: boolean }>('POST', '/api/ask/cancel', {
    conversation_id: conversationId,
  })

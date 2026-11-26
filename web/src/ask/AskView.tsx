import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useUiStore } from '../store/uiStore'
import { TurnView } from './TurnView'
import { ask, cancel, newConversation } from './askActions'
import { isActive, useAskStore } from './askStore'

/** Starting points shown before the first question. They only fill the box; the person sends them. */
const EXAMPLES = [
  'Which tables were changed most recently?',
  'How are the main tables related to each other?',
  'Which tables look like they hold customer information?',
]

/** The Ask tab: questions in plain language to Genie One, answered turn by turn in one conversation. */
export function AskView() {
  const turns = useAskStore((s) => s.turns)
  const conversationId = useAskStore((s) => s.conversationId)
  const connected = useUiStore((s) => s.connectedProfile)
  const warehouseId = useUiStore((s) => s.warehouseId)
  const [text, setText] = useState('')
  const thread = useRef<HTMLDivElement>(null)
  const running = turns.some(isActive)

  // Keep the newest progress step and answer in view while the thread grows.
  const last = turns[turns.length - 1]
  useEffect(() => {
    const el = thread.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, last?.steps.length, last?.state])

  function submit() {
    if (!text.trim() || running || !connected) return
    void ask(text)
    setText('')
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter asks, Shift+Enter is a newline. Enter that confirms an input method's composition is left alone.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className="ask-view">
      <div className="ask-toolbar">
        <strong>Ask Genie</strong>
        <span className="hint">
          {conversationId ? 'Follow-up questions stay in this conversation.' : 'Ask about your data in plain language.'}
        </span>
        <span className="spacer" />
        <button onClick={() => newConversation()} disabled={turns.length === 0}>
          New conversation
        </button>
      </div>

      <div className="ask-thread" ref={thread}>
        {turns.length === 0 && (
          <div className="ask-empty hint">
            <p>
              Genie One searches the tables you can read, writes SQL and answers. You can send its SQL to the Canvas, open its tables in
              the Graph and link them to concepts.
            </p>
            <p>Nothing is saved: the conversation lives in this page until you reload it.</p>
          </div>
        )}
        {turns.map((t) => (
          <TurnView key={t.id} turn={t} conversationId={conversationId} />
        ))}
      </div>

      <div className="ask-composer">
        {!connected && <p className="hint">Connect a profile first.</p>}
        {connected && !warehouseId && (
          <p className="hint">No SQL warehouse is selected. Genie runs its queries on the selected warehouse, so pick one in the picker.</p>
        )}
        <div className="ask-examples" role="group" aria-label="Example questions">
          <span className="hint">Try</span>
          {EXAMPLES.map((q) => (
            <button key={q} className="chip-button" disabled={!connected || running} onClick={() => setText(q)}>
              {q}
            </button>
          ))}
        </div>
        <div className="ask-composer-row">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={turns.length ? 'Ask a follow-up (Enter to send, Shift+Enter for a new line)' : 'Ask a question (Enter to send, Shift+Enter for a new line)'}
            aria-label="Question"
            disabled={!connected}
          />
          {running ? (
            <button
              onClick={() => {
                // Cancel undoes the send: the question goes back into the box, so it can be edited or sent again.
                const question = turns.find(isActive)?.question
                void cancel()
                if (question && !text.trim()) setText(question)
              }}
            >
              Cancel
            </button>
          ) : (
            <button className={text.trim() ? 'primary' : undefined} onClick={submit} disabled={!text.trim() || !connected}>
              Ask
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

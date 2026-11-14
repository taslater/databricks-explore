import { AskMarkdown } from './AskMarkdown'
import { SqlItem } from './SqlItem'
import { TableChips } from './TableChips'
import { isActive, type Turn } from './askStore'

const ENDED: Partial<Record<Turn['state'], string>> = {
  incomplete: 'Genie stopped before it had a full answer.',
  failed: 'Genie could not answer this question.',
  canceled: 'Canceled.',
}

/** One question and what came back: progress while it runs, then the answer, its SQL and its tables. */
export function TurnView({ turn, conversationId }: { turn: Turn; conversationId: string | null }) {
  const running = isActive(turn)
  return (
    <article className="ask-turn" aria-label="Question and answer">
      <div className="ask-question">{turn.question}</div>

      {running && (
        <div className="ask-progress" role="status">
          <div className="ask-working">
            {turn.state === 'starting' ? 'Sending the question…' : 'Genie is working…'}
          </div>
          <ul className="plain-list">
            {turn.steps.map((s, i) => (
              <li key={i} className={i === turn.steps.length - 1 ? 'ask-step ask-step-last' : 'ask-step'}>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      {turn.answer && <AskMarkdown text={turn.answer} />}

      {turn.state === 'completed' && !turn.answer && <p className="hint">Genie finished without a written answer.</p>}
      {ENDED[turn.state] && (
        <p className="hint" role="status">
          {ENDED[turn.state]}
        </p>
      )}
      {turn.error && (
        <p className="error" role="alert">
          {turn.error}
        </p>
      )}

      {conversationId &&
        turn.responseId &&
        turn.items.map((item) => (
          <SqlItem key={item.item_id} item={item} conversationId={conversationId} responseId={turn.responseId!} />
        ))}
      <TableChips tables={turn.tables} />
      {turn.deepLink && (
        <a className="ask-deeplink" href={turn.deepLink} target="_blank" rel="noreferrer noopener">
          Open in Databricks
        </a>
      )}
    </article>
  )
}

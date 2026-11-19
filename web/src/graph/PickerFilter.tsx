// The object picker's filter box: the input, the `.*` regex switch, an inline regex error, and match highlighting.
import type { KeyboardEvent, Ref } from 'react'
import { highlightParts, type Range } from './pickerMatch'

export const FILTER_HELP =
  'Not case-sensitive. Names that start with the text come first, then names with a _ part that starts with it, ' +
  'then other matches (dimmed). * matches any run of characters and ? one character; with either, the whole name ' +
  'must match. In Drill-down and Search, dev.schema.name drills by path (Tab completes). ' +
  'The .* button switches to regular expressions.'

interface Props {
  value: string
  onChange: (value: string) => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  placeholder: string
  /** Whether the filter is a regular expression. Undefined hides the switch (Search mode has no regex). */
  regex?: boolean
  onToggleRegex?: () => void
  /** An invalid-regex message to show under the input. */
  error: string | null
  /** The input element, so a list click can give focus back to it. */
  inputRef?: Ref<HTMLInputElement>
}

/** Filter input with the `.*` switch inside its right edge. A red outline and a message mark an invalid regex. */
export function PickerFilter({ value, onChange, onKeyDown, placeholder, regex, onToggleRegex, error, inputRef }: Props) {
  return (
    <div className="pick-filter-wrap">
      <input
        ref={inputRef}
        className={`pick-filter${error ? ' invalid' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        title={FILTER_HELP}
        aria-label="Filter"
        aria-invalid={error ? true : undefined}
        spellCheck={false}
        autoComplete="off"
      />
      {onToggleRegex && (
        <button
          type="button"
          className={`pick-regex${regex ? ' on' : ''}`}
          onClick={onToggleRegex}
          aria-pressed={!!regex}
          aria-label="Use regular expression"
          title={regex ? 'Regular expression (case-insensitive). Click for plain text and globs.' : 'Switch to regular expressions'}
        >
          .*
        </button>
      )}
      {error && <div className="pick-filter-error">{error}</div>}
    </div>
  )
}

/** A name with its matched characters marked. */
export function Highlighted({ name, ranges }: { name: string; ranges: Range[] }) {
  if (ranges.length === 0) return <>{name}</>
  return (
    <>
      {highlightParts(name, ranges).map((p, i) =>
        p.hit ? (
          <mark key={i} className="pick-hit">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

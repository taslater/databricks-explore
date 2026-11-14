import { useEffect, useRef, useState, type CSSProperties } from 'react'

interface Props {
  value: string
  editing: boolean
  /** Called with the final text when editing ends (blur, Escape or Cmd/Ctrl+Enter). */
  onCommit: (value: string) => void
  /** The character that started the edit, when typing did: the editor opens with it and the caret after it. */
  seed?: string | null
  placeholder?: string
  className?: string
  style?: CSSProperties
}

/**
 * A label that shows text and turns into a textarea while `editing`. Enter makes a new line. Blur, Escape or
 * Cmd/Ctrl+Enter ends the edit and keeps the text. Used for shape, sticky, frame and connector labels.
 */
export function InlineText({ value, editing, onCommit, seed, placeholder, className, style }: Props) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) {
      const start = seed ?? null
      setDraft(start ?? value)
      const el = ref.current
      if (el) {
        el.focus()
        if (start === null) {
          el.select()
        } else {
          el.value = start
          el.setSelectionRange(start.length, start.length)
        }
      }
    }
    // Only on entering edit mode. While editing, the draft is the source of truth.
  }, [editing])

  if (!editing) {
    return (
      <div className={`sk-text ${className ?? ''}`} style={style}>
        {value === '' && placeholder ? <span className="sk-placeholder">{placeholder}</span> : value}
      </div>
    )
  }
  return (
    <textarea
      ref={ref}
      className={`sk-text sk-editor nodrag nowheel nopan ${className ?? ''}`}
      style={style}
      value={draft}
      aria-label="Label"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault()
          onCommit(draft)
        }
      }}
    />
  )
}

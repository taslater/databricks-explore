import { useEffect, useRef, useState, type ReactNode } from 'react'

/** The open modal dialogs, oldest first. Only the last one answers Esc. */
const openModals: symbol[] = []

/**
 * What every modal dialog does: Esc closes it (only the topmost one), and when it closes, focus goes back to whatever had it
 * when the dialog opened. Pass `active = false` while a dialog that is always mounted is closed.
 */
export function useModalBehavior(onClose: () => void, active = true) {
  const latest = useRef(onClose)
  latest.current = onClose
  useEffect(() => {
    if (!active) return
    const id = Symbol('modal')
    openModals.push(id)
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || openModals[openModals.length - 1] !== id) return
      e.stopPropagation()
      e.preventDefault()
      latest.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      openModals.splice(openModals.indexOf(id), 1)
      if (opener && opener !== document.body && opener.isConnected) opener.focus()
    }
  }, [active])
}

function Frame({ title, onCancel, children }: { title: string; onCancel: () => void; children: ReactNode }) {
  useModalBehavior(onCancel)
  return (
    <div className="modal-backdrop app-dialog-backdrop" role="presentation" onMouseDown={onCancel}>
      <div data-surface="overlay" className="modal app-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

export interface ConfirmDialogProps {
  title: string
  message: ReactNode
  /** Names the action: "Discard", "Delete", "Replace". Never "OK". */
  confirmLabel: string
  /** Styles the confirm button as destructive. */
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Asks before something that cannot be taken back. Focus starts on the confirm button, so Enter confirms and Esc cancels. */
export function ConfirmDialog({ title, message, confirmLabel, destructive = false, onConfirm, onCancel }: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => confirmRef.current?.focus(), [])
  return (
    <Frame title={title} onCancel={onCancel}>
      <p className="app-dialog-message">{message}</p>
      <div className="app-dialog-actions">
        <button onClick={onCancel}>Cancel</button>
        <button ref={confirmRef} className={destructive ? 'app-dialog-danger' : 'app-dialog-primary'} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Frame>
  )
}

export interface NameDialogProps {
  title: string
  label: string
  initial?: string
  /** An error to show when the dialog opens, for example the reason an earlier try was refused. */
  initialError?: string | null
  placeholder?: string
  confirmLabel?: string
  /** Turns the typed text into the name that is used. The converted name is shown under the field as it changes. */
  convert?: (typed: string) => string
  /** What the preview line says about the converted name, for example "Saved as returns-tour". Omit for no preview. */
  previewText?: (name: string) => string
  /** Gets the converted name. Returns an error message to keep the dialog open, or null to close it. */
  onSubmit: (name: string) => Promise<string | null> | string | null
  onCancel: () => void
}

/** Asks for a name. Enter saves, Esc cancels, and a refusal shows under the field without closing the dialog. */
export function NameDialog({
  title,
  label,
  initial = '',
  initialError = null,
  placeholder,
  confirmLabel = 'Save',
  convert = (s) => s.trim(),
  previewText,
  onSubmit,
  onCancel,
}: NameDialogProps) {
  const [typed, setTyped] = useState(initial)
  const [error, setError] = useState<string | null>(initialError)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const name = convert(typed)
  useEffect(() => inputRef.current?.select(), [])

  async function submit() {
    if (name === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      setError(await onSubmit(name))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Frame title={title} onCancel={onCancel}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="app-dialog-field">
          <span>{label}</span>
          <input
            ref={inputRef}
            autoFocus
            value={typed}
            placeholder={placeholder}
            disabled={busy}
            onChange={(e) => {
              setTyped(e.target.value)
              setError(null)
            }}
          />
        </label>
        {previewText && (
          <p className="hint app-dialog-preview" data-testid="name-preview">
            {name === '' ? 'Type a name.' : previewText(name)}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="app-dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="app-dialog-primary" disabled={name === '' || busy}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Frame>
  )
}

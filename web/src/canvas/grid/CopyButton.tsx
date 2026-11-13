import { useEffect, useRef, useState } from 'react'
import { writeClipboard } from './clipboard'

/** Small "Copy" button for a piece of text (an error message, a summary). Shows "Copied" for a moment. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy() {
    setState((await writeClipboard(text)) ? 'copied' : 'failed')
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 1500)
  }

  return (
    <button className="qw-copy nodrag" onClick={() => void copy()} title="Copy to clipboard">
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </button>
  )
}

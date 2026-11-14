import Markdown, { type Components } from 'react-markdown'

// Genie's answer is untrusted text. react-markdown builds React elements and never injects HTML: raw tags in the
// text are shown as text, and its default URL filter drops javascript: and data: links. Links open in a new tab.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
}

/** An answer as safe Markdown. */
export function AskMarkdown({ text }: { text: string }) {
  return (
    <div className="ask-md">
      <Markdown components={components}>{text}</Markdown>
    </div>
  )
}

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AskMarkdown } from './AskMarkdown'

const html = (text: string) => renderToStaticMarkup(<AskMarkdown text={text} />)

describe('AskMarkdown', () => {
  it('renders bold, lists, code and links', () => {
    const out = html('The **orders** table has `n` rows.\n\n- a\n- b\n\n```sql\nSELECT 1\n```\n\n[docs](https://example.com/x)')
    expect(out).toContain('<strong>orders</strong>')
    expect(out).toContain('<code>n</code>')
    expect(out).toContain('<li>a</li>')
    expect(out).toContain('<pre><code class="language-sql">SELECT 1\n</code></pre>')
  })

  it('opens links in a new tab without a referrer', () => {
    expect(html('[x](https://example.com/p?a=1)')).toContain('<a href="https://example.com/p?a=1" target="_blank" rel="noreferrer noopener">x</a>')
  })

  it('never emits raw HTML elements from the text', () => {
    const out = html('hi <script>alert(1)</script> <img src=x onerror="alert(2)"> <iframe src="https://evil"></iframe>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<iframe')
    expect(out).toContain('&lt;script&gt;') // shown as text
  })

  it('drops javascript: and data: link targets', () => {
    expect(html('[a](javascript:alert(1))')).not.toContain('javascript:')
    expect(html('[b](data:text/html;base64,PHNjcmlwdD4=)')).not.toContain('data:')
  })
})

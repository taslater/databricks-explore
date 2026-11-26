// Vega-Lite config from the design tokens, read from the page when a chart renders, so a chart matches the theme in force (light or dark).
import type { ComponentProps } from 'react'
import type { VegaEmbed } from 'react-vega'

type EmbedOptions = NonNullable<ComponentProps<typeof VegaEmbed>['options']>

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** Embed options for a chart: canvas renderer, transparent background, text, axes and marks in token colours. Read again on a theme change. */
export function vegaOptions(): EmbedOptions {
  const text = token('--text')
  const muted = token('--muted')
  const grid = token('--border')
  const axis = { labelColor: muted, titleColor: text, domainColor: token('--grey-300'), tickColor: token('--grey-300'), gridColor: grid }
  return {
    renderer: 'canvas',
    config: {
      background: 'transparent',
      view: { stroke: 'transparent' },
      axis,
      legend: { labelColor: muted, titleColor: text },
      title: { color: text },
      header: { labelColor: muted, titleColor: text },
      mark: { color: token('--accent') },
      range: { category: ['--accent', '--orange', '--ok', '--purple', '--danger', '--warn', '--accent-strong', '--grey-300'].map(token) },
    },
  }
}

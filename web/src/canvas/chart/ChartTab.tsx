import { useMemo, useState, type ComponentProps } from 'react'
import { VegaEmbed } from 'react-vega'
import type { QueryResult } from '../../api/types'
import { useCanvasStore } from '../../store/canvasStore'
import { ChartPickerFields } from './ChartPicker'
import {
  buildSpec,
  chartColumns,
  missingFields,
  parseSpecJson,
  pickerFromSpec,
  renderSpec,
  type PickerState,
} from './chartSpec'

type VegaProps = ComponentProps<typeof VegaEmbed>

const VEGA_OPTIONS: VegaProps['options'] = { renderer: 'canvas' }
const TEMPLATE_SPEC = { mark: 'bar', encoding: {} }

interface ChartTabProps {
  windowId: string
  /** The last successful run, or null when there is no result to chart. */
  result: QueryResult | null
}

/**
 * Chart tab of a query window. The window's `chart.vega_lite` in the canvas store is the source of truth.
 * The picker and the JSON editor both write it. Rows are injected at render time, not stored.
 */
export function ChartTab({ windowId, result }: ChartTabProps) {
  const spec = useCanvasStore((s) => s.windows.find((w) => w.id === windowId)?.chart?.vega_lite ?? null)
  const setChartSpec = useCanvasStore((s) => s.setChartSpec)
  const columns = useMemo(() => chartColumns(result?.columns ?? []), [result])

  const [mode, setMode] = useState<'picker' | 'json'>('picker')
  const [picker, setPicker] = useState<PickerState>(() => pickerFromSpec(spec, columns))
  // A new run can bring new columns. Re-read the picker from the stored spec when that happens.
  const [pickerColumns, setPickerColumns] = useState(columns)
  if (pickerColumns !== columns) {
    setPickerColumns(columns)
    setPicker(pickerFromSpec(spec, columns))
  }
  const [draft, setDraft] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  // Tagged with the spec it failed on, so an error from an old spec is not shown for a new one.
  const [renderError, setRenderError] = useState<{ spec: unknown; message: string } | null>(null)

  const rendered = useMemo(
    () =>
      spec !== null && result !== null && columns.length > 0 ? renderSpec(spec, columns, result.rows) : null,
    [spec, columns, result],
  )

  if (result === null || columns.length === 0) {
    return (
      <div className="qw-chart-tab nodrag">
        <div className="hint">
          {result === null ? 'Run the query to chart its results.' : 'The last run returned no result set to chart.'}
        </div>
      </div>
    )
  }

  const missing = spec !== null ? missingFields(spec, columns) : []

  function changePicker(next: PickerState) {
    setPicker(next)
    // Incomplete picks (no x or y) clear the chart. The picker keeps its own state.
    setChartSpec(windowId, buildSpec(next, columns))
  }

  function openJson() {
    setDraft(JSON.stringify(spec ?? TEMPLATE_SPEC, null, 2))
    setJsonError(null)
    setMode('json')
  }

  function openPicker() {
    // Invalid text in the draft is dropped. The chart keeps the last valid spec.
    setPicker(pickerFromSpec(spec, columns))
    setMode('picker')
  }

  function editJson(text: string) {
    setDraft(text)
    const parsed = parseSpecJson(text)
    if (parsed.ok) {
      setJsonError(null)
      setChartSpec(windowId, parsed.spec)
    } else {
      setJsonError(parsed.error)
    }
  }

  let message: string | null = null
  if (missing.length > 0) message = `Not in the current results: ${missing.join(', ')}. Pick columns again.`

  return (
    <div className="qw-chart-tab nodrag">
      <div className="qw-chart-controls">
        {mode === 'picker' && <ChartPickerFields columns={columns} value={picker} onChange={changePicker} />}
        <button type="button" aria-pressed={mode === 'json'} onClick={mode === 'json' ? openPicker : openJson}>
          Edit JSON
        </button>
      </div>

      {mode === 'json' && (
        <textarea
          className="qw-json"
          spellCheck={false}
          aria-label="Vega-Lite spec"
          value={draft}
          onChange={(e) => editJson(e.target.value)}
        />
      )}
      {mode === 'json' && jsonError !== null && (
        <div className="error">{jsonError} The chart keeps the last valid spec.</div>
      )}
      {message !== null && <div className="error">{message}</div>}

      <div className="qw-chart-pane">
        {rendered === null ? (
          <div className="hint">No chart yet. Choose x and y, or enter a spec with Edit JSON.</div>
        ) : (
          <>
            {renderError !== null && renderError.spec === rendered && (
              <div className="error">Chart error: {renderError.message}</div>
            )}
            <VegaEmbed
              className="qw-chart-canvas"
              spec={rendered as VegaProps['spec']}
              options={VEGA_OPTIONS}
              onError={(err: unknown) =>
                setRenderError({ spec: rendered, message: err instanceof Error ? err.message : String(err) })
              }
            />
          </>
        )}
      </div>
    </div>
  )
}

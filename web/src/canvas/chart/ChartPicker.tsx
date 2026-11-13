import { CHART_MARKS, type ChartColumn, type ChartMark, type PickerState } from './chartSpec'

interface ChartPickerFieldsProps {
  columns: ChartColumn[]
  value: PickerState
  onChange: (next: PickerState) => void
}

/** Mark, x, y, and optional color selects. Column choices come from the last run's columns. */
export function ChartPickerFields({ columns, value, onChange }: ChartPickerFieldsProps) {
  return (
    <>
      <label>
        Mark
        <select value={value.mark} onChange={(e) => onChange({ ...value, mark: e.target.value as ChartMark })}>
          {CHART_MARKS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <ColumnSelect label="X" value={value.x} columns={columns} onChange={(x) => onChange({ ...value, x })} />
      <ColumnSelect label="Y" value={value.y} columns={columns} onChange={(y) => onChange({ ...value, y })} />
      <ColumnSelect
        label="Color"
        optional
        value={value.color}
        columns={columns}
        onChange={(color) => onChange({ ...value, color })}
      />
    </>
  )
}

function ColumnSelect({
  label,
  value,
  columns,
  optional = false,
  onChange,
}: {
  label: string
  value: string
  columns: ChartColumn[]
  optional?: boolean
  onChange: (key: string) => void
}) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{optional ? '(none)' : 'Choose...'}</option>
        {columns.map((c) => (
          <option key={c.key} value={c.key}>
            {`${c.name} (${c.kind})`}
          </option>
        ))}
      </select>
    </label>
  )
}

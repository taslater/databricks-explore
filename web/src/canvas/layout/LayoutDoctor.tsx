import { useCallback, useEffect, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { layoutDoctor, layoutTidy, type LayoutIssue, type LayoutReport, type TidyRule } from '../../api/layout'
import { useSketchStore } from '../../sketch/sketchStore'
import { appliedNote, applyChanges, currentDoc, currentGrid, plural } from './layoutActions'
import { useLayoutUi } from './layoutStore'

const SEVERITY_LABEL = { error: 'Errors', warning: 'Warnings', info: 'Notes' } as const

function scoreClass(score: number): string {
  return score >= 90 ? 'ld-good' : score >= 70 ? 'ld-fair' : 'ld-poor'
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The issues panel: the layout score, each issue with a Fix when there is one, and Tidy all. */
export function LayoutDoctor() {
  const setPanelOpen = useLayoutUi((s) => s.setPanelOpen)
  const setNote = useLayoutUi((s) => s.setNote)
  const note = useLayoutUi((s) => s.note)
  const select = useSketchStore((s) => s.select)
  const selectedIds = useSketchStore((s) => s.selectedIds)
  const { fitView } = useReactFlow()
  const [report, setReport] = useState<LayoutReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)

  const check = useCallback(async () => {
    setBusy(true)
    try {
      setReport(await layoutDoctor(currentDoc(), currentGrid()))
    } catch (e) {
      setNote(errorText(e), true)
    } finally {
      setBusy(false)
    }
  }, [setNote])

  // Checking runs when the panel opens. Edits afterwards make it stale, so there is a Check again button.
  useEffect(() => {
    void check()
  }, [check])

  async function tidy(opts: { ids?: string[]; rules?: TidyRule[] }) {
    setBusy(true)
    try {
      const out = await layoutTidy(currentDoc(), { ...opts, grid: currentGrid() })
      const count = applyChanges(out.changes)
      setNote(appliedNote(count, out.score.before, out.score.after))
      setReport(await layoutDoctor(currentDoc(), currentGrid()))
    } catch (e) {
      setNote(errorText(e), true)
    } finally {
      setBusy(false)
    }
  }

  function show(issue: LayoutIssue) {
    setPicked(issue.id)
    select(issue.nodes, issue.edges ?? [])
    void fitView({ nodes: issue.nodes.map((id) => ({ id })), padding: 0.5, maxZoom: 1, duration: 250 })
  }

  const groups = (['error', 'warning', 'info'] as const).map((sev) => ({
    sev,
    issues: report?.issues.filter((i) => i.severity === sev) ?? [],
  }))

  return (
    <div className="ld-panel nowheel nopan" role="region" aria-label="Layout doctor">
      <div className="ld-head">
        <div className={`ld-score ${report ? scoreClass(report.score) : ''}`} aria-label="Layout score">
          {report ? report.score : '–'}
          <span>/100</span>
        </div>
        <div className="ld-summary">
          {report ? (
            <>
              <div>
                {plural(report.issues.length, 'issue')} in {plural(report.metrics.node_count, 'node')}
              </div>
              <div className="hint">
                overlap {Math.round(report.metrics.overlap_area)} px², crossings {report.metrics.edge_crossings}
              </div>
            </>
          ) : (
            <div className="hint">{busy ? 'Checking…' : 'Not checked'}</div>
          )}
        </div>
        <button className="ld-close" onClick={() => setPanelOpen(false)} aria-label="Close the doctor" title="Close">
          &times;
        </button>
      </div>
      <div className="ld-actions">
        <button disabled={busy} onClick={() => void tidy({})} title="Apply every automatic fix with the smallest moves">
          Tidy all
        </button>
        <button disabled={busy} onClick={() => void check()}>
          Check again
        </button>
        {selectedIds.length > 0 && (
          <button
            disabled={busy}
            onClick={() => void tidy({ ids: selectedIds })}
            title="Tidy, moving only the selected nodes"
          >
            Tidy selection
          </button>
        )}
      </div>
      {note && <div className={note.error ? 'error ld-note' : 'hint ld-note'} role={note.error ? 'alert' : undefined}>{note.text}</div>}
      <div className="ld-list">
        {report && report.issues.length === 0 && <div className="hint">No layout issues.</div>}
        {groups.map(
          (g) =>
            g.issues.length > 0 && (
              <section key={g.sev}>
                <h4>{SEVERITY_LABEL[g.sev]}</h4>
                {g.issues.map((issue) => (
                  <div key={issue.id} className={`ld-issue ld-${issue.severity}${picked === issue.id ? ' picked' : ''}`}>
                    <button className="ld-issue-text" onClick={() => show(issue)} title="Select these nodes">
                      {issue.message}
                    </button>
                    {issue.fix && (
                      <button
                        disabled={busy}
                        onClick={() => void tidy({ ids: issue.fix?.ids, rules: issue.fix?.rules })}
                        title={`Fix with: ${issue.fix.rules.join(', ')}`}
                      >
                        Fix
                      </button>
                    )}
                  </div>
                ))}
              </section>
            ),
        )}
      </div>
    </div>
  )
}

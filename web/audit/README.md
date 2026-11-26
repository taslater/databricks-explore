# UI auditor

A deterministic crawler that finds generic UI defects in the demo-mode app. No LLM, no feature knowledge: it clicks controls
as a real user would (mouse at the control's centre), replays each path from a clean browser, and compares states.

Run: `cd web && npm run audit` (builds the UI first; about 25 minutes). Output in `web/audit-out/`:
`ui-findings.json`, `graph.json` (states and edges per crawl), `screens/` (one screenshot per state).
It is a reporter, not a gate: the test passes whatever it finds.

## What it crawls
Each top-level view (Canvas, Graph, Concepts, Ask, and the Agent access dialog) is its own start state with its own budget
(depth 3, up to 40 states, 45 crawl actions, 20 return attempts and 8 toggle replays), at 1500x900 and again at 1280x720.
The top-level tabs are roots, so they are not clicked inside a crawl. Override the budget with `AUDIT_ACTIONS`, `AUDIT_STATES`,
`AUDIT_DEPTH`, `AUDIT_EXTRA`, `AUDIT_TOGGLES`. Findings are deduplicated across roots and viewports; `where` lists each place one appeared.

## Rules
| rule | severity | meaning |
| --- | --- | --- |
| irreversible-transition | high | action takes A to B and no way back to A within 2 actions was found |
| toggle-not-undoable | high | a control whose label or pressed/expanded state changed (a toggle) is clicked again in B, at its centre, and does not lead back to A; reports what the click hit |
| occluded-control | high | another element covers the centre of a control (modal backdrops are ignored) |
| only-obscure-exit | medium | B gets back to A only through Escape or a control not visible in A at the same screen position |
| overlapping-controls | medium | two controls' boxes intersect (neither contains the other) |
| offscreen-control | medium | a control is partly outside the viewport |
| escape-does-nothing | low | B has a dialog, menu, listbox, aria-expanded=true or aria-pressed=true control that A lacked, and Escape changes nothing |
| clipped-text | low | text is wider than its box with no ellipsis |
| small-target | info | under 24x24 px; does not count toward the score |

Score is 100 minus 10 per high, 4 per medium, 1 per low finding (floor 0).
`summary.perCrawl[].unverified` lists the edges whose way back could not be fully checked (return-attempt budget used up), with the reason.

## Using ui-findings.json
1. Read `summary.rootCauses`: occluded and overlapping findings grouped by the element on top (class list, testid, nearest labelled ancestor), biggest first. Fix the top cause first; one CSS change usually clears many findings. Each has `examples`, a `repro` and a `screenshot`.
2. Then `findings` (sorted by severity, then by how many roots/viewports saw it). `repro` is the click path from the root's start state; `screenshot` is relative to `web/audit-out/`.
3. Fix in app code, rerun, and compare `findingsByRule`. Treat a finding as a crawler artefact if `repro` does not reproduce by hand.

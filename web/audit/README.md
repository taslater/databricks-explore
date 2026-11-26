# UI auditor

A deterministic crawler that finds generic UI defects in the demo-mode app. No LLM, no feature knowledge: it clicks controls
as a real user would (mouse at the control's centre), replays each path from a clean browser, and compares states.

Run: `cd web && npm run audit` (builds the UI first; about 2.5 minutes on 8 cores, down from about 23 serially). Output in `web/audit-out/`:
`ui-findings.json`, `graph.json` (states and edges per crawl), `screens/` (one screenshot per state).
It is a reporter, not a gate: the test passes whatever it finds.

## How it runs
One Playwright test per (root, viewport), spread over `AUDIT_WORKERS` workers (default: the CPU count, at most 10). Each worker starts its own demo server (own port and data folder) from a worker-scoped fixture; each crawl writes `audit-out/parts/<crawl>.json`, and the global teardown merges the parts, in crawl order, into `ui-findings.json` and `graph.json` with the same dedupe and scoring as a serial run. A crawl keeps one browser context and opens a new page (storage of the origin cleared) per reset. A page has settled when none of its requests is pending and the DOM has not mutated for 150 ms (3 s cap). `summary.timing` (and `perCrawl[].timing`) shows where the time went: reset, replay, act, settle (overlaps the others), snapshot, screenshot.

## What it crawls
Each top-level view (Canvas, Graph, Concepts, Ask, and the Agent access dialog) is its own start state with its own budget
(depth 3, up to 40 states, 45 crawl actions, 20 return attempts and 8 toggle replays), at 1500x900 and again at 1280x720.
The top-level tabs are roots, so they are not clicked inside a crawl. Override the budget with `AUDIT_ACTIONS`, `AUDIT_STATES`,
`AUDIT_DEPTH`, `AUDIT_EXTRA`, `AUDIT_TOGGLES`. Findings are deduplicated across roots and viewports; `where` lists each place one appeared.

## Rules
| rule | severity | meaning |
| --- | --- | --- |
| irreversible-transition | high | action takes A to B and no way back to A within 2 actions was found; the finding says what B has that A lacks |
| toggle-not-undoable | high | a control whose label or pressed/expanded state changed (a toggle) is clicked again in B, at its centre, and does not lead back to A; reports what the click hit and how the result differs from A |
| occluded-control | high | another element covers the centre of the visible part of a control |
| only-obscure-exit | medium | B gets back to A only through Escape or a control not visible in A at the same screen position. Not obscure: a dialog's own buttons (B opened a dialog A lacked), the opener of a dialog that A had and B closed, a control labelled Close, Cancel, Done, Back, Undo or Restore, and the opposite of a control A shows (Hide X / Show X, Open / Close, Expand / Collapse, Maximize / Restore, Zoom In / Zoom Out). Before reporting, B's other actions are tried (opposite first), because the way-back search stops at the first exit it finds, often Escape. `confidence` is `low` when B still has untried actions |
| overlapping-controls | medium | two controls' boxes intersect (neither contains the other) |
| offscreen-control | medium | a control is partly outside the viewport |
| escape-does-nothing | low (confidence low) | B has a dialog, menu, listbox, popover or aria-haspopup control with aria-expanded=true that A lacked, and Escape changes nothing (plain pressed toggles and expanders are not expected to close on Escape) |
| clipped-text | low | text is wider than its box with no ellipsis |
| small-target | info | under 24x24 px; does not count toward the score |

## Comparing states
States in the crawl graph are keyed by a strict signature (every control with its name and pressed/expanded state). Whenever a state is compared with A (is B back at A, is a toggle undone, is a transition irreversible) the comparison is **loose**: states are the same if they differ only in selection, meaning aria-selected, a "selected" class on the control or an ancestor, resize handles, and controls that are enabled in one state and disabled in the other (clicking inside a window selects it, which enables Duplicate and Delete and shows handles). A control that is part of the selection may appear or vanish without counting. Findings say what differed (`only before: ...`, `only after: ...`); an only-obscure-exit lists what a loose match overlooked. `graph.json` keeps each state's full control list (`controls`, with `[disabled]` and `[selection]` marks) so a difference can be checked by hand.

## Reset
Every action replays from a clean browser context and emptied server stores (`canvases`, `canvas_history`, `diagrams`, `diagram_history`, `relationships`, which holds concepts). A store missing from that list makes every later reset start somewhere else: Concepts at 1500x900 once logged about 100 reset failures because the concepts a click had saved were still there. `summary.perCrawl[].resetFailures` counts mismatches and `resetDiffs` shows what the start state had extra or lacked. `AUDIT_ROOTS=Concepts,Canvas` and `AUDIT_VIEWPORTS=1500` narrow a run.

## Measurement
- A control counts as visible only if part of its box shows inside every ancestor that clips (overflow other than visible, clip-path, contain:paint) and the viewport, and it is not inert, aria-hidden, visibility:hidden or opacity 0. Occlusion tests and clicks use the centre of the visible part.
- When modal dialogs are open (aria-modal, or a role=dialog inside a backdrop), only controls inside the topmost one are active; the rest are out of scope for actions and for occlusion/overlap checks.

## Score
Severity weights are 10 high, 4 medium, 1 low, 0 info. Each distinct root cause counts once: findings with an occluder (occluded and overlapping) are grouped by occluder and a group counts once, at its highest severity; every other finding counts once. Findings the rule labels `confidence: low` (an only-obscure-exit whose B still had untried actions; every escape-does-nothing, a heuristic) count a quarter of their weight, and all of them together at most 15, so a pile of uncertain findings cannot drive the score to 1. Info findings weigh 0. With T the weighted total, score = round(100 * exp(-T / 50)): 100 is clean, about 82 at T=10, 37 at T=50, 13 at T=100; the low-confidence ceiling alone costs at most 26 points (score 74 at T=15). `summary.weightedCauses` is T, `summary.lowConfidenceFindings` and `lowConfidenceWeight` show the low-confidence part. Expected findings (below) are excluded. `summary.weightedCauses` is T.

## Expected behaviour (`audit/expected.json`)
A list of `{rule, control, root?, viewport?, reason}`. `control` is the control's name (the text between the quotes in `control`) or a `/regex/` tested against the name and the whole label; `root` and `viewport` narrow it. `irreversible-transition` also matches the first click of the repro, since one one-way action shows up under each state it leads to. `reason` is required; a malformed entry or one without a reason fails the run before it starts.
Matching findings stay in `ui-findings.json` with `"expected": true` and `expectedReason`, are counted in `summary.expectedByRule` and not in `findingsByRule` or the score. Entries that match nothing are listed in `summary.staleExpected`: delete them.
Adding an entry is the maintainer's decision, not a fixing agent's. An agent that thinks a finding is by design says so in its report and leaves the file alone.
`summary.perCrawl[].unverified` lists the edges whose way back could not be fully checked (return-attempt budget used up), with the reason.

## Using ui-findings.json
1. Read `summary.rootCauses`: occluded and overlapping findings grouped by the element on top (class list, testid, nearest labelled ancestor), biggest first. Fix the top cause first; one CSS change usually clears many findings. Each has `examples`, a `repro` and a `screenshot`.
2. Then `findings` (sorted by severity, then by how many roots/viewports saw it). `repro` is the click path from the root's start state; `screenshot` is relative to `web/audit-out/`.
3. Fix in app code, rerun, and compare `findingsByRule`. Treat a finding as a crawler artefact if `repro` does not reproduce by hand.

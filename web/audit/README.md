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
| occluded-control | high | another element covers the centre of the visible part of a control |
| only-obscure-exit | medium | B gets back to A only through Escape or a control not visible in A at the same screen position (when B opened a dialog A lacked, the dialog's own buttons are the expected exit) |
| overlapping-controls | medium | two controls' boxes intersect (neither contains the other) |
| offscreen-control | medium | a control is partly outside the viewport |
| escape-does-nothing | low | B has a dialog, menu, listbox, popover or aria-haspopup control with aria-expanded=true that A lacked, and Escape changes nothing (plain pressed toggles and expanders are not expected to close on Escape) |
| clipped-text | low | text is wider than its box with no ellipsis |
| small-target | info | under 24x24 px; does not count toward the score |

## Measurement
- A control counts as visible only if part of its box shows inside every ancestor that clips (overflow other than visible, clip-path, contain:paint) and the viewport, and it is not inert, aria-hidden, visibility:hidden or opacity 0. Occlusion tests and clicks use the centre of the visible part.
- When modal dialogs are open (aria-modal, or a role=dialog inside a backdrop), only controls inside the topmost one are active; the rest are out of scope for actions and for occlusion/overlap checks.

## Score
Severity weights are 10 high, 4 medium, 1 low, 0 info. Each distinct root cause counts once: findings with an occluder (occluded and overlapping) are grouped by occluder and a group counts once, at its highest severity; every other finding counts once. With T the weighted total, score = round(100 * exp(-T / 50)): 100 is clean, about 82 at T=10, 37 at T=50, 13 at T=100. Expected findings (below) are excluded. `summary.weightedCauses` is T.

## Expected behaviour (`audit/expected.json`)
A list of `{rule, control, root?, viewport?, reason}`. `control` is the control's name (the text between the quotes in `control`) or a `/regex/` tested against the name and the whole label; `root` and `viewport` narrow it. `irreversible-transition` also matches the first click of the repro, since one one-way action shows up under each state it leads to. `reason` is required; a malformed entry or one without a reason fails the run before it starts.
Matching findings stay in `ui-findings.json` with `"expected": true` and `expectedReason`, are counted in `summary.expectedByRule` and not in `findingsByRule` or the score. Entries that match nothing are listed in `summary.staleExpected`: delete them.
Adding an entry is the maintainer's decision, not a fixing agent's. An agent that thinks a finding is by design says so in its report and leaves the file alone.
`summary.perCrawl[].unverified` lists the edges whose way back could not be fully checked (return-attempt budget used up), with the reason.

## Using ui-findings.json
1. Read `summary.rootCauses`: occluded and overlapping findings grouped by the element on top (class list, testid, nearest labelled ancestor), biggest first. Fix the top cause first; one CSS change usually clears many findings. Each has `examples`, a `repro` and a `screenshot`.
2. Then `findings` (sorted by severity, then by how many roots/viewports saw it). `repro` is the click path from the root's start state; `screenshot` is relative to `web/audit-out/`.
3. Fix in app code, rerun, and compare `findingsByRule`. Treat a finding as a crawler artefact if `repro` does not reproduce by hand.

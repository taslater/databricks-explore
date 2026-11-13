# Databricks Explorer (v0.4)

Local Flask app plus a React UI to browse Unity Catalog, draw relationships (lineage, FKs, view deps), and build query canvases.

## Run
Build the frontend once (and again after frontend changes), then start the server.
```sh
cd web && npm ci && npm run build && cd ..
uv run --with-requirements requirements.txt app.py
# open http://127.0.0.1:8765
```

Dev mode with hot reload: run the server as above, then in a second terminal `cd web && npm run dev` and open http://127.0.0.1:5173 (Vite proxies `/api` to the Flask server).

## Run without Databricks
Demo mode serves invented catalogs, tables, views, foreign keys, lineage and query results from a fake workspace. It never contacts Databricks, so it is safe for trying the UI, screenshots and tests.
```sh
uv run --with-requirements requirements.txt app.py --demo
# open http://127.0.0.1:8766, pick profile "demo", Connect, pick warehouse "Demo Serverless"
```
`EXPLORER_DEMO=1` does the same as `--demo`. Demo mode listens on port 8766 (`PORT` overrides) so the browser keeps its saved profile apart from real use, and it writes to `data-demo/` instead of `data/`.

Magic words in a query (the rest of the SQL is ignored; any query returns a result):

| Word | Result |
|---|---|
| `demo_slow` | stays running for 45 seconds, to test Cancel and the timer |
| `demo_error` | fails with a table-not-found message |
| `demo_wide` | a 60-column result |
| `demo_big` | 50,000 rows, so the 5,000-row cap and the truncated badge show |

Otherwise the result follows the first demo table named in the SQL (`demo.sales.orders` by default: 3,000 rows with ids, timestamps, dates, decimals, nulls, empty strings and long text). `GROUP BY` or `count(` gives a daily series for the Chart tab. A trailing `LIMIT n` is honored.

`EXPLORER_DATA_DIR` moves everything the app writes (cache, logs, diagrams, canvases) to another folder. It defaults to `data/`, or `data-demo/` in demo mode.

## Use
- Top bar: pick a profile and **Connect** (browser login if needed). Pick a SQL warehouse to enable queries on the canvas and search across all catalogs.
- **Graph** tab
  - Picker modes (remembered): **Drill-down**, **Tree**, **Search**. « collapses the picker.
  - Click node/edge for details; double-click node to expand; drag to arrange; **Reset layout** re-runs auto layout.
  - Checkboxes hide lineage / FK / view deps / stale lineage (not seen in N days).
  - **Save diagram** keeps positions → `data/diagrams/`.
- **Canvas** tab
  - **+ Query window** or double-click the empty canvas adds a SQL window. Run and Cancel run it on the selected warehouse; results appear in a grid, and the Chart tab draws a Vega-Lite chart.
  - **+ Note** adds a Markdown note. Drag a table from the picker to add a table card; **Query this** on a card creates `SELECT * FROM <table> LIMIT 100`.
  - Reference another window in SQL as `{{title}}`. The canvas draws a read-only link to it.
  - Save, Save as, and Open store canvases in `data/canvases/`. Named canvases autosave.

## Test
```sh
uv run --with-requirements requirements.txt pytest -q
cd web && npm test
```

## Calls
| Need | Call |
|---|---|
| browse | `catalogs.list`, `schemas.list`, `tables.list` |
| columns, PK/FK, view deps | `tables.get` |
| lineage + producers + timestamps | `GET /api/2.0/lineage-tracking/table-lineage` |
| search all (optional) | `system.information_schema.tables` via SQL warehouse |
| canvas queries | SQL Statement Execution API on the selected warehouse |

## Feedback files
`data/logs/calls.jsonl`, `data/cache/...`, `data/diagrams/`, `data/canvases/`, `data/screenshots/` (all under `EXPLORER_DATA_DIR` when set, and `data-demo/` in demo mode)

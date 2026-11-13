# Databricks Explorer (v0.4)

Local Flask app plus a React UI to browse Unity Catalog, draw relationships (lineage, FKs, view deps, and stored ones such as user-drawn edges), and build query canvases.

## Run
Build the frontend once (and again after frontend changes), then start the server.
```sh
cd web && npm ci && npm run build && cd ..
uv run --with-requirements requirements.txt app.py
# open http://127.0.0.1:8765
```

Dev mode with hot reload: run the server as above, then in a second terminal `cd web && npm run dev` and open http://127.0.0.1:5173 (Vite proxies `/api` to the Flask server).

## Use
- Top bar: pick a profile and **Connect** (browser login if needed). Pick a SQL warehouse to enable queries on the canvas and search across all catalogs.
- **Graph** tab
  - Picker modes (remembered): **Drill-down**, **Tree**, **Search**. « collapses the picker.
  - Click node/edge for details; double-click node to expand; drag to arrange; **Reset layout** re-runs auto layout.
  - Checkboxes hide each edge kind (the legend shows how each is drawn), stale lineage (not seen in N days) and rejected edges.
  - Drag from the green dot on a hovered table node onto another node to store a **manual** edge between them.
  - Click an edge to see its provenance, evidence and status. A stored edge can be **Accepted** or **Rejected**, and any edge can carry a note.
  - **Save diagram** keeps positions → `data/diagrams/`.
- **Canvas** tab
  - **+ Query window** or double-click the empty canvas adds a SQL window. Run and Cancel run it on the selected warehouse; results appear in a grid, and the Chart tab draws a Vega-Lite chart.
  - **+ Note** adds a Markdown note. Drag a table from the picker to add a table card; **Query this** on a card creates `SELECT * FROM <table> LIMIT 100`.
  - Reference another window in SQL as `{{title}}`. The canvas draws a read-only link to it.
  - Save, Save as, and Open store canvases in `data/canvases/`. Named canvases autosave.

## Relationships
Edges come from one place, `GET /api/relationships?table=<name>`. Foreign keys, lineage and view dependencies are derived from the cached Unity Catalog data on every read and are never stored. Everything else (mined joins, manual and sketched edges, concept links, ontology imports) is kept in `data/relationships/<profile>.sqlite`, one file per profile, each edge with its provenance and a status of proposed, accepted or rejected. A note on a derived edge is stored separately and follows the edge. `GET /api/relationships/export` and `POST /api/relationships/import` move stored edges as JSON. See `contracts/api.md`, section 4.

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
`data/logs/calls.jsonl`, `data/cache/...`, `data/diagrams/`, `data/canvases/`, `data/relationships/`, `data/screenshots/`

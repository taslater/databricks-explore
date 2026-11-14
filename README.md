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

## Run without Databricks
Demo mode serves invented catalogs, tables, views, foreign keys, lineage and query results from a fake workspace. It never contacts Databricks, so it is safe for trying the UI, screenshots and tests.
```sh
uv run --with-requirements requirements.txt app.py --demo
# open http://127.0.0.1:8767, pick profile "demo", Connect, pick warehouse "Demo Serverless"
```
`EXPLORER_DEMO=1` does the same as `--demo`. Demo mode listens on port 8767 (`PORT` overrides) so the browser keeps its saved profile apart from real use, and it writes to `data-demo/` instead of `data/`.

Magic words in a query (the rest of the SQL is ignored; any query returns a result):

| Word | Result |
|---|---|
| `demo_slow` | stays running for 45 seconds, to test Cancel and the timer |
| `demo_error` | fails with a table-not-found message |
| `demo_wide` | a 60-column result |
| `demo_big` | 50,000 rows, so the 5,000-row cap and the truncated badge show |

Otherwise the result follows the first demo table named in the SQL (`demo.sales.orders` by default: 3,000 rows with ids, timestamps, dates, decimals, nulls, empty strings and long text). `GROUP BY` or `count(` gives a daily series for the Chart tab. A trailing `LIMIT n` is honored.

Demo mode also has an invented query history (a few hundred statements by six fake users, with the hard SQL cases), table lineage and column lineage, so mining joins works offline. `python app.py --demo --redacted` (or `EXPLORER_DEMO_REDACTED=1`) makes every statement read `<REDACTED>`, to try the blocked path. In an ordinary demo three rows are redacted and get skipped. Mining state is kept in `data-demo/relationships/`; delete it to start over.

`EXPLORER_DATA_DIR` moves everything the app writes (cache, logs, diagrams, canvases) to another folder. It defaults to `data/`, or `data-demo/` in demo mode.

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
  - **+ Query window** or double-click the empty canvas adds a SQL window. Results appear in a grid, and the Chart tab draws a Vega-Lite chart. The window title bar has a maximize toggle that fills the canvas and restores the previous size.
  - **Run:** Cmd/Ctrl+Enter (or **Run**) runs the selection, or else the statement under the cursor. Shift+Cmd/Ctrl+Enter (or **Run all**) runs every statement in order, stops at the first error and shows the last result. Statements are split on `;`, not inside strings, quoted names or comments. The text that ran flashes. **Cancel** stops the running statement and the rest of a script, and a timer shows how long it has run.
  - **Result grid:** columns are typed. Numbers sort and filter as numbers and are right-aligned, dates use the date filter, NULL shows as dim italic `NULL` (an empty string stays blank), and the type is under the column name. Values are shown exactly as the warehouse returned them, except that timestamps drop the `T` and an all-zero fraction.
  - **Copy:** cells, errors and the summary are selectable. Click a cell and press Cmd/Ctrl+C to copy its exact value, or tick rows (checkbox column) and press Cmd/Ctrl+C to copy them as TSV with headers. Right-click a cell for copy value, row or column, and Copy as TSV, CSV, Markdown, JSON or a SQL IN list (of that column), with or without headers, for the ticked rows or else all rows. **Copy all as…** does the same for every row after filters and sort, and **Export CSV** downloads them.
  - **+ Note** adds a Markdown note. Drag a table from the picker to add a table card; **Query this** on a card creates `SELECT * FROM <table> LIMIT 100`.
  - **Minimap** is off until you turn it on with the button in the canvas's top-left corner. The Details panel is collapsed on this tab.
  - Reference another window in SQL as `{{title}}`. The canvas draws a read-only link to it.
  - Save, Save as, and Open store canvases in `data/canvases/`. Named canvases autosave. **New diagram** starts a blank sketch under the next free `diagram-N` name. It needs no profile or warehouse.
  - **Sketching** (draw.io-style, on the same canvas as the query windows). The left palette places a rectangle, rounded rectangle, ellipse, diamond, database, text, sticky note, frame or placeholder table: click for a default size, or drag to draw your own. Double-click (or Enter) edits a label in place. Drag from a side handle of any node to another to draw a connector, and drag a connector's end to reconnect it. Left-drag on the background is a marquee; pan with the hand tool, the space bar, or the middle or right button. Shortcuts: V select, H pan, C connect, R rectangle, U rounded, O ellipse, D diamond, B database, T text, S sticky, F frame, P placeholder table, Q query window, N note, G grid snap; Cmd/Ctrl+Z undo (Shift: redo), C copy, V paste, D duplicate, A select all, `]` and `[` forward and backward (Shift: front and back), Shift+L lock; Delete removes sketch nodes, connectors and table cards (query windows and notes keep their ✕ button, because they hold SQL and text); arrows nudge. **Properties** (button in the bottom bar) opens the Details area with the selection's label, shape, colors, font size, position, lock, and for a connector its line type, arrowheads, dash, color and label. **Arrange** aligns, distributes, orders and locks a selection. **Export** saves the canvas or the selection as PNG or SVG (the SVG embeds the page content, so some vector editors cannot open it).
  - A **placeholder table** is a table that does not exist yet: edit its name, and each column's name, type and key marker (click the box to cycle PK and FK) on the card. Link it to the real table once it exists and the card shows the real columns and marks differences. A connector between two tables (real or placeholder) can be saved to the relationship store as a `sketch` edge from its Properties, with optional columns. Nothing is saved to the store automatically.
  - Gray thin links are derived from SQL (`{{title}}` references and tables a query reads) and are read-only. Dark connectors are yours.

## Relationships
Edges come from one place, `GET /api/relationships?table=<name>`. Foreign keys, lineage and view dependencies are derived from the cached Unity Catalog data on every read and are never stored. Everything else (mined joins, manual and sketched edges, concept links, ontology imports) is kept in `data/relationships/<profile>.sqlite`, one file per profile, each edge with its provenance and a status of proposed, accepted or rejected. A note on a derived edge is stored separately and follows the edge.

**Mining joins** (Graph tab, **Mine joins**) is an explicit batch run through the selected SQL warehouse. It shows the SQL and time window first, then reads `system.query.history` and `system.access.table_lineage`, extracts the columns each statement joins on, and stores them as proposed `join_mined` edges with run and user counts. Statement text and user names are never stored. Reading query text needs an account admin or `databricks_pii_access`; without that the run stops and says so. Later runs are incremental. Review the results in **Suggested relationships**, and see a **Usage** summary of the busiest tables. A node's **cols** button shows its columns, with column lineage and mined joins drawn between them. Column lineage comes from `system.access.column_lineage`, one cached query per table. `GET /api/relationships/export` and `POST /api/relationships/import` move stored edges as JSON. See `contracts/api.md`, section 4.

## Concepts
The **Concepts** tab is a small business glossary over the catalog. It is shaped like an ontology, so a later import of Databricks' Genie Ontology (domains, certified terms, synonyms, metric views) can map onto it. A concept has a name (unique, ignoring case), a definition, synonyms, a domain, a status of draft, reviewed or certified, tags and provenance (`manual`, `uc_tag` or `ontology`). It links to a table (a metric view is a table), a column or another concept, with a relation: `defines`, `measures`, `identifies` or `describes` for tables and columns, `is_a`, `part_of` or `related_to` between concepts. Links are `concept_link` edges in the relationship store, so they travel with its export and import, and deleting a concept deletes its links.

- **Find candidates** searches the names and comments of the tables and columns already in the local cache for the concept's name and synonyms, and lists hits to link in one click. It never touches the warehouse, and only knows what you have browsed.
- **Suggest from tags...** shows the read-only SQL over the `system.information_schema` tag tables, then runs it on the selected warehouse and makes one draft concept per tag key and value, linked with `describes` to the tagged tables and columns. Running it again updates those concepts and keeps your edits. Demo mode has a few tags to try it. Tags whose name starts with `system.` (such as the certification tag) are skipped.
- **Import from Databricks...** shows every REST call and SQL statement first (all read-only), then reads Genie Ontology domains and pages (Beta endpoints; a 403 or 404 is reported as "not available on this workspace"), and the measures and dimensions of metric views (found through `system.information_schema.tables`, read from each view's YAML definition). They become concepts with origin `ontology`; measures and dimensions are linked `measures` or `describes` to the metric view's column. Running it again updates by source, keeps your edits to fields the source did not change, and removes only the links the import made. Demo mode fakes all of it.
- **Certification badges.** The `system.certification_status` tag (`certified` or `deprecated`) is read with one query on the selected warehouse and shown as a badge on table nodes in the Graph tab and next to link targets in the Concepts editor.
- On the **Graph** tab, the **Concepts** toggle draws the concepts linked to the tables on the graph as diamond nodes, with an edge to the table, or to the column when a column is linked. Click one to open it in the Concepts tab.
- **Export** and **Import** use the relationship store's JSON file (`contracts/api.md`, sections 4 and 6).

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
`data/logs/calls.jsonl`, `data/cache/...`, `data/diagrams/`, `data/canvases/`, `data/relationships/`, `data/screenshots/` (all under `EXPLORER_DATA_DIR` when set, and `data-demo/` in demo mode)

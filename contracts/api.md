# Explorer API contract

Source of truth for backend and frontend. Flask on `127.0.0.1:8765`, all bodies JSON. Sections 1 to 5 describe `app.py` as it behaves today.

## Conventions

- **Connection:** one active profile per server process (`STATE["ex"]`). Routes marked *needs connection* return an error until `POST /api/connect` succeeds.
- **Errors (all routes):** an error body is `{"error": "<message>"}`, with these statuses:
  - **400** for a body or query that fails validation (canvases), and for a body that is not valid JSON.
  - **401** for a failed non-interactive `POST /api/connect`.
  - **404** for an unknown route (including unknown `/api/...` paths under any method) and for a missing canvas.
  - **405** for a wrong method on a real route, with an `Allow` header.
  - **415** for a route that reads a JSON body when the request is not `application/json`.
  - **503** for `GET /` when the frontend is not built. That body is plain text, not JSON.
  - **500** for any other exception, including missing query params or body keys (`KeyError` text, e.g. `"'catalog'"`) and routes called before `POST /api/connect`.
- **Error text:** the SDK appends a `Config: host=..., profile=...` dump to some errors. The server removes it, and anything after it, from every error message it returns (error bodies and the `errors` strings of graph responses).
- **Cache wrapper:** routes marked *cached* return `{"fetched_at": "<ISO-8601 UTC>", "data": ...}` from `data/cache/<profile>/...`. Pass `?refresh=1` to re-fetch from Databricks and overwrite the cache.
- **Logging:** every remote call is appended to `data/logs/calls.jsonl` through `Explorer._call`.

---

## 1. Existing endpoints

### `GET /`

Serves `web/dist/index.html` (the React build). Not JSON. Returns 503 with a plain-text hint if the frontend has not been built. Any other non-`/api` path serves a file from `web/dist` or falls back to `index.html`.

### `GET /api/profiles`

No connection needed. Reads `~/.databrickscfg` (or `DATABRICKS_CONFIG_FILE`).

Response:

```json
{"profiles": [{"name": "dev", "host": "https://x.cloud.databricks.com", "auth_type": "databricks-cli"}],
 "config": "/Users/me/.databrickscfg"}

```

`host` and `auth_type` are `""` when unset.

### `GET /api/session`

No connection needed. Reports what the server is connected to now, so the page can tell whether a restore is needed.

Response: `{"profile": "dev" | null, "warehouse_id": "abc123" | null}`. Both are `null` when the server has no connection (for example after the Flask process restarts).

### `POST /api/connect`

Body: `{"profile": "dev", "interactive": true}`. `interactive` defaults to `true`.

Creates the `Explorer` for the profile and calls `current_user.me` and `get_workspace_id`. If the first attempt fails and `interactive` is `true`, it runs `databricks auth login --profile <p>` (opens a browser, blocks up to 3 minutes), then retries. The connection is stored only on success.

With `"interactive": false` (used by the page's restore on load), a failed first attempt returns **401** with `{"error": "..."}` and never opens a browser. The page then shows the profile as not connected, and the user connects with the normal Connect button.

Response:

```json
{"profile": "dev", "user": "someone@example.com", "host": "https://x.cloud.databricks.com", "workspace_id": "1234567890"}

```

`user` and `workspace_id` may be `null`.

### `GET /api/warehouses`

*Needs connection.* Lists SQL warehouses (not cached).

Response: array of `{"id": str, "name": str, "state": str|null}`. `state` is the Databricks state value, e.g. `"RUNNING"`.

### `POST /api/warehouse`

*Needs connection.* Body: `{"id": "<warehouse_id>"}`. An empty or missing `id` clears the selection. The id is not validated against Databricks.

Response: `{"warehouse_id": "<id>" | null}`

### `GET /api/catalogs`

*Needs connection.* *Cached* (`catalogs.json`). Supports `?refresh=1`.

Response:

```json
{"fetched_at": "2026-11-11T15:00:00+00:00",
 "data": [{"name": "main", "type": "MANAGED_CATALOG", "comment": null}]}

```

`data` is sorted by `name`. `type` and `comment` may be `null`.

### `GET /api/schemas?catalog=<cat>`

*Needs connection.* *Cached* per catalog. Supports `?refresh=1`.

Response: `{"fetched_at": str, "data": [{"name": str, "comment": str|null}]}`, sorted by `name`.

### `GET /api/objects?catalog=<cat>&schema=<sch>`

*Needs connection.* *Cached* per schema. Supports `?refresh=1`.

Response: `{"fetched_at": str, "data": [{"name": str, "full_name": "cat.sch.name", "type": str|null, "comment": str|null}]}`, sorted by `name`. Names starting with `__` (materialized-view and streaming-table backing tables) are excluded.

### `GET /api/search?q=<text>`

*Needs connection.* Case-insensitive substring match on the table name. No cache. Returns at most 300 results.

- If a warehouse is selected, queries `system.information_schema.tables` (excluding `__`-prefixed names) and returns `"source": "information_schema"`.
- Otherwise searches the cached `objects.json` files only and returns `"source": "cached schemas only (pick a SQL warehouse to search everything)"`.

Response:

```json
{"source": "information_schema",
 "data": [{"full_name": "main.sales.orders", "name": "orders", "type": "MANAGED"}]}

```

`type` may be `null` on the cached path. Results are sorted by `(name, full_name)`. No `fetched_at`.

### `GET /api/object?name=<cat.sch.obj>`

*Needs connection.* *Cached* per object (Unity Catalog `tables.get`). Supports `?refresh=1`.

Response: `{"fetched_at": str, "data": <Databricks TableInfo as_dict()>}`. `data` is passed through as-is. It includes fields such as `table_type`, `table_constraints`, `view_dependencies`, and `columns`.

### `GET /api/relations?name=<cat.sch.obj>`

*Needs connection.* Builds the graph for one object from its cached `object` (constraints, view deps) and `lineage` (`/api/2.0/lineage-tracking/table-lineage`). Supports `?refresh=1`. Partial failures are reported in `errors` with status 200.

Response:

```json
{"nodes": [{"id": "main.sales.orders", "label": "orders", "kind": "table", "focus": true}],
 "edges": [{"id": "fk:main.sales.orders->main.sales.customers", "source": "main.sales.orders",
            "target": "main.sales.customers", "kind": "fk", "constraint": "fk_cust",
            "child_columns": ["cust_id"], "parent_columns": ["id"], "label": "cust_id"}],
 "errors": []}

```

- **Node:** `{id, label, kind, focus?, self_ref?, self_ref_last_seen?}`. `kind` is the lowercased `table_type` (default `"table"`). `focus` is `true` only on the requested object. `self_ref` is set when lineage shows the object feeding itself.
- **Edge kinds:**
  - `fk`: `id = "fk:<child>-><parent>"`, plus `constraint`, `child_columns`, `parent_columns`, `label`.
  - `view_dep`: `id = "view_dep:<source>-><target>"`. Source is the dependency and target is the view.
  - `lineage`: `id = "lineage:<a><-><b>"` with the names sorted. Fields: `bidir` (both directions seen), `last_seen`, `last_seen_by_dir` (map of `"src->dst"` to timestamp).
- **`errors`:** strings such as `"tables.get: ..."` or `"lineage: ..."`.

### `GET /api/edge?src=<name>&tgt=<name>`

*Needs connection* (reads that profile's cache). Reads cached lineage only, with no remote call and no `refresh`. Returns the producers (jobs, notebooks, etc.) behind each direction of the link. If nothing is cached, `flows` is empty.

Response:

```json
{"flows": [{"source": "main.sales.raw", "target": "main.sales.orders", "last_seen": "2026-11-10T08:00:00Z",
            "producers": [{"kind": "job", "id": "123", "url": "https://.../jobs/123",
                           "workspace_id": "1234567890", "other_workspace": false,
                           "last_seen": "2026-11-10T08:00:00Z", "raw": {}}]}]}

```

- `flows` can hold up to two entries, one per direction. Each direction is listed separately.
- `producers` are sorted by `last_seen`, newest first.
- `kind` is one of `job`, `notebook`, `pipeline`, `dashboard`, `query`, or `file`. For `file`, `id` is the string `"None"` and `url` is `null`, because `_link` has no URL mapping for files. This is an existing quirk.
- `url` is `null` when the producer is in another workspace or has no id.

### `GET /api/diagrams`

Returns a JSON array of saved diagram names (file stems of `data/diagrams/*.json`), sorted.

### `GET /api/diagrams/<name>`

Returns the saved diagram file as stored: `{"name": str, "saved_at": str, ...}` plus whatever the client saved. A missing file returns a 500 error.

### `POST /api/diagrams`

Body: the diagram object. `name` is required. The server writes `data/diagrams/<safe(name)>.json` with `{"name", "saved_at": <now>, ...body}`. Body keys override the server defaults, so a client-supplied `saved_at` wins.

Response: `{"saved": "<safe(name)>"}`

---

## 2. Notes on existing behavior the frontend must know

- Search results and object lists are cached on disk, so `refresh=1` is the only way to see newer metadata.
- `/api/search` mixes two sources. Check `source` before assuming completeness.
- `/api/object` and `/api/relations` return raw Databricks objects. Only the fields listed above are guaranteed.

---

## 3. Query and canvas endpoints

### Shared shapes

**Query body** (used by `POST /api/query` and `POST /api/query/async`):

```json
{"sql": "SELECT * FROM {{daily_hours}} WHERE hours > :min",
 "params": {"min": 8},
 "max_rows": 100,
 "windows": {"daily_hours": "SELECT day, hours FROM main.default.hours"}}

```

- `sql` (string, required). May contain `:name` parameters and `{{title}}` references.
- `params` (object, optional, default `{}`). Each value is sent as a named string parameter, the same way `dbx.sql()` sends `str(v)` today. Keys are parameter names without the colon.
- `max_rows` (integer, optional, default `5000`, must be at least 1). Upper bound: none set.
- `windows` (object, optional). Maps window title to that window's SQL. Each `{{title}}` in `sql` becomes a CTE built from that SQL, recursively, with repeated references deduplicated. An unknown title, or a cycle, returns a 500 error whose message names the cycle. If `windows` is omitted, `{{...}}` is not expanded and Databricks reports the SQL error.

**Result shape** (returned by `POST /api/query`, and by `GET /api/query/<id>` once finished):

```json
{"statement_id": "01ef5a2c-0000-4c3a-9d7e-1f2e3d4c5b6a",
 "columns": [{"name": "day", "type": "DATE", "type_text": "date"}, {"name": "hours", "type": "DECIMAL", "type_text": "decimal(10,2)"}],
 "rows": [["2026-11-02", "8.5"], ["2026-11-03", null]],
 "row_count": 2,
 "truncated": false,
 "ms": 412}

```

- `statement_id` (string): the Databricks statement id. Valid for `GET` and `DELETE /api/query/<id>` as well.
- `columns[].type`: the Databricks `type_name` from the manifest (for example `STRING`, `INT`, `BIGINT`, `DECIMAL`, `DOUBLE`, `DATE`, `TIMESTAMP`, `ARRAY`, `STRUCT`). When the SDK enum lacks a type (`TIMESTAMP_NTZ`, `VARIANT`), `type` is the base name from `type_text`, uppercased, so it is never `null` for a known column.
- `columns[].type_text`: the warehouse's SQL type text as sent (for example `decimal(10,2)`, `array<string>`), or `null`. The UI uses it for the precision of `DECIMAL` and as the type label.
- `rows[][]`: one array per row, aligned with `columns`. Values are the statement API's JSON_ARRAY values, which are **strings or `null`**, not typed JSON numbers. The frontend must cast them for charts, using `columns[].type` to pick the cast.
- `row_count` = `rows.length`. `rows` is never longer than `max_rows`.
- `truncated` (boolean | null): `true` when the query has more than `max_rows` rows. `null` when the cap could not be applied in SQL, which is when the statement is not a query (sqlglot cannot parse it, or it is not `SELECT`/`WITH`/`VALUES`). In that case the server cuts `rows` to `max_rows` client-side and reports `truncated: null`.
- `ms` (integer): wall-clock milliseconds for the Databricks call, including polling.

**Canvas file:** the shape is described by `contracts/canvas.schema.json`. The server does not load that file. The pydantic models in `canvases.py` mirror it and do the validating. The API stores and returns the canvas unchanged.

**Canvas format versions.**

- **Version 1** has query, chart, note and table windows and read-only `links`. It requires `profile`.
- **Version 2** keeps all of that and adds the sketch node types and a top-level `edges` list. The UI writes version 2 from now on; version 1 files load unchanged and are rewritten as version 2 only when the user saves again. `profile` may be `null` in version 2 (a sketch made with no connection).
- Sketch nodes live in `windows`, with the same `id`, `position` and `size`, and a `type` of `shape` (with `shape`: `rect`, `rounded`, `ellipse`, `diamond` or `cylinder`), `text`, `sticky`, `frame` or `placeholder`. They carry `label` instead of `title` (not unique, not used in `{{title}}`), and optionally `fill`, `stroke` (CSS colors), `font_size`, `locked` and `z`. Any node, including query windows, may carry `locked` and `z`. A frame holds other nodes only by geometry: moving it moves the unlocked nodes lying inside it.
- A `placeholder` node is a table that does not exist yet: `placeholder: {id, name, columns: [{name, type, key?}], linked?}`. `id` is a UUID, and the relationship store knows the table as `ph:<id>`. `key` is `pk` or `fk`. `linked` is the full name of the real table it stands for, once it exists. A placeholder that is linked is named by that real table in stored edges.
- `edges[]` are connectors: `id`, `source`, `target` (window ids), `source_handle` and `target_handle` (`t`, `r`, `b` or `l`), `line` (`straight`, `step` or `curve`), `arrow_start`, `arrow_end`, `dashed`, `label`, `color`, and `relationship`. `relationship` is `{id?, source_column?, target_column?}` and means the connector was saved to the relationship store as a `sketch` edge (section 4) with that stored id. Edge ids are unique, and both ends must name an existing window.
- Saving a connector to the relationship store is a separate, explicit step (the client calls `POST /api/relationships/import` with one `sketch` edge). Saving a canvas never writes to the store.

### `POST /api/query`

*Needs connection and a selected warehouse.* Body: Query body.

Runs the statement synchronously and returns the Result shape. Long queries block until finished, so use the async endpoints for those. Wrapping for `truncated` uses `SELECT * FROM (<sql>) LIMIT <max_rows + 1>` (a literal number, so it cannot clash with user `:name` parameters) after expansion. Result chunks are read until `max_rows + 1` rows are seen or the result ends.

Response: 200, Result shape. Errors: 500 `{"error": ...}`, including Databricks SQL errors and expansion errors.

### `POST /api/query/async`

*Needs connection and a selected warehouse.* Body: Query body.

Submits the statement without waiting (Databricks `wait_timeout` of `0s`) and returns immediately.

Response: `{"statement_id": "<id>"}`. A SQL error may not show until the first `GET`, where it appears as `state: "FAILED"`.

### `POST /api/query/tables`

No connection needed. Body: `{"sql": "...", "windows": {...}?}` (same `sql` and `windows` as the Query body; `params` and `max_rows` are ignored).

Expands `{{title}}` references when `windows` is given, then returns the fully qualified table names the statement reads (sqlglot). CTE names are excluded. Used by the canvas to draw edges from a query window to table cards.

Response: `{"tables": ["main.sales.orders", ...]}`. Unparseable SQL or an unknown or cyclic reference returns 500 `{"error": ...}`.

### `GET /api/query/<id>`

Polls a statement submitted with `/api/query/async` (or `/api/query`).

Response: the Result shape plus `state` and `error`:

```json
{"statement_id": "01ef...", "state": "SUCCEEDED", "columns": [], "rows": [], "row_count": 0,
 "truncated": null, "ms": null, "error": null}

```

- `state`: one of `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELED`, `CLOSED` (Databricks statement states).
- While `PENDING` or `RUNNING`: `columns` and `rows` are `[]`, `row_count` is `0`, `truncated` is `null`, `ms` is `null`.
- `FAILED`, `CANCELED`, `CLOSED`: `columns` and `rows` are `[]`. `error` holds the Databricks error message for `FAILED`, otherwise `null`.
- `SUCCEEDED`: full Result shape. `ms` is the server-measured time from submit to completion. It may be `null` if the server restarted after submit.
- Unknown id: 500 `{"error": ...}`.

Errors: 500 `{"error": ...}`. A `FAILED` statement is still HTTP 200 (the statement ran, the state says it failed).

### `DELETE /api/query/<id>`

Requests cancellation through `statement_execution.cancel_execution`. Cancellation is best-effort and asynchronous. Poll `GET` to see `CANCELED`.

Response: `{"statement_id": "<id>", "cancel_requested": true}`. Cancelling a finished statement is a no-op and still returns 200.

### `GET /api/canvases`

No connection needed. Lists canvas names (file stems of `data/canvases/*.json`).

Response: JSON array of strings, sorted, e.g. `["hours", "sales"]`. Matches `GET /api/diagrams`.

### `POST /api/canvases`

No connection needed. Body: a canvas object, validated by the pydantic models in `canvases.py` (which mirror `contracts/canvas.schema.json`; the server does not load the schema file). Beyond the models: titles of query, chart, note and table windows unique, window ids unique, edge ids unique, and `links` and `edges` entries refer to existing ids. A version 1 body that carries a sketch type, an `edges` key or no `profile` is a 400.

Writes `data/canvases/<name>.json`, overwriting any existing canvas with that name. The server stores exactly the body it validated. It adds no fields, so save followed by load returns the same object.

Response: `{"saved": "<name>"}`. Validation failure: **400** `{"error": "<validation message>"}`. The message names the failing path (for example `windows[1].title: duplicate title "daily_hours"`).

Example body:

```json
{"version": 1, "name": "hours", "profile": "dev", "warehouse_id": "abc123",
 "viewport": {"x": 0, "y": 0, "zoom": 1},
 "windows": [
   {"id": "w1", "type": "query", "title": "daily_hours", "position": {"x": 0, "y": 0},
    "size": {"w": 520, "h": 360}, "sql": "SELECT day, hours FROM main.default.hours", "collapsed": false},
   {"id": "w2", "type": "query", "title": "long_days", "position": {"x": 560, "y": 0},
    "size": {"w": 520, "h": 360}, "sql": "SELECT * FROM {{daily_hours}} WHERE hours > 8", "collapsed": false}],
 "links": [{"from": "w1", "to": "w2"}]}

```

### `GET /api/canvases/<name>`

No connection needed. Returns the stored canvas object exactly as saved. The file is validated on load.

Errors: missing file returns **404** `{"error": "canvas not found: <name>"}`. A file that fails validation returns **400** `{"error": ...}` with the same message format as POST.

Decisions made after T0 review (these override anything above):

- Charts are attached to query windows through the optional `chart` field, per plan task C2. The standalone `chart` window type is in the enum but the UI does not create it.
- Row values stay as strings or `null`. The frontend casts them using `columns[].type`.

---

## 4. Relationships

One model for every relationship between tables or columns, with provenance. Implemented in `relationships.py`. All routes here *need a connection*, because the store is one SQLite file per profile: `data/relationships/<profile>.sqlite` (under the same data directory as the cache). Validation failures are **400** `{"error": "<path>: <reason>"}` (for example `edges[1].kind: ...`), unknown ids are **404**.

### The edge shape

```json
{"id": "e_3f9c...", "kind": "join_mined",
 "source": {"table": "main.sales.orders", "column": "cust_id"},
 "target": {"table": "main.sales.customers", "column": "id"},
 "directed": true,
 "provenance": {"origin": "query_history", "source_ref": "stmt-123", "fetched_at": "2026-11-12T09:00:00+00:00"},
 "evidence": {"runs": 12, "users": 3, "first_seen": "2026-10-01", "last_seen": "2026-11-10", "sample_refs": ["stmt-123"]},
 "status": "proposed", "note": "",
 "created_at": "2026-11-12T09:00:00+00:00", "updated_at": "2026-11-12T09:00:00+00:00"}
```

- **Endpoint** `{table, column?}`. `table` is a 3-part name `catalog.schema.table`, or `ph:<uuid>` for a placeholder that does not exist yet. `column` is omitted (or `null`) for a table-level end.
- **`kind`:** `fk`, `lineage`, `view_dep` (derived) or `join_mined`, `manual`, `sketch`, `concept_link`, `ontology` (stored).
- **`status`:** `derived` (only on derived edges), `proposed`, `accepted`, `rejected`.
- **`evidence.together`** (optional, default `[]`, only on mined edges) lists the composite keys a column pair belongs to: `[{"columns": [["l_partkey", "ps_partkey"], ["l_suppkey", "ps_suppkey"]], "runs": 4}]`. Each entry is every column pair (source column, target column, in the edge's orientation) joined in one condition between the same two tables, with the number of statements that did so. At most 5 entries, most runs first; across runs the counts are added by column set. Declared foreign-key pairs are not edges but still appear in `columns`. A pair's own `runs` counts every statement, so `runs` above the sum of its `together` runs means it also appeared alone.
- **`evidence`** is `null` unless the edge was mined from activity. For derived lineage it holds only `last_seen`. `provenance.origin` on derived edges is `unity_catalog:table_constraints`, `unity_catalog:view_dependencies` or `unity_catalog:table_lineage`, and `fetched_at` is when the cached metadata behind it was read.
- **Derived kinds are never stored.** They are normalized from `GET /api/relations` data at read time. An FK becomes one edge per column pair. Lineage seen in both directions becomes two directed edges. A user note on a derived edge is kept in an overlay keyed by its natural key.
- **Natural key:** `(kind, source table, source column, target table, target column)`. Writes upsert on it. An undirected edge (`directed: false`) is the same edge in either direction.
- **Derived ids** are `kind:table[#column]->table[#column]`, for example `fk:main.sales.orders#cust_id->main.sales.customers#id`. Stored ids are `e_<hex>`. Percent-encode ids in URLs (`#` and `>` in particular).

### `GET /api/relationships?table=<name>`

*Needs connection.* The unified list for one table: derived edges (read from the same cached data as `/api/relations`, with `?refresh=1` forwarded) plus stored edges with the table at either end, with notes applied to derived ones. `table` is required and may be a placeholder, which has no derived edges.

`level` is `table` (default) or `column`. `column` returns each edge as it is. `table` returns the table-level view: one edge per `(kind, source table, target table)`, rolled up from its members, because a column edge implies its table edge. A rolled edge has these extra fields, and its endpoints carry no column:

- `columns`: the member column pairs `[{"source": "cust_id", "target": "id"}]`.
- `members`: the ids of the edges it was rolled from.
- `id`: the member's own id when the group is a single table-level edge, otherwise the derived-style table-level id.
- `status`: the strongest member's (`accepted`, then `proposed`, `derived`, `rejected`). `note` for a derived group is the overlay note on its table-level id.
- `evidence`: runs summed, users the maximum, first and last seen the earliest and latest.

Undirected groups are oriented by sorted table name.

Response:

```json
{"table": "main.sales.orders", "level": "table",
 "nodes": [{"id": "main.sales.orders", "label": "orders", "kind": "table", "focus": true}],
 "edges": [{"id": "fk:main.sales.orders->main.sales.customers", "kind": "fk",
            "source": {"table": "main.sales.orders", "column": null},
            "target": {"table": "main.sales.customers", "column": null},
            "directed": true, "status": "derived", "note": "",
            "provenance": {"origin": "unity_catalog:table_constraints", "source_ref": "fk_cust", "fetched_at": "..."},
            "evidence": null, "columns": [{"source": "cust_id", "target": "id"}],
            "members": ["fk:main.sales.orders#cust_id->main.sales.customers#id"],
            "created_at": "...", "updated_at": "..."}],
 "errors": []}
```

`nodes` and `errors` are the ones `/api/relations` gives, plus a node for every stored edge's far end (`kind` `placeholder` for `ph:` names). Errors: 400 for a missing or invalid `table` or `level`.

### `POST /api/relationships`

*Needs connection.* Creates a `manual` edge. Body: `{"source": {"table", "column?"}, "target": {...}, "directed": true, "note": ""}`. Only `source` and `target` are required; other keys are rejected. The edge is stored with status `accepted` and provenance `{"origin": "user"}`.

Response: the edge. **201** when created. **200** when the natural key already existed: the edge is re-accepted (a rejected one comes back) and its note is replaced only when the body has one. Errors: 400 (bad endpoint, same endpoint on both sides, unknown key).

### `PATCH /api/relationships/<id>`

*Needs connection.* Body: `{"status"?, "note"?}`, at least one. For a stored edge, `status` is `proposed`, `accepted` or `rejected`. For a derived id, only `note` is accepted (a `status` is 400), and an empty note clears it. The response is the edge. An unknown stored id, or an id that is neither stored nor derived-shaped, is 404.

### `DELETE /api/relationships/<id>`

*Needs connection.* Removes a stored edge. For a derived id it removes the note overlay. Response: `{"deleted": "<id>"}`. 404 when there is nothing to remove.

### `GET /api/relationships/export`

*Needs connection.* Every stored edge, and every note on a derived edge, in the import format:

```json
{"version": 1, "exported_at": "...", "edges": [<edge>, ...],
 "overlays": [{"kind": "fk", "source": {"table": "..."}, "target": {"table": "..."}, "note": "...", "updated_at": "..."}]}
```

### `POST /api/relationships/import`

*Needs connection.* Body: the export format. In `edges`, only `kind`, `source`, `target` and `provenance` are required. `id`, timestamps, `directed` (true), `status` (`proposed`) and `note` have defaults. Edges of a derived kind, or with status `derived`, are 400. The import is all-or-nothing and upserts by natural key: an existing edge keeps its id and `created_at` and takes everything else from the file. Notes in `overlays` replace existing notes.

Response: `{"imported": 12, "created": 10, "updated": 2, "overlays": 1}`.

---

## 5. Query-history mining, suggestions and column lineage

Implemented in `mining.py` and `sqltools.join_pairs`. Mining is always an explicit, user-triggered batch run through the selected SQL warehouse. It reads `system.query.history` (finished SELECT, INSERT, MERGE and CREATE statements) and `system.access.table_lineage` (the tables each statement read, joined by `statement_id`), extracts the column pairs each statement joins on, and stores them as `join_mined` edges with status `proposed`. **Statement text and user names are never stored or logged.** Stored per edge: the two column endpoints, a run count, a distinct-user *count*, first and last seen as dates, and up to 5 statement ids. All routes *need a connection*.

Facts the design rests on: `statement_text` reads `<REDACTED>` unless the reader is an account admin or in `databricks_pii_access`; query history keeps 365 days and rows usually appear within an hour; lineage tables keep 395 days. The REST column-lineage endpoint is undocumented, so column lineage comes from the system tables.

### `GET /api/mining/plan?window_days=30&full=0`

What a run would do, without running anything. The page shows this before the user confirms.

- `window_days` (1 to 365, default 30). The first run, or `full=1`, reads the last `window_days` days. Any later run is **incremental**: it starts at the stored cursor, and `window_days` does not apply. The newest hour is always left out, because history rows may not be in yet.
- `row_cap` is the most statements one run reads (5000). A run that hits it stops there, moves the cursor to the last row read, and the next run continues.

```json
{"since": "2026-10-14T11:00:00Z", "until": "2026-11-13T11:00:00Z", "window_days": 30,
 "incremental": false, "cursor": null, "row_cap": 5000, "warehouse_id": "abc123",
 "queries": [{"name": "query_history", "sql": "SELECT statement_id, executed_by, start_time, left(statement_text, 100000) AS statement_text\nFROM system.query.history\nWHERE ... LIMIT 5000",
              "params": {"since": "2026-10-14T11:00:00Z", "until": "2026-11-13T11:00:00Z"}},
             {"name": "table_lineage", "sql": "WITH q AS (...) SELECT DISTINCT l.statement_id, l.source_table_full_name FROM system.access.table_lineage l JOIN q ...",
              "params": {"since": "...", "until": "..."}}]}
```

`sql` is exactly what runs, with `:since` and `:until` bound from `params`. Errors: 400 for a bad `window_days`.

### `POST /api/mining/runs`

Starts a run in the background. Body (optional): `{"window_days": 30, "full": false}`. `full: true` ignores the cursor, reads the whole window again and **replaces** the evidence of every pair it finds (so counts are not doubled). An ordinary run adds to existing evidence.

Response **202**: the status object below. Errors: **400** (bad window, or no warehouse selected), **409** (a run is already in progress).

### `GET /api/mining/status`

The current or latest run of this server process, plus the last stored run from any earlier one.

```json
{"state": "succeeded", "phase": null, "progress": {"done": 0, "total": 0},
 "started_at": "...", "finished_at": "...",
 "plan": {"since": "...", "until": "...", "window_days": 30, "incremental": false, "row_cap": 5000},
 "result": {"statements": 338, "parsed": 333, "with_joins": 236, "unparsed": 5, "redacted_skipped": 1, "no_lineage": 21,
            "pairs": 8, "skipped_fk": 1, "fk_unreadable_tables": 0, "invalid": 0, "created": 8, "updated": 0,
            "capped": false, "since": "...", "until": "...", "finished_at": "..."},
 "error": null, "reason": null,
 "last_run": {"...": "the result of the last stored run, or null"}}
```

- `state`: `idle` (nothing run in this process), `running`, `succeeded`, `failed` or `blocked`.
- While `running`, `phase` is `history`, `lineage`, `extract`, `foreign_keys` or `save`, and `progress` counts `done` of `total` for `extract` (statements) and `foreign_keys` (tables).
- `blocked` with `reason: "redacted"`: `statement_text` came back as `<REDACTED>` for at least half the rows, so the reader cannot see query text. `error` explains (account admin or `databricks_pii_access` needed). **Nothing is stored and the cursor does not move.** Fewer redacted rows are skipped and counted in `redacted_skipped`.
- `failed`: `error` is the warehouse's message, for example no `SELECT` on the system tables.
- In `result`: `unparsed` statements sqlglot could not read; `no_lineage` statements with no `table_lineage` row (short table names in those cannot be qualified and their joins are dropped); `skipped_fk` pairs that are already declared foreign keys; `fk_unreadable_tables` tables whose constraints could not be read, so their pairs were kept. `capped` means the row cap was hit and another run continues.
- Pairs between Databricks' own tables (`system`, `__databricks_internal`) are not mined.

### `GET /api/mining/usage?limit=10`

Top tables by runs and top table pairs read together, for the mined window. Computed in the same pass from the same statements. Distinct users are a count. After an incremental run runs are added, and the user count is the larger of the two (a lower bound, because names are not kept). `limit` is 1 to 100. Before any run: `{"window": null, "statements": 0, "tables": [], "pairs": []}`.

```json
{"window": {"since": "...", "until": "..."}, "statements": 338,
 "tables": [{"table": "demo.sales.orders", "runs": 205, "users": 6}],
 "pairs": [{"tables": ["demo.sales.customers", "demo.sales.orders"], "runs": 83, "users": 6}]}
```

### `GET /api/relationships/suggestions?status=proposed&table=<name>`

Stored `join_mined` edges at column level, most evidence first (runs, then users, then last seen). `status` is a comma-separated list of `proposed` (default), `accepted`, `rejected`. `table` optionally keeps edges with that table at either end. `counts` is over all `join_mined` edges, whatever the filter.

```json
{"edges": [<edge>, ...], "counts": {"proposed": 7, "accepted": 1, "rejected": 0}}
```

Errors: 400 for an unknown status.

### `POST /api/relationships/bulk`

Sets one status on several stored edges, all or none. Body `{"ids": ["e_..."], "status": "accepted"}` with 1 to 1000 ids and a `status` of `proposed`, `accepted` or `rejected`. Response `{"updated": 2}`. Errors: 400 (empty, a derived id, an unknown key), 404 (an id that does not exist; nothing is changed).

### `GET /api/relationships?table=<name>&level=column`

Section 4's route, now with column lineage. At `level=column`, derived `lineage` edges with column endpoints are added from `system.access.column_lineage` (one warehouse query for the table, **cached** like the other metadata, `?refresh=1` re-reads it). The edge `id` is `lineage:<table>#<column>-><table>#<column>`, `status` `derived`, `provenance.origin` `unity_catalog:column_lineage`, `evidence.last_seen` the latest event. Stored `join_mined`, `manual` and other edges come back as stored, each with its column endpoints, and FK edges come back one per column pair. At `level=table` nothing changes.

A cached copy is used when no warehouse is selected. With no warehouse and no cache, or without access to the system table, the response is still 200 with everything else and `errors` gains `"column_lineage: <reason>"`.

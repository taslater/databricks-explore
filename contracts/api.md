# Explorer API contract

Source of truth for backend and frontend. Flask on `127.0.0.1:8765`, all bodies JSON. Sections 1 to 3 describe `app.py` as it behaves today.

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
 "columns": [{"name": "day", "type": "DATE"}, {"name": "hours", "type": "DECIMAL"}],
 "rows": [["2026-11-02", "8.5"], ["2026-11-03", null]],
 "row_count": 2,
 "truncated": false,
 "ms": 412}

```

- `statement_id` (string): the Databricks statement id. Valid for `GET` and `DELETE /api/query/<id>` as well.
- `columns[].type`: the Databricks `type_name` from the manifest (for example `STRING`, `INT`, `BIGINT`, `DECIMAL`, `DOUBLE`, `DATE`, `TIMESTAMP`, `ARRAY`, `STRUCT`). `type_text` (e.g. `decimal(10,2)`) is not included.
- `rows[][]`: one array per row, aligned with `columns`. Values are the statement API's JSON_ARRAY values, which are **strings or `null`**, not typed JSON numbers. The frontend must cast them for charts, using `columns[].type` to pick the cast.
- `row_count` = `rows.length`. `rows` is never longer than `max_rows`.
- `truncated` (boolean | null): `true` when the query has more than `max_rows` rows. `null` when the cap could not be applied in SQL, which is when the statement is not a query (sqlglot cannot parse it, or it is not `SELECT`/`WITH`/`VALUES`). In that case the server cuts `rows` to `max_rows` client-side and reports `truncated: null`.
- `ms` (integer): wall-clock milliseconds for the Databricks call, including polling.

**Canvas file:** the shape is described by `contracts/canvas.schema.json`. The server does not load that file. The pydantic models in `canvases.py` mirror it and do the validating. The API stores and returns the canvas unchanged.

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

No connection needed. Body: a canvas object, validated by the pydantic models in `canvases.py` (which mirror `contracts/canvas.schema.json`; the server does not load the schema file). Beyond the models: window titles unique and window ids unique, and `links` entries refer to existing ids.

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

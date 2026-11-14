# MCP server contract

A Model Context Protocol server inside the Flask app, so a coding agent (Claude Code, for example) can explore the catalog and work on canvases next to the person using the browser UI. Implemented in `mcp_server/`. It adds `/mcp` and the two `/api/agent-access` routes to `app.py` and changes nothing else about the API, except for the canvas revision routes in `contracts/api.md` section 3.

**Scope.** Read access, local edits, and read-only SQL. **No tool writes to the Databricks workspace, and no tool connects or chooses a profile or warehouse.** The agent uses whatever the person connected in the UI. A tool that needs a connection returns an error result that says "Not connected: connect a profile in the app first."

## Transport

MCP streamable HTTP at `POST /mcp` on the app's own port (`127.0.0.1` only), answered with `application/json`. There is no SSE stream. The JSON-RPC methods are handled directly in Flask.

| Request | Answer |
| --- | --- |
| `POST /mcp` with `initialize` | `200`, the result below, and a `Mcp-Session-Id` header |
| `POST /mcp` with a notification, or a response from the client | `202`, empty body |
| `POST /mcp` with a request | `200`, one JSON-RPC response |
| `POST /mcp` with a JSON array | `200`, an array of the responses (`202` when none) |
| `POST /mcp` with `server/discover` | `200`, error `-32601`. This is the handshake-free probe of protocol 2026-07-28; clients fall back to `initialize` |
| `GET /mcp` | `405` (`Allow: POST, DELETE`). The server never streams |
| `DELETE /mcp` with a session | `204` (`404` for an unknown session) |

**Methods:** `initialize`, `notifications/initialized` (and any other notification, ignored), `ping`, `tools/list`, `tools/call`. Anything else is error `-32601`.

**Protocol version.** `initialize` echoes the client's `protocolVersion` when it is one of `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, and answers `2025-11-25` otherwise. A later request may carry `MCP-Protocol-Version`; an unsupported value is `400`. The initialize result is `{"protocolVersion", "capabilities": {"tools": {"listChanged": false}}, "serverInfo": {"name": "databricks-explore", "title", "version"}, "instructions"}`. Protocol 2026-07-28 itself (no handshake, no sessions) is not implemented.

**Sessions.** Every request except `initialize` needs `Mcp-Session-Id` (`400` when missing, `404` when unknown). A session id is a random part plus its HMAC under the token, so the server keeps no table and a session survives a restart of the app. A new token ends every session.

**Errors.**

- JSON-RPC errors (`{"jsonrpc": "2.0", "id", "error": {"code", "message"}}`): `-32700` invalid JSON (HTTP `400`), `-32600` not a JSON-RPC 2.0 request, an empty batch, a missing session or an unsupported protocol version (HTTP `400`, or `404` for an unknown session), `-32601` unknown method, `-32602` bad params or an unknown tool name.
- A tool that fails is **not** a JSON-RPC error. It is a normal result with `"isError": true` and the message as text, so the model can read it and correct the call. That includes arguments that fail the input schema (`Invalid arguments: ...`).

## Authentication and local-only checks

- **Token.** A random 32-byte URL-safe token is created at startup if `<data dir>/mcp_token` does not exist, and stored there with mode `0600` where the OS has file modes (a looser mode is tightened on next use; on Windows the file sits in the per-user folder). Every request to `/mcp` needs `Authorization: Bearer <token>` (compared in constant time), or it gets `401` with `WWW-Authenticate: Bearer`.
- **DNS rebinding.** A request whose `Host` is not `127.0.0.1`, `localhost` or `[::1]`, or whose `Origin` header is present and not one of those (`null` included), gets `403` before the token is looked at. A request with no `Origin` (a command line client) is fine.
- **Logging.** The token is never logged. Each tool call adds one line to `data/logs/calls.jsonl` with the tool name, milliseconds and success, and nothing else: no arguments, SQL or results.

### `GET /api/agent-access`

For the "Agent access" panel in the top bar. Same Host and Origin checks as `/mcp` (`403` otherwise), no token needed (the page is the owner).

```json
{"url": "http://127.0.0.1:8765/mcp", "token": "...",
 "command": "claude mcp add --transport http databricks-explore http://127.0.0.1:8765/mcp --header \"Authorization: Bearer ...\"",
 "tools": 33}
```

### `POST /api/agent-access/token`

Replaces the token and returns the same body. Agents using the old token get `401` until they are given the new command.

## Tool results

A result is `{"content": [...], "isError": false}`. Content is one text block, except `render_canvas`, which returns an `image` block (`mimeType: "image/png"`, base64) and a text block. Output is compact text by default. Tools that have a `format` argument return everything as JSON text with `"format": "json"`. Tool names, descriptions and input schemas are exactly what `tools/list` returns, with `annotations.readOnlyHint` set for the tools that change nothing. Every input schema is an object with `additionalProperties: false`.

## Tools: status and catalog

All of these read the app's connection. Catalog data comes from the local cache where it can.

| Tool | Input (`*` required) | Output |
| --- | --- | --- |
| `status` | `format` | Profile, selected warehouse, demo mode, saved canvas count, mining state and join suggestion counts. Works without a connection (it says so) |
| `search_tables` | `*q`, `scope` (`auto`, `cache`), `limit` (1-300, default 25) | A header line with the match count and source, then `catalog.schema.table  TYPE` per line. `auto` searches `system.information_schema` when a warehouse is selected (as the page's search box does), else the local cache; `cache` never uses the warehouse |
| `describe_table` | `*name` (`catalog.schema.table`), `refresh`, `format` | Header with type and fetch time, comment, one line per column (`name type [NOT NULL] -- comment`), PK/FK constraints, the first 400 characters of a view's definition. Reads the cache; one `tables.get` if the table was never opened. JSON: the `GET /api/object` body |
| `list_schemas` | `catalog`, `format` | The schemas of the catalog, or the catalogs when `catalog` is omitted. Cached |
| `list_tables` | `*catalog`, `*schema`, `limit` (1-1000, default 200), `format` | `name TYPE -- comment` per line. Cached |

## Tools: relationships and mining

| Tool | Input | Output |
| --- | --- | --- |
| `get_relationships` | `*table`, `level` (`table` default, `column`), `format` | One line per edge: `id kind status source[#column] -> target[#column] cols[...] runs= users= note=`. Edges are `contracts/api.md` section 4's (derived and stored). `column` adds column lineage, which reads the cached system table or runs one read-only query, as the page does |
| `add_relationship` | `*source`, `*target` (`{table, column?}`), `directed`, `note` | `created: <edge line>` (status `accepted`, origin `user`), or `already existed, re-accepted:` |
| `set_relationship_status` | `*id`, `status` (`proposed`, `accepted`, `rejected`), `note` | The edge line. A derived id (`fk:`, `lineage:`, `view_dep:`) takes only `note`. At least one of `status` and `note` |
| `mining_suggestions` | `status` (default `proposed`), `table`, `limit` (1-200, default 20), `format` | A count header (with the counts for all statuses), then one edge line per mined join, most evidence first |
| `usage` | `limit` (1-100, default 10), `format` | Busiest tables and table pairs from the last mining run, or `No usage yet` |
| `mine_plan` | `window_days` (1-365, default 30), `full` | The time window, whether it is incremental, the warehouse, and the exact read-only SQL on `system.query.history` and `system.access.table_lineage`. Runs nothing |
| `mine_run` | `*confirm` (must be `true`), `window_days`, `full` | Runs mining through the selected warehouse (read-only SQL on system tables) and stores proposed `join_mined` edges locally. Waits up to 25 seconds, then reports the result counts (`mining succeeded; 338 statements, 8 join pairs, ...`) or `still going`. Needs a selected warehouse. Statement text is never stored, as in `contracts/api.md` section 5 |

## Tools: concepts

Concept ids are the uuids of `contracts/api.md` section 6. There is no delete tool.

| Tool | Input | Output |
| --- | --- | --- |
| `list_concepts` | `q`, `domain`, `status`, `limit` (1-500, default 50), `format` | A count and the domains, then `id name [status] domain= links= -- definition` per concept |
| `get_concept` | `*id`, `format` | The concept line, synonyms, tags, origin, and `link <edge id> <relation> -> <target>` and `incoming <edge id> <relation> from <source>` lines |
| `create_concept` | `*name`, `definition`, `synonyms`, `domain`, `status`, `tags` | `created` and the detail. A name is unique, ignoring case |
| `update_concept` | `*id`, any of `name`, `definition`, `synonyms`, `domain` (`null` clears), `status`, `tags` (at least one) | `updated` and the detail |
| `link_concept` | `*id`, `*target` (`{table, column?}`; `concept:<uuid>` for a concept), `*relation`, `note` | `linked: <edge id> <relation> -> <target>`. Relations: `defines`, `measures`, `identifies`, `describes` for tables and columns; `is_a`, `part_of`, `related_to` for concepts |
| `unlink_concept` | `*id`, `*link_id` | `removed link <id>` |
| `find_candidates` | `*id`, `limit` (1-200, default 20), `format` | Tables and columns in the local cache whose name or comment mentions the concept or a synonym. Never uses the warehouse |

## Tool: run_sql

`run_sql(statement, max_rows?, timeout_s?)` runs **one** read-only statement on the SQL warehouse the app selected.

- **Gate.** The statement is parsed with sqlglot (Databricks dialect). Exactly one statement is accepted, and it must be a `SELECT` or `WITH ... SELECT` (also `UNION` and a parenthesized query), `DESCRIBE`/`DESC`, `SHOW` or `EXPLAIN`. Everything else is rejected, with `Rejected: <reason>` as an error result and no call to the warehouse: other statement kinds (`INSERT`, `DROP`, `MERGE`, `COPY`, `OPTIMIZE`, `SET`, `USE`, `CALL`, ...), more than one statement, an empty or unparseable statement, `SELECT ... INTO`, any DML or DDL node anywhere in the tree (so none hides in a CTE or subquery), and the functions `reflect`, `java_method`, `try_reflect` and `http_request`.
- **Caps.** `max_rows` is 1 to 1000 (default 100). `timeout_s` is 1 to 300 (default 60). A statement still running at the timeout is cancelled (`statement.cancel`) and the result is an error. The statement runs through the app's usual `query_async` and `query_status`, so it is logged like any query.
- **Output.** Text: a `columns: name TYPE, ...` line (the warehouse's type text), a TSV header line, the rows, and a closing line such as `(5 row(s) shown; the query has more than 5 rows (cap 5); 412 ms)`. A cell longer than 200 characters is cut with `...`, tabs and newlines in a cell become spaces, `NULL` is the word `NULL`, and the rows stop at about 24,000 characters (the closing line then says so).
- **Errors** (`isError`): rejected by the gate, not connected, no warehouse selected, timed out, or the warehouse's own error.

## Tools: canvases

A canvas is the saved file of `contracts/api.md` section 3 (format version 2 for anything an agent writes; a version 1 file is rewritten as version 2 on the first agent edit). Canvas tools need no connection and no warehouse. **They always read and write the saved file**, never the page's unsaved state.

**Nodes** (`add_nodes`) each have a `type` and are placed by `place` or `at`:

| Field | Meaning |
| --- | --- |
| `type` | `shape` (with `shape`: `rect`, `rounded`, `ellipse`, `diamond`, `cylinder`), `text`, `sticky`, `frame`, `placeholder` (a table that does not exist yet: `name`, `columns` of `{name, type?, key?}`), `query` (`sql`, `title`), `note` (`text`, `title`) or `table` (`table` = `catalog.schema.table`) |
| `id` | Optional. Otherwise `s<n>` for sketch types and `w<n>` for query, note and table windows, the lowest free number |
| `label`, `title` | `label` is the text of a sketch node. `title` names a query, note or table window (used as `{{title}}` in SQL). A title already taken gets `_2`, `_3`, ... |
| `w`, `h`, `fill`, `stroke`, `font_size`, `locked` | Optional. Styles default to what the page uses for a new node of that type. So does size, except that **a sketch node given no `w` is sized to its label** with `layout.fit_size`: at least the default size, widened to the label up to 320 px, then wrapped and taller. Give `w` to keep exactly the size you ask for (the doctor then reports `label_overflow` if it does not fit) |
| `place` | **Preferred.** `{relation, anchor, gap?}`: `right_of`, `left_of`, `below`, `above` an existing node, or `inside` a frame (the frame grows). The anchor may be a node added earlier in the same call. Consecutive nodes with the same `place` are placed together and stack (a column for `right_of`/`left_of`, a row for `below`/`above`). It uses `layout.arrange` mode `place`. `right_of` and `left_of` top-align the node with the anchor (`align`: `start` is the default there, `center` and `end` are the other choices; `below` and `above` center by default). A node that would land on something moves down first, up to 600 px, and only then further along the requested side; `below` and `above` move further along their own direction. `gap` defaults to 40 |
| `at` | `{x, y}` absolute position. Give `place` or `at`, not both. With neither, the node goes below the existing content (the origin on an empty canvas) |

| Tool | Input | Output |
| --- | --- | --- |
| `list_canvases` | none | `name: N nodes, M connectors, revision R` per saved canvas |
| `get_canvas` | `*name`, `format` (`describe` default, `text` as an alias of it, `json`), `max_lines` (10-300, default 60) | `describe` is `layout.describe`: counts, extent, score, frames, a reading-order map, connectors and top issues. `json` is the canvas file, compact |
| `create_canvas` | `*name` | An empty version 2 canvas with no profile. An existing name is an error |
| `add_nodes` | `*name`, `*nodes` (1-100), `auto_tidy` | The edit report (below) |
| `add_query_window` | `*name`, `*sql`, `title`, `place`, `at`, `w`, `h`, `auto_tidy` | The edit report. The SQL is stored, never run |
| `update_nodes` | `*name`, `*updates` (`[{id, ...}]`; `nodes` is accepted as an alias, the name `add_nodes` uses; give one of the two), `auto_tidy` | The edit report. Fields: `label`, `title`, `sql`, `text`, `table`, `shape`, `collapsed`, `z`, `w`, `h`, `fill`, `stroke`, `font_size`, `locked`, `place` or `at` (a move), and for a placeholder `name`, `columns`, `linked`. A new `title` rewrites `{{old}}` in other windows' SQL. A locked node can only be changed together with `locked: false` |
| `remove_nodes` | `*name`, `*ids` | The edit report. Ids may name nodes (their connectors go too) or connectors |
| `connect` | `*name`, then `source` and `target` (node ids) with optional `label`, `line` (`straight`, `step`, `curve`), `arrow_end` (default true), `arrow_start`, `dashed`, `color`, `source_handle`, `target_handle` (`t`, `r`, `b`, `l`), or `edges`: a list of those | The edit report. Connector ids are `c<n>`. Sides default to right to left, then re-picked to face each other unless given. A connector's label sits at the midpoint of its longest segment no other connector shares; if labels still collide, the doctor says so and `tidy` with `place_labels` nudges them (`label_offset`) |
| `arrange` | `*name`, `*mode` (`grid`, `row`, `column`, `layered`, `place`), `ids`, and the mode's options: `gap`, `align`, `cols`, `direction` (`LR`, `TB`), `layer_gap`, `relation`, `anchor`, `spacing`, `grid` | The edit report. Behavior is `POST /api/layout/arrange` |
| `tidy` | `*name`, `ids`, `rules` (`fit_labels`, `frames`, `overlaps`, `lines`, `align`, `spacing`, `grid`, `handles`, `place_labels`), `grid` | The edit report, with `tidied: N change(s), score a -> b`. `fit_labels` grows nodes whose labels overflow, and `place_labels` sets `label_offset` on connector labels that collide; both are on by default, and the doctor's `label_overflow` and `label_collision` issues name them in `[fix: ...]` (behavior: `contracts/api.md` section 3b) |
| `doctor` | `*name`, `grid`, `limit` (default 25), `format` | `score N/100; K issue(s)`, then `severity kind nodes: message [fix: tidy rules=... ids=...]`. Reads only. JSON: the `POST /api/layout/doctor` body |
| `render_canvas` | `*name`, `width` (200-2000, default 1000), `highlight` (ids, or `"issues"`) | An image block (PNG from `layout.render_png`) and a text line |
| `undo_canvas` | `*name` | Restores the state before the last agent write and reports the revision and how many earlier agent changes remain. Calling it again goes one change further back |

**The edit report.** Every canvas tool that changes a canvas saves it and returns:

```
added a, b. revision 4; doctor score 96/100 (1 warning). undo_canvas reverts it.
Canvas "d": 2 nodes (2 shape), 1 connectors; extent x 0..580, y 0..80 px. Layout score 96/100.
<the next lines of layout.describe, about 14 in all>
```

**Auto tidy.** After `add_nodes`, `add_query_window` and `update_nodes`, an overlap-only tidy (`layout.tidy` with `rules: ["overlaps"]`) runs on the nodes just touched, unless `auto_tidy: false`. The headline then says `moved N to clear overlaps`. Locked nodes never move.

**Undo.** Before each agent write, the file it replaces is kept as a snapshot in `data/canvas_history/<name>/` (the last 20 per canvas). A canvas that did not exist before has nothing to undo. `undo_canvas` and the page's "Undo agent change" button (`POST /api/canvases/<name>/undo`) restore the newest snapshot.

**Live sync.** Each canvas has a revision number (`GET /api/canvases/<name>/revision`, `contracts/api.md` section 3). Every save, by the page or by an agent, increments it. The page polls it every 2 seconds. With no unsaved edits it reloads the canvas in place and keeps its viewport. With unsaved edits it shows "An agent changed this canvas" with Reload and Keep mine, and its autosave waits for the choice. The page sends `X-Base-Revision` with a save, and the server answers `409` when the canvas moved on (`contracts/api.md`), so the page cannot overwrite an agent's save unseen. An agent write is never refused: MCP writes always go to the saved file.

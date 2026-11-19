# AGENTS.md

## Project map
`PROJECT_MAP.md` lists every file in this repo with a summary of its public functions and classes.
It is generated and git-ignored: run `python map_project.py` at the start of a session, then read it
before you go looking for files.

Agents without shell access can't list folders.
Treat `PROJECT_MAP.md` as the file listing and open files by the names it gives.

## Layout
The Python code is the `databricks_explore` package in `src/databricks_explore/` (import it as
`from databricks_explore import dbx`). The React UI is in `web/` and builds into
`src/databricks_explore/web_dist/` (git-ignored). `pyproject.toml` (hatchling) holds the dependencies;
the version is `__version__` in `src/databricks_explore/__init__.py` and nowhere else.

## Commands
- `uv sync` installs the package in editable mode with the dev group (pytest, jsonschema).
- `cd web && npm ci && npm run build` builds the UI once, and again after frontend changes.
- `uv run databricks-explore --demo --no-browser` runs the app on invented data (`--port N` to pick a port;
  `--data-dir DIR` keeps the files somewhere disposable).
- `uv run pytest -q` runs the Python tests. `cd web && npm test` runs the web tests.
- `cd web && npm run e2e` builds the UI and runs the Playwright scenarios (`web/e2e`, Chromium, demo mode on a free port and a
  temporary data folder). Once per machine: `npx playwright install chromium`. `npx playwright test e2e/graph-groups.spec.ts`
  reruns one file without rebuilding. A UI change adds or updates a scenario; add a `data-testid` only where role, label or
  text would be brittle. CI runs it as the `e2e` job and uploads the report when it fails.
- `uv build` makes the wheel and sdist in `dist/`; `python scripts/check_dist.py dist` checks them.
- `uv run --with mcp scripts/mcp_interop.py` checks the MCP server with the official SDK client.

Tests write to a temporary data folder (`tests/conftest.py`), never to the user's real one.

## Worktrees
An agent worktree should symlink the main checkout's `web/node_modules` rather than run `npm ci`,
unless `package.json` changed. It saves about 160 MB per worktree. Start a branch from the remote, not from
whatever the worktree was created on: `git fetch origin && git checkout -B <branch> origin/main`.

## Keeping it current
After you add, remove, rename, or change the signature of anything, run `python map_project.py` again
so your own copy stays accurate. Never commit `PROJECT_MAP.md`; it is git-ignored so branches cannot
conflict over it.

## Working in parallel
- Most Graph changes touch the same few files: `web/src/graph/derive.ts`, `TableNode.tsx`, the ELK layout
  (async), `GraphToolbar.tsx` and `GraphDetails.tsx`. Put an addition in its own component or section and
  insert it with a line or two, so parallel branches merge cleanly.
- Some logic exists in both TypeScript (the page) and Python (agent tools): edge derivation and families, table
  roles, the Model and flow layouts, size estimates, collapse, the export scene and legend. `tests/test_parity.py`
  and `web/src/parity.test.ts` run both sides on shared fixtures. Change both copies together.
- A new field in a saved graph must round-trip through save, MCP `get_graph`/`create_graph`/`update_graph`,
  rename and the trash copy, and graphs saved by older versions must still load.
- Demo mode answers with invented shapes. Check a new Databricks read (SQL, REST, system tables) against a real
  workspace before a release.
- macOS file names are case-insensitive: never add two files whose names differ only by case
  (`nodeFacts.ts` and `NodeFacts.tsx` collide).

## Conventions
- Put a one-line docstring at the top of each module and public function. The map uses that line as the summary.
- Functions starting with `_` are private and stay off the map.

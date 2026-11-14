# AGENTS.md

## Project map
`PROJECT_MAP.md` lists every file in this repo with a summary of its public functions and classes.
Read it before you go looking for files.

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
- `uv build` makes the wheel and sdist in `dist/`; `python scripts/check_dist.py dist` checks them.
- `uv run --with mcp scripts/mcp_interop.py` checks the MCP server with the official SDK client.

Tests write to a temporary data folder (`tests/conftest.py`), never to the user's real one.

## Worktrees
An agent worktree should symlink the main checkout's `web/node_modules` rather than run `npm ci`,
unless `package.json` changed. It saves about 160 MB per worktree.

## Keeping it current
After you add, remove, rename, or change the signature of anything, run:

    python map_project.py

Commit `PROJECT_MAP.md` with the change. `python map_project.py --check` exits 1 if it's stale.

## Conventions
- Put a one-line docstring at the top of each module and public function. The map uses that line as the summary.
- Functions starting with `_` are private and stay off the map.

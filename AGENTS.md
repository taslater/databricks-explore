# AGENTS.md

## Project map
`PROJECT_MAP.md` lists every file in this repo with a summary of its public functions and classes.
Read it before you go looking for files.

Agents without shell access can't list folders.
Treat `PROJECT_MAP.md` as the file listing and open files by the names it gives.

## Keeping it current
After you add, remove, rename, or change the signature of anything, run:

    python map_project.py

Commit `PROJECT_MAP.md` with the change. `python map_project.py --check` exits 1 if it's stale.

## Conventions
- Put a one-line docstring at the top of each module and public function. The map uses that line as the summary.
- Functions starting with `_` are private and stay off the map.

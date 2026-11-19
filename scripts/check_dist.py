"""Check a built wheel and sdist: the web UI and the third-party notices are inside, nothing generic is top-level.

Usage:  python scripts/check_dist.py [DIST_DIR]      (default: dist)
Exit status is 1 when anything is missing. Uses only the standard library.
"""
import sys
import tarfile
import zipfile
from pathlib import Path


def check_wheel(path: Path) -> list[str]:
    """Problems with one wheel, as messages."""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        entry_points = next((z.read(n).decode() for n in names if n.endswith(".dist-info/entry_points.txt")), "")
    problems = []
    for need in ("databricks_explore/__init__.py", "databricks_explore/cli.py", "databricks_explore/web_dist/index.html",
                 "databricks_explore/web_dist/THIRD-PARTY-NOTICES.txt"):
        if need not in names:
            problems.append(f"{path.name}: missing {need}")
    if not any(n.startswith("databricks_explore/web_dist/assets/") and n.endswith(".js") for n in names):
        problems.append(f"{path.name}: no JavaScript under databricks_explore/web_dist/assets/")
    elk = [n for n in names if n.startswith("databricks_explore/web_dist/assets/") and "/elk" in n and n.endswith(".js") and "elk-api" not in n]
    if len(elk) > 1:  # the layout worker is shipped once; dagre covers a browser that cannot start it
        problems.append(f"{path.name}: elkjs is shipped more than once: {', '.join(n.rsplit('/', 1)[1] for n in elk)}")
    if not any(n.endswith(".dist-info/licenses/LICENSE") for n in names):
        problems.append(f"{path.name}: the LICENSE file is not in the dist-info")
    if "databricks-explore = databricks_explore.cli:main" not in entry_points:
        problems.append(f"{path.name}: the databricks-explore console script is not declared")
    stray = sorted({n.split("/")[0] for n in names} - {"databricks_explore"} - {n.split("/")[0] for n in names if ".dist-info/" in n})
    if stray:
        problems.append(f"{path.name}: top-level entries outside the package: {', '.join(stray)}")
    return problems


def check_sdist(path: Path) -> list[str]:
    """Problems with one sdist, as messages."""
    with tarfile.open(path) as t:
        names = [n.split("/", 1)[1] for n in t.getnames() if "/" in n]
    problems = []
    for need in ("LICENSE", "pyproject.toml", "hatch_build.py", "web/package.json", "web/package-lock.json",
                 "src/databricks_explore/cli.py", "src/databricks_explore/web_dist/index.html",
                 "src/databricks_explore/web_dist/THIRD-PARTY-NOTICES.txt"):
        if need not in names:
            problems.append(f"{path.name}: missing {need}")
    if any(n.startswith("web/node_modules") for n in names):
        problems.append(f"{path.name}: contains web/node_modules")
    return problems


def main() -> int:
    """Check every wheel and sdist in the folder."""
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else "dist")
    wheels, sdists = sorted(folder.glob("*.whl")), sorted(folder.glob("*.tar.gz"))
    problems = [] if wheels and sdists else [f"{folder}: need one wheel and one sdist, found {len(wheels)} and {len(sdists)}"]
    for w in wheels:
        problems += check_wheel(w)
    for s in sdists:
        problems += check_sdist(s)
    for p in problems:
        print("FAIL", p)
    if not problems:
        print(f"ok: {', '.join(p.name for p in wheels + sdists)}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())

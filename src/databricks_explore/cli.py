"""The `databricks-explore` command: parse options, pick the data folder, start the server and open the browser."""
import argparse
import os
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Optional, Sequence

from . import __version__

HOST = "127.0.0.1"  # the app never listens on anything else
DEFAULT_PORT, DEMO_PORT = 8765, 8767  # demo mode has its own port so the browser keeps its saved profile apart


def build_parser() -> argparse.ArgumentParser:
    """The option parser. Defaults for --port and --data-dir are filled in by main() because they depend on --demo."""
    p = argparse.ArgumentParser(
        prog="databricks-explore",
        description="Local Unity Catalog explorer: query canvas, relationship graph and sketching. Serves on 127.0.0.1 only.",
        epilog="Environment: EXPLORER_DATA_DIR (same as --data-dir), PORT (same as --port), EXPLORER_DEMO=1 (same as --demo).",
    )
    p.add_argument("--version", action="version", version=f"databricks-explore {__version__}")
    p.add_argument("--demo", action="store_true", help="serve an invented workspace (no Databricks needed) on its own port and data folder")
    p.add_argument("--redacted", action="store_true", help="with --demo: make query history text read <REDACTED>, to try that path")
    p.add_argument("--port", type=int, help=f"port to listen on (default {DEFAULT_PORT}, or {DEMO_PORT} with --demo)")
    p.add_argument("--data-dir", metavar="DIR", help="where the app keeps its cache, canvases and relationships "
                   "(default: your per-user data folder, with a demo/ folder inside it for --demo)")
    p.add_argument("--debug", action="store_true", help="Werkzeug debugger and reloader (the debugger can run code from an error page)")
    p.add_argument("--no-browser", action="store_true", help="do not open a browser tab")
    return p


def source_checkout_hint(data_dir_given: bool) -> Optional[str]:
    """One line of advice when running from a source checkout that still has its old data/ folder, else None."""
    if data_dir_given:
        return None
    root = Path(__file__).resolve().parents[2]
    if (root / "pyproject.toml").is_file() and (root / "data").is_dir():
        return f"Hint: {root / 'data'} is from an earlier version and is not used now. To keep using it: --data-dir {root / 'data'}"
    return None


def main(argv: Optional[Sequence[str]] = None) -> int:
    """Run the app. Returns the exit status."""
    args = build_parser().parse_args(argv)
    # dbx reads these when it is first imported, so they are set before the app is.
    demo = args.demo or os.environ.get("EXPLORER_DEMO") == "1"
    if demo:
        os.environ["EXPLORER_DEMO"] = "1"
    if args.redacted:
        if not demo:
            print("--redacted only applies with --demo", file=sys.stderr)
            return 2
        os.environ["EXPLORER_DEMO_REDACTED"] = "1"
    data_dir_given = bool(args.data_dir or os.environ.get("EXPLORER_DATA_DIR"))
    if args.data_dir:
        os.environ["EXPLORER_DATA_DIR"] = str(Path(args.data_dir).expanduser().resolve())
    port = args.port if args.port is not None else int(os.environ.get("PORT") or (DEMO_PORT if demo else DEFAULT_PORT))
    debug = args.debug or os.environ.get("EXPLORER_DEBUG") == "1"

    from . import dbx
    from .app import app

    url = f"http://{HOST}:{port}"
    # With the reloader the first process only supervises; the server (and the message) belong to its child.
    serving = not debug or os.environ.get("WERKZEUG_RUN_MAIN") == "true"
    if serving:
        print(f"Databricks Explorer {__version__}{' (demo mode)' if demo else ''} at {url}", flush=True)
        print(f"Data folder: {dbx.DATA}", flush=True)
        if hint := source_checkout_hint(data_dir_given):
            print(hint, flush=True)
        if not args.no_browser:
            threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    try:
        app.run(host=HOST, port=port, debug=debug)
    except OSError as e:
        print(f"Could not listen on {HOST}:{port} ({e.strerror or e}). Pick another port with --port.", file=sys.stderr)
        return 1
    return 0

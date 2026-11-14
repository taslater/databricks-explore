"""Interoperability check: the official `mcp` Python SDK client against this app's MCP server, in demo mode.

Needs only the `mcp` SDK, not the app's code, so it can run against an installed tool:

    uv run --with mcp scripts/mcp_interop.py                       # from a checkout: starts its own demo server
    uv run --no-project --with mcp scripts/mcp_interop.py --url http://127.0.0.1:8765
                                                                   # against a demo server that is already running

Without --url it starts `python -m databricks_explore --demo --no-browser` on a free port with a temporary data folder
(the package must be importable, as after `uv sync`). Either way it plays the person in the browser (connects the demo
profile and picks the demo warehouse over the REST API, which no MCP tool may do), then plays the agent over MCP:
initialize, tools/list, status, search_tables, run_sql (one allowed, one rejected), and on a new canvas create_canvas,
add_nodes with structural placement, connect, arrange (layered), doctor and render_canvas. One PASS or FAIL line each.
Exit status is 1 when anything failed. A server it was pointed at is left running; one it started is stopped.
"""
import argparse
import asyncio
import base64
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

RESULTS: list[tuple[bool, str, str]] = []


def record(ok: bool, name: str, detail: str = "") -> bool:
    """Print and remember one check."""
    RESULTS.append((ok, name, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  -- {detail}" if detail else ""), flush=True)
    return ok


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def http(method: str, url: str, body=None):
    """The person's side: plain JSON over HTTP to the app's own API."""
    req = urllib.request.Request(url, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or "null")


def start_app(port: int, data_dir: str) -> subprocess.Popen:
    """Start our own demo server (the package must be importable) and wait until it answers."""
    cmd = [sys.executable, "-m", "databricks_explore", "--demo", "--no-browser", "--port", str(port), "--data-dir", data_dir]
    own_group = {} if sys.platform == "win32" else {"start_new_session": True}
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **own_group)
    wait_for(f"http://127.0.0.1:{port}", proc)
    return proc


def wait_for(base: str, proc: "subprocess.Popen | None" = None, seconds: float = 120) -> None:
    """Wait until the server at `base` answers /api/session. Raises when it does not, or when `proc` exits first."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            http("GET", f"{base}/api/session")
            return
        except Exception:
            if proc is not None and proc.poll() is not None:
                raise RuntimeError("the app exited while starting")
            time.sleep(0.5)
    raise RuntimeError(f"no answer from {base} in time")


def stop_app(proc: subprocess.Popen) -> None:
    """Stop the server we started."""
    try:
        if sys.platform == "win32":
            proc.terminate()
        else:
            os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()


def texts(result) -> str:
    return "\n".join(c.text for c in result.content if getattr(c, "type", "") == "text")


def failed(result) -> bool:
    return bool(getattr(result, "is_error", None) or getattr(result, "isError", None))


async def agent(url: str, token: str) -> None:
    async def call(session, tool, /, **args):
        return await session.call_tool(tool, args)

    async def check(name, fn):
        """Run one check: fn returns (ok, detail). An exception is a failure."""
        try:
            ok, detail = await fn()
        except Exception as e:
            ok, detail = False, f"{type(e).__name__}: {e}"
        record(ok, name, detail)

    http_client = httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"}, timeout=60)
    async with streamable_http_client(url, http_client=http_client) as (read, write):
        async with ClientSession(read, write) as session:
            async def init():
                r = await session.initialize()
                return r.server_info.name == "databricks-explore", f"{r.server_info.name}, protocol {r.protocol_version}"
            await check("initialize", init)

            async def listing():
                tools = (await session.list_tools()).tools
                names = {t.name for t in tools}
                need = {"status", "search_tables", "run_sql", "create_canvas", "add_nodes", "connect", "arrange", "doctor", "render_canvas"}
                return need <= names and all(t.description for t in tools), f"{len(tools)} tools"
            await check("tools/list", listing)

            async def status():
                r = await call(session, "status")
                return not failed(r) and "profile demo" in texts(r), texts(r).splitlines()[0]
            await check("status", status)

            async def search():
                r = await call(session, "search_tables", q="order")
                return not failed(r) and "demo.sales.orders" in texts(r), texts(r).splitlines()[0]
            await check("search_tables", search)

            async def sql_ok():
                r = await call(session, "run_sql", statement="SELECT order_id, amount FROM demo.sales.orders", max_rows=5)
                t = texts(r)
                return not failed(r) and t.startswith("columns: order_id bigint") and "5 row(s) shown" in t, t.splitlines()[-1]
            await check("run_sql: SELECT is allowed", sql_ok)

            async def sql_rejected():
                r = await call(session, "run_sql", statement="DROP TABLE demo.sales.orders")
                return failed(r) and texts(r).startswith("Rejected:"), texts(r)
            await check("run_sql: DROP is rejected", sql_rejected)

            async def create():
                r = await call(session, "create_canvas", name="interop")
                return not failed(r), texts(r)
            await check("create_canvas", create)

            async def add():
                r = await call(session, "add_nodes", name="interop", nodes=[
                    {"type": "shape", "id": "orders", "label": "orders", "at": {"x": 0, "y": 0}},
                    {"type": "shape", "id": "customers", "label": "customers", "place": {"relation": "right_of", "anchor": "orders", "gap": 80}},
                    {"type": "sticky", "id": "note", "label": "joined on customer_id", "place": {"relation": "below", "anchor": "orders"}}])
                return not failed(r) and "added orders, customers, note" in texts(r) and "doctor score" in texts(r), texts(r).splitlines()[0]
            await check("add_nodes (structural placement)", add)

            async def connect():
                r = await call(session, "connect", name="interop", source="orders", target="customers", label="customer_id")
                return not failed(r) and "connected orders->customers" in texts(r), texts(r).splitlines()[0]
            await check("connect", connect)

            async def arrange():
                r = await call(session, "arrange", name="interop", mode="layered", direction="LR")
                return not failed(r) and texts(r).startswith("arranged (layered)"), texts(r).splitlines()[0]
            await check("arrange (layered)", arrange)

            async def doctor():
                r = await call(session, "doctor", name="interop")
                return not failed(r) and texts(r).startswith("score "), texts(r).splitlines()[0]
            await check("doctor", doctor)

            async def render():
                r = await call(session, "render_canvas", name="interop", width=600)
                images = [c for c in r.content if getattr(c, "type", "") == "image"]
                png = base64.b64decode(images[0].data) if images else b""
                return (not failed(r) and png[:8] == b"\x89PNG\r\n\x1a\n" and images[0].mime_type == "image/png",
                        f"{len(png)} byte PNG" if png else "no image block")
            await check("render_canvas (image content)", render)


def run_checks(base: str) -> None:
    """The person's side over REST, then the agent's over MCP, against the server at `base`."""
    http("POST", f"{base}/api/connect", {"profile": "demo"})  # the person, in the browser
    http("POST", f"{base}/api/warehouse", {"id": "demo-wh-1"})
    access = http("GET", f"{base}/api/agent-access")  # what the Agent access panel shows
    record(access["command"].startswith("claude mcp add --transport http databricks-explore "), "Agent access command",
           access["command"].replace(access["token"], "<token>"))
    asyncio.run(agent(f"{base}/mcp", access["token"]))


def main() -> int:
    ap = argparse.ArgumentParser(description="MCP interoperability check against the app's demo mode. "
                                 "It creates a canvas named interop, so run it against a server whose data folder is disposable.")
    ap.add_argument("--url", help="base URL of a demo server that is already running, e.g. http://127.0.0.1:8765; "
                    "without it a server is started on a free port")
    args = ap.parse_args()
    if args.url:
        base = args.url.rstrip("/")
        wait_for(base)
        run_checks(base)
    else:
        port = free_port()
        with tempfile.TemporaryDirectory() as data_dir:
            proc = start_app(port, data_dir)
            try:
                run_checks(f"http://127.0.0.1:{port}")
            finally:
                stop_app(proc)
    bad = [name for ok, name, _ in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(bad)}/{len(RESULTS)} passed" + (f"; failed: {', '.join(bad)}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())

"""JSON-RPC 2.0 for MCP: initialize, ping, tools/list and tools/call, with protocol version negotiation and proper errors."""
import time
from typing import Any, Optional

from .. import dbx

from . import tools_canvas, tools_data, tools_graph  # noqa: F401  (importing registers the tools)
from . import tools_profile  # noqa: F401
from .schema import validate
from .tooling import REGISTRY, Context, ToolError

PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")  # newest first
SERVER_INFO = {"name": "databricks-explore", "title": "Databricks Explorer", "version": "0.5.0"}
INSTRUCTIONS = (
    "Local Unity Catalog explorer. Read the catalog, relationships and concepts, run read-only SQL, and edit canvases next to the person using the browser. "
    "Start with status. Tools that need a connection say so: the person connects in the app, you cannot. "
    "No tool writes to the workspace. Canvas edits are saved at once and undoable with undo_canvas. "
    "Graphs saved from the Graph tab are a separate store from canvases: list_graphs and get_graph read them, create_graph, update_graph, rename_graph and delete_graph change them (a delete keeps a copy in a trash folder), "
    "and export_graph draws one as Mermaid or a PNG. trace_column follows one column through column lineage and can add the tables it reaches to a saved graph. "
    "On canvases prefer structural placement (place: right_of/below/inside an anchor id) over absolute coordinates, and read the doctor score each edit returns.")

PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR = -32700, -32600, -32601, -32602, -32603


def error(code: int, message: str, rid: Any = None) -> dict:
    """A JSON-RPC error response."""
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def negotiate(requested: Optional[str]) -> str:
    """The protocol version to use: the client's when we speak it, else our newest."""
    return requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]


def handle(message: Any, ctx: Context) -> Optional[dict]:
    """Answer one JSON-RPC message. None for a notification or a response from the client (nothing to send back)."""
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return error(INVALID_REQUEST, "not a JSON-RPC 2.0 message")
    method, rid = message.get("method"), message.get("id")
    if method is None:
        return None if ("result" in message or "error" in message) else error(INVALID_REQUEST, "missing method", rid)
    if not isinstance(method, str):
        return error(INVALID_REQUEST, "method must be a string", rid)
    if "id" not in message:
        return None  # notifications/initialized, notifications/cancelled, ...: accepted, no reply
    if isinstance(rid, bool) or not isinstance(rid, (int, str)):
        return error(INVALID_REQUEST, "id must be a string or an integer")
    params = message.get("params", {})
    if not isinstance(params, dict):
        return error(INVALID_PARAMS, "params must be an object", rid)
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": negotiate(params.get("protocolVersion")), "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO, "instructions": INSTRUCTIONS}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": rid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": [t.listing() for t in REGISTRY.values()]}}
    if method == "tools/call":
        return _call(params, rid, ctx)
    return error(METHOD_NOT_FOUND, f"method not found: {method}", rid)


def _call(params: dict, rid: Any, ctx: Context) -> dict:
    name = params.get("name")
    tool = REGISTRY.get(name) if isinstance(name, str) else None
    if tool is None:
        return error(INVALID_PARAMS, f"unknown tool: {name!r}", rid)
    args = params.get("arguments", {})
    problems = validate(args, tool.schema) if isinstance(args, dict) else ["arguments: must be an object"]
    if problems:  # a tool execution error, so the model can read it and correct the call
        return _result(rid, [{"type": "text", "text": "Invalid arguments: " + "; ".join(problems[:6])}], True)
    started = time.time()
    try:
        content, failed = tool.handler(ctx, args), False
    except Exception as e:  # ToolError and every domain error (validation, not found, warehouse): message back to the agent
        content, failed = [{"type": "text", "text": _message(e)}], True
    # The name and timing only: never arguments, SQL or results.
    dbx.log({"op": f"mcp.{tool.name}", "ms": int((time.time() - started) * 1000), "ok": not failed})
    return _result(rid, content, failed)


def _message(e: Exception) -> str:
    if isinstance(e, ToolError):
        return str(e)
    msg = dbx.clean_error(e)
    return f"{type(e).__name__}: {msg}" if msg and not isinstance(e, (ValueError, LookupError)) else (msg or type(e).__name__)


def _result(rid: Any, content: list, is_error: bool) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "result": {"content": content, "isError": is_error}}

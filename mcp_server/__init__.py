"""An MCP server inside the Flask app: streamable HTTP at /mcp, local only, bearer token, JSON-RPC handled directly.

`register(app, explorer, store, miner)` adds /mcp and the two /api/agent-access routes the page uses. Read access,
local edits and read-only SQL only: no tool writes to the workspace or connects a profile. See contracts/mcp.md.
"""
import json
from typing import Callable

from flask import Flask, Response, jsonify, request

from . import auth, rpc
from .tooling import REGISTRY, Context

SESSION_HEADER = "Mcp-Session-Id"


def access_info(port: str) -> dict:
    """The URL, the token and the ready-to-paste `claude mcp add` command for the Agent access panel."""
    url = f"http://127.0.0.1:{port}/mcp"
    token = auth.get_token()
    return {"url": url, "token": token,
            "command": f'claude mcp add --transport http databricks-explore {url} --header "Authorization: Bearer {token}"',
            "tools": len(REGISTRY)}


def register(app: Flask, explorer: Callable, store: Callable, miner: Callable) -> None:
    """Add the MCP endpoint and the agent-access routes to the app."""
    ctx = Context(explorer=explorer, store=store, miner=miner)
    auth.get_token()  # create the token file at startup, so it exists before the first request

    def refuse_non_local():
        """403 for a Host or Origin that is not this machine (DNS rebinding); None when fine."""
        if not auth.host_is_local(request.host) or not auth.origin_is_local(request.headers.get("Origin")):
            return jsonify({"error": "forbidden: this endpoint only answers local requests"}), 403
        return None

    def json_rpc(body: dict, status: int = 200, headers: dict | None = None) -> Response:
        return Response(json.dumps(body), status=status, mimetype="application/json", headers=headers or {})

    @app.route("/mcp", methods=["GET", "POST", "DELETE"])
    def mcp_endpoint():
        refused = refuse_non_local()
        if refused:
            return refused
        if not auth.bearer_ok(request.headers.get("Authorization")):
            return Response(json.dumps({"error": "unauthorized: send Authorization: Bearer <token> (see Agent access in the app)"}),
                            status=401, mimetype="application/json", headers={"WWW-Authenticate": 'Bearer realm="databricks-explore"'})
        if request.method == "GET":  # no server-to-client stream is offered
            return Response("", status=405, headers={"Allow": "POST, DELETE"})
        session = request.headers.get(SESSION_HEADER)
        if request.method == "DELETE":
            return Response("", status=204 if auth.session_ok(session) else 404)
        version = request.headers.get("MCP-Protocol-Version")
        if version is not None and version not in rpc.PROTOCOL_VERSIONS:
            return json_rpc(rpc.error(rpc.INVALID_REQUEST, f"unsupported MCP-Protocol-Version {version}; use one of {', '.join(rpc.PROTOCOL_VERSIONS)}"), 400)
        try:
            body = json.loads(request.get_data(as_text=True) or "")
        except ValueError:
            return json_rpc(rpc.error(rpc.PARSE_ERROR, "the body is not valid JSON"), 400)
        batch = body if isinstance(body, list) else [body]
        if not batch:
            return json_rpc(rpc.error(rpc.INVALID_REQUEST, "empty batch"), 400)
        if all(isinstance(m, dict) and m.get("method") == "server/discover" for m in batch):
            # The 2026-07-28 handshake-free probe. We speak the initialize handshake, so say "no such method" and let the client fall back.
            return json_rpc(rpc.error(rpc.METHOD_NOT_FOUND, "method not found: server/discover; use initialize", batch[0].get("id")))
        is_init = any(isinstance(m, dict) and m.get("method") == "initialize" for m in batch)
        if not is_init:
            if not session:
                return json_rpc(rpc.error(rpc.INVALID_REQUEST, f"missing {SESSION_HEADER} header: send initialize first"), 400)
            if not auth.session_ok(session):
                return json_rpc(rpc.error(rpc.INVALID_REQUEST, "unknown session: send initialize again"), 404)
        replies = [r for r in (rpc.handle(m, ctx) for m in batch) if r is not None]
        headers = {SESSION_HEADER: auth.new_session_id()} if is_init else {}
        if not replies:
            return Response("", status=202, headers=headers)
        if isinstance(body, list):
            return Response(json.dumps(replies), mimetype="application/json", headers=headers)
        status = 400 if replies[0].get("error", {}).get("code") in (rpc.INVALID_REQUEST, rpc.PARSE_ERROR) else 200
        return json_rpc(replies[0], status, headers)

    @app.get("/api/agent-access")
    def agent_access():
        """The MCP URL, token and ready-to-paste command for the Agent access panel. Local requests only."""
        return refuse_non_local() or jsonify(access_info(request.environ.get("SERVER_PORT", "8765")))

    @app.post("/api/agent-access/token")
    def agent_access_new_token():
        """Replace the token. Agents using the old one get a 401 until they are given the new one."""
        refused = refuse_non_local()
        if refused:
            return refused
        auth.new_token()
        return jsonify(access_info(request.environ.get("SERVER_PORT", "8765")))

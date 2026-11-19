"""The /mcp endpoint: authentication, local-only checks, sessions, JSON-RPC errors, and the token file."""
import json
import os
import stat
import sys

import pytest

from databricks_explore import dbx
from mcp_helpers import Agent, agent, connected, env, offline_agent  # noqa: F401
from databricks_explore.mcp_server import auth, rpc
from databricks_explore.mcp_server.tooling import REGISTRY

EXPECTED_TOOLS = {
    "status", "search_tables", "describe_table", "list_schemas", "list_tables",
    "get_relationships", "lineage", "add_relationship", "set_relationship_status",
    "find_by_tag", "mining_suggestions", "usage", "mine_plan", "mine_run",
    "list_concepts", "get_concept", "create_concept", "update_concept", "link_concept", "unlink_concept", "find_candidates",
    "run_sql",
    "list_canvases", "get_canvas", "create_canvas", "add_nodes", "add_query_window", "update_nodes", "remove_nodes", "connect",
    "connect_known", "add_lineage", "run_window", "run_all_windows", "arrange", "tidy", "doctor", "render_canvas", "undo_canvas",
    "list_graphs", "get_graph", "create_graph", "update_graph", "rename_graph", "delete_graph", "export_graph",
}


def test_no_token_is_401_and_says_how(env):
    r = env.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert r.status_code == 401 and r.headers["WWW-Authenticate"].startswith("Bearer")
    r = env.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}, headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401
    r = env.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}, headers={"Authorization": "Basic abc"})
    assert r.status_code == 401


def test_a_non_local_origin_is_refused_even_with_the_token(env):
    a = Agent(env)
    for origin in ("https://evil.example", "http://localhost.evil.example", "null"):
        r = a.rpc("ping", Origin=origin)
        assert r.status_code == 403, origin
    assert a.rpc("ping", Origin="http://127.0.0.1:5173").status_code != 403
    assert a.rpc("ping", Origin="http://localhost:8765").status_code != 403


def test_a_non_local_host_is_refused_even_with_the_token(env):
    a = Agent(env)
    r = env.post("/mcp", data='{"jsonrpc":"2.0","id":1,"method":"ping"}', headers=a.headers(), base_url="http://rebind.example:8765")
    assert r.status_code == 403
    r = env.post("/mcp", data='{"jsonrpc":"2.0","id":1,"method":"ping"}', headers=a.headers(), base_url="http://127.0.0.1:8765")
    assert r.status_code != 403


def test_initialize_negotiates_and_returns_a_session(env):
    a = Agent(env)
    r = a.initialize("2025-06-18")
    body = r.get_json()["result"]
    assert r.status_code == 200 and r.headers["Mcp-Session-Id"]
    assert body["protocolVersion"] == "2025-06-18"
    assert body["capabilities"] == {"tools": {"listChanged": False}}
    assert body["serverInfo"]["name"] == "databricks-explore" and "status" in body["instructions"]
    assert Agent(env).initialize("1999-01-01").get_json()["result"]["protocolVersion"] == rpc.PROTOCOL_VERSIONS[0]


def test_initialized_notification_is_accepted_with_202_and_no_body(agent):
    r = agent.post({"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert r.status_code == 202 and r.get_data() == b""


def test_requests_need_the_session(env):
    a = Agent(env)
    r = a.rpc("tools/list")
    assert r.status_code == 400 and "initialize" in r.get_json()["error"]["message"]
    a.session = "forged.0000"
    assert a.rpc("tools/list").status_code == 404


def test_delete_ends_a_session_and_get_is_405(agent):
    assert agent.client.get("/mcp", headers=agent.headers()).status_code == 405
    assert agent.client.delete("/mcp", headers=agent.headers()).status_code == 204
    assert agent.client.delete("/mcp", headers={**agent.headers(), "Mcp-Session-Id": "x.y"}).status_code == 404


def test_ping_and_unknown_method_and_bad_json(agent):
    assert agent.rpc("ping").get_json()["result"] == {}
    r = agent.rpc("resources/list")
    assert r.get_json()["error"]["code"] == -32601
    r = agent.client.post("/mcp", data="{nope", headers=agent.headers())
    assert r.status_code == 400 and r.get_json()["error"]["code"] == -32700
    r = agent.post([])
    assert r.status_code == 400
    r = agent.post({"hello": "world"})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == -32600
    r = agent.rpc("ping", **{"MCP-Protocol-Version": "1999-01-01"})
    assert r.status_code == 400


def test_the_handshake_free_probe_is_answered_so_a_modern_client_falls_back_to_initialize(env):
    a = Agent(env)  # no session yet
    r = a.rpc("server/discover")
    assert r.status_code == 200 and r.get_json()["error"]["code"] == -32601 and "Mcp-Session-Id" not in r.headers
    assert r.get_json()["id"] == 1


def test_a_batch_gets_a_batch_back(agent):
    r = agent.post([{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"},
                    {"jsonrpc": "2.0", "id": 2, "method": "nope"}])
    out = r.get_json()
    assert [x["id"] for x in out] == [1, 2] and "error" in out[1]


def test_tools_list_has_every_tool_with_a_description_and_schema(agent):
    tools = agent.rpc("tools/list").get_json()["result"]["tools"]
    assert {t["name"] for t in tools} == EXPECTED_TOOLS == set(REGISTRY)
    for t in tools:
        assert t["description"].strip() and "\n" not in t["description"], t["name"]
        assert t["inputSchema"]["type"] == "object" and t["inputSchema"]["additionalProperties"] is False
        assert set(t["inputSchema"]["required"]) <= set(t["inputSchema"]["properties"]), t["name"]
        assert isinstance(t["annotations"]["readOnlyHint"], bool)
    by = {t["name"]: t for t in tools}
    assert by["status"]["annotations"]["readOnlyHint"] and not by["add_nodes"]["annotations"]["readOnlyHint"]
    assert by["mine_run"]["inputSchema"]["required"] == ["confirm"]


def test_tools_call_errors(agent):
    r = agent.rpc("tools/call", {"name": "no_such_tool", "arguments": {}})
    assert r.get_json()["error"]["code"] == -32602
    r = agent.rpc("tools/call", {"arguments": {}})
    assert r.get_json()["error"]["code"] == -32602
    bad = agent.fails("search_tables")  # a missing argument is an error result the model can read
    assert "Invalid arguments" in bad and "q" in bad
    assert "unknown field" in agent.fails("status", surprise=1)
    assert "expected integer" in agent.fails("search_tables", q="x", limit="five")
    r = agent.rpc("tools/call", {"name": "status", "arguments": "nope"})
    assert r.get_json()["result"]["isError"] is True


@pytest.mark.skipif(sys.platform == "win32", reason="Windows has no POSIX file modes")
def test_the_token_file_is_private_stable_and_never_logged(agent, tmp_path):
    path = tmp_path / "mcp_token"
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    token = path.read_text().strip()
    assert len(token) >= 40 and auth.get_token() == token
    agent.ok("status")
    agent.fails("search_tables", q="")
    for f in (tmp_path / "logs").rglob("*"):
        if f.is_file():
            assert token not in f.read_text()
    assert "mcp.status" in (tmp_path / "logs" / "calls.jsonl").read_text()
    os.chmod(path, 0o644)  # loosened by someone: tightened again on next use
    auth.get_token()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_tool_calls_log_the_name_not_the_arguments(agent, tmp_path):
    agent.ok("search_tables", q="a_distinctive_search_term")
    ours = [x for x in (tmp_path / "logs" / "calls.jsonl").read_text().splitlines() if '"mcp.' in x]
    assert ours and all("a_distinctive_search_term" not in x for x in ours)  # (the warehouse call itself is logged as for the UI)


def test_agent_access_routes_show_the_command_and_rotate_the_token(connected):
    info = connected.get("/api/agent-access", base_url="http://127.0.0.1:8123").get_json()
    token = auth.get_token()
    assert info["token"] == token and info["url"] == "http://127.0.0.1:8123/mcp"
    assert info["command"] == (f'claude mcp add --transport http databricks-explore http://127.0.0.1:8123/mcp '
                               f'--header "Authorization: Bearer {token}"')
    assert connected.get("/api/agent-access", headers={"Origin": "https://evil.example"}).status_code == 403
    assert connected.post("/api/agent-access/token", headers={"Origin": "https://evil.example"}).status_code == 403
    assert auth.get_token() == token
    old = Agent(connected)
    assert old.initialize().status_code == 200 and old.rpc("ping").status_code == 200
    new = connected.post("/api/agent-access/token").get_json()
    assert new["token"] != token and auth.get_token() == new["token"]
    assert old.rpc("ping").status_code == 401  # the old token and its sessions stop working
    assert Agent(connected).initialize().status_code == 200


def test_the_rest_of_the_app_still_works_next_to_mcp(connected):
    assert connected.get("/api/session").get_json()["profile"] == "demo"
    assert connected.get("/api/nope").status_code == 404

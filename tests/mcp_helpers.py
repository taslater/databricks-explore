"""Shared setup for the MCP tests: a demo-mode app on a temporary data folder and a small JSON-RPC client."""
import json

import pytest

from databricks_explore import app as app_module
from databricks_explore import canvases
from databricks_explore import dbx
from databricks_explore import demo
from databricks_explore.mcp_server import auth, tools_data


class Agent:
    """Speaks MCP to the app's test client the way a coding agent does."""

    def __init__(self, client):
        self.client = client
        self.token = auth.get_token()
        self.session = None
        self.n = 0

    def headers(self, **extra):
        h = {"Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.session:
            h["Mcp-Session-Id"] = self.session
        return {**h, **extra}

    def post(self, body, **headers):
        return self.client.post("/mcp", data=json.dumps(body), headers=self.headers(**headers))

    def rpc(self, method, params=None, **headers):
        self.n += 1
        body = {"jsonrpc": "2.0", "id": self.n, "method": method}
        if params is not None:
            body["params"] = params
        return self.post(body, **headers)

    def initialize(self, version="2025-06-18"):
        r = self.rpc("initialize", {"protocolVersion": version, "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})
        self.session = r.headers.get("Mcp-Session-Id")
        return r

    def call(self, tool, /, **args):
        """(is_error, text) of a tools/call. An image block shows as '<image/png N bytes>'."""
        r = self.rpc("tools/call", {"name": tool, "arguments": args})
        assert r.status_code == 200, r.get_data(as_text=True)
        res = r.get_json()["result"]
        parts = [c["text"] if c["type"] == "text" else f"<image {len(c['data'])}>" for c in res["content"]]
        return res["isError"], "\n".join(parts)

    def ok(self, tool, /, **args):
        err, out = self.call(tool, **args)
        assert not err, out
        return out

    def fails(self, tool, /, **args):
        err, out = self.call(tool, **args)
        assert err, out
        return out


@pytest.fixture
def env(monkeypatch, tmp_path):
    """Demo mode on a temporary data folder; a connected client with a warehouse selected."""
    monkeypatch.setattr(dbx, "DEMO", True)
    monkeypatch.setattr(dbx, "WorkspaceClient", demo.FakeWorkspaceClient)
    monkeypatch.setattr(dbx, "DATA", tmp_path)
    monkeypatch.setattr(dbx, "CACHE", tmp_path / "cache")
    monkeypatch.setattr(dbx, "LOGS", tmp_path / "logs")
    (tmp_path / "logs").mkdir()
    monkeypatch.setattr(dbx, "DIAGRAMS", tmp_path / "diagrams")
    (tmp_path / "diagrams").mkdir()
    monkeypatch.setattr(canvases, "CANVASES", tmp_path / "canvases")
    (tmp_path / "canvases").mkdir()
    monkeypatch.setattr(demo, "NORMAL_DELAY", 0)
    monkeypatch.setattr(demo, "SLOW_DELAY", 3600)
    monkeypatch.setattr(tools_data, "POLL_SECONDS", 0.02)
    monkeypatch.setitem(app_module.STATE, "ex", None)
    monkeypatch.setitem(app_module.STATE, "miner", None)
    return app_module.app.test_client()


@pytest.fixture
def connected(env):
    assert env.post("/api/connect", json={"profile": "demo"}).status_code == 200
    env.post("/api/warehouse", json={"id": "demo-wh-1"})
    return env


@pytest.fixture
def agent(connected):
    a = Agent(connected)
    assert a.initialize().status_code == 200
    return a


@pytest.fixture
def offline_agent(env):
    """An agent on an app with no connection."""
    a = Agent(env)
    assert a.initialize().status_code == 200
    return a

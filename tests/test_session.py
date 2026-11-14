"""Session restore routes: GET /api/session and POST /api/connect with interactive=false.

No Databricks connection. dbx.Explorer and dbx.cli_login are replaced, so nothing
talks to a workspace and no browser opens.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as app_module  # noqa: E402
import dbx  # noqa: E402


class FakeExplorer:
    """Connects unless `fail_profiles` names the profile."""
    fail_profiles: set = set()

    def __init__(self, profile):
        if profile in FakeExplorer.fail_profiles:
            raise RuntimeError("cannot configure default credentials")
        self.profile = profile
        self.warehouse_id = None

    def whoami(self):
        return {"user": "u@example.com", "host": "https://h", "workspace_id": "1"}


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setattr(dbx, "Explorer", FakeExplorer)
    monkeypatch.setitem(app_module.STATE, "ex", None)
    FakeExplorer.fail_profiles = set()
    logins = []
    monkeypatch.setattr(dbx, "cli_login", lambda profile: logins.append(profile))
    return app_module.app.test_client(), logins


def test_session_is_null_when_not_connected(env):
    c, _ = env
    assert c.get("/api/session").get_json() == {"profile": None, "warehouse_id": None}


def test_session_reports_profile_and_warehouse(env):
    c, _ = env
    c.post("/api/connect", json={"profile": "dev"})
    c.post("/api/warehouse", json={"id": "wh9"})
    assert c.get("/api/session").get_json() == {"profile": "dev", "warehouse_id": "wh9"}


def test_non_interactive_connect_succeeds_without_browser(env):
    c, logins = env
    r = c.post("/api/connect", json={"profile": "dev", "interactive": False})
    assert r.status_code == 200
    assert r.get_json()["profile"] == "dev"
    assert logins == []


def test_non_interactive_connect_failure_returns_401_and_never_opens_browser(env):
    c, logins = env
    FakeExplorer.fail_profiles = {"dev"}
    r = c.post("/api/connect", json={"profile": "dev", "interactive": False})
    assert r.status_code == 401
    assert "Could not reconnect to dev" in r.get_json()["error"]
    assert logins == []
    assert app_module.STATE["ex"] is None


def test_default_connect_still_runs_browser_login_on_failure(env):
    c, logins = env
    FakeExplorer.fail_profiles = {"dev"}
    # The retry after login fails too in this fake, so the route raises. What matters is the login ran.
    c.post("/api/connect", json={"profile": "dev"})
    assert logins == ["dev"]


def test_profiles_skip_dunder_sections(monkeypatch, tmp_path):
    cfg = tmp_path / "cfg"
    cfg.write_text("[__settings__]\nx = 1\n[dev]\nhost = https://h\n[__other]\nhost = https://o\n")
    monkeypatch.setenv("DATABRICKS_CONFIG_FILE", str(cfg))
    monkeypatch.setattr(dbx, "DEMO", False)
    assert [p["name"] for p in dbx.list_profiles()] == ["dev", "__other"]
